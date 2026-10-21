# AGENTS.md — working rules for this repository

AnonLink is an anonymous real-time chat: random filtered matching plus direct contact by User ID.
This file is for anyone (human or AI agent) changing the code. It records the rules that are not
obvious from reading a single file, and the things that have gone wrong before.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before touching the matching engine or the
realtime layer, and [docs/DECISIONS.md](docs/DECISIONS.md) before questioning a design choice — it
may already be argued there.

---

## 1. Non-negotiables

1. **Never report an unrun check as passing.** If a test, build or lint could not run, say exactly
   why (missing database, blocked port, no network). "Probably fine" is not a result.
2. **Never call the project production-ready.** It has not been load-tested, penetration-tested,
   backed up, monitored or deployed over HTTPS. Those gaps are listed in `docs/SECURITY.md`.
3. **Do not rewrite working components.** Prefer the smallest change that fixes the actual defect.
   Every deviation from the existing stack or architecture needs an entry in `docs/DECISIONS.md`.
4. **Never delete user work.** Investigate before removing anything; keep uncommitted changes.
5. **No secrets in the repository.** Configuration lives in the root `.env` (git-ignored) and is
   described in `.env.example`. No force-pushes, no destructive migrations without a rollback plan.
6. **The server is the authority.** Any rule that decides who may see, send, join or be matched must
   be enforced in `apps/api`. A check that exists only in the browser is decoration.

## 2. Layout and dependency direction

```
apps/api            NestJS: REST + Socket.IO, matchmaking, chats, moderation, Prisma
apps/web            Next.js App Router: every screen the user sees
packages/shared     domain rules shared by browser and server (filters, ids, limits, REST views)
packages/protocol   Socket.IO event and payload contracts
tests/e2e           Playwright specs (two independent browser contexts)
scripts             setup.mjs / doctor.mjs — owner-facing environment checks (Russian output)
infrastructure      local Postgres bootstrap; unverified deployment sketches
```

`packages/shared` and `packages/protocol` must not import from `apps/*`. A rule that both the
browser and the server need (validation, filter arithmetic, id formats, view types) belongs in
`packages/shared` so the two can never drift.

## 3. Everyday commands

```powershell
pnpm setup          # idempotent: Node check, .env, install, DB, migrations, build
pnpm dev            # API on :3001, web on :3000
pnpm diagnose       # environment report (the owner may run this)
pnpm lint           # eslint, all packages
pnpm format:check   # prettier --check (use `pnpm format` to fix)
pnpm typecheck      # tsc --noEmit in every package
pnpm test           # vitest: packages + API integration (needs PostgreSQL)
pnpm build          # turbo build (required before `pnpm test:e2e`)
pnpm test:e2e       # Playwright: spawns its own API :3201 and web :3200
```

