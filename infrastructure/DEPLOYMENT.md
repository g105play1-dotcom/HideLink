# Deployment plan (single host) — UNVERIFIED

This plan has never been executed. It is written from what the application actually requires, and
every command here should be treated as a draft to be rehearsed on a throwaway host first. Nothing
in this document has been tested against a real deployment.

Target: one Debian or Ubuntu server with a public address, a domain, and a PostgreSQL instance
(local or managed). One application process is enough — the matching queue and presence live in
process memory, so two instances behind a plain load balancer would each know about only half of the
waiting users (see `docs/ARCHITECTURE.md`).

## 0. Prerequisites

- A domain with an `A`/`AAAA` record pointing at the host.
- Node.js 22.12+ (NodeSource or nvm).
- PostgreSQL 16+ reachable from the application, with a dedicated role and database.
- Caddy (simplest TLS) or nginx.

## 1. Database and role

```bash
sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE anonlink LOGIN PASSWORD 'CHANGE-ME';
CREATE DATABASE anonlink OWNER anonlink;
SQL
```

Migrations are applied by the application's own tooling (`prisma migrate deploy`) — never by hand,
and never with `db push`, which can rewrite data.

## 2. Code and configuration

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin anonlink
sudo -u anonlink git clone <repository> /srv/anonlink
cd /srv/anonlink
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Configuration lives in `/srv/anonlink/.env`, owned by the application user, mode `600`. Required
values for production:

```ini
NODE_ENV=production
API_HOST=127.0.0.1
API_PORT=3001
DATABASE_URL=postgresql://anonlink:CHANGE-ME@localhost:5432/anonlink?schema=public
CORS_ORIGINS=https://app.example.com
COOKIE_SECURE=true
TRUST_PROXY=true
NEXT_PUBLIC_API_URL=https://app.example.com
```

`NEXT_PUBLIC_API_URL` is inlined into the web bundle at build time, so changing it means rebuilding
the web app. The API refuses to start with an `http://` origin in `CORS_ORIGINS` or with
`COOKIE_SECURE=false`, which is the one guardrail that survives a careless edit.

Apply the schema once:

```bash
sudo -u anonlink pnpm --filter @anonlink/api exec prisma migrate deploy
```

## 3. Run it

Two processes under systemd. The API must be restarted automatically — it is the only stateful
piece, and a restart loses ongoing chats (they are deliberately not persisted).

`/etc/systemd/system/anonlink-api.service`:

```ini
[Unit]
Description=AnonLink API
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=anonlink
WorkingDirectory=/srv/anonlink/apps/api
EnvironmentFile=/srv/anonlink/.env
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=2
# The API allocates no privileged ports and needs no capabilities.
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/anonlink-web.service` uses the same shape with
`WorkingDirectory=/srv/anonlink/apps/web` and
`ExecStart=/usr/bin/node node_modules/next/dist/bin/next start --port 3000`. (Starting Next.js
through its own CLI entry point avoids depending on a shell shim.)

## 4. Reverse proxy

Put Caddy in front using `infrastructure/Caddyfile`, replacing the host name. It terminates TLS,
forwards `/api/*` and `/socket.io/*` to the API and everything else to the web app. Keep both
application ports bound to `127.0.0.1` so nothing is reachable directly.

WebSocket upgrades must pass through untouched — Socket.IO depends on them.

## 5. Before announcing the address

- [ ] Backups: a nightly `pg_dump` to a different machine, **and one restored by hand** to prove it
      works. Identities, blocks and reports live in the database; **if the owner archive is enabled,
      the stored transcripts do too**, and then a backup inherits every risk listed in
      `docs/SECURITY.md` §13 — an encrypted volume and a retention policy for dumps become mandatory,
      not optional.
- [ ] Monitoring: uptime of `GET /api/v1/health/ready`, process restarts, and an alert that reaches
      a person.
- [ ] Log retention and a place to read them (the API logs a correlation id per failed request).
- [ ] A decision on `ABUSE_HASH_SALT` (see `docs/SECURITY.md`).
- [ ] If the archive will be used: generate `ADMIN_TOKEN`, keep it out of the repository, and decide
      who besides the owner may read the database (see `docs/SECURITY.md` §13).
- [ ] A rehearsal of the report triage flow: what happens when a report arrives at 02:00?
- [ ] A load test that establishes how many concurrent chats one process holds, so the next step is
      a measurement rather than a guess.

## 6. Rolling back

The application deploys are code-only, so a rollback is `git checkout <previous tag>` + restart. An
applied migration is the one thing that does not roll back by itself: every migration in
`apps/api/prisma/migrations` is additive (nullable or defaulted columns only), so the previous
application version keeps working against the newer schema. That is the reason for the rule in
`AGENTS.md`.
