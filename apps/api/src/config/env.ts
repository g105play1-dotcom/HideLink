import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Environment configuration, validated once at boot.
 *
 * Design notes:
 *  - A single `.env` at the repository root is the source of truth for local
 *    development. Both `pnpm dev:api` (cwd `apps/api`) and the Prisma CLI load it.
 *  - Configuration is validated with Zod and exposed as a typed object rather than
 *    a `get('SOME_STRING') as T` accessor, so a typo fails at boot, not at runtime.
 *  - Invalid configuration produces a human-readable report and stops the process.
 *    A half-configured anonymous chat service is worse than one that refuses to start.
 */

/** `"true"`/`"false"` -> boolean. (`z.coerce.boolean()` would treat `"false"` as `true`.) */
const booleanString = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no', ''])
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return defaultValue;
      return value === 'true' || value === '1' || value === 'yes';
    });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // --- HTTP server -----------------------------------------------------------
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  API_HOST: z.string().min(1).default('127.0.0.1'),

  // --- Database -------------------------------------------------------------
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // --- Browser origins ------------------------------------------------------
  /**
   * Comma-separated allow-list. Used for CORS *and* for the WebSocket Origin
   * check, so both transports share one policy.
   */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),

  // --- Anonymous sessions ---------------------------------------------------
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  COOKIE_SECURE: booleanString(false),
  COOKIE_DOMAIN: z
    .string()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),

  // --- Chat rules -----------------------------------------------------------
  MESSAGE_MAX_LENGTH: z.coerce.number().int().min(1).max(4000).default(2000),
  /** How long a peer may stay disconnected before the chat is abandoned. */
  PEER_RECONNECT_GRACE_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),

  // --- Search filters -------------------------------------------------------
  /**
   * How long a filtered search waits before the first filter is dropped.
   *
   * Deliberately generous: the point of a filter is to avoid a bad match, so widening
   * too eagerly would defeat the setting rather than serve it. Zero disables relaxation
   * entirely, which is what the integration tests use to make "filters keep two
   * incompatible users apart" deterministic.
   */
  MATCH_RELAX_AFTER_MS: z.coerce.number().int().min(0).max(3_600_000).default(45_000),
  /** How much longer each further filter waits before it is dropped too. */
  MATCH_RELAX_STEP_MS: z.coerce.number().int().min(1_000).max(600_000).default(20_000),
  /**
   * Housekeeping interval. `0` turns the periodic sweep off (integration tests drive it
   * by hand); the end-to-end stack runs it fast so relaxation is observable in seconds.
   */
  MAINTENANCE_INTERVAL_MS: z.coerce.number().int().min(0).max(600_000).default(15_000),

  // --- Abuse protection -----------------------------------------------------
  RATE_LIMIT_HTTP_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_SESSION_CREATE_PER_HOUR: z.coerce.number().int().min(1).default(30),
  RATE_LIMIT_CHAT_MESSAGES_PER_10S: z.coerce.number().int().min(1).default(20),
  RATE_LIMIT_LOOKUP_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  RATE_LIMIT_CONNECT_REQUEST_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  /**
   * How many "contact the owner" messages one identity may send per day.
   *
   * Deliberately low: the form is for a handful of considered messages, not a channel, and
   * an unlimited inbox is a spam target. Keyed by identity, not by address, so people
   * behind a shared connection do not spend each other's budget.
   */
  RATE_LIMIT_OWNER_MESSAGE_PER_DAY: z.coerce.number().int().min(1).default(5),
  MAX_SOCKETS_PER_USER: z.coerce.number().int().min(1).max(50).default(4),
  MAX_PENDING_REQUESTS_PER_USER: z.coerce.number().int().min(1).max(20).default(3),

  // --- Retention ------------------------------------------------------------
  REPORT_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  SESSION_RETENTION_DAYS: z.coerce.number().int().min(1).default(7),
  SECURITY_EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  /**
   * How long a "contact the owner" message is kept before the maintenance job deletes it.
   *
   * Longer than a report on purpose: a suggestion or an advertising enquiry is not an
   * incident to investigate within days, it is correspondence, and losing it after a month
   * would make the feature useless. It is still bounded — a growing pile of user text is
   * exactly the kind of state this service refuses to keep by default.
   */
  OWNER_MESSAGE_RETENTION_DAYS: z.coerce.number().int().min(1).default(180),

  /**
   * Optional salt enabling storage of hashed client IP / User-Agent for abuse
   * investigation. Unset (the default) means AnonLink stores no client-identifying
   * data whatsoever. See docs/SECURITY.md.
   */
  ABUSE_HASH_SALT: z
    .string()
    .min(16, 'ABUSE_HASH_SALT must be at least 16 characters when set')
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),

  /** Trust the first `X-Forwarded-For` hop when running behind a reverse proxy. */
  TRUST_PROXY: booleanString(false),

  // --- Owner (admin) surface ------------------------------------------------
  /**
   * The secret that opens the owner's admin surface (`/api/v1/admin/*`), which is how
   * the archive of conversations is read and how the archive policy is set.
   *
   * Unset (the default) means the surface does not exist at all: every admin route
   * answers as if it had never been mounted. That is the safe default — archiving is
   * off anyway, so there is nothing to read — and it means an operator who never wants
   * an admin surface cannot create one by accident. Set it to a long random string
   * (at least 32 characters) before reading archives. See docs/SECURITY.md.
   */
  ADMIN_TOKEN: z
    .string()
    .min(32, 'ADMIN_TOKEN must be at least 32 characters when set')
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
});

