# AnonLink — Architecture

## 1. Purpose and scope

This document describes how the AnonLink monorepo is put together: which packages own which rules, how a browser request and a chat message travel through the system, where state lives (in process vs. in PostgreSQL), and which parts are deliberately ephemeral. It is meant to be read with `docs/DECISIONS.md` (which argues each choice) and `docs/PRODUCT_SPEC.md` (which states the user-facing promises).

**What this document is not.** It is not a deployment, operations, security or scaling document, and it makes no claim that the system is production-ready. There is no evidence in this repository of load testing, penetration testing, backup/restore drills, monitoring or HTTPS termination. The default configuration runs the API as a **single Node process** with matchmaking, chats and presence held in process memory; the consequences are stated where they apply and summarised in §10. The runtime configuration is the root `.env` (git-ignored), described by `.env.example`.

The companion documents are `docs/SECURITY.md` (threat model, what is refused, what is unverified), `docs/TESTING.md` (the test suites and their real coverage limits), `docs/ARCHITECTURE.md` (this file), `docs/PRODUCT_SPEC.md`, `docs/DECISIONS.md`, `docs/ROADMAP.md` and the Russian owner-facing `docs/COMPLIANCE.md`.

---

## 2. System map: four packages

```
apps/api            NestJS 12 (Express + Socket.IO): REST, realtime gateway, matchmaking,
                    chats, moderation, the owner surface (archive + inbox + moderation), Prisma 7 access
apps/web            Next.js 16 App Router (React 19, Zustand, TanStack Query, Tailwind 4)
packages/shared     domain rules: filters/preferences, relaxation, limits, id formats,
                    validation schemas, error codes, REST view types
packages/protocol   Socket.IO event names, payload types, acknowledgement contract
tests/e2e           Playwright specs (two independent browser contexts)
```

**Dependency direction.** `packages/protocol` depends on `packages/shared` (`packages/protocol/package.json` lists `@anonlink/shared`); `apps/api` and `apps/web` depend on both. Neither shared package depends on `apps/*` — this is stated in `AGENTS.md` and visible in the manifests: `packages/shared/package.json` declares only `zod`, and `packages/protocol/package.json` declares only `@anonlink/shared`. A rule both ends need (validation, filter arithmetic, ID formats) therefore has one definition and cannot drift.

What each package owns:

- `packages/shared/src/preferences.ts` — the filter vocabulary, the strict/mutual predicate (`preferencesFit`, `mutuallyCompatible`) and the relaxation ladder (`RELAXABLE_CRITERIA`, `activeRelaxationOrder`, `relaxBySteps`, `relaxationStage`).
- `packages/shared/src/ids.ts` — the public User ID format (`AL` + 12 Crockford Base32 chars; `generatePublicId`, `normalizePublicId`, `isValidPublicId`).
- `packages/shared/src/limits.ts` — shared numbers (`CHAT_MEMORY_MESSAGE_LIMIT`, `MATCH_TICKET_TTL_MS`, `CONNECT_REQUEST_TTL_MS`, `SESSION_TOKEN_BYTES`, `REPORT_REASONS`, end reasons).
- `packages/shared/src/archive.ts` — the archive policy model, its schema-level cross-field rules, and `archiveSubjectMatches` / `shouldArchiveChat`, the same predicate the API applies (the browser never decides).
- `packages/shared/src/errors.ts`, `schemas.ts`, `rest.ts` — the `ErrorCode` enum, the Zod schemas used by both ends, and the REST view types (`SessionView`, `UserLookupView`, …).
- `packages/protocol/src/events.ts`, `payloads.ts` — `PROTOCOL_VERSION`, the client/server event maps, `AckResult<T>` and every payload, plus `SocketData`.

Build/tooling: `pnpm-workspace.yaml` defines `apps/*`, `packages/*`, `tests/*`; `turbo.json` orders `build → typecheck/lint/test`. The API is ESM (`"type": "module"`, `module: nodenext`), so relative TypeScript imports carry `.js` extensions; it is compiled with `nest build`.

---

## 3. Request and event lifecycle

### Browser boot → session bootstrap

1. `apps/web/src/components/app-providers.tsx` mounts the single boot point and calls `client.boot()` (`apps/web/src/lib/anonymous-client.ts`) in a `useEffect`.
2. `boot()` calls `POST /api/v1/session` via `apiRequest` (`apps/web/src/lib/http.ts`, `credentials: 'include'`). The route is `@Anonymous()` and idempotent: an existing cookie returns the same identity with no creation budget consumed (`apps/api/src/identity/identity.controller.ts`).
3. On first use the controller rate-limits the *address* (`sessionCreate` bucket), then `IdentityService.createIdentity` (`apps/api/src/identity/identity.service.ts`) inserts an `Identity` plus a `Session` whose `tokenHash` is `sha256(token)`; the raw 32-byte token is returned only in an `HttpOnly` cookie.
4. `boot()` opens the socket (`openSocket`) and sets connection state to `connecting`.

