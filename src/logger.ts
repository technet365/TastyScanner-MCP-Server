// ============================================================================
// TastyScanner MCP — Logger
// ============================================================================

const LOG_LEVEL = (process.env.LOG_LEVEL ?? "info").toLowerCase();

const LEVELS: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel = LEVELS[LOG_LEVEL] ?? 1;

function timestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  debug(...args: any[]) {
    if (currentLevel <= 0) console.debug(`[${timestamp()}] [DEBUG]`, ...args);
  },
  info(...args: any[]) {
    if (currentLevel <= 1) console.log(`[${timestamp()}] [INFO]`, ...args);
  },
  warn(...args: any[]) {
    if (currentLevel <= 2) console.warn(`[${timestamp()}] [WARN]`, ...args);
  },
  error(...args: any[]) {
    if (currentLevel <= 3) console.error(`[${timestamp()}] [ERROR]`, ...args);
  },
};
