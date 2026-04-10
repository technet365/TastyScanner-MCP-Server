# Contributing to TastyScanner MCP Server

Thank you for your interest in contributing! 🎉

## Quick Start

```bash
git clone https://github.com/technet365/TastyScanner-MCP-Server.git
cd TastyScanner-MCP-Server
npm install
cp .env.example .env
# Edit .env with your TastyTrade credentials
npm run dev
```

## Development Workflow

1. **Fork** the repository
2. **Create a branch**: `git checkout -b feature/my-feature`
3. **Make changes** and test locally
4. **Commit**: `git commit -m "feat: add my feature"`
5. **Push**: `git push origin feature/my-feature`
6. **Open a PR**

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation
- `refactor:` Code refactoring
- `test:` Adding tests
- `chore:` Maintenance

## Code Standards

- TypeScript strict mode
- Run `npm run lint` before committing
- Run `npm run build` to ensure compilation
- Test with both sandbox and production (carefully!)

## Adding New MCP Tools

1. Define the tool in `src/mcp-server.ts`
2. Add types in `src/types.ts`
3. Implement logic (possibly in `src/tasty-client.ts` or `src/strategy-builder.ts`)
4. Add example responses in `examples/tool-responses.json`
5. Update README.md

## Testing with TastyTrade

- Use **sandbox mode** (`TASTY_PRODUCTION=false`) for development
- Never commit real credentials
- Test order execution with paper trading first

## Questions?

- Open a [Discussion](https://github.com/technet365/TastyScanner-MCP-Server/discussions)
- Check existing [Issues](https://github.com/technet365/TastyScanner-MCP-Server/issues)

## Sponsors

This project is maintained in spare time. Consider [sponsoring](https://github.com/sponsors/technet365) to support development!
