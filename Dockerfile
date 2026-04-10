FROM node:24-alpine

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/

# Install dev deps for build, build, then remove dev deps
RUN npm install && \
    npx tsc && \
    npm prune --omit=dev

EXPOSE 7698

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:7698/health || exit 1

CMD ["node", "dist/mcp-server.js"]
