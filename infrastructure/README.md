# Infrastructure

Everything in this directory is either **verified locally** or **explicitly unverified**. Read the
label on each file before relying on it.

| File | Status |
| --- | --- |
| `postgres/init.sql` | **Verified.** Creates the local development role and database. Applied by hand on the Windows development machine (PostgreSQL 18, service `postgresql-x64-18`). |
| `Caddyfile` | **Unverified.** A reverse-proxy sketch that has never been run against this application. |
| `DEPLOYMENT.md` | **Unverified plan.** Steps for a single Debian/Ubuntu host. Written from the real requirements of the codebase, not from a rehearsal. |

There is deliberately **no Docker Compose file**. The project runs on Node and PostgreSQL with no
container requirement (see `docs/DECISIONS.md` D16), and publishing a compose file that was never
built would be a claim nobody can check. If containers are wanted later, that is a new decision with
its own Dockerfiles and a build that is actually executed.

## What is genuinely required for a public deployment

These are not suggestions; each one is a stated property of the code that only holds if the
environment provides it:

1. **HTTPS in front of the API and the web app**, with `COOKIE_SECURE=true`. The session cookie is
   the only credential; over plain HTTP any network position can steal it.
2. **`CORS_ORIGINS` listing exactly the browser origins over https.** It gates REST *and* the
   Socket.IO Origin check; the API refuses to start in production if an `http://` origin is listed.
3. **`TRUST_PROXY=true` only behind the proxy**, and the proxy must overwrite `X-Forwarded-For`
   rather than append to it.
4. **Secrets outside the repository.** `DATABASE_URL`, `ADMIN_TOKEN` (only if the archive is used) and
   `ABUSE_HASH_SALT`, if used, come from the environment or a root-owned file, never from a commit.
5. **A second PostgreSQL as a backup target, and a restore that has been rehearsed.** A backup that
   has never been restored is an assumption.
6. **Monitoring and log retention.** The API logs security events and a correlation id per request;
   nothing is watching them yet.
7. **A decision about `ABUSE_HASH_SALT`.** Unset means no client identifiers are stored at all,
   which limits abuse investigation. Set means a salted hash of IP/User-Agent is stored next to
   security events.
