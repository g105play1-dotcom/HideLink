# Security

What AnonLink protects, how, and — importantly — what has **not** been verified. This document is
written from the code, not from intentions: every claim names the file that implements it. Where a
property depends on the deployment, it says so and points at `infrastructure/README.md`.

## 1. How to read this document

Three kinds of statements appear here, and they are labelled:

- **Implemented** — the code does this today, and a test or a read of the code confirms it.
- **Depends on the deployment** — true only if the operator configures things correctly (HTTPS,
  proxy handling, secrets outside the repository).
- **Not verified** — no test, no audit, no load test. These are collected in §14.

AnonLink has **not** been penetration-tested, load-tested, backed up or monitored. Nothing in this
file should be read as a claim that it is safe to run publicly as-is.

## 2. What AnonLink refuses to store

The privacy posture is a storage decision, not a policy paragraph.

| Data | Stored? |
| --- | --- |
| Chat messages | **Never.** In-memory only, bounded by `CHAT_MEMORY_MESSAGE_LIMIT`, dropped when the chat ends. |
| Who talked to whom | **Never** as a transcript. `ChatSession` records only lifecycle metadata (participants, start/end, `messageCount`, end reason). |
| Message text of a reported message | Only inside the abuse report, until `REPORT_RETENTION_DAYS` (default 30) elapses, then hard-deleted. |
| Name, e-mail, phone, address, GPS, device id | **Never asked for, never stored.** There is no code path that accepts them. |
| Client IP / User-Agent | **Not stored by default.** Only a salted SHA-256 digest, and only when `ABUSE_HASH_SALT` is deliberately set. |
| Session token | Only its SHA-256 digest (`IdentityService.createIdentity` → `sha256Hex(token)`). |
| Public User ID, settings, blocks, reports, security events | Stored. These are the only durable rows. |

`apps/api/test/persistence.test.ts` reads the database directly and searches every text column of
every table for a message that was just sent; it also asserts the column set of `Identity` and
rejects columns whose names imply captured contact data. It is the enforcement mechanism for the
table above — do not weaken it.

## 3. Threat model

**Assets.** (a) the content of a live chat; (b) the link between a public User ID and a person;
(c) the session cookie; (d) a user's declared profile/filters and availability setting; (e) the
integrity of moderation (blocks and reports must mean something).

**Adversaries considered.**

| Adversary | Considered, and how it is met |
| --- | --- |
| A stranger who knows (or guesses) a User ID | The ID is not a credential: `GET /users/:publicId` returns existence and request policy only; lookups are rate limited per identity. |
| Another user in the same random chat | Authorisation is per chat and per participant; messages are rendered per socket (`from: 'you' \| 'peer'`); the peer's User ID is never sent. |
| A third party who learns a `chatId` | Joining, sending into, ending or blocking in someone else's chat is refused with `NOT_A_PARTICIPANT` / `CHAT_NOT_FOUND`. Covered by `apps/api/test/chat.test.ts` and `tests/e2e/specs/access.spec.ts`. |
| A malicious web page in the same browser | `SameSite=Lax` cookie + exact `Origin` allow-list on state-changing HTTP requests and on the WebSocket handshake. |
| An abuser with automation | Token-bucket rate limits per identity and per address, socket cap per identity, message length and payload ceilings, block/report. |
| Someone who exfiltrates the database | No transcripts to find; session rows hold digests, not tokens; no client identifiers unless the operator opted in. |
| An authenticated user probing the API | One global guard, one validation path, error codes instead of messages. |

**Out of scope.** A compromised server process or database while running (it holds plaintext chats
in memory by design); a malicious operator; traffic analysis; end-to-end encryption, which AnonLink
does not implement; and anything requiring identity verification, which does not exist.

## 4. Identity and sessions

**Implemented.**

- An identity is created with `POST /session`; there is no credential to choose, so there is no
  password to leak or reuse (`apps/api/src/identity/identity.service.ts`).