### Socket handshake → guard pipeline

The handshake is constrained by `ConfiguredSocketIoAdapter` (`apps/api/src/realtime/socket-io.adapter.ts`): an Origin allow-list checked in `allowRequest` before a socket exists, CORS with credentials, a 64 kB packet ceiling (`maxHttpBufferSize`) and a 10 s `connectTimeout`. `CORS_ORIGINS` is the same allow-list the HTTP layer uses.

On connection the gateway (`apps/api/src/realtime/chat.gateway.ts`) attaches handlers synchronously, then resolves identity in `authenticate`:

```
Origin (adapter) → session cookie → identity lookup → ban check → presence.register
   → per-identity socket ceiling (MAX_SOCKETS_PER_USER) → session:ready
```

Failure (no identity, banned, over the socket cap) emits `app:error` and disconnects; a socket over the cap also logs a security event. Every inbound event then passes through `ChatGateway.guard()`, the single validation/authorisation/error boundary:

```
await identity ready → rate-limit (per bucket) → zod schema.safeParse(payload)
   → run handler → ack { ok: true, data } | ack { ok: false, error }
```

`guard()` finds the payload and the acknowledgement by *shape* (non-function vs. function), so `(payload, ack)`, `(ack)` and `(payload)` all work. Unknown event names are reported as `UNSUPPORTED_EVENT` via `socket.onAny` instead of being dropped.

For HTTP the equivalent boundary is the global `RequestGuard` (`apps/api/src/identity/request.guard.ts`), registered as `APP_GUARD` in `app.module.ts`. It runs, in order: origin policy for non-safe methods, identity resolution, rate limiting, then authorisation. Authentication is required unless a route is marked `@Anonymous()`, so the default fails closed.

### One message's round trip

```
user types → client.sendMessage()              apps/web/src/lib/anonymous-client.ts
  queueOutgoingMessage() → optimistic bubble    apps/web/src/store/app-store.ts
  emit 'chat:message' { chatId, clientMessageId, text } + ack
server gateway.guard() validates chatMessageSchema, rate-limits 'chatMessage'
  chat.sendMessage()                            apps/api/src/chat/chat.service.ts
     registry.get(chatId) → hasParticipant → isActive
     sanitizeMessageText() (server-side)        apps/api/src/common/sanitize.ts
     chat.append(candidate)   (idempotent per clientMessageId)
     bus.emit({ type: 'chat.message', chat, message })
  ack { ok: true, { messageId, sentAt } }
server onAppEvent() renders per participant      chat.gateway.ts + chat.views.ts
  emitToUser(userId, 'chat:message', buildMessageView(..., userId))
client store.receiveMessage() replaces the optimistic bubble by clientMessageId,
  or appends; then confirmMessage() reconciles the ack
```

The sender sees `from: 'you'` on every socket; the peer sees `from: 'peer'`. The `clientMessageId` is echoed only to its author.

---

## 4. Matchmaking engine

The engine is `apps/api/src/chat/chat.matching.ts` (`MatchingService`), driven by `ChatService` (`apps/api/src/chat/chat.service.ts`).

### The queue and the ticket

Tickets live in a `Map<userId, Ticket>`; `Map` insertion order gives FIFO scan order. A ticket holds three fields:

```ts
interface Ticket {
  enqueuedAt: number;      // wait-time fairness
  relaxAllowed: boolean;   // may the server widen this search?
  relaxedSteps: number;    // steps already applied (applied exactly once)
}
```

The identity facts are *not* on the ticket; they live in the directory cache (§5). `enqueue` is idempotent — a re-join keeps the position and only refreshes `relaxAllowed`. `claimOrEnqueue` is the single atomic step: it scans waiting tickets in order, calls the synchronous `isEligible` predicate, and either removes the claimed peer **and** the caller and returns `matched`, or inserts the caller and returns `waiting`. The caller is not in the queue while scanning, so it can never match itself.

### The mutual-compatibility predicate

`ChatService.isEligible` is synchronous by contract and fails closed:

```
registry.activeFor(candidate)                    → false
directory.isBanned(candidate)                    → false
directory.isBlockedBetween(seeker, candidate)    → false
directory.sides(seeker, candidate) === null      → false
mutuallyCompatible(seeker side, candidate side)  → the decision
```

Each side is built from the cached profile and `relaxBySteps(prefs, steps).criteria`, so a ticket's own step count applies to that side. `mutuallyCompatible` (`packages/shared/src/preferences.ts`) requires **both** sides' filters to hold: `preferencesFit` returns `false` for any undeclared value (`gender === null`, `birthYear === null`, or an undeclared place cannot satisfy "same as mine"). A filter is a refusal, so consent must hold in both directions; both parties must also be free and unblocked.

