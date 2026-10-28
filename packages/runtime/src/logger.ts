import { pino, stdSerializers, stdTimeFunctions, type DestinationStream, type Logger as Pino } from 'pino';
import { currentCorrelation, currentOrigin } from './telemetry/origin.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

/** What the app logs through: a message a person reads, and fields a machine filters on */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger whose every line also carries `bindings` (`{ module: 'publish', launch: 12 }`) */
  child(bindings: LogFields): Logger;
}

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const SECRET_KEY = /token|secret|authorization|password|passwd|cookie|api[-_]?key|private[-_]?key|credential/i;
export const REDACTED = '[redacted]';

/**
 * Masks the values of secret-looking keys, at any depth. Pino's own `redact` needs every path
 * spelled out, and a token nested in a provider's error body would slip past a fixed list. A number
 * or a boolean is never a secret, so counts like `outputTokens` stay readable.
 */
export function redactFields(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  if (Array.isArray(value)) {
    seen.add(value);
    return value.map((item) => redactFields(item, depth + 1, seen));
  }
  // Errors, dates, buffers keep their shape: their serializers know how to print them
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  seen.add(value);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) && item !== null && item !== undefined && typeof item !== 'number' && typeof item !== 'boolean' ? REDACTED : redactFields(item, depth + 1, seen);
  }
  return out;
}

/** The work's own ids and origin, which every line inside it carries */
function contextFields(): LogFields {
  const origin = currentOrigin();
  return { ...(origin.name !== 'other' && { origin: origin.name }), ...currentCorrelation() };
}

function levelOf(value: string | undefined): LogLevel | 'silent' | undefined {
  const level = value?.trim().toLowerCase();
  return level === 'silent' || LEVELS.includes(level as LogLevel) ? (level as LogLevel | 'silent') : undefined;
}

export interface LoggerOptions {
  /** `SHIPCAST_LOG_LEVEL`, then `info` */
  level?: LogLevel | 'silent';
  /** `SHIPCAST_LOG_FORMAT=pretty` for lines a person reads; JSON otherwise, which is what production ships */
  format?: 'json' | 'pretty';
  /** Fields on every line: the process name, the version */
  bindings?: LogFields;
  /** stdout when left out */
  destination?: DestinationStream;
  env?: Record<string, string | undefined>;
}

const short = (value: unknown): string => (typeof value === 'string' && !/\s/.test(value) && value !== '' ? value : JSON.stringify(value));

/** One line per entry: `10:42:07.120 INFO  published origin=job:publish launch=12` */
export function prettyLine(json: string): string {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return json;
  }
  const { time, level, msg, pid: _pid, hostname: _hostname, err, error, ...rest } = entry;
  const clock = typeof time === 'string' ? time.slice(11, 23) : '';
  const fields = Object.entries(rest).map(([key, value]) => `${key}=${short(value)}`);
  const failure = [err, error].find((e): e is { stack?: unknown; message?: unknown } => typeof e === 'object' && e !== null);
  const stack = failure ? `\n  ${String(failure.stack ?? failure.message).replace(/\n/g, '\n  ')}` : '';
  return `${[clock, String(level).toUpperCase().padEnd(5), String(msg ?? ''), ...fields].filter(Boolean).join(' ')}${stack}\n`;
}

/** Wraps a pino logger in the app's interface, with the message first as console calls had it */
class PinoLogger implements Logger {
  readonly #inner: Pino;

  constructor(inner: Pino) {
    this.#inner = inner;
  }

  debug(message: string, fields: LogFields = {}): void {
    this.#inner.debug(fields, message);
  }

  info(message: string, fields: LogFields = {}): void {
    this.#inner.info(fields, message);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.#inner.warn(fields, message);
  }

  error(message: string, fields: LogFields = {}): void {
    this.#inner.error(fields, message);
  }

  child(bindings: LogFields): Logger {
    // Pino's bindings formatter does not see a child's bindings, so they are masked here
    return new PinoLogger(this.#inner.child(redactFields(bindings) as LogFields));
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const env = options.env ?? process.env;
  const format = options.format ?? (env.SHIPCAST_LOG_FORMAT?.trim().toLowerCase() === 'pretty' ? 'pretty' : 'json');
  const out: DestinationStream = options.destination ?? { write: (line) => void process.stdout.write(line) };
  // JSON to stdout goes through pino's own buffered stream, the fast path
  const sink: DestinationStream | undefined = format === 'pretty' ? { write: (line) => out.write(prettyLine(line)) } : options.destination;
  const inner = pino(
    {
      level: options.level ?? levelOf(env.SHIPCAST_LOG_LEVEL) ?? 'info',
      base: { pid: process.pid, ...(options.bindings && (redactFields(options.bindings) as LogFields)) },
      timestamp: stdTimeFunctions.isoTime,
      formatters: {
        // A label, not pino's number: what log search and a person both read
        level: (label) => ({ level: label }),
        log: (fields) => redactFields(fields) as LogFields,
      },
      mixin: contextFields,
      serializers: { err: stdSerializers.err, error: stdSerializers.err },
    },
    ...(sink ? [sink] : []),
  );
  return new PinoLogger(inner);
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  /** Bindings, the work's ids and the call's fields, redacted as the real logger would */
  fields: LogFields;
}

/** A logger for tests: keeps every entry, shared with its children, in `entries` */
export class MemoryLogger implements Logger {
  readonly entries: LogEntry[];
  readonly #bindings: LogFields;
  readonly #level: LogLevel;

  constructor(options: { level?: LogLevel; entries?: LogEntry[]; bindings?: LogFields } = {}) {
    this.entries = options.entries ?? [];
    this.#bindings = options.bindings ?? {};
    this.#level = options.level ?? 'debug';
  }

  debug(message: string, fields?: LogFields): void {
    this.#write('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.#write('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.#write('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.#write('error', message, fields);
  }

  child(bindings: LogFields): Logger {
    return new MemoryLogger({ level: this.#level, entries: this.entries, bindings: { ...this.#bindings, ...bindings } });
  }

  /** The messages at a level, for short assertions */
  messages(level?: LogLevel): string[] {
    return this.entries.filter((e) => level === undefined || e.level === level).map((e) => e.message);
  }

  #write(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (LEVELS.indexOf(level) < LEVELS.indexOf(this.#level)) return;
    this.entries.push({ level, message, fields: redactFields({ ...this.#bindings, ...contextFields(), ...fields }) as LogFields });
  }
}

const INSTALLED = Symbol.for('shipcast.logger');
const global = globalThis as typeof globalThis & { [INSTALLED]?: Logger };

/**
 * The process's logger, built from the environment on first use. Kept on `globalThis` for the same
 * reason as telemetry: the app's server bundle and its launcher are separate module graphs.
 */
export function logger(): Logger {
  global[INSTALLED] ??= createLogger();
  return global[INSTALLED];
}

/** Replaces the process's logger: a test's memory logger, or one with the process name bound */
export function setLogger(next: Logger): void {
  global[INSTALLED] = next;
}
