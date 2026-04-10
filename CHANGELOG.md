# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2025-04-10

### Added
- Initial release
- 11 MCP tools for TastyTrade integration:
  - `get_market_overview` - Scan symbols for IVR, IV, beta, price
  - `get_strategies` - Build Iron Condor setups with POP calculation
  - `get_positions` - List open positions with P&L
  - `execute_trade` - Place multi-leg options orders
  - `close_position` - Close existing positions
  - `adjust_order` - Adjust working order prices
  - `get_working_orders` - List pending orders
  - `get_account_info` - Account balance and buying power
  - `get_connection_status` - Check TastyTrade connection
  - `get_watchlists` - List personal and platform watchlists
  - `manage_watchlist` - Create, modify, delete watchlists
- Docker support with health checks
- OAuth authentication with auto-refresh
- Rate limiting (120 req/min)
- Configurable auth token for endpoint protection
- Live trading safety toggle (`ENABLE_LIVE_TRADING`)
