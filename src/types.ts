// ============================================================================
// TastyScanner MCP — Type Definitions
// Mirrors the main app's interfaces for MCP consumption
// ============================================================================

// ---------------------------------------------------------------------------
// get_market_overview
// ---------------------------------------------------------------------------

export interface MarketOverviewItem {
  symbol: string;
  price: number;
  ivr: number;       // impliedVolatilityIndexRank (0-100)
  iv: number;        // impliedVolatilityIndex
  beta: number;
  earnings_date: string | null;  // ISO date string
}

export type MarketOverviewResponse = MarketOverviewItem[];

// ---------------------------------------------------------------------------
// get_strategies
// ---------------------------------------------------------------------------

export interface StrategyLeg {
  action: "BTO" | "STO";
  type: "Put" | "Call";
  strike: number;
  price: number;        // mid price
  delta: number;
  spread: number;       // bid-ask spread
}

export interface StrategySetup {
  strategy_name: string;
  expiry_date: string;    // ISO date
  dte: number;            // days to expiration
  legs: StrategyLeg[];
  credit: number;
  max_profit: number;
  max_loss: number;
  rr_ratio: number;       // risk/reward ratio (wings / credit)
  pop: number;            // probability of profit %
  theta: number;
  delta: number;
  wings: number;
  bpe: number;            // buying power effect (≈ max_loss for IC)
}

export type StrategiesResponse = StrategySetup[];

// ---------------------------------------------------------------------------
// get_positions
// ---------------------------------------------------------------------------

export interface PositionLeg {
  type: string;            // "Equity Option", etc.
  strike: number | null;
  expiry: string | null;   // ISO date
  quantity: number;
  price: number;           // trade price per leg
  option_type: "C" | "P" | null;
  is_sell: boolean;
}

export interface Position {
  position_id: string;
  symbol: string;
  strategy: string;         // detected strategy type
  legs: PositionLeg[];
  entry_credit: number;     // tradingPrice (signed)
  current_value: number;    // marketPrice (signed)
  pnl: number;
  pnl_percent: number;
  dte: number | null;
  opened_at: string;        // ISO datetime
}

export type PositionsResponse = Position[];

// ---------------------------------------------------------------------------
// execute_trade
// ---------------------------------------------------------------------------

export interface ExecuteTradeLeg {
  action: "Buy to Open" | "Sell to Open" | "Buy to Close" | "Sell to Close";
  type: "Equity Option";
  strike: number;
  expiry: string;
  quantity: number;
  symbol: string;     // OCC symbol e.g. "SPY   260120C00500000"
}

export interface ExecuteTradeParams {
  symbol: string;
  legs: ExecuteTradeLeg[];
  limit_price: number;
  price_effect: "Credit" | "Debit";
  size: number;               // defaults to 1
  time_in_force?: string;     // defaults to "Day"
  order_type?: string;        // defaults to "Limit"
}

export interface ExecuteTradeResponse {
  order_id: string;
  status: string;
  message: string;
}

// ---------------------------------------------------------------------------
// close_position
// ---------------------------------------------------------------------------

export interface ClosePositionParams {
  position_id: string;
  reason: "take_profit" | "stop_loss" | "dte_expiry" | "manual";
}

export interface ClosePositionResponse {
  order_id: string;
  status: string;
  pnl_realized: number;
  message: string;
}

// ---------------------------------------------------------------------------
// Connection / Config
// ---------------------------------------------------------------------------

export interface TastyConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accountNumber: string;
  isProduction: boolean;
}

export interface ConnectionStatus {
  connected: boolean;
  streamer_connected: boolean;
  account_number: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// adjust_order
// ---------------------------------------------------------------------------

export interface AdjustOrderParams {
  order_id: number;
  adjustment: "improve_fill" | "custom";
  custom_price?: number;
}

export interface AdjustOrderResponse {
  order_id: number;
  old_price: number;
  new_price: number;
  tick_size: number;
  price_effect: string;
  status: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Tool error wrapper
// ---------------------------------------------------------------------------

export interface ToolError {
  error: true;
  code: string;
  message: string;
}

export type ToolResult<T> = T | ToolError;

export function isToolError<T>(result: ToolResult<T>): result is ToolError {
  return (result as ToolError).error === true;
}

export function makeError(code: string, message: string): ToolError {
  return { error: true, code, message };
}