- The session token is 32 CSPRNG bytes, base64url (`apps/api/src/common/ids.ts`). The database stores
  `sha256(token)` only; the raw token exists in the `Set-Cookie` header and nowhere else.
- The cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`; `Secure` is added when `COOKIE_SECURE=true`,
  which production **requires** (`loadConfig` refuses to start otherwise).
- Sessions expire absolutely after `SESSION_TTL_DAYS` (default 30). `identify()` returns `null` for
  an unknown, revoked or expired token — all three are indistinguishable to a client.
- A banned identity is rejected on every HTTP route (guard step 2) and on the WebSocket handshake,
  before any handler exists.
- `DELETE /session` revokes every session of the identity and issues a **new** identity
  ("Новый ID"). The old User ID keeps its existing blocks and reports, so rotating an ID is not a
  way to escape a block or a report.
- The public User ID is never accepted as proof of anything: no route or event takes it as a
  credential. Format is `AL` + 12 Crockford Base32 characters, generated with a CSPRNG and backed by
  a unique index with a retry loop.

**Depends on the deployment.** Over plain HTTP the cookie can be read by anyone on the path. There is
no HTTPS in local development, and no TLS termination in this repository that has been tested.

## 5. Authorisation: the server decides

**Implemented.** Every rule about who may see, send, join or be matched lives in `apps/api`:

- `RequestGuard` (`apps/api/src/identity/request.guard.ts`) runs for every HTTP request as a global
  guard: Origin → identity resolution → rate limit → authentication, which fails closed unless a
  route explicitly opts out with `@Anonymous()` (only `POST /session` and the health endpoints do).
- `ChatService` is the only writer of chat state and re-checks participation on every inbound event:
  `sendMessage`, `leaveChat`, `reportChat`, `blockPeerOfChat` all begin with
  `registry.get(chatId)` + `hasParticipant(userId)`.
- `ChatService.isEligible` is the single place that decides whether two identities may be paired:
  active-chat check, ban check, block check (both directions), then mutual filter compatibility. It
  is synchronous, so it cannot interleave with another match.
- Render views are built per recipient (`apps/api/src/chat/chat.views.ts`, `buildChatView` /
  `buildMessageView`), which is where "the peer's User ID is never disclosed in a random chat" is
  enforced rather than documented.
- The realtime gateway forwards only `AppError` messages to clients; anything else becomes a generic
  `INTERNAL_ERROR` plus a short correlation id that is logged server-side
  (`ChatGateway.toErrorPayload`).

## 6. Input validation and size limits

**Implemented.** Validation is defined once, in `packages/shared/src/schemas.ts`, and applied to all
three callers: the browser (for immediate feedback), the REST pipes
(`zodBody`/`zodParam`/`zodQuery` in `apps/api/src/common/zod-validation.pipe.ts`) and every WebSocket
event (`schema.safeParse` inside `ChatGateway.guard`). Unknown fields are rejected by the strict
schemas, so a client cannot smuggle extra columns into a settings write.

| Limit | Value | Where |
| --- | --- | --- |
| Chat message | `MESSAGE_MAX_LENGTH` (default 2000), hard ceiling 4000 | `env.ts`, `sanitize.ts` |
| Message too long | Rejected with `MESSAGE_TOO_LONG`, never silently truncated | `chat.service.ts` |
| JSON body | 64 kB | `main.ts` |
| Form body | 16 kB | `main.ts` |
| Socket packet | 64 kB (`maxHttpBufferSize`) | `socket-io.adapter.ts` |
| `clientMessageId` | `[A-Za-z0-9_-]{1,64}` | `packages/shared` |
| Report details / request note | schema-capped, and the abuse-hash fields are redacted from logs | `packages/shared`, `logger.ts` |

`sanitizeMessageText` removes control and zero-width characters, caps blank-line runs, and truncates
by code point rather than by UTF-16 unit, so an emoji is never split.

## 7. Rate limiting and abuse controls

**Implemented** (`apps/api/src/common/rate-limit.service.ts`). Token buckets, in process, keyed by
identity when known and by client address otherwise:

| Bucket | Default | Applies to |
| --- | --- | --- |
| `http` | 120/min | every HTTP request, after identity resolution |
| `sessionCreate` | 30/hour | `POST /session` |
| `chatMessage` | 20/10 s | `chat:message` |
| `lookup` | 20/min | `GET /users/:publicId` |
| `connectRequest` | 10/min | `request:send` |

Plus: `MAX_SOCKETS_PER_USER` (default 4) simultaneous sockets per identity, enforced at the handshake
*before* the socket joins any room; `MAX_PENDING_REQUESTS_PER_USER` (default 3) pending outgoing
direct requests; and a reconnect grace of `PEER_RECONNECT_GRACE_MS` before a chat is abandoned.

Two deliberate properties:

- **Rate-limit trips are not written to the database.** They are the most frequent hostile event
  there is, and recording them would let an attacker turn the database into a write amplifier — and
  would itself be a log of who was doing what. `ModerationService.recordSecurityEvent` is only called
  for low-frequency events (blocks, reports, self-contacts, bans).
- **Buckets are per process.** With several API instances, each enforces its own budget. That is
  acceptable for the abuse levels this service targets and is stated rather than implied.

## 8. Transport, browser policy and headers

**Implemented.**

- The browser talks to the API origin directly; there is no Next.js proxy. `CORS_ORIGINS` is one
  exact allow-list used for CORS (`main.ts`, `credentials: true`) *and* for the socket handshake
  (`socket-io.adapter.ts`, `allowRequest`). A wildcard would be rejected by the browser for
  credentialed requests anyway, and the code never uses one.
- `Reply` headers on every API response (`SecurityHeadersInterceptor`):
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Resource-Policy: same-site`, `Cross-Origin-Opener-Policy: same-origin`,
  `Permissions-Policy: geolocation=(), camera=(), microphone=()`, `Cache-Control: no-store`, and
  `X-Powered-By` removed. `Strict-Transport-Security` is added only when `NODE_ENV=production`.