### The relaxation ladder

Relaxation is how a long, heavily-filtered search is eventually matched.

- **Opt-in per user.** `SearchPreferences.relaxAllowed` defaults to `false`; nothing widens unless the user set it.
- **One filter per step, in a fixed order.** `RELAXABLE_CRITERIA` is `['languages', 'location', 'age', 'genders']` (least meaningful first); `activeRelaxationOrder(prefs)` keeps only those actually set, and `relaxBySteps(prefs, steps)` drops the first `steps` and reports which were dropped.
- **The step count comes from the clock, not the queue.** `relaxationStage(waitedMs, { relaxAfterMs, stepMs })` returns `0` until `relaxAfterMs`, then one step per `stepMs`. `MatchingService.relaxationDue` evaluates this per ticket, stores the new count on `relaxedSteps` and returns the advanced tickets; the chat service announces the newly dropped criterion and retries at once.
- **Only the maintenance sweep widens.** `ChatService.relax()` is called exclusively from `MaintenanceService.runOnce` on `MAINTENANCE_INTERVAL_MS`; `joinRandom` reads the current step count but never takes a new step. Deliberate (`docs/DECISIONS.md`, D17): widening inside `joinRandom` would depend on who happened to arrive — unfair and untestable.
- **Every step is announced.** Each dropped criterion yields a `match:relaxed` push naming `dropped` and the `criteria` now in force; the user is never silently handed someone outside their filters.
- **The retry.** `tryMatchWaitingUser` re-runs `claimOrEnqueue` with the new steps, because the newly compatible partner may have been waiting all along, rejected only by the dropped filter.

Timing defaults (`apps/api/src/config/env.ts`): `MATCH_RELAX_AFTER_MS = 45000`, `MATCH_RELAX_STEP_MS = 20000`, `MAINTENANCE_INTERVAL_MS = 15000`. Setting `MATCH_RELAX_AFTER_MS = 0` disables widening entirely — the integration suite does this (`apps/api/test/support/test-env.ts`), while the e2e stack runs the sweep at 250 ms and relaxes after 4 s (`tests/e2e/env.ts`).

### Rollback path on database failure

`ChatService.createAndPersistChat` bridges the synchronous decision to durable state: cancel both tickets, `registry.create(...)` in memory, then `await prisma.chatSession.create(...)`. If the write throws, `registry.abort(chatId)` removes the in-memory chat and **both** participants are re-enqueued with their own `relaxAllowed`; the caller gets a generic `INTERNAL_ERROR` and the failure is logged as `chat.persist_failed`. In-memory state never survives a decision the database rejected.

### Why single-instance

`MatchingService`, `ChatRegistryService` and `PresenceService` are in-process `Map`s, and `AppEventBus` (`apps/api/src/events/app-events.ts`) is process-local by design: AnonLink runs one API instance, so there is nothing to fan out across processes. That is what makes "no identity is ever matched twice" true without a lock or a transaction — the event loop is the atomicity mechanism, and every registry/matching method is synchronous.

A second instance would change this materially: each process would have its own queue, presence map and event bus, so two users could be matched twice, a `chat:started` raised in one process would never reach a socket held in the other, and per-process rate limits would multiply. The queue replacement is described, but **not implemented**, in the header comment of `apps/api/src/chat/chat.matching.ts` (see §10).

---

## 5. Directory cache

`apps/api/src/directory/directory.service.ts` (`DirectoryService`) is a per-process, in-memory cache of the facts the matchmaker must read *inside* its synchronous critical section. Per identity it holds `publicId`, `banned` (from `bannedAt`), the `incomingRequests` policy, the declared `profile` and the saved search `preferences`, plus two block indexes (`blockedByMe`, `blockingMe`) and an `inFlight` map of concurrent loads. It makes no decisions — who may meet whom is decided in `ChatService.isEligible` (`docs/DECISIONS.md`, D6). Its surface is `ensureLoaded` / `refresh` (load), `load` (private, three parallel Prisma reads), `patch`, `sides` and `forget`; `load` narrows every value through `apps/api/src/identity/settings.mapper.ts`, so a hand-edited or rolled-back row cannot inject a value the code does not understand.

- **Loaded** on the first socket of an identity (`ChatGateway.authenticate` → `chat.handleConnected` → `directory.refresh`), which bounds staleness to the connection's lifetime. `ensureLoaded` returns existing facts or joins an in-flight load and never issues a duplicate query.
- **Patched** synchronously on every local mutation: `PATCH /me/settings` (`apps/api/src/identity/identity.controller.ts`) patches `incomingRequests`, `profile` and `search` right after the write, so a new filter or "invitations off" takes effect immediately instead of after a reconnect; `ModerationService.ban` patches `banned`; block/unblock update both indexes.
- **Forgotten** on the last socket disconnect (`ChatGateway.onDisconnect` calls `directory.forget`), and a connect-time `refresh` reloads it. `load` also forgets when the identity row has vanished.

