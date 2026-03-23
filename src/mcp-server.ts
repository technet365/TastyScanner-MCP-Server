// ============================================================================
// TastyScanner MCP Server
// HTTP transport (Streamable HTTP) for DeerFlow AI agent
// ============================================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
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
  "Scans symbols and returns key metrics for premium-selling analysis. " +
  "Each symbol includes: current price, IVR (Implied Volatility Rank 0-100 — how high current IV is vs 52-week range), " +
  "IV (Implied Volatility Index — actual IV percentage), beta (correlation to SPY), " +
  "and next earnings date. Results sorted by IVR descending — high IVR (>30) = best for selling premium.\n\n" +
  "SYMBOL SOURCES (use one):\n" +
  "• watchlist — name of a personal TastyTrade watchlist (use get_watchlists to see available ones)\n" +
  "• public_watchlist — name of a TastyTrade platform watchlist (e.g. 'High Options Volume')\n" +
  "• symbols — explicit list of tickers\n" +
  "• (none) — falls back to built-in default list (~40 popular symbols)\n\n" +
  "WORKFLOW: Use get_watchlists() first to see your lists, then scan with watchlist='My Candidates'.",
  {
    watchlist: z
      .string()
      .optional()
      .describe("Name of a personal TastyTrade watchlist to scan (from get_watchlists)."),
    public_watchlist: z
      .string()
      .optional()
      .describe("Name of a TastyTrade platform watchlist to scan (e.g. 'High Options Volume')."),
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
  async ({ watchlist, public_watchlist, symbols, min_ivr, min_price, max_price, hide_earnings_within_days }) => {
    logger.info("[Tool] get_market_overview called", { watchlist, public_watchlist, symbols, min_ivr });

    if (!tastyClient.isConnected) {
      return errorResult("NOT_CONNECTED", "TastyTrade connection not established.");
    }

    try {
      // Resolve symbols from source
      let targetSymbols: string[];

      if (symbols && symbols.length > 0) {
        targetSymbols = symbols;
      } else if (watchlist) {
        const wl = await tastyClient.getWatchlist(watchlist);
        const entries = wl?.["watchlist-entries"] ?? wl?.entries ?? [];
        targetSymbols = entries.map((e: any) => e.symbol ?? e).filter(Boolean);
        if (targetSymbols.length === 0) {
          return errorResult("EMPTY_WATCHLIST", `Watchlist '${watchlist}' is empty or not found.`);
        }
        logger.info(`[Tool] Scanning watchlist '${watchlist}': ${targetSymbols.length} symbols`);
      } else if (public_watchlist) {
        const wl = await tastyClient.getWatchlist(public_watchlist);
        const entries = wl?.["watchlist-entries"] ?? wl?.entries ?? [];
        targetSymbols = entries.map((e: any) => e.symbol ?? e).filter(Boolean);
        if (targetSymbols.length === 0) {
          return errorResult("EMPTY_WATCHLIST", `Public watchlist '${public_watchlist}' is empty or not found.`);
        }
        logger.info(`[Tool] Scanning public watchlist '${public_watchlist}': ${targetSymbols.length} symbols`);
      } else {
        targetSymbols = DEFAULT_SYMBOLS;
      }

      const metrics = await tastyClient.getBulkSymbolMetrics(targetSymbols);

      let results: MarketOverviewItem[] = metrics.map((m) => ({
        symbol: m.symbol,
        price: round(m["close-price"] ?? 0),
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
              source: watchlist ? `watchlist:${watchlist}` : public_watchlist ? `public:${public_watchlist}` : symbols ? "custom" : "default",
              count: results.length,
              items: results,
            }, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return errorResult("FETCH_FAILED", `Failed to fetch market data: ${err.message}`);
    }
  },
);

// ===========================================================================
// TOOL 2: get_strategies
// ===========================================================================

server.tool(
  "get_strategies",
  "Scans the options chain for a symbol and builds trading strategy setups. " +
  "Supports 12 strategy types across credit and debit families:\n\n" +
  "CREDIT STRATEGIES (sell premium, positive theta, profit from time decay):\n" +
  "• iron_condor — 4 legs: put spread + call spread at different strikes. Neutral outlook, defined risk.\n" +
  "• put_credit_spread — 2 legs: STO put + BTO put below. Bullish, profits if stock stays above short strike.\n" +
  "• call_credit_spread — 2 legs: STO call + BTO call above. Bearish, profits if stock stays below short strike.\n" +
  "• iron_butterfly — 4 legs: like iron condor but short strikes at same ATM price. Higher credit, tighter range.\n" +
  "• jade_lizard — 3 legs: naked STO put + call credit spread. Zero upside risk when credit ≥ wings.\n" +
  "• twisted_sister — 3 legs: naked STO call + put credit spread. Zero downside risk when credit ≥ wings.\n\n" +
  "DEBIT STRATEGIES (buy premium, negative theta, profit from large moves or direction):\n" +
  "• long_straddle — 2 legs: BTO put + BTO call at same strike. Profits from big move in either direction.\n" +
  "• long_strangle — 2 legs: BTO put + BTO call at different OTM strikes. Cheaper than straddle, needs bigger move.\n" +
  "• bull_call_spread — 2 legs: BTO call + STO call above. Bullish directional, defined risk.\n" +
  "• bear_put_spread — 2 legs: BTO put + STO put below. Bearish directional, defined risk.\n" +
  "• call_butterfly — 3 legs: BTO lower + 2×STO mid + BTO upper (calls). Profits if stock pins near short strike.\n" +
  "• put_butterfly — 3 legs: BTO lower + 2×STO mid + BTO upper (puts). Profits if stock pins near short strike.\n\n" +
  "Results sorted by risk/reward ratio (lower = better). " +
  "Use strategy_type='all' to scan everything, or pick a specific type.",
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
    wings: z.array(z.number()).optional().describe("Wing widths to test in dollars (default: [1,2,3,5,10])"),
    max_results: z.number().optional().describe("Limit number of results returned (default: 20)"),
  },
  async ({ symbol, strategy_type, min_dte, max_dte, min_delta, max_delta, debit_min_delta, debit_max_delta, wings, max_results }) => {
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

      const strategies = await builder.buildStrategies(symbol.toUpperCase(), stype);
      const limited = strategies.slice(0, max_results ?? 20);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(limited, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return errorResult("STRATEGY_BUILD_FAILED", `Failed to build strategies for ${symbol}: ${err.message}`);
    }
  },
);

// ===========================================================================
// TOOL 3: get_positions
// ===========================================================================

server.tool(
  "get_positions",
  "Returns all current open positions from the TastyTrade account. " +
  "Each position includes: underlying symbol, detected strategy type (Iron Condor, Put Credit Spread, etc.), " +
  "individual legs with strikes/expiries/quantities, entry credit or debit, current market value, " +
  "unrealized P&L in dollars and percentage, days to expiration, and open timestamp. " +
  "Strategy detection is automatic based on leg structure. " +
  "Use this before close_position() to see what needs managing.",
  {},
  async () => {
    logger.info("[Tool] get_positions called");

    if (!tastyClient.isConnected) {
      return errorResult("NOT_CONNECTED", "TastyTrade connection not established.");
    }

    try {
      const rawPositions = await tastyClient.getActivePositions();

      const positions: Position[] = rawPositions.map((pos: any) => {
        const legs: PositionLeg[] = (pos.legs ?? [pos]).map((leg: any) => ({
          type: leg["instrument-type"] ?? leg.instrumentType ?? "Equity Option",
          strike: leg["strike-price"] ?? leg.strikePrice ?? null,
          expiry: leg["expiration-date"] ?? leg.expirationDate ?? null,
          quantity: leg.quantity ?? 0,
          price: leg["average-open-price"] ?? leg.averageOpenPrice ?? 0,
          option_type: leg["option-type"] ?? leg.optionType ?? null,
          is_sell: (leg.quantity ?? 0) < 0,
        }));

        const symbol = pos["underlying-symbol"] ?? pos.underlyingSymbol ?? pos.symbol ?? "";
        const marketPrice = pos["close-price"] ?? pos.closePrice ?? 0;
        const tradingPrice = pos["average-open-price"] ?? pos.averageOpenPrice ?? 0;
        const quantity = pos.quantity ?? 0;
        const pnl = round((marketPrice - tradingPrice) * quantity * 100);
        const pnlPercent = tradingPrice !== 0
          ? round((pnl / Math.abs(tradingPrice * quantity * 100)) * 100)
          : 0;

        return {
          position_id: String(pos.id ?? pos["id"] ?? ""),
          symbol,
          strategy: _detectStrategy(legs),
          legs,
          entry_credit: round(tradingPrice),
          current_value: round(marketPrice),
          pnl,
          pnl_percent: pnlPercent,
          dte: _calcMinDTE(legs),
          opened_at: pos["created-at"] ?? pos.createdAt ?? new Date().toISOString(),
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
    } catch (err: any) {
      return errorResult("POSITIONS_FAILED", `Failed to fetch positions: ${err.message}`);
    }
  },
);

// ===========================================================================
// TOOL 4: execute_trade
// ===========================================================================

server.tool(
  "execute_trade",
  "Places an options order on TastyTrade. ⚠️ EXECUTES REAL TRADES WITH REAL MONEY. " +
  "Requires ENABLE_LIVE_TRADING=true in environment. " +
  "Accepts multi-leg orders (spreads, condors, butterflies). Each leg needs an OCC option symbol " +
  "(e.g. 'SPY   260417P00560000'), action (Buy/Sell to Open/Close), and quantity. " +
  "Always use order_type='Limit' with a specific limit_price — never market orders on options. " +
  "After placing, use get_working_orders() to monitor fill status and adjust_order() if not filling.",
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
    } catch (err: any) {
      return errorResult("ORDER_FAILED", `Failed to place order: ${err.message}`);
    }
  },
);

// ===========================================================================
// TOOL 5: close_position (safe — guidance only, no auto-execution)
// ===========================================================================

server.tool(
  "close_position",
  "Provides instructions to close an existing position safely. " +
  "Does NOT auto-execute — returns the inverse legs and recommended limit price. " +
  "The AI agent should review the output, then call execute_trade() with the inverse legs. " +
  "This two-step approach prevents accidental closures.",
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
    } catch (err: any) {
      return errorResult("CLOSE_FAILED", `Failed to analyze position: ${err.message}`);
    }
  },
);

