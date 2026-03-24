// ============================================================================
// TastyScanner MCP — TastyTrade Client Wrapper
// OAuth authentication (clientId + clientSecret + refreshToken)
// Same auth flow as main TastyScanner app (tasty.broker.ts)
// + Auto-reconnect on 401 (expired token)
// ============================================================================

import TastyTradeClient, { STREAMER_STATE, MarketDataSubscriptionType } from "@tastytrade/api";
import { TastyConfig, ConnectionStatus } from "./types.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Streamer data cache (from DxLink WebSocket)
// ---------------------------------------------------------------------------

export interface QuoteData {
  bidPrice: number;
  askPrice: number;
}

export interface GreeksData {
  delta: number;
  theta: number;
  gamma: number;
  vega: number;
  rho: number;
  volatility: number;
}

interface StreamerCache {
  quotes: Map<string, QuoteData>;
  greeks: Map<string, GreeksData>;
  trades: Map<string, { price: number }>;
}

// ---------------------------------------------------------------------------
// TastyClient
// ---------------------------------------------------------------------------

export class TastyClient {
  private client: TastyTradeClient | null = null;
  private config: TastyConfig;
  private accountNumber: string = "";
  private _connected = false;
  private _streamerConnected = false;
  private _reconnecting = false;
  private streamerCache: StreamerCache = {
    quotes: new Map(),
    greeks: new Map(),
    trades: new Map(),
  };

  constructor(config: TastyConfig) {
    this.config = config;
  }

  // -------------------------------------------------------------------------
  // Connection — OAuth flow (mirrors tasty.broker.ts _createTastyClientConfig)
  // -------------------------------------------------------------------------

  async connect(): Promise<ConnectionStatus> {
    try {
      logger.info("[TastyClient] Connecting via OAuth...");

      // Build config same as main app: ProdConfig + OAuth credentials
      const prodConfig = TastyTradeClient.ProdConfig;

      const clientConfig = {
        ...prodConfig,
        clientSecret: this.config.clientSecret,
        refreshToken: this.config.refreshToken,
        oauthScopes: ["read", "trade", "openid"],
      };

      this.client = new TastyTradeClient(clientConfig);

      // Patch SDK v6 generateAccessToken to include client_id
      // (SDK v6 doesn't send client_id in the token request — same fix as main app)
      this._patchGenerateAccessToken();

      logger.info("[TastyClient] OAuth config ready, loading accounts...");

      // Load accounts (this triggers the first token refresh via OAuth)
      const accounts = (await this.client.accountsAndCustomersService.getCustomerAccounts()) as any[];
      if (!accounts || accounts.length === 0) {
        throw new Error("No accounts found — check OAuth credentials");
      }

      this.accountNumber =
        this.config.accountNumber ||
        accounts[0]?.account?.["account-number"] ||
        "";

      logger.info(`[TastyClient] Using account: ${this.accountNumber}`);

      // Connect account streamer (WebSocket for order/balance events)
      await this._connectAccountStreamer();

      // Connect quote streamer (DxLink for market data)
      await this._connectQuoteStreamer();

      this._connected = true;

      return {
        connected: true,
        streamer_connected: this._streamerConnected,
        account_number: this.accountNumber,
        error: null,
      };
    } catch (err: any) {
      logger.error("[TastyClient] Connection failed:", err.message);
      this._connected = false;
      return {
        connected: false,
        streamer_connected: false,
        account_number: null,
        error: err.message,
      };
    }
  }

  /**
   * Patch SDK v6's generateAccessToken to include client_id in the
   * form-urlencoded body. This is the exact same patch from:
   * src/app/services/brokers/tasty/tasty.broker.ts lines 113-139
   */
  private _patchGenerateAccessToken(): void {
    if (!this.client || !this.config.clientId) return;

    const clientId = this.config.clientId;
    const tastyClient = this.client;

    tastyClient.httpClient.generateAccessToken = async function () {
      const httpClient = tastyClient.httpClient as any;
      const params = new URLSearchParams({
        client_id: clientId,
        refresh_token: httpClient.refreshToken,
        client_secret: httpClient.clientSecret,
        scope: httpClient.oauthScopes.join(" "),
        grant_type: "refresh_token",
      });

      // Dynamic import axios (same approach as main app — clean instance, no auth headers)
      const axiosModule = await import("axios");
      const cleanAxios = axiosModule.default.create();
      const tokenResponse = await cleanAxios.post(
        `${httpClient.baseUrl}/oauth/token`,
        params.toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
        },
      );
      httpClient.accessToken.updateFromTokenResponse(tokenResponse);
      return httpClient.accessToken;
    };

