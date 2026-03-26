// ============================================================================
// TastyScanner MCP Server
// HTTP transport (Streamable HTTP) for DeerFlow AI agent
// ============================================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { z } from "zod";

import { TastyClient } from "./tasty-client.js";
import { StrategyBuilder, StrategyType } from "./strategy-builder.js";
import {
  MarketOverviewItem,
  Position,
  PositionLeg,
  ExecuteTradeResponse,
  ClosePositionResponse,
  AdjustOrderResponse,
  makeError,
} from "./types.js";
import { logger } from "./logger.js";
import {
  TastyOrderApiResponse,
  TastyOrderLegApiResponse,
  TastyWatchlistApiResponse,
  TastyWatchlistEntryApiResponse,
  TastyPositionApiResponse,
  TastyPositionLegApiResponse,
  extractErrorMessage,
} from "./tasty-api-types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.MCP_PORT ?? "7698", 10);
const TASTY_CLIENT_ID = process.env.TASTY_CLIENT_ID ?? "";
const TASTY_CLIENT_SECRET = process.env.TASTY_CLIENT_SECRET ?? "";
const TASTY_REFRESH_TOKEN = process.env.TASTY_REFRESH_TOKEN ?? "";
const TASTY_ACCOUNT = process.env.TASTY_ACCOUNT ?? "";
const TASTY_PRODUCTION = (process.env.TASTY_PRODUCTION ?? "true") === "true";
const ENABLE_LIVE_TRADING = (process.env.ENABLE_LIVE_TRADING ?? "false") === "true";
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? "";

const DEFAULT_SYMBOLS = [
  "SPY", "QQQ", "IWM", "TLT", "GLD", "SLV", "EEM", "XLE", "XLF", "SMH",
  "HYG", "USO", "DIA", "EFA", "ARKK",
  "AAPL", "MSFT", "AMZN", "NVDA", "GOOG", "META", "TSLA", "NFLX", "AMD", "CRM",
  "SOFI", "PLTR", "RIVN", "SNAP", "HOOD", "COIN", "SQ", "UBER", "ROKU", "MARA",
  "F", "NIO", "BAC", "T", "INTC", "WBD", "AAL", "LCID", "PLUG", "CCL",
];

// ---------------------------------------------------------------------------
// TastyTrade Client (shared singleton)
// ---------------------------------------------------------------------------

const tastyClient = new TastyClient({
  clientId: TASTY_CLIENT_ID,
  clientSecret: TASTY_CLIENT_SECRET,
  refreshToken: TASTY_REFRESH_TOKEN,
  accountNumber: TASTY_ACCOUNT,
  isProduction: TASTY_PRODUCTION,
});

const strategyBuilder = new StrategyBuilder(tastyClient);

// ---------------------------------------------------------------------------
// MCP Server Setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "tastyscanner-mcp",
  version: "1.0.0",
});

// ===========================================================================
// TOOL 1: get_market_overview
// ===========================================================================