**Why failing closed is safe.** `sides(a, b)` returns `null` when either side is unknown, and `isEligible` treats `null` as "not eligible". A user with no cached facts can therefore never be matched: the failure mode is "no match", never "matched with someone a filter would have excluded". This is safe because a ticket only exists for an identity loaded when it queued, and every reconnect reloads. `isBlockedBetween(a, b)` is answerable from `a`'s records alone because `load` fetches blocks in both directions.

---

## 6. Persistence

PostgreSQL is the only durable store. It holds identity and session metadata, moderation state and retention-bound forensic events — and no chat transcript, unless the owner has switched the archive on (`docs/DECISIONS.md` D21). The schema is `apps/api/prisma/schema.prisma`.

| Model | Purpose | Notable fields |
| --- | --- | --- |
| `Identity` | one anonymous identity; no sign-up | `publicId` (unique), `lastSeenAt`, `bannedAt`, `incomingRequests`, declared profile + filter columns |
| `Session` | a bearer session | `tokenHash` (unique, `Char(64)`), `expiresAt`, `revokedAt`, optional `ipHash`/`userAgentHash` |
| `ChatSession` | one lifecycle row per chat | `kind`, `status`, `startedAt`, `endedAt`, `endReason`, participants, `initiatorId`, `messageCount` |
| `Block` | one-directional block | `blockerId`, `blockedId`, unique together |
| `Report` | abuse report | `reason`, `details`, `messageId`, `messageSnapshot`, `status`, `expiresAt` |
| `PlatformPolicy` | installation-wide switches the owner sets in `/admin` | fixed id `default`, `blockingEnabled` (default `false`; a missing row means off) |
| `SecurityEvent` | low-frequency, high-signal events | `type`, `identityId`, `targetId`, `expiresAt` |
| `OwnerMessage` | one message a user sent the owner (topic, text, optional contact) | `topic`, `text`, `contact`, `identityId`, `expiresAt` |
| `ArchivePolicy` | the owner's single archive setting | `enabled`, `audience`, criteria columns, `storeText`, `storeMedia`, `retentionDays` |
| `ArchiveSubject` | one explicitly selected User ID (audience `selected`) | `publicId`, unique |
| `ChatArchive` | one archived conversation | `chatId`, `participantsAtStart`, `messageCount`, `expiresAt` |
| `ArchivedMessage` | one stored message | `archiveId`, `seq`, `senderId`, `text`, inert `mediaKind`/`mediaRef`, `sentAt` |

The brief lists five models; the schema actually has **eight** product models (adding `ChatSession`,
`OwnerMessage` and `PlatformPolicy`) plus **four** archive models that exist only for the owner's opt-in
feature.

**Deliberately not stored.** Chat transcripts live only in `ChatRecord.messages` in process memory, bounded by `CHAT_MEMORY_MESSAGE_LIMIT = 200` (`apps/api/src/chat/chat.registry.ts`) — unless the owner's archive selected the chat, in which case the same message is also handed to `ArchiveService.recordMessage`. The only row content a message can otherwise reach is a `Report.messageSnapshot`, always copied from the server's own in-memory message and deleted on `expiresAt`. Pending direct requests live in memory for `CONNECT_REQUEST_TTL_MS = 60_000` (`apps/api/src/chat/chat.requests.ts`) and do not survive a restart. The one other place user-written text is stored is `OwnerMessage`: written *by* the user *for* the owner, bounded and retention-bound, and the only stored text the user is told about (`docs/DECISIONS.md` D26, `docs/SECURITY.md` §13.1). `ipHash`/`userAgentHash` are written only when `ABUSE_HASH_SALT` is set (default: unset), and rate-limit trips are never persisted (`docs/DECISIONS.md`, D7). `apps/api/test/persistence.test.ts` enforces the default by reading the database directly and searching every text column for a sent message; `apps/api/test/archive.test.ts` proves the opt-in path.

**The archive seam.** The archive is a leaf: `chat/chat.service.ts` asks `ArchiveService.shouldArchive(participants)` **synchronously**, once, when the chat is created, and stores the answer on `ChatRecord.archived`. Messages are handed over after the dedup check (`trackWrite(archive.recordMessage(...))`), so a database failure can never delay or lose a message. The chat domain does not know the archive exists beyond that one call — the policy cache, the Prisma writes, the retention query and the owner's HTTP surface all live in `apps/api/src/archive/` (`archive.service.ts`, `admin.guard.ts`, `admin.controller.ts`, `admin-session.controller.ts`, `archive.module.ts`) and depend on nothing in `chat/`. The decision is re-read on every message rather than cached on the chat, which is what makes switching the switch off take effect immediately instead of at the next chat.

