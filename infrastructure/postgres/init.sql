-- =============================================================================
-- AnonLink — one-time PostgreSQL provisioning
-- =============================================================================
-- Creates the least-privilege application role and the application database.
-- Run once, as a PostgreSQL superuser:
--
--   Windows PowerShell:
--     $env:PGPASSWORD='<postgres-superuser-password>'
--     & "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -h localhost -p 5432 `
--         -d postgres -v ON_ERROR_STOP=1 -f infrastructure/postgres/init.sql
--
--   Linux / macOS / Docker:
--     psql -U postgres -h localhost -p 5432 -d postgres -v ON_ERROR_STOP=1 \
--         -f infrastructure/postgres/init.sql
--
-- The role deliberately has NO superuser, NO createdb* and NO createrole rights
-- beyond what it needs: it owns the application database only.
-- (*CREATEDB is granted purely so `pnpm db:ensure` can bootstrap a fresh
--  development database on demand. Revoke it in production.)
-- =============================================================================

\set ON_ERROR_STOP on

-- The application role. Password is a local development default and is
-- overridden through DATABASE_URL in real deployments.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anonlink') THEN
    CREATE ROLE anonlink
      LOGIN
      CREATEDB
      PASSWORD 'anonlink'
      NOSUPERUSER
      NOCREATEROLE
      NOREPLICATION
      NOBYPASSRLS;
    RAISE NOTICE 'role "anonlink" created';
  ELSE
    RAISE NOTICE 'role "anonlink" already exists — left untouched';
  END IF;
END
$do$;

-- The application database, owned by the application role.
-- UTF8 + C collation: deterministic byte-wise ordering for our ASCII identifiers
-- and independent of the host Windows code page.
SELECT 'CREATE DATABASE anonlink OWNER anonlink ENCODING ''UTF8'' LC_COLLATE ''C'' LC_CTYPE ''C'' TEMPLATE template0'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'anonlink')\gexec

\echo 'AnonLink database provisioning finished.'