- The Web front end sets no cookie of its own and reads the session only through the API; the
  browser never has access to the token (it is `HttpOnly`), which is why an XSS cannot steal a
  session — though it could still *use* one for the lifetime of the page, which is the standard
  limitation and is not mitigated.
- CSRF relies on two independent layers: `SameSite=Lax` and the Origin allow-list on non-safe
  methods. A missing `Origin` header is accepted because non-browser clients cannot borrow a
  browser's cookie jar (`apps/api/src/common/origin.ts`).

**Depends on the deployment.** `TRUST_PROXY=true` must be set *only* behind a proxy that overwrites
`X-Forwarded-For`; enabling it while the API is directly reachable lets a client forge its own
address and escape per-address limits. `COOKIE_SECURE=true` requires real HTTPS.

## 9. Lookup by User ID: enumeration and privacy

**Implemented.** `GET /users/:publicId` returns exactly `{ publicId, exists, acceptsRequests }`
(`IdentityService.lookupByPublicId`). It deliberately returns **no** presence information: "online
now" would turn the endpoint into a tracking oracle for any known ID. Unknown and known-but-offline
targets are indistinguishable from the response.

Cost is flat: a single indexed `findUnique` on a unique column, so timing does not reveal existence.
The endpoint is authenticated (the global guard requires an identity) and rate limited per identity
(20/min), which limits both enumeration and its usefulness. Sending a direct request to someone who
is offline, banned, has requests disabled, or has blocked you is a targeted check rather than a
lookup: each of those paths records a coarse security event and returns a deliberately uninformative
error to the requester (a blocked user must not be able to tell "blocked" from "busy", or blocking
would become a way to send a message).

## 10. Blocks, reports and bans

**Implemented.**

- A block is directional and durable (`Block` table). Matchmaking consults blocks on *every* pairing
  attempt from the in-memory directory cache, and direct requests check the database — so
  reconnecting, rotating a socket or restarting a tab does not bypass a block.
  `tests/e2e/specs/access.spec.ts` and `apps/api/test/moderation.test.ts` cover it.