**Prisma 7 specifics.** The `prisma-client` generator outputs to `apps/api/src/generated/prisma` (git-ignored, `@ts-nocheck`), and the client connects through `@prisma/adapter-pg` (`apps/api/src/prisma/prisma.service.ts`). The datasource URL is not loaded from `.env` automatically; the CLI config `apps/api/prisma7.config.ts` walks up to find the root `.env`, the same strategy the API uses in `apps/api/src/config/env.ts`.

**The inbox seam.** `OwnerMessageService` (`apps/api/src/owner/`) is a leaf that knows only Prisma and the configured retention: `OwnerController` validates the body and applies the per-identity budget, `ArchiveModule` renders the inbox on the owner's admin API, and `MaintenanceService` deletes expired rows. It imports no feature module, so no cycle is possible; the owner's key is the only credential, shared with the archive through `AdminGuard`.

**The platform-policy seam.** `PlatformService` (`apps/api/src/platform/`) is a leaf with one dependency, Prisma. It loads the single `PlatformPolicy` row at boot and answers `blockingEnabled()` **synchronously**, because `ChatService.assertBlockingAllowed` runs inside the chat domain's critical section and must not await a query (the same constraint as `DirectoryService`, §4). `PUT /admin/platform` writes the row and replaces the cache; a missing row or a failed read means `false`, so the failure mode is "the action is unavailable", never "the action was silently granted". The chat domain calls one method and does not know where the switch is stored; the owner's routes live on `ArchiveModule`'s `AdminController`, which is the single guarded surface for `/admin` (D31).

**The moderation seam.** `ModerationService.listReports` and `setReportStatus` are additions to the existing moderation leaf; they read the same `Report` rows the socket path writes and reuse `REPORT_ADMIN_SELECT`. The owner's `AdminController` exposes them, `apps/web/src/components/admin-screen.tsx` renders them, and nothing in the chat path depends on the panel. Status is the *only* mutable field: `reportStatusSchema` is `.strict()` and the update's `data` contains nothing else, so evidence cannot be rewritten by a later caller.

**Migrations are additive**: adding an optional or defaulted column is acceptable; dropping or rewriting one requires a written rollback plan (`AGENTS.md`). Eight migrations are committed under `apps/api/prisma/migrations/`: `20261018000147_init`, `20261018023949_add_search_preferences`, `20261019064049_add_chat_archives` (four new tables, no change to an existing one), `20261019120000_add_blocking_toggle` (one defaulted column, now legacy and unread after D31), `20261019153000_search_multiple_places` (the only destructive step in the history — it carries the old choice into a new column before dropping it, and its file holds the rollback plan), `20261019180000_add_owner_messages` (one new enum and one new table), `20261019210000_search_place_lists` (place-list columns for profile and filters) and `20261020120000_platform_policy` (one new table, no change to an existing one). The test database is prepared with `prisma migrate deploy` (`apps/api/test/global-setup.ts`).

**Retention** (`MaintenanceService.enforceRetention`) hard-deletes rows whose deadlines passed:

```
report.deleteMany        where expiresAt        < now
securityEvent.deleteMany where expiresAt        < now
session.deleteMany       where expiresAt < now - SESSION_RETENTION_DAYS
                            or revokedAt < now - SESSION_RETENTION_DAYS
chatArchive.deleteMany   where expiresAt is not null and expiresAt < now   (cascades to messages)
ownerMessage.deleteMany  where expiresAt        < now
```

`Identity` rows are never deleted here: they hold a random ID and timestamps, and deleting one would cascade away the reports describing abuse it may have committed. The archive's `expiresAt` is only ever set when the owner chose a non-zero `retentionDays`; the same query is reachable on demand as `POST /api/v1/admin/archives/delete-expired`, because the interval is zero in tests and the sweep is not otherwise callable.

---

## 7. Realtime protocol

The contract is `packages/protocol` (`events.ts`, `payloads.ts`). `PROTOCOL_VERSION = 1`; `session:ready` carries it and the browser shows an "update the page" notice on a mismatch.

**Ack contract.** Every client event may carry an acknowledgement callback, and the server answers exactly one shape:

```ts
type AckResult<T> = { ok: true; data: T } | { ok: false; error: ErrorPayload };
interface ErrorPayload { code: ErrorCode; message: string; context?: string }
```

`ChatGateway.guard()` calls `ack({ ok: true, data })` on success; on failure it calls `ack({ ok: false, error })` if a callback was supplied, otherwise it pushes the same payload as `app:error` to that one socket. Client→server events are `match:join`, `match:cancel`, `chat:message`, `chat:leave`, `chat:next`, `request:send`, `request:respond`, `report:send`, `block:peer`.

