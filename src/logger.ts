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

// Patterns for sensitive data that should be redacted
const SENSITIVE_PATTERNS = [
  /("?(?:password|secret|token|api[_-]?key|refresh[_-]?token|access[_-]?token|client[_-]?secret|authorization)"?\s*[:=]\s*)"?[^"',\s}]{4,}"?/gi,
  /Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*/gi,
];

function sanitize(arg: unknown): unknown {
  if (typeof arg === "string") {
    let sanitized = arg;
    for (const pattern of SENSITIVE_PATTERNS) {
      sanitized = sanitized.replace(pattern, (match, prefix) => {
        if (prefix) return `${prefix}"[REDACTED]"`;
        return "[REDACTED]";
      });
    }
    return sanitized;
  }
  if (typeof arg === "object" && arg !== null) {
    try {
      let json = JSON.stringify(arg);
      for (const pattern of SENSITIVE_PATTERNS) {
        json = json.replace(pattern, (match, prefix) => {
          if (prefix) return `${prefix}"[REDACTED]"`;
          return "[REDACTED]";
        });
      }
      return JSON.parse(json);
    } catch {
      return arg;
    }
  }
  return arg;
}

function sanitizeArgs(args: unknown[]): unknown[] {
  return args.map(sanitize);
}

export const logger = {
  debug(...args: unknown[]) {
    if (currentLevel <= 0) console.debug(`[${timestamp()}] [DEBUG]`, ...sanitizeArgs(args));
  },
  info(...args: unknown[]) {
    if (currentLevel <= 1) console.log(`[${timestamp()}] [INFO]`, ...sanitizeArgs(args));
  },
  warn(...args: unknown[]) {
    if (currentLevel <= 2) console.warn(`[${timestamp()}] [WARN]`, ...sanitizeArgs(args));
  },
  error(...args: unknown[]) {
    if (currentLevel <= 3) console.error(`[${timestamp()}] [ERROR]`, ...sanitizeArgs(args));
  },
};
