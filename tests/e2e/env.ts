/**
 * One source of truth for the end-to-end environment.
 *
 * The suite runs the whole stack itself — its own API, its own web build, its own
 * database — on dedicated ports, so `pnpm test:e2e` works while the owner's development
 * servers are running on 3000/3001. Nothing here touches the development database or
 * process.
 *
 * Every value is derived from the single repository `.env`, following the same
 * conventions as `apps/api/test/support/test-env.ts` (which stays the canonical
 * description of the *test* database naming rule).
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { config as loadDotenv } from 'dotenv';

const MAX_SEARCH_DEPTH = 8;

/**
 * Locates the repository root by its workspace marker.
 *
 * Derived from the working directory rather than the module path because Playwright may
 * compile this file as CommonJS or ESM depending on the package; walking up to a known
 * file works in both, and it is the same trick `src/config/env.ts` uses for `.env`.
 */
function findRepositoryRoot(): string {
  let directory = resolve(process.cwd());

  for (let depth = 0; depth < MAX_SEARCH_DEPTH; depth += 1) {
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) return directory;

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new Error(
    'Could not find the repository root (no pnpm-workspace.yaml above the working directory).',
  );
}

export const REPO_ROOT = findRepositoryRoot();

const envFile = join(REPO_ROOT, '.env');
if (existsSync(envFile)) loadDotenv({ path: envFile, quiet: true });

/** Dedicated ports: the development stack stays on 3000/3001. */
export const E2E_API_PORT = 3201;
export const E2E_WEB_PORT = 3200;

export const E2E_API_ORIGIN = `http://127.0.0.1:${E2E_API_PORT}`;
export const E2E_API_BASE = `${E2E_API_ORIGIN}/api/v1`;
export const E2E_WEB_ORIGIN = `http://localhost:${E2E_WEB_PORT}`;

/**
 * The development database URL with `_test` appended to the database name.
 *
 * Same rule as the API integration suite. Duplicated deliberately: importing that
 * module would drag the API package's `nodenext` TypeScript setup into this
 * Playwright-compiled package for eight lines of string manipulation.
 */
function resolveE2eDatabaseUrl(): string {
  const base = process.env['DATABASE_URL'];
  if (!base) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env in the repository root, then run `pnpm setup`.',
    );
  }

  const url = new URL(base);
  const name = url.pathname.replace(/^\//, '');
  url.pathname = `/${name}_test`;
  return url.toString();
}

export const E2E_DATABASE_URL = resolveE2eDatabaseUrl();

/**
 * Environment for the spawned API.
 *
 * Deliberately different from development in three ways: the message limit is small, so
 * the "too long" path is cheap to test; the reconnect grace outlasts a browser reload,
 * because a reload must never end the conversation; and the rate-limit budgets are high,
 * since the limiter has its own unit tests and a shared per-address bucket would make
 * unrelated tests fail intermittently.
 */
const E2E_ENV: Readonly<Record<string, string>> = Object.freeze({
  NODE_ENV: 'test',
  API_HOST: '127.0.0.1',
  API_PORT: String(E2E_API_PORT),
  CORS_ORIGINS: `${E2E_WEB_ORIGIN},http://127.0.0.1:${E2E_WEB_PORT}`,
  COOKIE_SECURE: 'false',
  SESSION_TTL_DAYS: '30',

  MESSAGE_MAX_LENGTH: '200',
  PEER_RECONNECT_GRACE_MS: '10000',

  // The stack runs the housekeeper fast enough to watch it work: the sweep wakes up four
  // times a second, and a filtered search is widened after four seconds and then one
  // filter at a time. Without this a relaxation test would take a minute of real waiting.
  MAINTENANCE_INTERVAL_MS: '250',
  MATCH_RELAX_AFTER_MS: '4000',
  MATCH_RELAX_STEP_MS: '2000',

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

  TRUST_PROXY: 'false',
});

/**
 * Environment for a child process: the E2E overrides on top of the real one.
 *
 * `ABUSE_HASH_SALT` is removed rather than left to the machine's `.env`: "no client
 * identifiers are stored at all" is a privacy guarantee the suite exercises, not a
 * setting that may vary between developers. An empty string is *not* the same as unset —
 * the configuration schema rejects it — so the key must be absent.
 */
export function serverEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...E2E_ENV,
    DATABASE_URL: E2E_DATABASE_URL,
    ...overrides,
  };

  if (!('ABUSE_HASH_SALT' in overrides)) delete env['ABUSE_HASH_SALT'];

  return env;
}

/** Every path the harness needs, resolved once. */
export const E2E_PATHS = {
  apiRoot: join(REPO_ROOT, 'apps', 'api'),
  apiEntry: join(REPO_ROOT, 'apps', 'api', 'dist', 'main.js'),
  webRoot: join(REPO_ROOT, 'apps', 'web'),
  /** Next.js' own CLI entry point, so no shell or `.cmd` shim is needed to start it. */
  nextCli: join(REPO_ROOT, 'apps', 'web', 'node_modules', 'next', 'dist', 'bin', 'next'),
  webBuildId: join(REPO_ROOT, 'apps', 'web', '.next-e2e', 'BUILD_ID'),
  results: join(REPO_ROOT, 'tests', 'e2e', '.results'),
  run: join(REPO_ROOT, 'tests', 'e2e', '.results', 'run'),
  apiLog: join(REPO_ROOT, 'tests', 'e2e', '.results', 'run', 'api.log'),
  webLog: join(REPO_ROOT, 'tests', 'e2e', '.results', 'run', 'web.log'),
  serversFile: join(REPO_ROOT, 'tests', 'e2e', '.results', 'run', 'servers.json'),
} as const;

/** How long a freshly spawned server may take to answer. */
export const SERVER_START_TIMEOUT_MS = 120_000;
