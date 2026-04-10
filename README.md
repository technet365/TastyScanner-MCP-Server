<div align="center">

# 🎯 TastyScanner MCP Server

**Let Claude trade options for you on TastyTrade**

[![CI](https://github.com/technet365/TastyScanner-MCP-Server/actions/workflows/ci.yml/badge.svg)](https://github.com/technet365/TastyScanner-MCP-Server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-2025--03--26-green.svg)](https://modelcontextprotocol.io/)
[![Discord](https://img.shields.io/discord/1234567890?color=7289da&label=Discord&logo=discord&logoColor=white)](https://discord.gg/739SVUQBrE)

[Features](#-features) • [Quick Start](#-quick-start) • [Documentation](#available-tools) • [Discord](https://discord.gg/739SVUQBrE) • [Sponsor](#-support-the-project)

</div>

---

## 🤖 What is this?

TastyScanner MCP Server connects **Claude, GPT, or any AI agent** to your **TastyTrade** account via the [Model Context Protocol](https://modelcontextprotocol.io/). 

Ask your AI assistant to:
- *"Scan the market for high IVR stocks"*
- *"Build an Iron Condor on SPY with 30-45 DTE"*
- *"Show my positions and P&L"*
- *"Close my AAPL position at 50% profit"*

<!-- 
TODO: Add demo GIF here
![Demo](docs/demo.gif)
-->

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔍 **Market Scanner** | Scan symbols for IVR, IV, beta, price, earnings dates |
| 🏗️ **Strategy Builder** | Auto-construct Iron Condors with POP, R:R, Greeks |
| 📊 **Position Tracking** | Real-time P&L, Greeks, days to expiration |
| ⚡ **Trade Execution** | Place and close multi-leg options orders |
| 🔒 **Safety First** | Live trading disabled by default, sandbox support |
| 🐳 **Docker Ready** | One-command deployment |

---

## 🎯 Why TastyScanner?

| | TastyScanner | Other MCP Servers |
|--|:------------:|:-----------------:|
| **Strategy Builder** (Iron Condor auto-construction) | ✅ | ❌ |
| **POP Calculation** (Probability of Profit) | ✅ | ❌ |
| **TypeScript** (Node.js ecosystem) | ✅ | Python only |
| **Docker-first** | ✅ | Manual setup |
| **Watchlist Management** | ✅ | ❌ |

---

## 🚀 Quick Start

### Option 1: Docker (Recommended)

```bash
# Clone
git clone https://github.com/technet365/TastyScanner-MCP-Server.git
cd TastyScanner-MCP-Server

# Configure
cp .env.example .env
# Edit .env with your TastyTrade OAuth credentials

# Run
docker compose up -d

# Verify
curl http://localhost:7698/health
```

### Option 2: Node.js

```bash
npm install
cp .env.example .env
npm run build
npm start
```

### Connect to Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tastytrade": {
      "url": "http://localhost:7698/mcp"
    }
  }
}
```

---

## Architecture

```
┌────────────────────┐         ┌─────────────────────┐
│  Claude / GPT /    │         │  TastyScanner-MCP   │
│  Any AI Agent      │── MCP ──│    (port 7698)      │
└────────────────────┘  HTTP   └──────────┬──────────┘
                                          │
                                @tastytrade/api
                                          │
                               ┌──────────▼──────────┐
                               │   TastyTrade API    │
                               │ (WebSocket + REST)  │
                               └─────────────────────┘
```

The MCP server connects to TastyTrade using the official `@tastytrade/api` SDK
with OAuth authentication (client credentials + refresh token).

## Quick Start

### 1. Configure credentials

```bash
cp .env.example .env
# Edit .env with your TastyTrade OAuth credentials
```

### 2. Build and run

```bash
docker compose build
docker compose up -d
curl http://localhost:7698/health
```

### 3. Connect to Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tastytrade": {
      "url": "http://localhost:7698/mcp"
    }
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
| `adjust_order` | Adjust working order price for better fill |
| `get_working_orders` | List pending/unfilled orders |
| `get_account_info` | Account balance and buying power |
| `get_connection_status` | Check TastyTrade connection health |
| `get_watchlists` | List personal and platform watchlists |
| `manage_watchlist` | Create, add to, remove from, or delete watchlists |

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

#### `adjust_order`
```
Params: order_id, adjustment ('improve_fill' | 'custom'), custom_price?
Returns: {order_id, old_price, new_price, status, message}
⚠️ Requires ENABLE_LIVE_TRADING=true
```

#### `get_working_orders`
```
Params: (none)
Returns: [{order_id, symbol, status, price, price_effect, legs[]}]
```

#### `get_watchlists`
```
Params: include_public? (default: true)
Returns: {personal: [{name, symbols[]}], platform: [{name, symbol_count}]}
```

#### `manage_watchlist`
```
Params: action ('create' | 'add' | 'remove' | 'delete'), name, symbols?[]
Returns: {success, message}
```

## Development

### Run locally (without Docker)

```bash
cd tastyscanner-mcp
npm install

# Copy env template and fill in credentials
cp .env.example .env
# Edit .env with your OAuth credentials

# Run with hot-reload
npm run dev

# Or build and run
npm run build
npm start
```

### Test with curl

```bash
# Initialize MCP session (add -H "Authorization: Bearer <token>" if MCP_AUTH_TOKEN is set)
curl -X POST http://localhost:7698/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-auth-token" \
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
  -H "Authorization: Bearer your-auth-token" \
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
| `TASTY_CLIENT_ID` | Yes | — | TastyTrade OAuth Client ID |
| `TASTY_CLIENT_SECRET` | Yes | — | TastyTrade OAuth Client Secret |
| `TASTY_REFRESH_TOKEN` | Yes | — | TastyTrade OAuth Refresh Token |
| `TASTY_ACCOUNT` | No | auto | Account number (auto-detects first) |
| `TASTY_PRODUCTION` | No | `true` | `true` = production, `false` = sandbox |
| `MCP_PORT` | No | `7698` | HTTP server port |
| `MCP_AUTH_TOKEN` | No | — | Bearer token for endpoint auth. If set, all `/mcp` requests require `Authorization: Bearer <token>` |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |
| `ENABLE_LIVE_TRADING` | No | `false` | Set `true` to allow `execute_trade` and `adjust_order` |

## Security Notes

- **Authentication**: Set `MCP_AUTH_TOKEN` in `.env` to require Bearer token auth on all `/mcp` endpoints. Without it, the server is open (backwards compatible but not recommended for production).
- **Rate limiting**: 120 requests/minute per IP on MCP endpoints.
- **CORS**: Restricted to `MCP_CORS_ORIGIN` (default `http://localhost:3333`).
- Credentials are passed via environment variables, never hardcoded.
- `execute_trade` and `adjust_order` require `ENABLE_LIVE_TRADING=true` — disabled by default.
- Session IDs use `crypto.randomUUID()` (cryptographically secure).
- Account numbers are masked in logs (last 4 digits only).
- **Do not expose port 7698 to the internet** without auth enabled.

---

## 💖 Support the Project

If TastyScanner MCP Server saves you time or helps you trade better, consider supporting its development:

<a href="https://github.com/sponsors/technet365">
  <img src="https://img.shields.io/badge/Sponsor-❤️-red?style=for-the-badge&logo=github" alt="Sponsor on GitHub">
</a>
<a href="https://discord.gg/739SVUQBrE">
  <img src="https://img.shields.io/badge/Discord-Join-7289da?style=for-the-badge&logo=discord&logoColor=white" alt="Join Discord">
</a>

### Sponsor Benefits

| Tier | Benefits |
|------|----------|
| ☕ **$5/mo** | Support development, name in README |
| 🥈 **$15/mo** | Early access to new features, priority support |
| 🥇 **$50/mo** | Direct input on roadmap, 1:1 onboarding call |

---

## 📜 License

[MIT](LICENSE) © 2024-2025 [technet365](https://github.com/technet365)

---

<div align="center">

**[⬆ Back to top](#-tastyscanner-mcp-server)**

Made with ❤️ for the TastyTrade community

</div>
