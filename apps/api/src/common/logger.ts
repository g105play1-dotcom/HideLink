import { Logger } from '@nestjs/common';

/**
 * The single logging entry point for the API.
 *
 * Hard rules (see docs/SECURITY.md):
 *  - Message text, session tokens, cookie values, `DATABASE_URL` and any other
 *    secret must NEVER be passed to these methods.
 *  - Metadata values are restricted to primitives, so it is not possible to
 *    "accidentally" dump a whole object (and with it a message body) into a log line.
 *
 * A monkeypatched-free, dependency-free logger is deliberate: it can be used from
 * Nest components and from plain helpers such as exception filters alike.
 */

export type LogValue = string | number | boolean | null | undefined;
export type LogMeta = Readonly<Record<string, LogValue>>;

/** Keys whose values are never logged, even if a caller passes them. */
const FORBIDDEN_KEYS = new Set([
  'text',
  'message',
  'messageText',
  'token',
  'sessionToken',
  'cookie',
  'password',
  'authorization',
  'databaseUrl',
  'DATABASE_URL',
  'secret',
  'note',
  'details',
  'messageSnapshot',
  'ip',
  'userAgent',
]);

function formatMeta(meta: LogMeta | undefined): string {
  if (!meta) return '';

  const parts: string[] = [];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) continue;
    if (FORBIDDEN_KEYS.has(key)) {
      // Explicitly recorded as redacted so the intent is visible in the log.
      parts.push(`${key}=[redacted]`);
      continue;
    }
    parts.push(`${key}=${typeof value === 'string' ? value.replace(/\s+/g, ' ') : String(value)}`);
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

export class SafeLogger {
  private readonly logger = new Logger('anonlink');

  info(event: string, meta?: LogMeta): void {
    this.logger.log(`${event}${formatMeta(meta)}`);
  }

  debug(event: string, meta?: LogMeta): void {
    this.logger.debug(`${event}${formatMeta(meta)}`);
  }

  warn(event: string, meta?: LogMeta): void {
    this.logger.warn(`${event}${formatMeta(meta)}`);
  }

  /**
   * Logs an unexpected failure. The stack trace is kept, but only for the server
   * console: it is never included in a client-facing response.
   */
  error(event: string, error: unknown, meta?: LogMeta): void {
    const detail =
      error instanceof Error ? `${error.name}: ${error.message}` : `non-error:${typeof error}`;
    this.logger.error(`${event}${formatMeta(meta)} error=${detail}`);
    if (error instanceof Error && error.stack) {
      this.logger.debug(`stack ${error.stack.split('\n').slice(0, 6).join('\n')}`);
    }
  }

  /** Abuse-relevant, low-volume events. Kept distinguishable for alerting. */
  security(event: string, meta?: LogMeta): void {
    this.logger.warn(`security:${event}${formatMeta(meta)}`);
  }
}

/** Process-wide logger instance. */
export const log = new SafeLogger();
