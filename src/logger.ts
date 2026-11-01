/**
 * Small leveled logger with secret redaction. Output still goes through the console methods, so process
 * managers and log files behave as before; every line gains a timestamp, level, and optional scope.
 */

export const LOG_LEVEL_SETTINGS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevelSetting = (typeof LOG_LEVEL_SETTINGS)[number];
export type LogLevel = Exclude<LogLevelSetting, "silent">;

const SEVERITY: Record<LogLevelSetting, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const REDACTED = "[redacted]";
const MIN_SECRET_LENGTH = 6;

/** Receives one finished, already-redacted line. */
export type LogSink = (level: LogLevel, line: string) => void;

const consoleSink: LogSink = (level, line) => {
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
};

export interface Redactor {
    /** Registers an exact secret value to mask wherever it appears. Short values are ignored to avoid masking ordinary text. */
    add(secret: string | undefined): void;
    redact(text: string): string;
}

export function createRedactor(): Redactor {
    const secrets = new Set<string>();

    return {
        add(secret) {
            if (secret && secret.length >= MIN_SECRET_LENGTH) secrets.add(secret);
        },
        redact(text) {
            let result = text;
            // Longest first so a secret that contains another is masked completely.
            for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
                result = result.split(secret).join(REDACTED);
            }
            return result
                .replace(/\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}\b/g, REDACTED)
                .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`)
                .replace(/\b(client_secret|access_token|refresh_token|password|secret|token)=([^&\s"']+)/gi, `$1=${REDACTED}`)
                .replace(/("(?:client_secret|access_token|refresh_token|password|secret|token)"\s*:\s*")([^"]*)(")/gi, `$1${REDACTED}$3`);
        }
    };
}

function formatError(error: Error, depth = 0): string {
    const own = error.stack ?? `${error.name}: ${error.message}`;
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && depth < 3) {
        return `${own}\nCaused by: ${formatError(cause, depth + 1)}`;
    }
    return cause === undefined ? own : `${own}\nCaused by: ${String(cause)}`;
}

function formatDetail(detail: unknown): string {
    if (detail instanceof Error) return formatError(detail);
    if (typeof detail === "string") return detail;
    if (detail === undefined) return "undefined";
    try {
        return JSON.stringify(detail) ?? String(detail);
    } catch {
        return "[unserializable value]";
    }
}

export interface Logger {
    debug(message: string, ...details: unknown[]): void;
    info(message: string, ...details: unknown[]): void;
    warn(message: string, ...details: unknown[]): void;
    error(message: string, ...details: unknown[]): void;
    /** Returns a logger that tags every line with a scope such as `scheduler`. */
    child(scope: string): Logger;
}

export interface RootLogger extends Logger {
    setLevel(level: LogLevelSetting): void;
    getLevel(): LogLevelSetting;
    /** Registers a value (for example the Discord token) to be masked in all output. */
    addSecret(secret: string | undefined): void;
}

export interface LoggerOptions {
    level?: LogLevelSetting;
    sink?: LogSink;
    now?: () => Date;
    redactor?: Redactor;
}

export function createLogger(options: LoggerOptions = {}): RootLogger {
    const state = { level: options.level ?? "info" };
    const sink = options.sink ?? consoleSink;
    const now = options.now ?? (() => new Date());
    const redactor = options.redactor ?? createRedactor();

    const make = (scope?: string): Logger => {
        const write = (level: LogLevel, message: string, details: unknown[]) => {
            if (SEVERITY[level] < SEVERITY[state.level]) return;
            try {
                const parts = [message, ...details.map(formatDetail)].join(" ");
                const prefix = `${now().toISOString()} ${level.toUpperCase().padEnd(5)} ${scope ? `[${scope}] ` : ""}`;
                sink(level, redactor.redact(prefix + parts));
            } catch {
                // Logging must never take the bot down.
            }
        };

        return {
            debug: (message, ...details) => write("debug", message, details),
            info: (message, ...details) => write("info", message, details),
            warn: (message, ...details) => write("warn", message, details),
            error: (message, ...details) => write("error", message, details),
            child: (childScope) => make(scope ? `${scope}:${childScope}` : childScope)
        };
    };

    return {
        ...make(),
        setLevel: (level) => {
            state.level = level;
        },
        getLevel: () => state.level,
        addSecret: (secret) => redactor.add(secret)
    };
}

/** Shared application logger. Level and secrets are configured once at startup in `src/index.ts`. */
export const logger = createLogger();
