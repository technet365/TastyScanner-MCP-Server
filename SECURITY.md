# Security Policy

## ⚠️ IMPORTANT: Trading Security

This software interacts with **real trading accounts** and **real money**. Security is critical.

## Reporting a Vulnerability

**DO NOT** create a public GitHub issue for security vulnerabilities.

Instead, please email: **security@technet365.com** (or open a private security advisory)

### What to Include
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Time
- Initial response: 48 hours
- Status update: 7 days
- Fix timeline: depends on severity

## Security Best Practices

### For Users

1. **Never commit credentials**
   - Use `.env` files (gitignored)
   - Use environment variables in production

2. **Limit API scopes**
   - Only enable scopes you need
   - Use read-only access when possible

3. **Enable `ENABLE_LIVE_TRADING=false`**
   - Keep disabled until you're ready
   - Test with paper trading first

4. **Set `MCP_AUTH_TOKEN`**
   - Always use authentication in production
   - Use strong, random tokens

5. **Network isolation**
   - Don't expose port 7698 to the internet
   - Use reverse proxy with TLS

### For Contributors

1. Never log sensitive data (full account numbers, tokens)
2. Use `crypto.randomUUID()` for session IDs
3. Validate all user inputs
4. Follow principle of least privilege

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

## Acknowledgments

We thank security researchers who responsibly disclose vulnerabilities.