server.tool(
  "get_market_overview",
  "Scan symbols for options trading metrics: price, IVR (0-100, higher=better for selling premium), IV, beta, earnings date. " +
  "Sorted by IVR descending. Pass watchlist name, explicit symbols array, or omit for defaults (~40 popular tickers). " +
  "Returns max 50 results.",
  {
    watchlist: z
      .string()
      .optional()
      .describe("Watchlist name to scan. Searches personal watchlists first, falls back to TastyTrade platform watchlists if not found."),
    symbols: z
      .array(z.string())
      .optional()
      .describe("Explicit list of symbols to scan. Overrides watchlist if both provided."),
    min_ivr: z
      .number()
      .optional()
      .describe("Minimum IVR filter (0-100). Symbols below this are excluded."),
    min_price: z
      .number()
      .optional()
      .describe("Minimum stock price filter."),
    max_price: z
      .number()
      .optional()
      .describe("Maximum stock price filter."),
    hide_earnings_within_days: z
      .number()
      .optional()
      .describe("Hide symbols with earnings within N days (avoids IV crush risk)."),
  },
  async ({ watchlist, symbols, min_ivr, min_price, max_price, hide_earnings_within_days }) => {
    logger.info("[Tool] get_market_overview called", { watchlist, symbols, min_ivr });

    if (!tastyClient.isConnected) {
      return errorResult("NOT_CONNECTED", "TastyTrade connection not established.");
    }

    try {
      // Resolve symbols from source
      let targetSymbols: string[];
      let resolvedSource = "default";

      if (symbols && symbols.length > 0) {
        targetSymbols = symbols;
        resolvedSource = "custom";
      } else if (watchlist) {
        // Try personal watchlist first
        let wl: TastyWatchlistApiResponse | null = null;
        let sourceType = "personal";

        try {
          wl = await tastyClient.getWatchlist(watchlist);
        } catch {
          // Personal watchlist not found — try public
        }

        let entries = wl?.["watchlist-entries"] ?? wl?.entries ?? [];
        let wlSymbols = entries.map((e: TastyWatchlistEntryApiResponse) => e.symbol ?? "").filter(Boolean);

        // Fallback to public watchlist if personal is empty or not found
        if (wlSymbols.length === 0) {
          logger.info(`[Tool] Personal watchlist '${watchlist}' not found, trying public...`);
          sourceType = "platform";
          try {
            const publicWatchlists = await tastyClient.getPublicWatchlists();
            const match = (Array.isArray(publicWatchlists) ? publicWatchlists : [])
              .find((pw: TastyWatchlistApiResponse) => (pw.name ?? "").toLowerCase() === watchlist.toLowerCase());

            if (match) {
              entries = match["watchlist-entries"] ?? match.entries ?? [];
              wlSymbols = entries.map((e: TastyWatchlistEntryApiResponse) => e.symbol ?? "").filter(Boolean);
            }
          } catch {
            // Public lookup also failed
          }
        }

        if (wlSymbols.length === 0) {
          return errorResult(
            "WATCHLIST_NOT_FOUND",
            `Watchlist '${watchlist}' not found in personal or platform watchlists. ` +
            `Use get_watchlists() to see available names.`,
          );
        }

        targetSymbols = wlSymbols;
        resolvedSource = `${sourceType}:${watchlist}`;
        logger.info(`[Tool] Scanning ${sourceType} watchlist '${watchlist}': ${targetSymbols.length} symbols`);
      } else {
        targetSymbols = DEFAULT_SYMBOLS;
      }

      const metrics = await tastyClient.getBulkSymbolMetrics(targetSymbols);

      let results: MarketOverviewItem[] = metrics.map((m) => ({
        symbol: m.symbol ?? "",
        price: round(parseFloat(String(m["close-price"] ?? "0"))),
        ivr: round((m["implied-volatility-index-rank"] ?? 0) * 100),
        iv: round((m["implied-volatility-index"] ?? 0) * 100),
        beta: round(m.beta ?? 0),
        earnings_date: m.earnings?.["expected-report-date"] ?? null,
      }));

      // Apply filters
      if (min_ivr !== undefined) {
        results = results.filter((r) => r.ivr >= min_ivr);
      }
      if (min_price !== undefined) {
        results = results.filter((r) => r.price >= min_price);
      }
      if (max_price !== undefined) {
        results = results.filter((r) => r.price <= max_price);
      }
      if (hide_earnings_within_days !== undefined && hide_earnings_within_days > 0) {
        const now = new Date();
        results = results.filter((r) => {
          if (!r.earnings_date) return true;
          const earningsDate = new Date(r.earnings_date);
          const daysUntil = Math.ceil((earningsDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
          return daysUntil < 0 || daysUntil > hide_earnings_within_days;
        });
      }

      // Sort by IVR descending
      results.sort((a, b) => b.ivr - a.ivr);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              source: resolvedSource,
              count: results.length,
              items: results,
            }, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      return errorResult("FETCH_FAILED", `Failed to fetch market data: ${extractErrorMessage(err)}`);
    }
  },
);

// ===========================================================================
// TOOL 2: get_strategies
// ===========================================================================

server.tool(
  "get_strategies",
  "Build options strategy setups for a symbol. Returns top results sorted by risk/reward ratio.\n" +
  "CREDIT (sell premium): iron_condor, put_credit_spread, call_credit_spread, iron_butterfly, jade_lizard, twisted_sister\n" +
  "DEBIT (buy premium): long_straddle, long_strangle, bull_call_spread, bear_put_spread, call_butterfly, put_butterfly\n" +
  "Each result has: legs, credit/debit, max_loss, rr_ratio, pop%, theta, delta, wings, bpe. Default max 20 results.",
  {
    symbol: z.string().describe("Ticker symbol (e.g. 'SPY', 'AAPL', 'TSLA')"),
    strategy_type: z
      .enum([
        "all",
        "iron_condor", "put_credit_spread", "call_credit_spread",
        "iron_butterfly", "jade_lizard", "twisted_sister",
        "long_straddle", "long_strangle",
        "bull_call_spread", "bear_put_spread",
        "call_butterfly", "put_butterfly",
      ])
      .optional()
      .describe("Which strategy type to build. Default: 'all' (scans all 12 types)."),
    min_dte: z.number().optional().describe("Minimum days to expiration (default: 20)"),
    max_dte: z.number().optional().describe("Maximum days to expiration (default: 60)"),
    min_delta: z.number().optional().describe("Min delta for credit strategy short strikes (default: 0.10)"),
    max_delta: z.number().optional().describe("Max delta for credit strategy short strikes (default: 0.30)"),
    debit_min_delta: z.number().optional().describe("Min delta for debit strategy long strikes (default: 0.30)"),
    debit_max_delta: z.number().optional().describe("Max delta for debit strategy long strikes (default: 0.50)"),
    wings: z.array(z.number()).optional().describe("Wing widths in dollars (default: [1,2,3,5,10])"),
    max_results: z.number().optional().describe("Max results returned (default: 20, max: 50)"),
    max_loss: z.number().optional().describe("Max loss per contract in $ (e.g. 500). Filters out riskier setups."),
  },
  async ({ symbol, strategy_type, min_dte, max_dte, min_delta, max_delta, debit_min_delta, debit_max_delta, wings, max_results, max_loss }) => {
    const stype = (strategy_type ?? "all") as StrategyType;
    logger.info("[Tool] get_strategies called", { symbol, strategy_type: stype, min_dte, max_dte });

    if (!tastyClient.isConnected) {
      return errorResult("NOT_CONNECTED", "TastyTrade connection not established.");
    }

    try {
      const builder = new StrategyBuilder(tastyClient, {
        ...(min_dte !== undefined && { minDTE: min_dte }),
        ...(max_dte !== undefined && { maxDTE: max_dte }),
        ...(min_delta !== undefined && { minDelta: min_delta }),
        ...(max_delta !== undefined && { maxDelta: max_delta }),
        ...(debit_min_delta !== undefined && { debitMinDelta: debit_min_delta }),
        ...(debit_max_delta !== undefined && { debitMaxDelta: debit_max_delta }),
        ...(wings !== undefined && { wings }),
      });

      let strategies = await builder.buildStrategies(symbol.toUpperCase(), stype);

      // Apply max_loss filter if provided
      if (max_loss !== undefined && max_loss > 0) {
        strategies = strategies.filter(s => s.max_loss <= max_loss);
      }

      const cap = Math.min(max_results ?? 20, 50);
      const limited = strategies.slice(0, cap);

      logger.info(`[Tool] get_strategies: ${strategies.length} total → returning ${limited.length} (cap ${cap})`);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              symbol: symbol.toUpperCase(),
              strategy_type: stype,
              total_found: strategies.length,
              returned: limited.length,
              strategies: limited,
            }, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      return errorResult("STRATEGY_BUILD_FAILED", `Failed to build strategies for ${symbol}: ${extractErrorMessage(err)}`);
    }
  },
);