- Blocking the peer of a chat also ends that chat and cancels any pending invitation between the two
  (`ChatService.blockPeerOfChat`).
- A block cannot be used as a probe: `blockByPublicId` refuses a target that does not exist with the
  same `USER_NOT_FOUND` as the lookup, and self-block is refused explicitly.
- A report ends the chat, takes its message snapshot from the server's own copy (never from client
  input), and is hard-deleted after `REPORT_RETENTION_DAYS`.
- `ModerationService.ban` marks the identity, revokes all its sessions, and the guard then refuses it
  everywhere. **Honest limitation:** banning an anonymous identity cannot outlast the identity. There
  is no registration and no device fingerprint (deliberately), so a banned person who clears cookies
  starts over. Bans are a speed bump for abuse, not a ban of a human, and no code claims otherwise.

## 11. Privacy *inside* a chat

**Implemented.**

- In a random chat the peer sees a per-chat alias (`Stranger 7K3M`, derived from fresh random bytes
  per chat) and never a User ID. Two chats with the same person share no identifier, so chats cannot
  be correlated (`apps/api/src/common/ids.ts`, `chat.views.ts`).
- Message views are built per recipient; the sender sees `from: 'you'` in every one of their tabs.
- Direct contact by User ID is the deliberate exception: the person you ask **does** see your User
  ID, because you typed theirs. The interface states this above the input, before the button is
  pressed (`apps/web/src/components/direct-panel.tsx`).
- Declared profile and filters are never returned to another identity: no view type exposes them, and
  `ChatSession`/`Report` are the only places two identities are linked.
- The typing indicator was dropped from the MVP rather than shipped: it leaks activity patterns to
  the peer and has no privacy story that justifies it yet (see `docs/DECISIONS.md`).

## 12. Retention and deletion

**Implemented** by `MaintenanceService.runOnce` (`apps/api/src/maintenance/maintenance.service.ts`),
which is the enforcement point for every deadline in the schema:

| Data | Deleted |
| --- | --- |
| Abuse reports (with message snapshot) | after `REPORT_RETENTION_DAYS` (30) |
| Security events | after `SECURITY_EVENT_RETENTION_DAYS` (90) |
| Sessions | after `SESSION_RETENTION_DAYS` (7) past expiring or being revoked |
| Finished chats in memory | after their tombstone expires (`ChatRegistryService.sweep`) |
| Stale queue tickets, expired requests, rate-limit keys | every sweep |

`Identity` rows are deliberately **never** deleted: they hold a random public ID and timestamps, no
personal data, and deleting one would cascade away the reports that describe the abuse it may have
committed. The consequence is that a "deleted" account is not a thing — a user who wants a fresh
start gets a new identity, and the old row remains as an abuse record.

The sweep interval is `MAINTENANCE_INTERVAL_MS` (default 15 s). Setting it to `0` disables retention
entirely, which the integration tests use on purpose — a production deployment must not do that.

## 13. Storage policy for chat archives

The brief asked for an administrative switch that can enable or disable storing and viewing chat
archives. **There is no such switch, because there are no archives**: AnonLink is built so a
transcript cannot be produced (see §2 and `docs/DECISIONS.md` D1). Implementing the switch would
mean implementing transcript storage, which reverses a headline promise of the product; that is an
owner decision, recorded in `docs/ROADMAP.md`, not a gap an engineer should quietly close.

What an operator *can* control today: retention periods (§12), whether client identifiers are hashed
at all (`ABUSE_HASH_SALT`), and who may hold a database backup. There is no moderation console, and
moderators cannot read a conversation — a report carries only the single snapshotted message that was
reported.

## 14. Known gaps and what must happen before a public deployment

Each item says what is missing and how it would be verified. None of them is a formality.

