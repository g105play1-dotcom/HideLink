import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { config as loadDotenv } from 'dotenv';

/**
 * One source of truth for the test environment.
 *
 * Imported by three very different callers — `vitest.config.ts`, the global setup and
 * the test helpers — so the port, the database and every limit are defined once. When
 * these were spread across files, a change to one of them silently stopped applying to
 * the others.
 */

const MAX_SEARCH_DEPTH = 8;

/**
 * Locates the repository `.env`.
 *
 * The same upward walk as `src/config/env.ts` and `next.config.ts`: the working
 * directory depends on which tool started the process, so it cannot be hard-coded.
 */
function findEnvFile(): string | null {
  let directory = resolve(process.cwd());

  for (let depth = 0; depth < MAX_SEARCH_DEPTH; depth += 1) {
    const candidate = join(directory, '.env');
    if (existsSync(candidate)) return candidate;

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return null;
}

/** A dedicated port, so a running dev server is never disturbed (or disturbed by). */
export const TEST_API_PORT = 3101;
export const TEST_API_HOST = '127.0.0.1';
export const TEST_API_URL = `http://${TEST_API_HOST}:${TEST_API_PORT}`;
export const TEST_API_PREFIX = '/api/v1';
export const TEST_API_BASE = `${TEST_API_URL}${TEST_API_PREFIX}`;

/**
 * The development database URL with `_test` appended to the database name.
 *
 * Derived rather than hard-coded so there is still exactly one place that says where
 * PostgreSQL lives. The suite runs migrations and writes rows, so it must never point
 * at the development database by accident.
 */
export function resolveTestDatabaseUrl(): string {
  const envFile = findEnvFile();
  if (envFile) loadDotenv({ path: envFile, quiet: true });

  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env in the repository root before running the tests.',
    );
  }

  const url = new URL(base);
  const name = url.pathname.replace(/^\//, '');
  url.pathname = `/${name}_test`;
  return url.toString();
}

/**
 * Environment for the spawned API.
 *
 * The limits are deliberately different from development:
 *  - `MESSAGE_MAX_LENGTH` is small, so a boundary test costs nothing;
 *  - `PEER_RECONNECT_GRACE_MS` is short, so the disconnect tests finish quickly;
 *  - the request budgets are huge, because the limiter is exercised by unit tests and a
 *    shared per-address bucket would otherwise make unrelated tests fail intermittently.
 */
export const TEST_ENV: Readonly<Record<string, string>> = Object.freeze({
  NODE_ENV: 'test',
  API_HOST: TEST_API_HOST,
  API_PORT: String(TEST_API_PORT),
  CORS_ORIGINS: 'http://localhost:3000',
  COOKIE_SECURE: 'false',
  SESSION_TTL_DAYS: '30',

  MESSAGE_MAX_LENGTH: '200',
  PEER_RECONNECT_GRACE_MS: '1500',

  // Relaxation is off for the whole integration suite, and the periodic sweep with it.
  // Widening a search is a *behaviour*, and the suite has to be able to say "these two
  // filters keep two users apart" without a background job quietly proving otherwise a
  // second later. The end-to-end stack turns both on with short timings instead.
  MATCH_RELAX_AFTER_MS: '0',
  MAINTENANCE_INTERVAL_MS: '0',

  RATE_LIMIT_HTTP_PER_MINUTE: '20000',
  RATE_LIMIT_SESSION_CREATE_PER_HOUR: '5000',
  RATE_LIMIT_CHAT_MESSAGES_PER_10S: '500',
  RATE_LIMIT_LOOKUP_PER_MINUTE: '2000',
  RATE_LIMIT_CONNECT_REQUEST_PER_MINUTE: '500',
  MAX_SOCKETS_PER_USER: '4',
  MAX_PENDING_REQUESTS_PER_USER: '3',

  REPORT_RETENTION_DAYS: '30',
  SESSION_RETENTION_DAYS: '7',
  SECURITY_EVENT_RETENTION_DAYS: '90',

  // The owner key the admin tests present. Pinned here — not taken from the developer's
  // `.env` — so the suite can never depend on, or accidentally print, a real secret. It
  // satisfies the schema's 32-character minimum, which is the point of that minimum.
  ADMIN_TOKEN: 'test-owner-key-not-a-real-secret-0001',

  TRUST_PROXY: 'false',
});

/**
 * Keys removed from the child environment even if the developer's `.env` sets them.
 *
 * `ABUSE_HASH_SALT` unset is the privacy guarantee — "no client identifiers are stored
 * at all" — so the suite must exercise that default rather than whatever the machine
 * happens to have. Note that an empty string is *not* the same as unset: the schema
 * rejects `''` (it is shorter than the minimum), which is exactly the kind of mistake
 * this list prevents.
 */
export const TEST_UNSET_KEYS = ['ABUSE_HASH_SALT'] as const;

/**
 * Environment for a child process: the test overrides, on top of the real one.
 *
 * `DATABASE_URL` is part of the return type (not just `ProcessEnv`) because it is
 * always set here, and callers would otherwise have to re-assert it.
 */
export function testEnv(
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv & { DATABASE_URL: string; NODE_ENV: string; API_PORT: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...TEST_ENV,
    DATABASE_URL: resolveTestDatabaseUrl(),
    ...overrides,
  };

  for (const key of TEST_UNSET_KEYS) {
    if (!(key in overrides)) delete env[key];
  }

  return env as NodeJS.ProcessEnv & {
    DATABASE_URL: string;
    NODE_ENV: string;
    API_PORT: string;
  };
}

/** How long to wait for the spawned API to answer `/health/ready`. */
export const SERVER_START_TIMEOUT_MS = 60_000;