    logger.info("[TastyClient] Patched generateAccessToken with client_id (OAuth)");
  }

  private async _connectAccountStreamer(): Promise<void> {
    if (!this.client) return;
    try {
      this.client.accountStreamer.addMessageObserver((json: object) => {
        const msg = json as any;
        if (msg?.action !== "heartbeat") {
          logger.debug("[AccountStreamer] message:", msg?.type);
        }
      });

      this.client.accountStreamer.addStreamerStateObserver((state: STREAMER_STATE) => {
        logger.info(`[AccountStreamer] state: ${STREAMER_STATE[state]}`);
      });

      await this.client.accountStreamer.start();
      this.client.accountStreamer.subscribeToAccounts([this.accountNumber]);

      logger.info("[TastyClient] Account streamer connected");
    } catch (err: any) {
      logger.warn("[TastyClient] Account streamer failed:", err.message);
    }
  }

  private async _connectQuoteStreamer(): Promise<void> {
    if (!this.client) return;
    try {
      const streamer = this.client.quoteStreamer;

      streamer.addEventListener((events: any) => {
        if (Array.isArray(events)) {
          for (const evt of events) {
            this._processStreamerEvent(evt);
          }
        } else if (events) {
          this._processStreamerEvent(events);
        }
      });

      await streamer.connect();
      this._streamerConnected = true;
      logger.info("[TastyClient] Quote streamer (DxLink) connected");
    } catch (err: any) {
      logger.warn("[TastyClient] Quote streamer failed:", err.message);
    }
  }

  private _processStreamerEvent(data: any): void {
    const eventType = data?.eventType ?? "";
    const eventSymbol = data?.eventSymbol ?? "";
    if (!eventSymbol) return;

    switch (eventType) {
      case "Quote":
        this.streamerCache.quotes.set(eventSymbol, {
          bidPrice: data.bidPrice ?? 0,
          askPrice: data.askPrice ?? 0,
        });
        break;
      case "Greeks":
        this.streamerCache.greeks.set(eventSymbol, {
          delta: data.delta ?? 0,
          theta: data.theta ?? 0,
          gamma: data.gamma ?? 0,
          vega: data.vega ?? 0,
          rho: data.rho ?? 0,
          volatility: data.volatility ?? 0,
        });
        break;
      case "Trade":
        this.streamerCache.trades.set(eventSymbol, {
          price: data.price ?? 0,
        });
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Auto-reconnect on 401
  // -------------------------------------------------------------------------

  /**
   * Wraps an API call with auto-reconnect logic.
   * If the call fails with 401 (expired token), reconnects and retries once.
   * Prevents concurrent reconnect attempts with a guard flag.
   */
  private async _withAutoReconnect<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.response?.status ?? err?.status;
      const msg = err?.message ?? "";

      if (status === 401 || msg.includes("401")) {
        // Prevent concurrent reconnect storms
        if (this._reconnecting) {
          throw new Error("Reconnect already in progress — please retry in a few seconds.");
        }

        logger.warn("[TastyClient] Got 401 — token expired, reconnecting...");
        this._reconnecting = true;
        this._connected = false;
        this._streamerConnected = false;

        try {
          const reconnectStatus = await this.connect();
          if (!reconnectStatus.connected) {
            throw new Error(`Reconnect failed: ${reconnectStatus.error}`);
          }

          logger.info("[TastyClient] Reconnected successfully, retrying call...");
          return await fn(); // retry once after reconnect
        } finally {
          this._reconnecting = false;
        }
      }

      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Public API — Market Data
  // -------------------------------------------------------------------------

  get isConnected(): boolean {
    return this._connected;
  }

  get isStreamerConnected(): boolean {
    return this._streamerConnected;
  }

  getStatus(): ConnectionStatus {
    return {
      connected: this._connected,
      streamer_connected: this._streamerConnected,
      account_number: this._connected ? this.accountNumber : null,
      error: null,
    };
  }

  async getBulkSymbolMetrics(symbols: string[]): Promise<any[]> {
    this._ensureConnected();
    return this._withAutoReconnect(async () => {
      try {
        const response = await this.client!.marketMetricsService.getMarketMetrics({
          symbols: symbols.join(","),
        });
        const items = response?.data?.items ?? response?.items ?? response ?? [];
        return Array.isArray(items) ? items : [];
      } catch (err: any) {
        logger.error("[TastyClient] getBulkSymbolMetrics failed:", err.message);
        throw err;
      }
    });
  }

  async getOptionsChain(symbol: string): Promise<any> {
    this._ensureConnected();
    return this._withAutoReconnect(async () => {
      try {
        return await this.client!.instrumentsService.getNestedOptionChain(symbol);
      } catch (err: any) {
        logger.error(`[TastyClient] getOptionsChain(${symbol}) failed:`, err.message);
        throw err;
      }
    });
  }

  async subscribeToSymbols(streamerSymbols: string[]): Promise<void> {
    if (!this.client || !this._streamerConnected) return;
    try {
      this.client.quoteStreamer.subscribe(streamerSymbols, [
        MarketDataSubscriptionType.Quote,
        MarketDataSubscriptionType.Greeks,
        MarketDataSubscriptionType.Trade,
      ]);
    } catch (err: any) {
      logger.warn("[TastyClient] subscribe failed:", err.message);
    }
  }

  getQuote(streamerSymbol: string): QuoteData | undefined {
    return this.streamerCache.quotes.get(streamerSymbol);
  }

  getGreeks(streamerSymbol: string): GreeksData | undefined {
    return this.streamerCache.greeks.get(streamerSymbol);
  }

  getTrade(streamerSymbol: string): { price: number } | undefined {
    return this.streamerCache.trades.get(streamerSymbol);
  }

  // -------------------------------------------------------------------------
  // Public API — Account & Positions
  // -------------------------------------------------------------------------

  async getActivePositions(): Promise<any[]> {
    this._ensureConnected();
    return this._withAutoReconnect(async () => {
      try {
        const positions = await this.client!.balancesAndPositionsService.getPositionsList(
          this.accountNumber,
        );
        return positions ?? [];
      } catch (err: any) {
        logger.error("[TastyClient] getActivePositions failed:", err.message);
        throw err;
      }
    });
  }

  async getLiveOrders(): Promise<any[]> {
    this._ensureConnected();
    return this._withAutoReconnect(async () => {
      try {
        const orders = await this.client!.orderService.getLiveOrders(this.accountNumber);
        return orders ?? [];
      } catch (err: any) {
        logger.error("[TastyClient] getLiveOrders failed:", err.message);
        throw err;
      }
    });
  }

  async getOrders(queryParams?: object): Promise<any[]> {
    this._ensureConnected();
    return this._withAutoReconnect(async () => {
      try {
        const orders = await this.client!.orderService.getOrders(
          this.accountNumber,
          queryParams,
        );
        return orders ?? [];
      } catch (err: any) {
        logger.error("[TastyClient] getOrders failed:", err.message);
        throw err;
      }
    });
  }

  async getAccountBalance(): Promise<any> {
    this._ensureConnected();
    return this._withAutoReconnect(async () => {
      try {
        return await this.client!.balancesAndPositionsService.getAccountBalanceValues(
          this.accountNumber,
        );
      } catch (err: any) {
        logger.error("[TastyClient] getAccountBalance failed:", err.message);
        throw err;
      }
    });
  }

  async sendOrder(orderData: object): Promise<any> {
    this._ensureConnected();
    return this._withAutoReconnect(async () => {
      try {
        return await this.client!.orderService.createOrder(
          this.accountNumber,
          orderData,
        );
      } catch (err: any) {
        logger.error("[TastyClient] sendOrder failed:", err.message);
        throw err;
      }
    });
  }

  async cancelOrder(orderId: number): Promise<any> {
    this._ensureConnected();
    return this._withAutoReconnect(async () => {
      try {
        return await this.client!.orderService.cancelOrder(
          this.accountNumber,
          orderId,
        );
      } catch (err: any) {
        logger.error("[TastyClient] cancelOrder failed:", err.message);
        throw err;
      }
    });
  }

  /**
   * Replace a working order with a new price.
   * SDK: orderService.replaceOrder(accountNumber, orderId, replacementOrder)
   * Used by adjust_order tool for auto-replace logic.
   */
  async replaceOrder(orderId: number, replacementData: object): Promise<any> {
    this._ensureConnected();
    return this._withAutoReconnect(async () => {
      try {
        return await this.client!.orderService.replaceOrder(
          this.accountNumber,
          orderId,
          replacementData,
        );
      } catch (err: any) {
        logger.error("[TastyClient] replaceOrder failed:", err.message);
        throw err;
      }
    });
  }

  /**
   * Get symbol tick sizes for price adjustments.
   * SDK: instrumentsService.getSingleEquity(symbol)
   */
  async getSymbolInfo(symbol: string): Promise<any> {
    this._ensureConnected();
    return this._withAutoReconnect(async () => {
      try {
        return await this.client!.instrumentsService.getSingleEquity(symbol);
      } catch (err: any) {
        logger.error(`[TastyClient] getSymbolInfo(${symbol}) failed:`, err.message);
        throw err;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Public API — Watchlists
  // -------------------------------------------------------------------------

  /** User's personal watchlists (saved on TastyTrade account) */
  async getUserWatchlists(): Promise<any[]> {
    this._ensureConnected();
    return this._withAutoReconnect(async () => {
      try {
        const result = await this.client!.watchlistsService.getAllWatchlists();
        return result ?? [];
      } catch (err: any) {
        logger.error("[TastyClient] getUserWatchlists failed:", err.message);
        throw err;
      }
    });
  }

  /** TastyTrade platform watchlists (High IVR, Most Active, etc.) */
  async getPublicWatchlists(): Promise<any[]> {
    this._ensureConnected();
    return this._withAutoReconnect(async () => {
      try {
        const result = await this.client!.watchlistsService.getPublicWatchlists();
        return result ?? [];
      } catch (err: any) {
        logger.error("[TastyClient] getPublicWatchlists failed:", err.message);
        throw err;
      }
    });
  }

  /** Get a single watchlist by name */
  async getWatchlist(name: string): Promise<any> {
    this._ensureConnected();
    return this._withAutoReconnect(async () => {
      try {
        return await this.client!.watchlistsService.getSingleWatchlist(name);
      } catch (err: any) {
        logger.error(`[TastyClient] getWatchlist(${name}) failed:`, err.message);
        throw err;
      }
    });
  }

  /** Create a new user watchlist */
  async createWatchlist(watchlist: object): Promise<any> {
    this._ensureConnected();
    return this._withAutoReconnect(async () => {
      try {
        return await this.client!.watchlistsService.createAccountWatchlist(watchlist);
      } catch (err: any) {
        logger.error("[TastyClient] createWatchlist failed:", err.message);
        throw err;
      }
    });
  }

  /** Replace (update) an existing watchlist — use for add/remove symbols */
  async replaceWatchlist(name: string, watchlist: object): Promise<any> {
    this._ensureConnected();
    return this._withAutoReconnect(async () => {
      try {
        return await this.client!.watchlistsService.replaceWatchlist(name, watchlist);
      } catch (err: any) {
        logger.error(`[TastyClient] replaceWatchlist(${name}) failed:`, err.message);
        throw err;
      }
    });
  }

  /** Delete a user watchlist */
  async deleteWatchlist(name: string): Promise<any> {
    this._ensureConnected();
    return this._withAutoReconnect(async () => {
      try {
        return await this.client!.watchlistsService.deleteWatchlist(name);
      } catch (err: any) {
        logger.error(`[TastyClient] deleteWatchlist(${name}) failed:`, err.message);
        throw err;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private _ensureConnected(): void {
    if (!this._connected || !this.client) {
      throw new Error("Not connected to TastyTrade. Check OAuth credentials and try again.");
    }
  }
}
