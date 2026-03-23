# TastyScanner MCP Server

MCP (Model Context Protocol) server that wraps TastyTrade trading functionality
for consumption by AI agents like DeerFlow (tasty-autonomus).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Docker Network                        │
│                                                         │
│  ┌──────────────┐     ┌──────────────────┐             │
│  │ TastyScanner │     │ TastyScanner-MCP │             │
│  │   (UI app)   │     │   (port 7698)    │             │
│  │  port 3333   │     │                  │             │
│  └──────┬───────┘     └────────┬─────────┘             │
│         │                      │                        │
│         │    @tastytrade/api   │                        │
│         └──────────┬───────────┘                        │
│                    │                                    │
│         ┌──────────▼───────────┐                       │
│         │   TastyTrade API     │                       │
│         │   (WebSocket + REST) │                       │
│         └──────────────────────┘                       │
│                                                         │
│  ┌──────────────────┐                                  │
│  │ DeerFlow Agent   │──── MCP HTTP ────► port 7698    │
│  │ (tasty-autonomus)│                                  │
│  └──────────────────┘                                  │
└─────────────────────────────────────────────────────────┘
```

**Key decision:** The MCP server connects **independently** to TastyTrade using
the same `@tastytrade/api` SDK. It does NOT proxy through the UI app. Both
containers share credentials via `.env` but maintain separate connections.

Why? The UI app is a Vite/React frontend (browser-side). It has no HTTP API
to call. The MCP server is a Node.js backend service — it needs its own
TastyTrade session.

## Quick Start

### 1. Configure credentials

```bash
cp tastyscanner-mcp/.env.example .env
# Edit .env with your TastyTrade credentials
```

### 2. Build and run

```bash
# Build both containers
docker compose build

# Run
docker compose up -d

# Check health
curl http://localhost:7698/health
```

### 3. Register with DeerFlow

Add to your DeerFlow `extensions_config.json`:

```json
{
  "tastytrade": {
    "enabled": true,
    "type": "http",
    "url": "http://tastyscanner-mcp:7698/mcp",
    "description": "TastyTrade trading tools: market overview, strategies, positions, trade execution"
  }
}
```

## Available Tools

| Tool | Description |
|------|-------------|
| `get_market_overview` | Scan symbols for IVR, IV, beta, price, earnings |
| `get_strategies` | Build Iron Condor setups for a symbol |
| `get_positions` | List current open positions with P&L |
| `execute_trade` | Place an options order (⚠️ real money) |
| `close_position` | Close an existing position |
| `get_account_info` | Account balance and buying power |
| `get_connection_status` | Check TastyTrade connection health |

### Tool Details

#### `get_market_overview`
```
Params: symbols?[], min_ivr?, min_price?, max_price?
Returns: [{symbol, price, ivr, iv, beta, earnings_date}] sorted by IVR desc
```

#### `get_strategies`
```
Params: symbol, min_dte?, max_dte?, min_delta?, max_delta?, wings?[], max_results?
Returns: [{strategy_name, expiry_date, dte, legs[], credit, max_profit, max_loss, rr_ratio, pop, theta, delta, wings, bpe}]
```

#### `get_positions`
```
Params: (none)
Returns: [{position_id, symbol, strategy, legs[], entry_credit, current_value, pnl, pnl_percent, dte, opened_at}]
```

#### `execute_trade`
```
Params: symbol, legs[{action, symbol, quantity}], limit_price, price_effect, time_in_force?, order_type?
Returns: {order_id, status, message}
⚠️ This places REAL orders with REAL money.
```

#### `close_position`
```
Params: position_id, reason, limit_price?
Returns: {order_id, status, pnl_realized, message}
```

## Development

### Run locally (without Docker)

```bash
cd tastyscanner-mcp
npm install

# Set env vars
export TASTY_USERNAME=your_email
export TASTY_PASSWORD=your_password
export TASTY_ACCOUNT=5WT12345  # optional

# Run with hot-reload
npm run dev

# Or build and run
npm run build
npm start
```

### Test with curl

```bash
# Initialize MCP session
curl -X POST http://localhost:7698/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": {"name": "test", "version": "1.0.0"}
    }
  }'

# Call a tool (use session-id from init response)
curl -X POST http://localhost:7698/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: <session-id>" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "get_connection_status",
      "arguments": {}
    }
  }'
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TASTY_USERNAME` | Yes | — | TastyTrade login email |
| `TASTY_PASSWORD` | Yes | — | TastyTrade password |
| `TASTY_ACCOUNT` | No | auto | Account number (auto-detects first) |
| `TASTY_PRODUCTION` | No | `true` | `true` = production, `false` = sandbox |
| `MCP_PORT` | No | `7698` | HTTP server port |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |

## How It Relates to TastyScanner

This MCP server replicates key logic from the main TastyScanner app:

| Main App File | MCP Equivalent | What it does |
|--------------|----------------|--------------|
| `services/brokers/tasty/tasty.broker.ts` | `src/tasty-client.ts` | TastyTrade connection, auth, WebSocket |
| `services/market-overview/market-overview.service.ts` | `get_market_overview` tool | Symbol metrics scanning |
| `models/strategies-builder.ts` | `src/strategy-builder.ts` | Iron Condor/spread construction |
| `models/iron-condor.model.ts` | `src/strategy-builder.ts` | IC credit, POP, R:R calculation |
| `services/brokers/tasty/tasty-account.model.ts` | `get_positions` + `execute_trade` | Order management |
| `services/brokers/interfaces/` | `src/types.ts` | Type definitions |

The strategy building logic (delta filtering, wing construction, credit spread
pairing, POP calculation) is faithfully replicated from the MobX models into
plain TypeScript functions suitable for server-side use.

## Security Notes

- MCP server runs on internal Docker network only — **do not expose port 7698 to the internet**
- Credentials are passed via environment variables, never hardcoded
- The `execute_trade` tool places real orders — DeerFlow should implement confirmation gates
- No authentication on the MCP endpoint itself (relies on network isolation)