// ===========================================================================
// TOOL 3: get_positions
// ===========================================================================

server.tool(
  "get_positions",
  "Returns all open positions. Each has: symbol, detected strategy type, legs (strike/expiry/qty), entry price, current value, P&L ($, %), DTE.",
  {},
  async () => {
    logger.info("[Tool] get_positions called");

    if (!tastyClient.isConnected) {
      return errorResult("NOT_CONNECTED", "TastyTrade connection not established.");
    }

    try {
      const rawPositions = await tastyClient.getActivePositions();

      const positions: Position[] = rawPositions.map((pos: TastyPositionApiResponse) => {
        const rawLegs = pos.legs ?? [pos as unknown as TastyPositionLegApiResponse];
        const legs: PositionLeg[] = rawLegs.map((leg) => ({
          type: (leg["instrument-type"] ?? "Equity Option") as string,
          strike: typeof leg["strike-price"] === "string" ? parseFloat(leg["strike-price"]) : null,
          expiry: (leg["expiration-date"] ?? leg["expires-at"] ?? null) as string | null,
          quantity: (leg.quantity ?? 0) as number,
          price: typeof leg["average-open-price"] === "string" ? parseFloat(leg["average-open-price"]) : 0,
          option_type: (leg["option-type"] ?? null) as "C" | "P" | null,
          is_sell: ((leg.quantity ?? 0) as number) < 0,
        }));

        const symbol = (pos["underlying-symbol"] ?? pos.symbol ?? "") as string;
        const marketPrice = pos["close-price"] ? parseFloat(String(pos["close-price"])) : 0;
        const tradingPrice = pos["average-open-price"] ? parseFloat(String(pos["average-open-price"])) : 0;
        const quantity = pos.quantity ?? 0;
        const pnl = round((marketPrice - tradingPrice) * quantity * 100);
        const pnlPercent = tradingPrice !== 0
          ? round((pnl / Math.abs(tradingPrice * quantity * 100)) * 100)
          : 0;

        return {
          position_id: String(pos.id ?? ""),
          symbol,
          strategy: _detectStrategy(legs),
          legs,
          entry_credit: round(tradingPrice),
          current_value: round(marketPrice),
          pnl,
          pnl_percent: pnlPercent,
          dte: _calcMinDTE(legs),
          opened_at: (pos["created-at"] ?? new Date().toISOString()) as string,
        };
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(positions, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      return errorResult("POSITIONS_FAILED", `Failed to fetch positions: ${extractErrorMessage(err)}`);
    }
  },
);

// ===========================================================================
// TOOL 4: execute_trade
// ===========================================================================

server.tool(
  "execute_trade",
  "⚠️ REAL MONEY. Places an options order. Requires ENABLE_LIVE_TRADING=true. " +
  "Pass legs with OCC symbols, limit_price, price_effect (Credit/Debit). Always use Limit orders.",
  {
    symbol: z.string().describe("Underlying symbol (e.g. 'SPY')"),
    legs: z
      .array(
        z.object({
          action: z.enum(["Buy to Open", "Sell to Open", "Buy to Close", "Sell to Close"]),
          symbol: z.string().describe("OCC option symbol"),
          quantity: z.number().int().min(1),
        }),
      )
      .describe("Order legs with OCC symbols"),
    limit_price: z.number().positive().describe("Limit price for the order"),
    price_effect: z.enum(["Credit", "Debit"]).describe("Whether this is a credit or debit order"),
    time_in_force: z
      .enum(["Day", "GTC", "Ext", "GTC Ext"])
      .optional()
      .describe("Time in force (default: Day)"),
    order_type: z
      .enum(["Limit", "Market"])
      .optional()
      .describe("Order type (default: Limit)"),
  },
  async ({ symbol, legs, limit_price, price_effect, time_in_force, order_type }) => {
    logger.info("[Tool] execute_trade called", { symbol, legs: legs.length, limit_price, price_effect });

    if (!ENABLE_LIVE_TRADING) {
      return errorResult(
        "TRADING_DISABLED",
        "Live trading is disabled. Set ENABLE_LIVE_TRADING=true in .env to enable order execution.",
      );
    }

    if (!tastyClient.isConnected) {
      return errorResult("NOT_CONNECTED", "TastyTrade connection not established.");
    }

    try {
      const orderData = {
        "order-type": order_type ?? "Limit",
        "time-in-force": time_in_force ?? "Day",
        "price": limit_price,
        "price-effect": price_effect,
        "legs": legs.map((leg) => ({
          "action": leg.action,
          "instrument-type": "Equity Option",
          "quantity": leg.quantity,
          "symbol": leg.symbol,
        })),
      };

      const result = await tastyClient.sendOrder(orderData);

      const response: ExecuteTradeResponse = {
        order_id: String(result?.id ?? result?.data?.id ?? "unknown"),
        status: result?.status ?? result?.data?.status ?? "submitted",
        message: `Order placed for ${symbol}: ${legs.length} legs at ${limit_price} ${price_effect}`,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(response, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      return errorResult("ORDER_FAILED", `Failed to place order: ${extractErrorMessage(err)}`);
    }
  },
);

// ===========================================================================
// TOOL 5: close_position (safe — guidance only, no auto-execution)
// ===========================================================================

server.tool(
  "close_position",
  "Returns instructions to close a position (does NOT auto-execute). Shows inverse legs and recommended price. You must then call execute_trade() yourself.",
  {
    position_id: z.string().describe("Position ID to close (from get_positions)"),
    reason: z
      .enum(["take_profit", "stop_loss", "dte_expiry", "manual"])
      .describe("Reason for closing — logged for audit trail"),
  },
  async ({ position_id, reason }) => {
    logger.info("[Tool] close_position called", { position_id, reason });

    if (!tastyClient.isConnected) {
      return errorResult("NOT_CONNECTED", "TastyTrade connection not established.");
    }

    try {
      const positions = await tastyClient.getActivePositions();
      const liveOrders = await tastyClient.getLiveOrders();

      // Build a guidance response — the agent must call execute_trade() itself
      const guidance = {
        position_id,
        reason,
        active_positions_count: Array.isArray(positions) ? positions.length : 0,
        live_orders_count: Array.isArray(liveOrders) ? liveOrders.length : 0,
        instructions: [
          "1. Call get_positions() to see exact current legs and P&L for this position.",
          "2. For each leg, build the inverse action:",
          "   - 'Sell to Open' legs → close with 'Buy to Close'",
          "   - 'Buy to Open' legs → close with 'Sell to Close'",
          "3. Set limit_price to the current mid-price of the spread.",
          "4. Call execute_trade() with the inverse legs and a Credit price_effect (for closing a credit position) or Debit (for closing a debit position).",
          "5. If the order doesn't fill, use adjust_order() to improve the fill price incrementally.",
        ],
        safety_note: "This tool does NOT auto-close. Review the position before executing.",
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(guidance, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      return errorResult("CLOSE_FAILED", `Failed to analyze position: ${extractErrorMessage(err)}`);
    }
  },
);

// ===========================================================================
// TOOL 6: adjust_order (auto-replace — tick-size price improvement)
// ===========================================================================

server.tool(
  "adjust_order",
  "Adjust a working order's price to improve fill. 'improve_fill' moves price by one tick toward fill (credit→cheaper, debit→pricier). 'custom' sets exact price. Requires ENABLE_LIVE_TRADING=true.",
  {
    order_id: z.number().int().describe("Working order ID (from get_working_orders or execute_trade response)"),
    adjustment: z
      .enum(["improve_fill", "custom"])
      .describe("'improve_fill' = auto-adjust by one tick toward fill. 'custom' = set specific price."),
    custom_price: z
      .number()
      .optional()
      .describe("Required when adjustment='custom'. The new limit price."),
  },
  async ({ order_id, adjustment, custom_price }) => {
    logger.info("[Tool] adjust_order called", { order_id, adjustment, custom_price });

    if (!ENABLE_LIVE_TRADING) {
      return errorResult(
        "TRADING_DISABLED",
        "Live trading is disabled. Set ENABLE_LIVE_TRADING=true in .env to enable order adjustments.",
      );
    }

    if (!tastyClient.isConnected) {
      return errorResult("NOT_CONNECTED", "TastyTrade connection not established.");
    }

    try {
      // Fetch the live order to get current price and legs
      const liveOrders = await tastyClient.getLiveOrders();
      const rawOrders: TastyOrderApiResponse[] = Array.isArray(liveOrders)
        ? liveOrders
        : [];

      const order = rawOrders.find(
        (o: TastyOrderApiResponse) => o.id === order_id || o["id"] === order_id,
      );

      if (!order) {
        return errorResult("ORDER_NOT_FOUND", `No live order found with ID ${order_id}`);
      }

      const currentPrice = typeof order.price === "string" ? parseFloat(order.price) : (order.price ?? 0);
      const priceEffect = (order["price-effect"] ?? "Credit") as string;
      const orderType = (order["order-type"] ?? "Limit") as string;
      const timeInForce = (order["time-in-force"] ?? "Day") as string;
      const legs = order.legs ?? [];

      let newPrice: number;

      if (adjustment === "custom") {
        if (custom_price === undefined) {
          return errorResult("MISSING_PRICE", "custom_price is required when adjustment='custom'");
        }
        newPrice = custom_price;
      } else {
        // Auto-replace logic from WorkingOrderAutoReplaceHandlerBaseModel:
        // Tick size: $0.01 for options under $3, $0.05 for options $3+
        const tickSize = currentPrice < 3 ? 0.01 : 0.05;

        if (priceEffect === "Credit") {
          // Credit order: subtract tick to make it cheaper (easier fill)
          newPrice = round(currentPrice - tickSize);
        } else {
          // Debit order: add tick to make it more expensive (easier fill)
          newPrice = round(currentPrice + tickSize);
        }

        if (newPrice <= 0) {
          return errorResult("PRICE_TOO_LOW", `Adjusted price would be ${newPrice} — cannot go below 0`);
        }
      }

      // Build replacement order (same structure as TastyWorkingOrderModel.replaceOrder)
      const replacementData = {
        "order-type": orderType,
        "time-in-force": timeInForce,
        "price": newPrice,
        "price-effect": priceEffect,
        "legs": legs.map((leg: TastyOrderLegApiResponse) => ({
          "action": leg.action ?? "",
          "instrument-type": leg["instrument-type"] ?? "Equity Option",
          "quantity": leg.quantity ?? 0,
          "symbol": leg.symbol ?? "",
        })),
      };

      const result = await tastyClient.replaceOrder(order_id, replacementData);

      const tickSize = currentPrice < 3 ? 0.01 : 0.05;
      const response: AdjustOrderResponse = {
        order_id,
        old_price: currentPrice,
        new_price: newPrice,
        tick_size: tickSize,
        price_effect: priceEffect,
        status: result?.status ?? result?.data?.status ?? "replaced",
        message: `Order ${order_id} adjusted: ${currentPrice} → ${newPrice} (${priceEffect}, tick=${tickSize})`,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(response, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      return errorResult("ADJUST_FAILED", `Failed to adjust order: ${extractErrorMessage(err)}`);
    }
  },
);

// ===========================================================================
// TOOL 7: get_working_orders
// ===========================================================================

server.tool(
  "get_working_orders",
  "Returns all current live/working orders. " +
  "Use this to see pending orders that haven't filled yet, " +
  "then use adjust_order() to improve fill prices if needed.",
  {},
  async () => {
    logger.info("[Tool] get_working_orders called");

    if (!tastyClient.isConnected) {
      return errorResult("NOT_CONNECTED", "TastyTrade connection not established.");
    }

    try {
      const orders = await tastyClient.getLiveOrders();
      const rawOrders: TastyOrderApiResponse[] = Array.isArray(orders)
        ? orders
        : [];

      const formatted = rawOrders.map((o: TastyOrderApiResponse) => ({
        order_id: o.id,
        symbol: o["underlying-symbol"] ?? "",
        status: o.status ?? "",
        price: typeof o.price === "string" ? parseFloat(o.price) : (o.price ?? 0),
        price_effect: o["price-effect"] ?? "",
        order_type: o["order-type"] ?? "",
        time_in_force: o["time-in-force"] ?? "",
        received_at: o["received-at"] ?? "",
        legs: (o.legs ?? []).map((leg: TastyOrderLegApiResponse) => ({
          action: leg.action ?? "",
          symbol: leg.symbol ?? "",
          quantity: leg.quantity ?? 0,
          instrument_type: leg["instrument-type"] ?? "",
        })),
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(formatted, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      return errorResult("ORDERS_FAILED", `Failed to fetch working orders: ${extractErrorMessage(err)}`);
    }
  },
);

// ===========================================================================
// TOOL 8: get_account_info
// ===========================================================================

server.tool(
  "get_account_info",
  "Returns account balance: cash, net liquidating value, options buying power, stock buying power. Check before trading.",
  {},
  async () => {
    logger.info("[Tool] get_account_info called");

    if (!tastyClient.isConnected) {
      return errorResult("NOT_CONNECTED", "TastyTrade connection not established.");
    }

    try {
      const balance = await tastyClient.getAccountBalance();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(balance, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      return errorResult("BALANCE_FAILED", `Failed to fetch account balance: ${extractErrorMessage(err)}`);
    }
  },
);

// ===========================================================================
// TOOL 9: get_connection_status
// ===========================================================================

server.tool(
  "get_connection_status",
  "Check if TastyTrade is connected, streamer is active, and market status (open/closed). Call first to verify server is operational.",
  {},
  async () => {
    const status = tastyClient.getStatus();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(status, null, 2),
        },
      ],
    };
  },
);

// ===========================================================================
// TOOL 10: get_watchlists
// ===========================================================================

server.tool(
  "get_watchlists",
  "Returns personal + platform watchlists. Use names as input to get_market_overview(watchlist='...'). Manage with manage_watchlist().",
  {
    include_public: z
      .boolean()
      .optional()
      .describe("Include TastyTrade platform watchlists (default: true)"),
  },
  async ({ include_public }) => {
    logger.info("[Tool] get_watchlists called", { include_public });

    if (!tastyClient.isConnected) {
      return errorResult("NOT_CONNECTED", "TastyTrade connection not established.");
    }

    try {
      const userWatchlists = await tastyClient.getUserWatchlists();

      const userFormatted = (Array.isArray(userWatchlists) ? userWatchlists : []).map((wl: TastyWatchlistApiResponse) => ({
        name: wl.name ?? wl["name"] ?? "",
        type: "personal" as const,
        symbols: (wl["watchlist-entries"] ?? wl.entries ?? []).map((e: TastyWatchlistEntryApiResponse) => e.symbol ?? ""),
      }));

      let publicFormatted: { name: string; type: string; symbol_count: number }[] = [];
      if (include_public !== false) {
        const publicWatchlists = await tastyClient.getPublicWatchlists();
        publicFormatted = (Array.isArray(publicWatchlists) ? publicWatchlists : []).map((wl: TastyWatchlistApiResponse) => ({
          name: wl.name ?? "",
          type: "platform" as const,
          symbol_count: (wl["watchlist-entries"] ?? wl.entries ?? []).length,
        }));
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              personal: userFormatted,
              platform: publicFormatted,
            }, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      return errorResult("WATCHLIST_FAILED", `Failed to fetch watchlists: ${extractErrorMessage(err)}`);
    }
  },
);

// ===========================================================================
// TOOL 11: manage_watchlist
// ===========================================================================

server.tool(
  "manage_watchlist",
  "Manage personal watchlists. Actions: create (new list), add (symbols to list), remove (symbols from list), delete (entire list).",
  {
    action: z
      .enum(["create", "add", "remove", "delete"])
      .describe("What to do with the watchlist"),
    name: z
      .string()
      .describe("Watchlist name (e.g. 'Premium Candidates', 'High IVR')"),
    symbols: z
      .array(z.string())
      .optional()
      .describe("Symbols to add/remove/create with. Not needed for 'delete'."),
  },
  async ({ action, name, symbols }) => {
    logger.info("[Tool] manage_watchlist called", { action, name, symbols });

    if (!tastyClient.isConnected) {
      return errorResult("NOT_CONNECTED", "TastyTrade connection not established.");
    }

    try {
      switch (action) {
        case "create": {
          if (!symbols || symbols.length === 0) {
            return errorResult("MISSING_SYMBOLS", "Provide at least one symbol to create a watchlist.");
          }
          const entries = symbols.map((s) => ({ symbol: s.toUpperCase() }));
          await tastyClient.createWatchlist({
            name,
            "watchlist-entries": entries,
          });
          return successResult(`Watchlist '${name}' created with ${symbols.length} symbols: ${symbols.join(", ")}`);
        }

        case "add": {
          if (!symbols || symbols.length === 0) {
            return errorResult("MISSING_SYMBOLS", "Provide symbols to add.");
          }
          // Get current watchlist, merge, replace
          const current = await tastyClient.getWatchlist(name);
          const currentEntries: TastyWatchlistEntryApiResponse[] = current?.["watchlist-entries"] ?? current?.entries ?? [];
          const currentSymbols = new Set(currentEntries.map((e: TastyWatchlistEntryApiResponse) => (e.symbol ?? "").toUpperCase()));
          const newSymbols = symbols.filter((s) => !currentSymbols.has(s.toUpperCase()));

          if (newSymbols.length === 0) {
            return successResult(`All symbols already in '${name}'. No changes made.`);
          }

          const merged = [
            ...currentEntries,
            ...newSymbols.map((s) => ({ symbol: s.toUpperCase() })),
          ];
          await tastyClient.replaceWatchlist(name, {
            name,
            "watchlist-entries": merged,
          });
          return successResult(
            `Added ${newSymbols.length} symbols to '${name}': ${newSymbols.join(", ")}. ` +
            `Total: ${merged.length} symbols.`,
          );
        }

        case "remove": {
          if (!symbols || symbols.length === 0) {
            return errorResult("MISSING_SYMBOLS", "Provide symbols to remove.");
          }
          const current = await tastyClient.getWatchlist(name);
          const currentEntries: TastyWatchlistEntryApiResponse[] = current?.["watchlist-entries"] ?? current?.entries ?? [];
          const toRemove = new Set(symbols.map((s) => s.toUpperCase()));
          const filtered = currentEntries.filter(
            (e: TastyWatchlistEntryApiResponse) => !toRemove.has((e.symbol ?? "").toUpperCase()),
          );

          await tastyClient.replaceWatchlist(name, {
            name,
            "watchlist-entries": filtered,
          });
          return successResult(
            `Removed ${currentEntries.length - filtered.length} symbols from '${name}'. ` +
            `Remaining: ${filtered.length} symbols.`,
          );
        }

        case "delete": {
          await tastyClient.deleteWatchlist(name);
          return successResult(`Watchlist '${name}' deleted.`);
        }

        default:
          return errorResult("INVALID_ACTION", `Unknown action: ${action}`);
      }
    } catch (err: unknown) {
      return errorResult("WATCHLIST_FAILED", `Failed to ${action} watchlist: ${extractErrorMessage(err)}`);
    }
  },
);

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function errorResult(code: string, message: string) {
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(makeError(code, message)),
      },
    ],
  };
}

function successResult(message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ success: true, message }),
      },
    ],
  };
}

function round(v: number, d = 2): number {
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

function _detectStrategy(legs: PositionLeg[]): string {
  const optionLegs = legs.filter((l) => l.strike !== null);
  if (optionLegs.length === 4) {
    const puts = optionLegs.filter((l) => l.option_type === "P");
    const calls = optionLegs.filter((l) => l.option_type === "C");
    if (puts.length === 2 && calls.length === 2) return "Iron Condor";
    if (puts.length === 3 || calls.length === 3) return "Butterfly";
  }
  if (optionLegs.length === 3) return "Jade Lizard / Twisted Sister";
  if (optionLegs.length === 2) {
    const puts = optionLegs.filter((l) => l.option_type === "P");
    const calls = optionLegs.filter((l) => l.option_type === "C");
    if (puts.length === 2) return "Put Credit Spread";
    if (calls.length === 2) return "Call Credit Spread";
    if (puts.length === 1 && calls.length === 1) {
      const sameStrike = optionLegs[0].strike === optionLegs[1].strike;
      return sameStrike ? "Straddle" : "Strangle";
    }
  }
  if (optionLegs.length === 1) {
    return optionLegs[0].is_sell ? "Naked Short" : "Long Option";
  }
  return "Custom";
}

function _calcMinDTE(legs: PositionLeg[]): number | null {
  const expiries = legs
    .filter((l) => l.expiry)
    .map((l) => {
      const exp = new Date(l.expiry!);
      const now = new Date();
      return Math.ceil((exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    });
  return expiries.length > 0 ? Math.min(...expiries) : null;
}

// ===========================================================================
// HTTP Transport & Express Server
// ===========================================================================

async function main() {
  logger.info("=== TastyScanner MCP Server starting ===");
  logger.info(`Port: ${PORT}`);
  logger.info(`Production: ${TASTY_PRODUCTION}`);
  logger.info(`Account: ${TASTY_ACCOUNT || "(auto-detect)"}`);

  // Connect to TastyTrade via OAuth
  if (TASTY_CLIENT_ID && TASTY_CLIENT_SECRET && TASTY_REFRESH_TOKEN) {
    logger.info("Connecting to TastyTrade (OAuth)...");
    const status = await tastyClient.connect();
    logger.info(`Connection: ${status.connected ? "OK" : "FAILED"}${status.error ? " — " + status.error : ""}`);
    if (status.connected) {
      logger.info(`  Streamer: ${status.streamer_connected ? "OK" : "NOT CONNECTED"}`);
      logger.info(`  Account: ***${(status.account_number ?? "").slice(-4)}`);
    }
  } else {
    logger.warn(
      "TASTY_CLIENT_ID / TASTY_CLIENT_SECRET / TASTY_REFRESH_TOKEN not set — running in disconnected mode. " +
      "Tools will return NOT_CONNECTED errors until OAuth credentials are provided.",
    );
  }

  // Express app with dual transport support
  const app = express();
  app.use(express.json());

  // CORS — restrict to same-origin or configured origins
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", process.env.MCP_CORS_ORIGIN ?? "http://localhost:3333");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
    if (_req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // Bearer token auth middleware (skip health check)
  const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
    if (!MCP_AUTH_TOKEN) {
      // No token configured — allow all (backwards compatible)
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or invalid Authorization header. Expected: Bearer <token>" });
      return;
    }

    const token = authHeader.slice(7);
    // Constant-time comparison to prevent timing attacks
    if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(MCP_AUTH_TOKEN))) {
      logger.warn(`[Auth] Invalid token from ${req.ip}`);
      res.status(403).json({ error: "Invalid authentication token" });
      return;
    }

    next();
  };

  // Simple rate limiter — max requests per IP per window
  const RATE_LIMIT_WINDOW_MS = 60_000;
  const RATE_LIMIT_MAX = 120;
  const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

  const rateLimitMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    let entry = rateLimitMap.get(ip);

    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
      rateLimitMap.set(ip, entry);
    }

    entry.count++;

    if (entry.count > RATE_LIMIT_MAX) {
      res.status(429).json({ error: "Rate limit exceeded. Try again later." });
      return;
    }

    next();
  };

  // Health check — no auth required
  app.get("/health", (_req, res) => {
    const status = tastyClient.getStatus();
    res.json({
      service: "tastyscanner-mcp",
      version: "1.0.0",
      auth_enabled: !!MCP_AUTH_TOKEN,
      live_trading: ENABLE_LIVE_TRADING,
      ...status,
    });
  });

  // Apply auth + rate limiting to MCP endpoints
  app.use("/mcp", authMiddleware, rateLimitMiddleware);

  // --- Streamable HTTP transport (modern MCP) ---
  // This is the preferred transport for DeerFlow

  const activeSessions = new Map<string, StreamableHTTPServerTransport>();
  const transportSessionIds = new WeakMap<StreamableHTTPServerTransport, string>();

  app.post("/mcp", async (req, res) => {
    try {
      // Check for existing session
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && activeSessions.has(sessionId)) {
        transport = activeSessions.get(sessionId)!;
      } else {
        // New session — use cryptographically random session ID
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid) => {
            activeSessions.set(sid, transport);
            transportSessionIds.set(transport, sid);
            logger.info(`[MCP] New session: ${sid}`);
          },
        });

        transport.onclose = () => {
          const sid = transportSessionIds.get(transport);
          if (sid) {
            activeSessions.delete(sid);
            logger.info(`[MCP] Session closed: ${sid}`);
          }
        };

        await server.connect(transport);
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err: unknown) {
      logger.error("[MCP] POST /mcp error:", extractErrorMessage(err));
      if (!res.headersSent) {
        res.status(500).json({ error: extractErrorMessage(err) });
      }
    }
  });

  // Handle GET for SSE stream (session-based)
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !activeSessions.has(sessionId)) {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }
    const transport = activeSessions.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  // Handle DELETE for session cleanup
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && activeSessions.has(sessionId)) {
      const transport = activeSessions.get(sessionId)!;
      await transport.handleRequest(req, res);
      activeSessions.delete(sessionId);
    } else {
      res.status(404).json({ error: "Session not found" });
    }
  });

  // Start server
  app.listen(PORT, "0.0.0.0", () => {
    logger.info(`=== TastyScanner MCP Server listening on port ${PORT} ===`);
    logger.info(`  Streamable HTTP: http://0.0.0.0:${PORT}/mcp`);
    logger.info(`  Health:          http://0.0.0.0:${PORT}/health`);
    logger.info(`  Auth:            ${MCP_AUTH_TOKEN ? "ENABLED (Bearer token)" : "DISABLED — set MCP_AUTH_TOKEN to secure"}`);
    logger.info(`  Rate limit:      ${RATE_LIMIT_MAX} req/min per IP`);
    logger.info(`  Live trading:    ${ENABLE_LIVE_TRADING ? "ENABLED ⚠️" : "DISABLED"}`);
  });
}

main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});