**Push events.** `ServerEvent` defines `session:ready`, `session:rotated`, `match:queued`, `match:cancelled`, `match:relaxed`, `chat:started`, `chat:resumed`, `chat:message`, `chat:peer-away`, `chat:peer-back`, `chat:ended`, `request:incoming`, `request:resolved`, `peer:blocked`, `app:error`. The chat domain never imports the gateway: state changes are published as `AppEvent`s on `AppEventBus` (`apps/api/src/events/app-events.ts`) and rendered by `ChatGateway.onAppEvent`, once per socket, in `chat.views.ts`. That is why a message reads as `from: 'you'` for its sender and `from: 'peer'` for everyone else, and an end reason as `left` to the leaver and `peer_left` to the peer.

**The server is authoritative.** The client never decides who sees what: every send, join, leave, block and report is authorised in `ChatService` against the registry's participant list, and the gateway only validates shape and rate limits. `reportChat` takes the `messageSnapshot` from the server's own copy of the message; `block:peer` is keyed by `chatId` because a random chat must not reveal the peer's User ID; and `ChatRecord.revealPublicId` returns `undefined` for every random chat, so no call site can disclose it by forgetting a check.

**Duplicate and out-of-order absorption.** The protocol is idempotent where retries are normal: `ChatRecord.append` keys on `(senderId, clientMessageId)` and returns `duplicate: true` for a replay, which is acknowledged but not broadcast again; `store.receiveMessage` replaces the optimistic bubble in place for a matching `clientMessageId` and otherwise skips a `messageId` already present; `store.confirmMessage` reconciles by `clientMessageId`, so ack and echo are idempotent in either order; `store.startChat` is a no-op when the same `chatId` is already current (both `chat:started` and `request:resolved` can announce one chat); and `store.endChat` ignores a `chat:ended` whose `chatId` is no longer current.

---

## 8. Web app structure

**Store vs. components.** `apps/web/src/store/app-store.ts` is a Zustand store describing what is on screen — connection, session, chat, messages, search criteria, direct requests, notices. It holds render state only and never talks to the network; components read the store and never open the socket themselves.

**The singleton client.** `apps/web/src/lib/anonymous-client.ts` exports `const client = new AnonymousClient()`. It is a module-level singleton because the anonymous identity is a single cookie, so a second socket would only multiply connections for one user (and hit `MAX_SOCKETS_PER_USER`). It owns REST bootstrap (`boot`, `retryBoot`, `rotateIdentity`), the socket and its reconnect policy (`openSocket`, `reconnectSoon`, the `MAX_SERVER_CLOSE_RETRIES` guard against a reconnect loop), translation of every server push into store actions, the imperative commands the UI calls (`startMatching`, `sendMessage`, `leaveChat`, `nextPeer`, `requestDirect`, `respondToRequest`, `reportCurrentChat`, `blockCurrentPeer`) and `command<T>()`, which emits an event and resolves on the ack with a 12 s timeout (`COMMAND_TIMEOUT_MS`). Server state the server owns (block list, User ID lookup, settings) is cached by TanStack Query (`apps/web/src/components/app-providers.tsx`); the live conversation is not, because Socket.IO already pushes it and a cache would be a second source of truth.

**Error code → Russian text.** The server sends codes and English messages; the UI renders its own text keyed by the stable `ErrorCode`, in the interface language. `apps/web/src/lib/error-text.ts` holds the `ERROR_TEXT`, `CHAT_END_TEXT`, `REQUEST_STATUS_TEXT`, `MATCH_CANCEL_TEXT` and `REPORT_REASON_LABELS` key maps, and `describeError` falls back to the server message only for codes it does not know. `ApiError` (`apps/web/src/lib/http.ts`) carries `code`, `status` and `context`; a thrown `fetch` (offline or CORS) becomes `DATABASE_UNAVAILABLE` with `status: 0`.

**Interface languages.** `apps/web/src/i18n/` is the whole translation seam: `config.ts` (three locales, native names, cookie/storage helpers), `messages.ts` (the dictionaries, with the Russian sentence as the key, `en` as the key set, `zh` typed against it and a module-load placeholder check), `index.tsx` (`I18nProvider`, `useI18n`, and `activeT` for code outside React) and `site.ts` (per-locale title/description). `app/layout.tsx` reads the `anonlink.locale` cookie to render `<html lang>` and metadata, so the document is correct before hydration; the switch writes the cookie and a `localStorage` mirror. There is no locale in the URL and no server-side message catalogue: the API is language-neutral, and the browser maps its codes to the chosen language. `/admin` deliberately stays Russian and forces `<html lang="ru">` while mounted (D32).