// ===========================================================================
// TOOL 6: adjust_order (auto-replace — tick-size price improvement)
// ===========================================================================

server.tool(
  "adjust_order",
  "Adjusts a working order's price to improve fill probability. " +
  "Uses the same auto-replace logic as TastyScanner UI: " +
  "credit orders get cheaper by one tick, debit orders get more expensive by one tick. " +
  "Tick size depends on the option price: $0.01 for prices < $3, $0.05 for prices ≥ $3. " +
  "Max adjustments: 4 (for $0.01 tick), 2 (for $0.02 tick), 1 (for $0.05 tick).",
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
      const rawOrders = Array.isArray(liveOrders)
        ? liveOrders
        : (liveOrders as any)?.data?.items ?? [];

      const order = rawOrders.find(
        (o: any) => o.id === order_id || o["id"] === order_id,
      );

      if (!order) {
        return errorResult("ORDER_NOT_FOUND", `No live order found with ID ${order_id}`);
      }

      const currentPrice = order.price ?? order["price"] ?? 0;
      const priceEffect = order["price-effect"] ?? order.priceEffect ?? "Credit";
      const orderType = order["order-type"] ?? order.orderType ?? "Limit";
      const timeInForce = order["time-in-force"] ?? order.timeInForce ?? "Day";
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
        "legs": legs.map((leg: any) => ({
          "action": leg.action ?? leg["action"],
          "instrument-type": leg["instrument-type"] ?? leg.instrumentType ?? "Equity Option",
          "quantity": leg.quantity ?? leg["quantity"],
          "symbol": leg.symbol ?? leg["symbol"],
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
    } catch (err: any) {
      return errorResult("ADJUST_FAILED", `Failed to adjust order: ${err.message}`);
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
      const rawOrders = Array.isArray(orders)
        ? orders
        : (orders as any)?.data?.items ?? [];

      const formatted = rawOrders.map((o: any) => ({
        order_id: o.id ?? o["id"],
        symbol: o["underlying-symbol"] ?? o.underlyingSymbol ?? "",
        status: o.status ?? "",
        price: o.price ?? o["price"] ?? 0,
        price_effect: o["price-effect"] ?? o.priceEffect ?? "",
        order_type: o["order-type"] ?? o.orderType ?? "",
        time_in_force: o["time-in-force"] ?? o.timeInForce ?? "",
        received_at: o["received-at"] ?? o.receivedAt ?? "",
        legs: (o.legs ?? []).map((leg: any) => ({
          action: leg.action ?? leg["action"],
          symbol: leg.symbol ?? leg["symbol"],
          quantity: leg.quantity ?? leg["quantity"],
          instrument_type: leg["instrument-type"] ?? leg.instrumentType ?? "",
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
    } catch (err: any) {
      return errorResult("ORDERS_FAILED", `Failed to fetch working orders: ${err.message}`);
    }
  },
);

// ===========================================================================
// TOOL 8: get_account_info
// ===========================================================================

server.tool(
  "get_account_info",
  "Returns TastyTrade account balance and buying power details: " +
  "cash balance, net liquidating value, derivative (options) buying power, " +
  "stock buying power, maintenance requirement, and pending cash. " +
  "Use this to check available capital before placing trades with execute_trade().",
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
    } catch (err: any) {
      return errorResult("BALANCE_FAILED", `Failed to fetch account balance: ${err.message}`);
    }
  },
);

// ===========================================================================
// TOOL 9: get_connection_status
// ===========================================================================

server.tool(
  "get_connection_status",
  "Returns TastyTrade connection health: whether authenticated, " +
  "whether the DxLink quote streamer is active (needed for real-time data in get_strategies), " +
  "and the connected account number. Call this first to verify the MCP server is operational " +
  "before using any other tools.",
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
  "Returns all available watchlists — both your personal TastyTrade watchlists " +
  "and TastyTrade's platform watchlists (High Options Volume, High IVR, etc.). " +
  "Personal watchlists can be managed with manage_watchlist(). " +
  "Use the watchlist names as input to get_market_overview(watchlist='...') to scan them.\n\n" +
  "WORKFLOW:\n" +
  "1. get_watchlists() → see what's available\n" +
  "2. get_market_overview(watchlist='My Candidates') → scan a specific watchlist\n" +
  "3. manage_watchlist(action='add', ...) → add promising symbols to your list",
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

      const userFormatted = (Array.isArray(userWatchlists) ? userWatchlists : []).map((wl: any) => ({
        name: wl.name ?? wl["name"] ?? "",
        type: "personal" as const,
        symbols: (wl["watchlist-entries"] ?? wl.entries ?? []).map((e: any) => e.symbol ?? e),
      }));

      let publicFormatted: any[] = [];
      if (include_public !== false) {
        const publicWatchlists = await tastyClient.getPublicWatchlists();
        publicFormatted = (Array.isArray(publicWatchlists) ? publicWatchlists : []).map((wl: any) => ({
          name: wl.name ?? wl["name"] ?? "",
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
    } catch (err: any) {
      return errorResult("WATCHLIST_FAILED", `Failed to fetch watchlists: ${err.message}`);
    }
  },
);

// ===========================================================================
// TOOL 11: manage_watchlist
// ===========================================================================

server.tool(
  "manage_watchlist",
  "Manages your personal TastyTrade watchlists. Actions:\n\n" +
  "• create — Create a new watchlist with given symbols. Use this to build a curated list of candidates.\n" +
  "• add — Add symbols to an existing watchlist. Use after scanning market to save good candidates.\n" +
  "• remove — Remove symbols from a watchlist. Use to clean out positions you've closed or symbols with poor metrics.\n" +
  "• delete — Delete an entire watchlist.\n\n" +
  "WORKFLOW: After scanning with get_market_overview(), add high-IVR symbols to your watchlist. " +
  "Periodically clean out symbols that no longer meet criteria. " +
  "Then use get_strategies(symbol) on each watchlist member to find trades.",
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
          const currentEntries: any[] = current?.["watchlist-entries"] ?? current?.entries ?? [];
          const currentSymbols = new Set(currentEntries.map((e: any) => (e.symbol ?? e).toUpperCase()));
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
          const currentEntries: any[] = current?.["watchlist-entries"] ?? current?.entries ?? [];
          const toRemove = new Set(symbols.map((s) => s.toUpperCase()));
          const filtered = currentEntries.filter(
            (e: any) => !toRemove.has((e.symbol ?? e).toUpperCase()),
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
    } catch (err: any) {
      return errorResult("WATCHLIST_FAILED", `Failed to ${action} watchlist: ${err.message}`);
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
    logger.info("Connection status:", status);
  } else {
    logger.warn(
      "TASTY_CLIENT_ID / TASTY_CLIENT_SECRET / TASTY_REFRESH_TOKEN not set — running in disconnected mode. " +
      "Tools will return NOT_CONNECTED errors until OAuth credentials are provided.",
    );
  }

  // Express app with dual transport support
  const app = express();
  app.use(express.json());

  // Health check
  app.get("/health", (_req, res) => {
    const status = tastyClient.getStatus();
    res.json({
      service: "tastyscanner-mcp",
      version: "1.0.0",
      ...status,
    });
  });

  // --- Streamable HTTP transport (modern MCP) ---
  // This is the preferred transport for DeerFlow

  const activeSessions = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp", async (req, res) => {
    try {
      // Check for existing session
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && activeSessions.has(sessionId)) {
        transport = activeSessions.get(sessionId)!;
      } else {
        // New session
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => `tasty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          onsessioninitialized: (sid) => {
            activeSessions.set(sid, transport);
            logger.info(`[MCP] New session: ${sid}`);
          },
        });

        transport.onclose = () => {
          const sid = (transport as any).sessionId;
          if (sid) {
            activeSessions.delete(sid);
            logger.info(`[MCP] Session closed: ${sid}`);
          }
        };

        await server.connect(transport);
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err: any) {
      logger.error("[MCP] POST /mcp error:", err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
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
    logger.info(`  Live trading:    ${ENABLE_LIVE_TRADING ? "ENABLED" : "DISABLED"}`);
  });
}

main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});
