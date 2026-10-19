/**
 * Shared helpers for the repository-level scripts (`doctor.mjs`, `setup.mjs`).
 *
 * These scripts are the owner's entry point into the project, so they are written to be
 * runnable with nothing but Node: no build step, no TypeScript, no dependencies beyond
 * what the repository already installs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadDotenv, parse as parseDotenv } from 'dotenv';

/**
 * The repository root.
 *
 * Derived from this file's own location rather than `process.cwd()`, so every script
 * behaves identically whether the owner runs it from the root, from a package directory
 * or from a shortcut somewhere else.
 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const ENV_PATH = join(REPO_ROOT, '.env');
export const ENV_EXAMPLE_PATH = join(REPO_ROOT, '.env.example');

/** Loads the repository `.env`. Real environment variables always win. */
export function loadEnvironment({ override = false } = {}) {
  if (!existsSync(ENV_PATH)) return { found: false, keys: [] };

  const result = loadDotenv({
    path: ENV_PATH,
    quiet: true,
    ...(override ? { override: true } : {}),
  });
  return { found: true, keys: Object.keys(result.parsed ?? {}), error: result.error };
}

/** Keys declared in `.env` without printing any values. */
export function envKeys() {
  if (!existsSync(ENV_PATH)) return [];
  return Object.keys(parseDotenv(readFileSync(ENV_PATH, 'utf8')));
}

/**
 * Renders a connection string with the password removed.
 *
 * Diagnostics are printed to a console and pasted into bug reports, so a raw
 * `DATABASE_URL` — which contains a real password — must never be echoed.
 */
export function maskDatabaseUrl(raw) {
  if (!raw) return '(не задан)';
  try {
    const url = new URL(raw);
    const auth = url.username ? `${url.username}:***@` : '';
    return `${url.protocol}//${auth}${url.host}${url.pathname}`;
  } catch {
    return '(не удалось разобрать)';
  }
}

/** Parses `DATABASE_URL` into the pieces the checks need, or an explanation. */
export function parseDatabaseUrl(raw) {
  if (!raw) return { ok: false, reason: 'DATABASE_URL is not set' };

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `not a valid URL: ${maskDatabaseUrl(raw)}` };
  }

  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    return { ok: false, reason: `expected a postgresql:// URL, got ${url.protocol}` };
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) return { ok: false, reason: 'the URL does not name a database' };

  return {
    ok: true,
    database,
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: url.searchParams.get('sslmode') === 'require',
  };
}

/** Connection options for `pg`, for an arbitrary database on the same server. */
export function connectionOptions(parsed, database = parsed.database) {
  return {
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    password: parsed.password,
    database,
    connectionTimeoutMillis: 5000,
    ...(parsed.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
  };
}

/** `>=22.12.0` → `{ major: 22, minor: 12, patch: 0 }`, or `null` if unparsable. */
export function parseMinimumVersion(range) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(range ?? '');
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Compares two `x.y.z` version strings. Returns -1, 0 or 1. */
export function compareVersions(a, b) {
  const left = String(a)
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b)
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);

  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

/** Reads and parses a JSON file from the repository. */
export function readJson(relativePath) {
  return JSON.parse(readFileSync(join(REPO_ROOT, relativePath), 'utf8'));
}

/** Whether a repository-relative path exists. */
export function exists(relativePath) {
  return existsSync(join(REPO_ROOT, relativePath));
}