Definition of done for a change: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`,
`pnpm build` all pass, and `pnpm test:e2e` passes when the change touches anything a user can see
or the request/event surface.

## 4. Code conventions

- **The API is ESM.** `"type": "module"`, `module`/`moduleResolution: nodenext`. Relative imports in
  TypeScript must carry the `.js` extension (`./thing.js`), including in tests. Forgetting this
  breaks the build or, worse, only the runtime.
- **Validation lives in `packages/shared`** and is applied with the same schemas on the browser, in
  the REST pipes (`zodBody`/`zodParam`/`zodQuery`) and in the gateway. New input means a new schema
  there, not an `if` in a controller.
- **Error contract.** Responses are `{ error: { code, message, context? } }` with a code from the
  shared `ErrorCode` enum. The browser renders Russian text from its own mapping
  (`apps/web/src/lib/error-text.ts`) and never displays the server's English message, so wording can
  change server-side without leaving half-translated copy in the UI.
- **Comments explain *why*.** The codebase intentionally documents rejected alternatives and
  invariants ("why this is synchronous", "why failing closed is correct"). Do not strip those
  comments when refactoring; update them.
- **UI text is Russian** (`<html lang="ru">`), code and comments are English. Every rendered control
  must actually work — no disabled placeholders, no dead buttons.
- **Web state**: `apps/web/src/lib/anonymous-client.ts` owns REST bootstrap + the socket and
  translates server events into the Zustand store (`apps/web/src/store/app-store.ts`), which holds
  render state only. Components read the store; they never talk to the socket directly.
- **React 19 lint rules are on**: no `setState` in an effect body, no `Date.now()` during render
  (use `apps/web/src/lib/use-ticker.ts`). These rules are enforced by `pnpm lint`.
- **Config**: add a variable to the zod schema in `apps/api/src/config/env.ts`, to `.env.example`
  with a comment explaining the consequence of changing it, and to `docs/` if it changes behaviour.

## 5. Database rules

- Prisma 7 with the `prisma-client` generator, output `apps/api/src/generated/prisma` (git-ignored,
  `@ts-nocheck`), and the `@prisma/adapter-pg` driver adapter. Configuration is
  `apps/api/prisma7.config.ts`; the environment is not loaded automatically.
- **Migrations are additive.** Adding an optional/defaulted column is fine; dropping or rewriting is
  not, without a written rollback plan in the commit message and `docs/DECISIONS.md`.
- `apps/api/test/global-setup.ts` runs `prisma migrate deploy` against the `*_test` database.
- **Never wipe the test database.** Tests must be self-contained: use a `randomUUID()` needle for any
  global text search, and clean up queue/chat state you created (see §6).
- Chat transcripts are **not** stored by default. PostgreSQL holds identities, sessions, blocks,
  reports, security events, and the voluntary profile/filters. The **owner** may switch on an archive
  (`docs/DECISIONS.md` D21) that stores whole conversations for the people he selects; it is off until
  he does, and users are told nothing about it. `apps/api/test/persistence.test.ts` enforces the default
  (and fails if it finds a non-empty archive) — do not weaken it; `apps/api/test/archive.test.ts` covers
  the opt-in path and must leave the switch off and the archive empty in `afterEach`.

## 6. Testing rules

- Add rules to unit tests where the rule is a pure function (`packages/shared/src/*.test.ts`).
- Add server behaviour to `apps/api/test/*.test.ts`. These run against a real API process (port
  **3101**) and a `*_test` database; `apps/api/test/support/api-client.ts` speaks only the documented
  protocol, deliberately.
- **Matchmaking is global to the server.** A test that leaves a user queued will hand that user to
  the next test's first joiner, and the failure will look like a filter bug. Always leave the queue
  (`match:cancel`) and any chat (`chat:leave`) in `afterEach`, as
  `apps/api/test/search-filters.test.ts` does.
- Timing-dependent behaviour is disabled in integration tests on purpose:
  `MATCH_RELAX_AFTER_MS=0` (no widening) and `MAINTENANCE_INTERVAL_MS=0` (the sweep runs only when a
  test asks for it) via `apps/api/test/support/test-env.ts`. Filter-widening is proved end to end
  instead, where the timing policy is short.
- End-to-end specs live in `tests/e2e/specs`, use real ARIA roles and visible text, and run with
  `workers: 1` because matchmaking is global. Only two non-semantic hooks are allowed: `#own-user-id`
  and `data-chat-id`. The stack (API :3201, web :3200, `_test` DB) is spawned by
  `tests/e2e/global-setup.ts` — there is no Playwright `webServer`, so ports must be free.
- New E2E behaviour should assert what the *user* can do, not the internals.

## 7. Windows / PowerShell gotchas

- `pnpm` is a `.cmd` shim: scripts must spawn it through a shell (`shell: true`), while
  `process.execPath` must not.
- Never round-trip non-ASCII files through PowerShell (`Get-Content -Raw | Set-Content` mangles
  encoding). Use the editor/write tools or a Node script.
- `\n` inside a PowerShell command string is not a newline; use separate statements.
- `psql` is not on `PATH`: `C:\Program Files\PostgreSQL\18\bin\psql.exe`.
- Freeing a port: `Get-NetTCPConnection -LocalPort <port> -State Listen` then `Stop-Process -Force`.
- Killing the E2E stack: `taskkill /pid <pid> /T /F` (PIDs are in `tests/e2e/.results/run/servers.json`).

## 8. Dependencies

- Every version is pinned exactly, and `pnpm-workspace.yaml` (`allowBuilds` map, `strictPeerDependencies:
  false`) forbids unapproved install scripts — installing something new is a deliberate act.
- Check the registry before bumping: several "latest" tags are pre-release majors
  (`typescript@7`, `prisma@8-rc`) that must not be adopted casually.
- Justifications for every removed or added dependency belong in `docs/DECISIONS.md`.

## 9. Documentation

Behaviour changes update the matching document, not just the code:

| Change | Update |
| --- | --- |
| Any user-visible behaviour, acceptance criteria | `docs/PRODUCT_SPEC.md` |
| Requirement status | `docs/COMPLIANCE.md` |
| Architectural change, seam, scaling | `docs/ARCHITECTURE.md` |
| Auth, validation, limits, privacy, secrets | `docs/SECURITY.md` |
| New tests, new suite, coverage gaps | `docs/TESTING.md` |
| A decision taken or reversed | `docs/DECISIONS.md` |
| Social-network adapter, external identity, token bootstrap | `docs/INTEGRATIONS.md` |
| Plans, owner decisions needed | `docs/ROADMAP.md` |
| Setup/commands | `README.md` |

Documentation is intentionally bilingual: the owner-facing documents (`README.md`,
`docs/PRODUCT_SPEC.md`, `docs/COMPLIANCE.md`) are Russian; engineering documents are English,
matching the code.

## 10. Invariants that are easy to break

- **The public User ID is not a secret.** Knowing it grants nothing: no session, no chat, no data.
  Lookup by ID returns existence and availability only.
- **Random matches never disclose the peer's User ID.** Per-socket messages are rendered from that
  socket's point of view (`from: 'you' | 'peer'`), and the alias is per chat.
- **Filters are strict and mutual.** An undeclared value never satisfies a filter; both sides must
  accept each other (`packages/shared/src/preferences.ts`).
- **Widening a search is opt-in, one step at a time, and always announced.** It happens only in the
  maintenance sweep, never from `joinRandom`, so integration tests stay deterministic.
- **The chat domain never imports the gateway.** Lifecycle changes travel on
  `apps/api/src/events/app-events.ts`; the gateway renders them.
- **Atomicity is the event loop.** `ChatRegistryService`/`MatchingService` operations are synchronous
  and database writes happen after the in-memory decision, with an explicit rollback path.
- **Disconnecting is not leaving.** A peer that vanishes is given `PEER_RECONNECT_GRACE_MS` before the
  chat is abandoned.