**How a disconnect is rendered.** `ConnectionStatus` is `booting | connecting | connected | reconnecting | offline | rejected`, and `apps/web/src/components/connection-badge.tsx` maps each to a Russian label, variant and icon, announced via `aria-live="polite"`. Transport drops set `reconnecting` ("Соединение потеряно. Восстанавливаем…") and Socket.IO reconnects on its own; a server-initiated close retries a bounded number of times before `offline`; a refusal (`IDENTITY_BANNED`, `FORBIDDEN_ORIGIN`, `TOO_MANY_CONNECTIONS`) sets `rejected` and stops the loop. A *peer's* disconnect is separate: `chat:peer-away` / `chat:peer-back` toggle `peerAway` and append a system message, because disconnecting is not leaving.

**The owner's page, outside the product.** `apps/web/src/app/admin/page.tsx` (server, `noindex`) renders `apps/web/src/components/admin-screen.tsx` (client). It is the one screen that does not go through the Zustand store or the singleton socket: it talks to the admin REST routes with `apiRequest` and holds its state in TanStack Query plus local `useState`. Nothing in the product links to it — users are told nothing about archiving — and its only credential is the `anonlink_admin` cookie the server sets. It is also the one screen that is always Russian, whatever the public interface language is; the client corrects `<html lang>` on mount. `admin-screen.tsx` mirrors the policy schema's cross-field rules so the owner sees *why* a save is refused instead of a generic error; the server re-validates everything.

---

## 9. Cross-cutting concerns

**Configuration and validation.** `loadConfig` in `apps/api/src/config/env.ts` walks up (at most 8 directories) to find the single root `.env`, validates the whole environment with Zod, and throws one consolidated error listing every problem. In production it additionally requires `COOKIE_SECURE=true` and rejects plain `http://` origins. The result is frozen and injected via the `APP_CONFIG` symbol by the global `ConfigModule`. A missing variable fails at boot, not at first use; there is no `get('X') as T` accessor.

**Error contract.** `HttpErrorFilter` (`apps/api/src/common/http-error.filter.ts`) shapes every HTTP failure as `{ error: { code, message, context? } }`. Only `AppError` — and explicit `HttpException`s, mapped onto shared codes — influences status and message; anything else is logged with a correlation id and returned as a generic `INTERNAL_ERROR`. `AppError` (`apps/api/src/common/app-error.ts`) maps each `ErrorCode` to a default status and message. Rate-limit failures add a `Retry-After` header derived from a `retry-after-ms:<n>` context.

**Rate limiting.** `RateLimitService` (`apps/api/src/common/rate-limit.service.ts`) is a per-process token-bucket limiter with five buckets — `http` (120/min), `sessionCreate` (30/hour), `chatMessage` (20/10 s), `lookup` (20/min), `connectRequest` (10/min) — all configurable and used by both the HTTP and socket guards. Keys are the authenticated `identity:<id>` where known, otherwise the address, and each bucket has a `maxKeys` cap so attacker-controlled keys cannot grow memory without bound. State is per process, so a multi-instance deployment would enforce a separate budget per instance.

**Logging.** `apps/api/src/common/logger.ts` is the only logging entry point. `SafeLogger` restricts metadata to primitives and redacts a forbidden-key list (`text`, `token`, `cookie`, `DATABASE_URL`, `note`, `details`, `messageSnapshot`, `ip`, `userAgent`, …), so a message body or secret cannot be dumped into a log line by accident; `log.security(...)` marks low-volume abuse signals. Prisma query logging is disabled because parameters can contain a report snapshot.

---

## 10. Known limits and the seams for growth

Everything here is **not built**. Each item names the exact file where the seam lives, or states plainly that there is no seam.