1. **HTTPS with `COOKIE_SECURE=true`** and an https-only `CORS_ORIGINS`. The API refuses to start in
   production without both, but nothing in this repository has terminated TLS.
   *Verify:* deploy behind a proxy, then confirm the cookie carries `Secure` and a plain-http origin
   is rejected at boot.
2. **Reverse proxy with `TRUST_PROXY=true`** and a proxy that overwrites `X-Forwarded-For`.
   *Verify:* send a request with a forged `X-Forwarded-For` and confirm the rate limiter does not
   treat it as a different client.
3. **Secrets outside the repository.** `DATABASE_URL` (and `ABUSE_HASH_SALT`, if used) from the
   environment or a root-owned file.
   *Verify:* `git log -p` shows no credential; the deployed file is mode `600` and owned by the app
   user.
4. **Backups and a rehearsed restore.** Nothing important is duplicated today.
   *Verify:* restore last night's dump into a scratch database and count rows in `Identity`, `Block`
   and `Report`.
5. **Monitoring and alerting** for `GET /api/v1/health/ready`, process restarts, and `security:` log
   events (blocks, reports, origin rejections). There is a logger; nothing watches it.
   *Verify:* stop the API and confirm a person is told within a minute.
6. **A load test.** No numbers exist for concurrent chats, memory per chat, or matchmaking latency
   under load, so no scaling claim is made anywhere.
   *Verify:* a repeatable script with a documented result, run before any capacity decision.
7. **Dependency audit.** `pnpm audit --audit-level high` is wired into CI
   (`.github/workflows/ci.yml`) but has never been executed in this environment (no registry access
   from the build machine, and no CI runner has run at all).
   *Verify:* run the security job once and read its output.
8. **A penetration test** by someone other than the author, covering authorisation on the socket
   surface, enumeration, and the redirect candidate list of abuse paths.
   *Verify:* an external report with findings and retests.
9. **A moderation process.** Who acts on a report, within what time, and with what authority. The
   code produces reports; nothing consumes them.
10. **No age gate, by decision.** The owner decided (2026-10-19, `docs/DECISIONS.md` D20) that the
    service imposes no age restriction and that users choose their own filter bounds. Declared age
    remains unverified and is not verifiable. The consequence, recorded rather than hidden: someone who
    declares themselves a minor can be matched with an adult. If that becomes unacceptable, the options
    are a rules/moderation policy or an age gate — neither is built, and neither is claimed here.
11. **Log review.** `SafeLogger` structurally redacts forbidden keys, but no test asserts that a
    given code path cannot log an unexpected field. Treat log content as reviewed-by-reading only.
12. **No CSRF token.** `SameSite=Lax` plus the Origin allow-list is the whole defence. A browser
    that ignores `SameSite` (or a same-site subdomain takeover) would defeat it.
13. **The retention sweep itself has no test.** `MaintenanceService.runOnce` is the enforcement point
    for every deadline in §12, but no test advances a clock and asserts a deletion — the integration
    suite disables the interval on purpose, and the E2E stack only exercises the filter-widening half
    of the sweep. *Verify:* an integration test that calls `runOnce` with a moved clock and counts the
    rows it removed (see `docs/TESTING.md` §6).

## 15. Facts a reader can verify

```powershell
# The session cookie's attributes and the shape of the response
pnpm dev
curl.exe -i -X POST http://localhost:3001/api/v1/session -H 'Origin: http://localhost:3000'

# Nothing about a chat transcript is stored (reads the database, fails if any column holds the text)
pnpm --filter @anonlink/api test test/persistence.test.ts

# Blocks survive a reconnect; a third party cannot touch someone else's chat
pnpm --filter @anonlink/api test test/moderation.test.ts
pnpm test:e2e -- specs/access.spec.ts

# Rate-limit behaviour, in isolation
pnpm --filter @anonlink/api test test/unit/rate-limit.test.ts

# Production configuration checks (point .env at production to see the refusal)
Get-Content apps/api/src/config/env.ts
Get-Content apps/api/src/identity/request.guard.ts
```
