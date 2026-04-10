// ============================================================================
// TastyTrade API response shapes (kebab-case JSON from REST API)
// Used in tasty-client.ts and mcp-server.ts for type-safe parsing
// ============================================================================

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface TastyAccountApiResponse {
  account: {
    "account-number": string;
  };
}

export interface TastyBalanceApiResponse {
  "cash-balance": string;
  "net-liquidating-value": string;
  "derivative-buying-power": string;
  "equity-buying-power": string;
  "maintenance-excess": string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Streamer
// ---------------------------------------------------------------------------

export interface TastyStreamerMessage {
  type?: string;
  action?: string;
  data?: Record<string, unknown>;
}

export interface TastyStreamerEvent {
  eventType?: string;
  eventSymbol?: string;
  bidPrice?: number;
  askPrice?: number;
  delta?: number;
  theta?: number;
  gamma?: number;
  vega?: number;
  rho?: number;
  volatility?: number;
  price?: number;
}

// ---------------------------------------------------------------------------
// SDK internal types (for patching generateAccessToken)
// ---------------------------------------------------------------------------

export interface TastyHttpClientInternals {
  refreshToken: string;
  clientSecret: string;
  oauthScopes: string[];
  baseUrl: string;
  accessToken: {
    updateFromTokenResponse(response: unknown): void;
  };
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export interface TastyOrderApiResponse {
  id: number;
  "account-number"?: string;
  status?: string;
  "order-type"?: string;
  "time-in-force"?: string;
  price?: string | number;
  "price-effect"?: string;
  "received-at"?: string;
  "updated-at"?: string;
  "underlying-symbol"?: string;
  source?: string;
  size?: number;
  cancellable?: boolean;
  editable?: boolean;
  legs?: TastyOrderLegApiResponse[];
  data?: { id?: number; status?: string; items?: TastyOrderApiResponse[] };
  [key: string]: unknown;
}

export interface TastyOrderLegApiResponse {
  action?: string;
  "instrument-type"?: string;
  quantity?: number;
  "remaining-quantity"?: number;
  symbol?: string;
  fills?: TastyOrderFillApiResponse[];
}

export interface TastyOrderFillApiResponse {
  "fill-price"?: string;
  "filled-at"?: string;
  quantity?: number;
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export interface TastyPositionApiResponse {
  "account-number"?: string;
  "instrument-type"?: string;
  "underlying-symbol"?: string;
  symbol?: string;
  "streamer-symbol"?: string;
  quantity?: number;
  "quantity-direction"?: string;
  "average-open-price"?: string;
  "close-price"?: string;
  "created-at"?: string;
  "updated-at"?: string;
  "expires-at"?: string;
  "expiration-date"?: string;
  "strike-price"?: string;
  "option-type"?: string;
  multiplier?: number;
  action?: string;
  id?: number | string;
  legs?: TastyPositionLegApiResponse[];
  [key: string]: unknown;
}

export interface TastyPositionLegApiResponse {
  "instrument-type"?: string;
  symbol?: string;
  quantity?: number;
  "quantity-direction"?: string;
  action?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Option Chain
// ---------------------------------------------------------------------------

export interface TastyChainApiResponse {
  expirations?: TastyExpirationApiResponse[];
  data?: { items?: TastyExpirationApiResponse[] };
}

export interface TastyExpirationApiResponse {
  "expiration-date"?: string;
  "days-to-expiration"?: number;
  "expiration-type"?: string;
  "settlement-type"?: string;
  strikes?: TastyStrikeApiResponse[];
}

export interface TastyStrikeApiResponse {
  "strike-price"?: string;
  call?: string;
  "call-streamer-symbol"?: string;
  put?: string;
  "put-streamer-symbol"?: string;
}

// ---------------------------------------------------------------------------
// Market Metrics
// ---------------------------------------------------------------------------

export interface TastyMetricsApiResponse {
  symbol?: string;
  "implied-volatility-index-rank"?: number;
  "implied-volatility-index"?: number;
  "close-price"?: string;
  beta?: number;
  earnings?: {
    "expected-report-date"?: string;
  };
  data?: { items?: TastyMetricsApiResponse[] };
  items?: TastyMetricsApiResponse[];
}

// ---------------------------------------------------------------------------
// Symbol Info
// ---------------------------------------------------------------------------

export interface TastyEquityInfoApiResponse {
  symbol?: string;
  description?: string;
  "option-tick-sizes"?: TastyTickSizeApiResponse[];
  "tick-sizes"?: TastyTickSizeApiResponse[];
}

export interface TastyTickSizeApiResponse {
  threshold?: string;
  value?: string;
}

// ---------------------------------------------------------------------------
// Watchlists
// ---------------------------------------------------------------------------

export interface TastyWatchlistApiResponse {
  name?: string;
  "watchlist-entries"?: TastyWatchlistEntryApiResponse[];
  entries?: TastyWatchlistEntryApiResponse[];
}

export interface TastyWatchlistEntryApiResponse {
  symbol?: string;
}

// ---------------------------------------------------------------------------
// Error extraction helper
// ---------------------------------------------------------------------------

export function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
  }
  return String(err);
}

export function extractHttpStatus(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null) {
    const obj = err as Record<string, unknown>;
    const response = obj.response as Record<string, unknown> | undefined;
    if (response && typeof response.status === "number") return response.status;
    if (typeof obj.status === "number") return obj.status;
  }
  return undefined;
}