- **Redis-backed queue / multiple instances.** The seam is the header comment of `apps/api/src/chat/chat.matching.ts`, which names the methods a Redis/Valkey implementation would reproduce (`enqueue`, `cancel`, `claimOrEnqueue`, `relaxationDue`, `sweep`) and suggests Lua or `WATCH`/`MULTI` for the claim step. Nothing outside that file assumes in-memory storage, but `PresenceService` (`apps/api/src/presence/presence.service.ts`), the per-process rate limiter and the process-local `AppEventBus` would *also* need shared implementations, and there is no seam for those. `/health/ready` reports `singleInstance: true` (`apps/api/src/health/health.controller.ts`) so the constraint is visible at runtime.
- **Direct-request persistence across restarts.** `apps/api/src/chat/chat.requests.ts` keeps invitations in memory for 60 s by design; making them durable needs a mailbox and a notification model that do not exist.
- **Media / attachments.** Not built, and there is **no dedicated code seam**. The only note is `docs/PRODUCT_SPEC.md` (message length and storage are not tied to text, described as "architecturally prepared" but explicitly not "almost done"). Implementation would be new work in `apps/api/src/chat/chat.registry.ts`, `packages/shared/src/schemas.ts` and `packages/protocol`. The archive's `storeMedia` flags and `ArchivedMessage.mediaKind`/`mediaRef` columns exist and are deliberately inert — they record nothing, because nothing produces an attachment yet.
- **Moderation tooling.** The durability exists (`Report`, `SecurityEvent`, `ModerationService`'s `createReport`, `recordSecurityEvent` and an operator-only `ban()`), and the owner now has one HTTP surface for moderation: `GET /admin/reports`, `PATCH /admin/reports/:id` (status only) and `GET/PUT /admin/platform` on the guarded `AdminController`, rendered in `/admin` (D31). What is still missing is an **account model**: the key is one shared secret, so a moderator cannot have their own identity or audit trail, and `ban()` is still called from server code only, with no endpoint. The next step is a new module alongside `apps/api/src/moderation/`, not a bigger `AdminController`.
- **Scaling, load testing, backups, monitoring, HTTPS.** None present. This is a single Node process with in-process matchmaking, chats and presence; that is the honest ceiling of the current design. `docs/PRODUCT_SPEC.md` §23 lists the same gaps (shared queue, shared presence, sticky connections or cross-process events).
- **Minors guarantee.** There is none: age *filters* impose no floor (`packages/shared/src/preferences.ts`, `PROFILE_LIMITS.AGE_MIN = 0`), a declared birth year is unverified, and `docs/DECISIONS.md` (D18 → D20) records the policy as the owner's choice (no age restriction) rather than a guarantee.
- **Archive encryption / key management.** The archive is plaintext in PostgreSQL, guarded only by `ADMIN_TOKEN` (`docs/DECISIONS.md` D21, `docs/SECURITY.md` §13). There is no encryption at rest, no key rotation and no second factor; nothing in `apps/api/src/archive/` assumes encryption, so adding it is new work rather than a seam.

---

## Facts a reader can verify

- **Strict, mutual filters and the ladder** — `packages/shared/src/preferences.ts`: `preferencesFit`, `mutuallyCompatible`, `RELAXABLE_CRITERIA`, `relaxBySteps`; exercised by `packages/shared/src/preferences.test.ts`.
- **In-process queue + the Redis seam** — `apps/api/src/chat/chat.matching.ts`: the class comment ("Why an in-memory queue and not Redis") and `claimOrEnqueue`.
- **Directory fails closed** — `apps/api/src/directory/directory.service.ts`: `sides` returns `null` for an unknown side; `isEligible` in `apps/api/src/chat/chat.service.ts` treats that as not eligible.
- **No transcripts by default** — `apps/api/prisma/schema.prisma`: eight product models (including `PlatformPolicy`, which holds no user content) and no message-body column outside the archive, plus `OwnerMessage`, which stores text the user deliberately addressed to the owner; `apps/api/test/persistence.test.ts` scans every text column for a sent message on a default installation.
- **Blocking is a platform switch, off by default** — `apps/api/src/platform/platform.service.ts` (`blockingEnabled` starts `false`, a missing row means `false`), `apps/api/prisma/migrations/20261020120000_platform_policy/migration.sql`, and `apps/api/test/unit/platform.test.ts`; the refusal path is `ChatService.assertBlockingAllowed` (`apps/api/test/platform.test.ts`).
- **The archive is opt-in and owner-only** — `apps/api/src/archive/archive.service.ts` (`shouldArchive`, `recordMessage`), `admin.guard.ts` (404 when `ADMIN_TOKEN` is unset, 401 otherwise) and `apps/api/test/archive.test.ts`.
- **The owner's inbox is bounded and told** — `apps/api/src/owner/owner.service.ts` (`create` sets `expiresAt` from `OWNER_MESSAGE_RETENTION_DAYS`), `apps/web/src/components/contact-owner-dialog.tsx` (the text the user reads before sending) and `apps/api/test/owner-messages.test.ts`.
- **Relaxation only from the maintenance sweep** — `apps/api/src/maintenance/maintenance.service.ts` (`runOnce` calls `chat.relax`) and `apps/api/src/chat/chat.service.ts` (`relax`); compare `apps/api/test/support/test-env.ts` (`MATCH_RELAX_AFTER_MS=0`) with `tests/e2e/env.ts` (`4000` / `2000` / `250`).
- **HTTP guard order** — `apps/api/src/identity/request.guard.ts`: origin → identity → rate limit → authorisation, with `@Anonymous()` in `apps/api/src/identity/request-context.ts`.
- **Realtime boundary** — `apps/api/src/realtime/chat.gateway.ts`: `guard()` (validation + ack shape) and `onAppEvent` (per-socket rendering); event names in `packages/protocol/src/events.ts`.
- **Validated frozen config** — `apps/api/src/config/env.ts`: the Zod `envSchema`, defaults and production checks; injected via `APP_CONFIG` in `apps/api/src/config/config.module.ts`.
- **Russian error text keyed by code** — `apps/web/src/lib/error-text.ts` (`ERROR_TEXT`) and the singleton client `apps/web/src/lib/anonymous-client.ts`.