export type AppConfig = Readonly<
  z.infer<typeof envSchema> & {
    isProduction: boolean;
    isTest: boolean;
    /** Resolved `.env` location, for diagnostics. */
    envFile: string | null;
  }
>;

/** Injection token for {@link AppConfig}. */
export const APP_CONFIG = Symbol('APP_CONFIG');

const MAX_SEARCH_DEPTH = 8;

/**
 * Locates the repository `.env`, which is the single source of local configuration.
 *
 * Searching upwards instead of hard-coding `../../.env` matters because the process
 * working directory is not dependable: `pnpm dev:api` runs from `apps/api`, a
 * production `node dist/main.js` might run from anywhere, and the module's own
 * location differs again between `src` (ts-node) and `dist` (compiled). Walking up
 * from both starting points finds the file in every one of those cases — and if it
 * is genuinely absent, the process environment is used instead, which is what a
 * container deployment does.
 */
function findEnvFile(): string | null {
  const starts = [process.cwd(), dirname(fileURLToPath(import.meta.url))];

  for (const start of starts) {
    let directory = resolve(start);
    for (let depth = 0; depth < MAX_SEARCH_DEPTH; depth += 1) {
      const candidate = join(directory, '.env');
      if (existsSync(candidate)) return candidate;

      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }

  return null;
}

/**
 * Loads and validates configuration.
 *
 * Throws a single, consolidated error listing every invalid variable, because a
 * non-technical operator benefits far more from "here are all the problems" than
 * from fixing them one restart at a time.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  // `quiet` keeps dotenv from printing promotional tips into the boot log.
  const envFile = findEnvFile();
  if (envFile) loadDotenv({ path: envFile, quiet: true });

  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => {
      const key = issue.path.join('.') || '(root)';
      return `  - ${key}: ${issue.message}`;
    });
    throw new Error(
      [
        'Invalid AnonLink configuration.',
        ...lines,
        '',
        'Fix the values in the repository-root `.env` file (start from `.env.example`).',
        'Run `pnpm diagnose` for a full environment report.',
      ].join('\n'),
    );
  }

  const value = parsed.data;

  if (value.NODE_ENV === 'production') {
    const problems: string[] = [];
    if (!value.COOKIE_SECURE) {
      problems.push('COOKIE_SECURE must be "true" in production (sessions would leak over HTTP).');
    }
    if (value.CORS_ORIGINS.some((origin) => origin.startsWith('http://'))) {
      problems.push('CORS_ORIGINS must not contain plain http:// origins in production.');
    }
    if (!value.ABUSE_HASH_SALT) {
      // Not fatal: storing no client identifiers is the privacy-preserving default.
      process.emitWarning(
        'ABUSE_HASH_SALT is not set: no hashed client identifiers will be recorded, ' +
          'which limits abuse investigation. See docs/SECURITY.md.',
      );
    }
    if (problems.length > 0) {
      throw new Error(
        ['Unsafe production configuration:', ...problems.map((p) => `  - ${p}`)].join('\n'),
      );
    }
  }

  return Object.freeze({
    ...value,
    isProduction: value.NODE_ENV === 'production',
    isTest: value.NODE_ENV === 'test',
    envFile,
  });
}
