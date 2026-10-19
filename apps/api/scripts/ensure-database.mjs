#!/usr/bin/env node
/**
 * Ensures the database referenced by `DATABASE_URL` exists.
 *
 * This exists because `prisma migrate` cannot create the database it is asked to
 * migrate: it fails with a confusing P1003 error instead. Running this before
 * migrations turns that into "it just works" for the project owner.
 *
 * Behaviour:
 *   - connects to the target database; if that succeeds, nothing is done;
 *   - if the database is missing, creates it by connecting to the server's
 *     `postgres` maintenance database with the same credentials;
 *   - on a connection/auth failure it prints an actionable message and exits
 *     with a non-zero code (silenced by `--quiet` for build hooks).
 *
 * Usage: node scripts/ensure-database.mjs [--quiet]
 */
import process from 'node:process';

import { config as loadDotenv } from 'dotenv';
import pg from 'pg';

const { Client } = pg;

const quiet = process.argv.includes('--quiet');

/** Resolves the repository `.env`, which lives two levels above this package. */
function loadEnv() {
  loadDotenv({ path: ['../../.env', '.env'], quiet: true });
}

function report(message) {
  if (!quiet) process.stdout.write(`${message}\n`);
}

function fail(message, hint) {
  if (!quiet) {
    process.stderr.write(`\n[db:ensure] ${message}\n`);
    if (hint) process.stderr.write(`[db:ensure] ${hint}\n`);
  }
  process.exit(1);
}

function parseDatabaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(
      `DATABASE_URL is not a valid connection string: ${JSON.stringify(raw)}`,
      'Expected a value like postgresql://anonlink:anonlink@localhost:5432/anonlink?schema=public',
    );
  }

  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    fail(
      `DATABASE_URL must use the postgresql:// scheme, got ${url.protocol}`,
      'Create a `.env` file in the repository root (copy .env.example) with a PostgreSQL URL.',
    );
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) {
    fail('DATABASE_URL does not name a database.', 'Add a database name, e.g. ...:5432/anonlink');
  }

  return { url, database, ssl: url.searchParams.get('sslmode') === 'require' };
}

/** Builds a connection config for a given database on the same server. */
function connectionOptions(url, database, ssl) {
  const options = {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    connectionTimeoutMillis: 5000,
  };
  if (ssl) options.ssl = { rejectUnauthorized: false };
  return options;
}

async function canConnect(options) {
  const client = new Client(options);
  try {
    await client.connect();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  } finally {
    await client.end().catch(() => {});
  }
}

function describeConnectionError(error, host, port) {
  const code = error?.code;
  if (code === 'ECONNREFUSED') {
    return {
      message: `No PostgreSQL server is accepting connections on ${host}:${port}.`,
      hint: [
        'Start the PostgreSQL service. In an elevated PowerShell window run:',
        '    Start-Service postgresql-x64-18',
        'Then check it with: Get-Service postgresql-x64-18',
      ].join('\n'),
    };
  }
  if (code === '28P01' || code === '3D000') {
    return {
      message: `PostgreSQL rejected the credentials in DATABASE_URL (${code}).`,
      hint: [
        'Provision the application role and database once, as a superuser:',
        "    $env:PGPASSWORD='<postgres-superuser-password>'",
        '    & "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe" -U postgres -h localhost -p 5432 `',
        '        -d postgres -v ON_ERROR_STOP=1 -f infrastructure/postgres/init.sql',
      ].join('\n'),
    };
  }
  if (code === 'ETIMEDOUT') {
    return {
      message: `Timed out connecting to PostgreSQL at ${host}:${port}.`,
      hint: 'Check that the service is running and that no firewall blocks the port.',
    };
  }
  return {
    message: `Could not connect to PostgreSQL: ${error?.message ?? String(error)}`,
    hint: 'Run `pnpm diagnose` at the repository root for a full environment report.',
  };
}

async function main() {
  loadEnv();

  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) {
    fail(
      'DATABASE_URL is not set.',
      'Copy .env.example to .env in the repository root and adjust DATABASE_URL.',
    );
  }

  const { url, database, ssl } = parseDatabaseUrl(rawUrl);
  const target = connectionOptions(url, database, ssl);

  const direct = await canConnect(target);
  if (direct.ok) {
    report(`[db:ensure] database "${database}" is reachable.`);
    return;
  }

  // Only "database does not exist" is recoverable here.
  if (direct.error?.code !== '3D000') {
    const { message, hint } = describeConnectionError(direct.error, target.host, target.port);
    fail(message, hint);
  }

  report(`[db:ensure] database "${database}" is missing — creating it…`);

  const admin = connectionOptions(url, 'postgres', ssl);
  const adminClient = new Client(admin);
  try {
    await adminClient.connect();
    // Identifiers cannot be parameterised; they are validated above instead.
    await adminClient.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
    report(`[db:ensure] created database "${database}".`);
  } catch (error) {
    if (error?.code === '42501') {
      fail(
        `The role "${target.user}" is not allowed to create databases.`,
        'Grant it with: ALTER ROLE anonlink CREATEDB;  (as a superuser)',
      );
    }
    const { message, hint } = describeConnectionError(error, admin.host, admin.port);
    fail(`Failed to create database "${database}": ${error?.message ?? message}`, hint);
  } finally {
    await adminClient.end().catch(() => {});
  }
}

await main();
