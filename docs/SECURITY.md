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
| Chat messages | **Only if the owner switches archiving on** — it is off by default. Otherwise in memory only, bounded by `CHAT_MEMORY_MESSAGE_LIMIT`, dropped when the chat ends. The archive is described in §13. |
| Who talked to whom | `ChatSession` always records lifecycle metadata (participants, start/end, `messageCount`, end reason) — never text. A transcript exists only for chats the owner's archive policy selected (§13). |
| Message text of a reported message | Only inside the abuse report, until `REPORT_RETENTION_DAYS` (default 30) elapses, then hard-deleted. The client sends the id of the last message it holds; the server copies the text from its own chat state, so the reporter cannot forge it. |
| Message text sent through "Связаться с администрацией" | **Yes, on purpose** — the user asked a human to read it, and is told so before sending. Bounded by `OWNER_MESSAGE_MAX_LENGTH`, deleted after `OWNER_MESSAGE_RETENTION_DAYS` (default 180), readable only with `ADMIN_TOKEN` (§13.1). |
| Name, e-mail, phone, address, GPS, device id | **Never asked for, never stored.** There is no code path that accepts them. |
| Client IP / User-Agent | **Not stored by default.** Only a salted SHA-256 digest, and only when `ABUSE_HASH_SALT` is deliberately set. |
| Session token | Only its SHA-256 digest (`IdentityService.createIdentity` → `sha256Hex(token)`). |
| Public User ID, settings, blocks, reports, **friendships**, security events | Stored. These are the only durable rows (plus the optional archive). A friendship is just two internal identities and a creation timestamp — no alias, transcript, presence or contact data. |

`apps/api/test/persistence.test.ts` reads the database directly and searches every text column of
every table for a message that was just sent; it also asserts the column set of `Identity` and
rejects columns whose names imply captured contact data. It is the enforcement mechanism for the
*default* installation — archiving off, nothing stored. `apps/api/test/archive.test.ts` is the other
half: it turns the archive on, proves what is stored and for whom, and proves that switching it off
stops recording immediately. Neither file should be weakened. `apps/api/test/owner-messages.test.ts`
covers the deliberate text of §13.1, which is written by the user rather than captured, and is the
only stored text a user is told about.

## 3. Threat model

**Assets.** (a) the content of a live chat; (b) the link between a public User ID and a person;
(c) the session cookie; (d) a user's declared profile/filters and availability setting; (e) the
integrity of moderation (blocks and reports must mean something); (f) the social graph — which two
identities agreed to be friends.

**Adversaries considered.**

| Adversary | Considered, and how it is met |
| --- | --- |
| A stranger who knows (or guesses) a User ID | The ID is not a credential: `GET /users/:publicId` returns existence and request policy only; lookups are rate limited per identity. |
| Another user in the same random chat | Authorisation is per chat and per participant; messages are rendered per socket (`from: 'you' \| 'peer'`); the peer's User ID is never sent. A friend request is visible only to the two participants and is answered inside the live chat. |
| A third party who learns a `chatId` | Joining, sending into, ending or blocking in someone else's chat is refused with `NOT_A_PARTICIPANT` / `CHAT_NOT_FOUND`. Covered by `apps/api/test/chat.test.ts` and `tests/e2e/specs/access.spec.ts`. |
| A friend or an ex-friend | A friendship reveals the other User ID and the date, nothing else: no presence, no transcript, no "message" channel. Either side can remove the link; the other side is told, but not who else they know or when they are online. Blocking, reporting or rotating an ID severs the link. |
| A forged social-network launch proof (planned) | Nothing accepts one today. The planned contract requires server-side HMAC/signature verification and a server-issued token; a browser-asserted `externalId` is never trusted (`docs/INTEGRATIONS.md`). |
| A malicious web page in the same browser | `SameSite=Lax` cookie + exact `Origin` allow-list on state-changing HTTP requests and on the WebSocket handshake. |
| An abuser with automation | Token-bucket rate limits per identity and per address, socket cap per identity, message length and payload ceilings, block/report. Friend requests reuse the `connectRequest` budget and are capped at one per chat. |
| Someone who exfiltrates the database | Session rows hold digests, not tokens; no client identifiers unless the operator opted in. Transcripts exist only where the owner's archive selected them, and those are **plaintext** (§13) — the archive is the one asset a database thief would want. Friendships reveal the pair and date, not the conversation. |
| An authenticated user probing the API | One global guard, one validation path, error codes instead of messages. |

**Out of scope.** A compromised server process or database while running (it holds plaintext chats
in memory by design); a malicious owner — the archive (§13) is readable by whoever holds the owner
key, so users are *not* protected from the operator, only from each other and from strangers; traffic
analysis; end-to-end encryption, which AnonLink does not implement; and anything requiring identity
verification, which does not exist.

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
  way to escape a block or a report. Its friendships are deleted silently: notifying old contacts
  would announce that the person used the panic button (`docs/DECISIONS.md` D34).
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
| Friend request / answer | `chatId` must be a UUID, one request per chat, only the addressee may answer | `packages/shared`, `chat.service.ts` |

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
| `connectRequest` | 10/min | `request:send` and `friend:request` |

Plus: `MAX_SOCKETS_PER_USER` (default 4) simultaneous sockets per identity, enforced at the handshake
*before* the socket joins any room; `MAX_PENDING_REQUESTS_PER_USER` (default 3) pending outgoing
direct requests; `FRIEND_REQUEST_TTL_MS` (60 s, one request per chat); and a reconnect grace of
`PEER_RECONNECT_GRACE_MS` before a chat is abandoned.

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
- Blocking the peer of a chat also ends that chat, cancels any pending invitation between the two and
  deletes their friendship in the same database transaction (`ChatService.blockPeerOfChat`,
  `ModerationService.blockPeer`).
- A block cannot be used as a probe: `blockByPublicId` refuses a target that does not exist with the
  same `USER_NOT_FOUND` as the lookup, and self-block is refused explicitly.
- A report ends the chat, takes its message snapshot from the server's own copy (never from client
  input), deletes any friendship with the reported peer in the same transaction, and is hard-deleted
  after `REPORT_RETENTION_DAYS`.
- The reported identity gets a warning that a complaint exists and that access may be closed, up to a
  ban (`report:warning` plus `GET /api/v1/me/report-warning`, acknowledged with `POST
  /api/v1/me/report-warning/read`). It contains only the time: never the reporter, chat, reason, note or
  snapshot. The reporter's side still sees `reported`; the target still sees `peer_left`, so the
  warning is the only new disclosure (D38). A new report overwrites an unread warning.
- The owner can suspend an identity from `/admin` (`POST`/`DELETE /api/v1/admin/identities/:publicId/ban`).
  A ban requires a stored reason, is enforced by the request guard and the socket handshake on every
  request, ends a live chat through the `identity.banned` event, closes the identity's sockets, and
  deletes its friendships in the same transaction. Sessions are deliberately **not** revoked: a revoked
  cookie would look like a stranger to `POST /session` and be exchanged for a brand-new User ID on the
  next reload. Keeping the session lets the guard answer `IDENTITY_BANNED` instead. `apps/api/test/ban.test.ts`
  and `tests/e2e/specs/admin.spec.ts` cover the action, the live tab and unbanning.
  **Honest limitation:** banning an anonymous identity cannot outlast the identity. There is no
  registration and no device fingerprint (deliberately), so a banned person who clears cookies starts
  over. Bans are a speed bump for abuse, not a ban of a human, and no code claims otherwise. The report
  warning is likewise only a notice: it does not reveal whether the report will be actioned, and the
  target can infer that the peer probably filed it because there is no other report path. The shared
  `ADMIN_TOKEN` also means a ban cannot yet be attributed to a particular moderator (`docs/DECISIONS.md`
  D36).

## 10.1 Friendships

**Implemented.**

- A friendship can be requested only by a participant of an **active** chat, with `friend:request` and
  that chat's id. `ChatService.requestFriend` re-checks participation and activity after every await,
  so a chat ending mid-request cannot leave a question for a dead conversation.
- The recipient sees the per-chat alias, never the requester's User ID. The User IDs are sent only in
  the `friend:resolved` event after acceptance and in `GET /friends`; before that, the random-match
  rule still applies (`apps/api/src/chat/chat.service.ts`, `apps/api/src/friends/friends.service.ts`).
- One request per chat; `FRIEND_REQUEST_TTL_MS = 60_000`; only the addressee can answer
  (`FRIEND_REQUEST_NOT_FOUND` otherwise); a decline or expiry marks the chat closed, so neither side
  can ask again there. The request is memory-only and is cancelled when the chat ends.
- `Friendship` stores a canonical pair (`userIdA < userIdB`) with a unique index and a DB `CHECK`;
  `FriendsService` applies the same ordering, so a pair cannot exist twice in opposite directions.
  `GET /friends` returns only the caller's list (capped at 200) and `DELETE /friends/:publicId` is
  unilateral and idempotent. Covered by `apps/api/test/friends.test.ts`.
- A reload restores a pending question (`session:ready.pendingFriendRequest`) and an existing link
  (`friendsWithPeer`); a reconnect does not silently drop the question while its 60 seconds are
  running. `tests/e2e/specs/friends.spec.ts` covers the visible flow.
- There is no admin surface for friendships. The social graph is not moderation evidence, and the
  owner's shared key does not need another read path (`docs/DECISIONS.md` D34).

## 10.2 Social integrations (planned, not implemented)

**Not built.** No VK or Telegram code exists. The design constraint is D35 and
`docs/INTEGRATIONS.md`; this section records the security rules the first integration must satisfy.

- A platform account is linked only after **server-side** verification of the platform proof
  (Telegram `initData` HMAC, VK launch-parameter signature, or provider server credentials). A
  client-supplied `externalId`, username or launch payload is untrusted input.
- The external id is personal data and is never placed in `publicId`, `ChatView`, `FriendView`, the
  protocol, archive criteria or logs. A link belongs to one internal identity and is removed with it.
- A platform integration is another client of the same server: it may not write product tables
  directly, keep a second transcript or bypass filters, blocks, reports, rate limits or friend
  consent. If the owner's archive is off, the adapter must not create a new durable copy.
- The standalone site keeps the `HttpOnly`, `SameSite=Lax` cookie. A cookie-less iframe requires a
  separate short-lived bearer-token mode with the same guard rules; the global cookie policy is not
  weakened to accommodate an embed.
- Provider secrets (`VK_*`, `TELEGRAM_*`) live only in the root `.env`; the web bundle never receives
  them. Platform origins are added to `CORS_ORIGINS` explicitly.
- A platform ban or report is not automatically an AnonLink ban, and a bot button is not consent to
  a friendship. Those remain separate, server-decided actions.

## 11. Privacy *inside* a chat

**Implemented.**

- In a random chat the peer sees a per-chat alias (`Stranger 7K3M`, derived from fresh random bytes
  per chat) and never a User ID. Two chats with the same person share no identifier, so chats cannot
  be correlated (`apps/api/src/common/ids.ts`, `chat.views.ts`).
- Message views are built per recipient; the sender sees `from: 'you'` in every one of their tabs.
- Direct contact by User ID is the deliberate exception: the person you ask **does** see your User
  ID, because you typed theirs. The interface states this above the input, before the button is
  pressed (`apps/web/src/components/direct-panel.tsx`).
- A friendship is the second, narrower exception: after both sides explicitly accept in a live chat,
  each sees the other's User ID and the date. It reveals no alias history, no presence and no
  transcript; either side can remove it (`docs/DECISIONS.md` D34).
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
| Unread report warnings (`Identity.reportWarningAt`) | after `REPORT_RETENTION_DAYS` (30), or immediately when acknowledged; a warning cannot outlive the report that caused it |
| Security events | after `SECURITY_EVENT_RETENTION_DAYS` (90) |
| Sessions | after `SESSION_RETENTION_DAYS` (7) past expiring or being revoked |
| Archived conversations (§13) | after the owner's `retentionDays`; `0` means only when the owner deletes them |
| "Связаться с администрацией" messages (§13.1) | after `OWNER_MESSAGE_RETENTION_DAYS` (180) |
| Finished chats in memory | after their tombstone expires (`ChatRegistryService.sweep`) |
| Pending direct and friend requests | when their 60-second deadline passes, when the chat ends, or on a restart (memory only) |
| Stale queue tickets, expired requests, rate-limit keys | every sweep |

`Identity` rows are deliberately **never** deleted: they hold a random public ID and timestamps, no
personal data, and deleting one would cascade away the reports that describe the abuse it may have
committed. The consequence is that a "deleted" account is not a thing — a user who wants a fresh
start gets a new identity, and the old row remains as an abuse record. `Friendship` rows likewise have
no expiry: they are deleted when either side removes the contact, and by a block, a report or an
identity rotation (`docs/DECISIONS.md` D34).

The sweep interval is `MAINTENANCE_INTERVAL_MS` (default 15 s). Setting it to `0` disables retention
entirely, which the integration tests use on purpose — a production deployment must not do that.

## 13. Owner archive

The owner asked (2026-10-19, `docs/DECISIONS.md` D21) for an administrative switch that can keep
conversations, read by him alone, with the scope, content and retention chosen by hand. It is built,
and it is **off** until he turns it on.

**Access.** `ADMIN_TOKEN` — at least 32 characters, environment only, never in the database, never in
a User ID. The owner enters it once at `/admin`; `POST /api/v1/admin/session` validates it and sets
`anonlink_admin` (`HttpOnly`, `SameSite=Strict`, `Secure` when `COOKIE_SECURE=true`, 8-hour lifetime),
so the key does not have to be kept in browser storage. Requests may also carry
`Authorization: Bearer …` for scripts. The comparison is timestamp-safe (both sides are SHA-256
hashed first, so length is not observable). With `ADMIN_TOKEN` unset, every admin route answers
`404 ROUTE_NOT_FOUND` — the surface is not merely locked, it does not exist.

**What is stored.** `ChatArchive` (one row per archived chat, with `expiresAt`) and `ArchivedMessage`
(sender id, text, nullable media columns, `sentAt`, `seq`). A chat is selected when the policy is
enabled and **at least one** participant is in scope; the whole conversation is then kept, including
the messages of a participant who did not match anything. The decision is taken once, when the chat
starts; each message additionally re-checks the switch, so turning it off stops recording at once.

**Retention.** `ArchivePolicy.retentionDays` (0 = keep until deleted). The maintenance sweep calls
`ArchiveService.deleteExpired`, and the owner can trigger the same query from `/admin`
(`POST /admin/archives/delete-expired`) or delete one transcript / everything explicitly.

**What this does not protect against — read this before enabling it.**

1. The archive is **plaintext in PostgreSQL**. Anyone who can read the database, a backup, or the
   filesystem reads every kept conversation. There is no encryption at rest.
2. Anyone who obtains `ADMIN_TOKEN` reads the whole archive. There is no second factor, no rotation
   flow and no per-device revocation: changing the value in `.env` and restarting is the rotation.
3. The `/admin` browser flow is covered by the E2E suite (`tests/e2e/specs/admin.spec.ts`,
   `tests/e2e/specs/moderation.spec.ts`); its API is covered by `apps/api/test/archive.test.ts`,
   `apps/api/test/platform.test.ts` and `apps/api/test/moderation.test.ts`.
4. The owner key is a static shared secret, not an account. There is no audit log of who read what
   (there is one owner), and no log of admin actions beyond `archive.policy_updated` and
   `platform.policy_changed`.
5. Anything that can read the API process's environment — a shell on the box, a debugger, a process
   dump — can read the key.

The alternative the owner rejected was to keep nothing (D1). A third option — encrypting the archive
with a key held by the same process — was rejected as theatre: the process must decrypt it to serve
the page.

Moderators are a separate matter: the moderation panel (§13.2) exists, but there are still no
moderator accounts. A report carries only the single snapshotted message the reporter's client named.

### 13.1 The owner's inbox ("Связаться с администрацией")

A user who wants to reach the operator fills one form (topic, text, optional contact line). Unlike
everything else a user writes, this text is stored on purpose — the point of the form is that a human
reads it — so the controls are about *bounding* it rather than avoiding it:

- **The user is told.** The form states, before sending, that the message is stored, that the owner
  sees the sender's User ID and that it is deleted after a retention period. That is the deliberate
  difference from the archive (§13), which is silent (`docs/DECISIONS.md` D26).
- **Bounded size.** `OWNER_MESSAGE_MAX_LENGTH` (2000) for the text, `OWNER_CONTACT_MAX_LENGTH` (200)
  for the optional contact line. The topic is a fixed vocabulary, so nothing arbitrary is indexed or
  rendered as a category.
- **Bounded rate.** `RATE_LIMIT_OWNER_MESSAGE_PER_DAY` (5) per identity, in the same token-bucket
  limiter as everything else (§7); trips are never persisted.
- **Bounded life.** `OWNER_MESSAGE_RETENTION_DAYS` (180) by default, enforced by the maintenance
  sweep; the owner can delete one message or the whole inbox at any time.
- **Sender from the session.** The request body cannot carry an identity: `POST /api/v1/owner/messages`
  takes it from the authenticated session, and the schema is `.strict()`, so a forged field is a
  rejection rather than a silently ignored value.
- **The owner's boundary.** `GET`/`DELETE /api/v1/admin/messages` sit behind the same `AdminGuard` as
  the archive: with no `ADMIN_TOKEN` the route does not exist at all.

The message text is plaintext in PostgreSQL, like the archive. The contact line is free text and is
**not** verified: nothing sends to it, so a user cannot be turned into an outbound relay, and a forged
value can only mislead the owner's own reply.

### 13.2 Moderation panel

The owner asked (2026-10-20, `docs/DECISIONS.md` D31) that blocking stop being a personal setting,
that it ship **off**, and that reports — which users could already file — become readable. The panel is
one of the cards on `/admin`, behind the same `AdminGuard` and therefore the same key as the archive
and the inbox; with no `ADMIN_TOKEN` those routes do not exist.

- **Blocking.** `PlatformPolicy` holds one row (`id = 'default'`) with `blockingEnabled`, default
  `false`; a missing row means `false`. `PUT /admin/platform` is validated by `.strict()` and
  `PlatformService` caches the value for the synchronous chat path. A new block is refused with
  `BLOCKING_DISABLED` (409) by both `block:peer` and `POST /blocks`. The unblock path is deliberately
  *not* gated: switching the action off must not trap anyone with a block they cannot lift.
- **AI permissions.** The same row carries `aiAutonomyEnabled` and `aiCompanionEnabled`, both default
  `false`. They are policy, not a working provider: no AI adapter exists, so nothing reads them yet. The
  server getters are the only authority a future adapter may consult; a prompt or client field cannot
  grant either permission (D38). The switches are visible only in `/admin`; they are not part of a
  user's session view.
- **Reports.** `GET /admin/reports?limit=` returns non-expired reports newest first;
  `PATCH /admin/reports/:id` accepts only `{ status }` (`open`, `reviewed`, `actioned`, `dismissed`).
  Reason, details, participants, chat id and the message snapshot are evidence and cannot be edited
  through the API. The list is capped by `limit` (default 50, maximum 200) so one request cannot read
  the whole table.
- **Bans.** `POST /admin/identities/:publicId/ban` requires a 3–200 character reason;
  `DELETE` lifts it. The identity is marked and the guard/handshake refuse it on every later request.
  Sessions are **not** revoked, because a revoked cookie would be exchanged for a fresh User ID on the
  next `POST /session`; the trade-off is documented in D36. Live sockets receive `IDENTITY_BANNED` and
  are closed, an active chat ends for the peer as an ordinary `peer_left`, and friendships are deleted
  in the same transaction. Only `bannedAt`/`bannedReason` are stored; there is no free-text accusation
  beyond the owner's own reason.
- **What is exposed.** Reports are plaintext in PostgreSQL and readable by anyone who obtains
  `ADMIN_TOKEN`. There is no per-moderator identity, no second factor and no audit trail of who changed
  a status or issued a ban; with one owner the only possible "who" is the owner himself. This is listed
  as a gap in §14.
- **What is not exposed.** The panel is not reachable from the user application; the report form does
  not reveal the peer's User ID in a random chat, and the report response to the reporter contains
  only an id. Report text is rendered as text by React (no HTML), so a hostile reporter cannot inject
  markup into the owner's page. A reported person is told only that a complaint and a possible ban
  exist, never the reporter, reason or evidence; a banned person is not told anything about the
  reporter or the peer, and the peer is not told that a ban happened.

## 14. Known gaps and what must happen before a public deployment

Each item says what is missing and how it would be verified. None of them is a formality.

1. **HTTPS with `COOKIE_SECURE=true`** and an https-only `CORS_ORIGINS`. The API refuses to start in
   production without both, but nothing in this repository has terminated TLS.
   *Verify:* deploy behind a proxy, then confirm the cookie carries `Secure` and a plain-http origin
   is rejected at boot.
2. **Reverse proxy with `TRUST_PROXY=true`** and a proxy that overwrites `X-Forwarded-For`.
   *Verify:* send a request with a forged `X-Forwarded-For` and confirm the rate limiter does not
   treat it as a different client.
3. **Secrets outside the repository.** `DATABASE_URL`, `ADMIN_TOKEN` (only if the archive is used) and
   `ABUSE_HASH_SALT`, if used, from the environment or a root-owned file.
   *Verify:* `git log -p` shows no credential; the deployed file is mode `600` and owned by the app
   user.
4. **Backups and a rehearsed restore.** Nothing important is duplicated today. Once archiving is on,
   the stored transcripts are among the most sensitive rows in the database, so a backup inherits
   every risk in §13.
   *Verify:* restore last night's dump into a scratch database and count rows in `Identity`, `Block`,
   `Report` and `ChatArchive`.
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
13. **The scheduled retention sweep itself has no test.** `MaintenanceService.runOnce` is the
    enforcement point for every deadline in §12, but no test advances a clock and runs the timer — the
    integration suite disables the interval on purpose, and the E2E stack only exercises the
    filter-widening half of the sweep. The archive's retention *query* is covered: `archive.test.ts`
    backdates one archive and calls the same `deleteExpired` method through
    `POST /admin/archives/delete-expired`, which is why that endpoint exists. The other deadlines
    remain covered by reading, not by running. *Verify:* an integration test that calls `runOnce` with
    a moved clock and counts the rows it removed (see `docs/TESTING.md` §6).
14. **The archive is unencrypted at rest** (§13). Enabling it means transcripts are as exposed as the
    database and its backups. *Verify:* none — this is a property, not a defect to be tested away; the
    mitigation is an encrypted volume and a backup policy, neither of which is in this repository.
15. **No second factor and no key rotation for `ADMIN_TOKEN`.** One static secret grants the whole
    archive, the inbox and the moderation panel. *Verify:* rotate the value, restart, and confirm the
    old cookie stops working (the cookie holds the key, so it does).
16. **Admin actions are not attributed and are barely audited.** The `/admin` browser flow is now
    covered by `admin.spec.ts` and `moderation.spec.ts`, but the key is one shared secret: a report
    status change names no person, and only `archive.policy_updated` / `platform.policy_changed` are
    logged (values, not content). Reads, deletions and report status changes leave no trace. With one
    owner there is no "who" to record — only "when", which is not recorded either. *Verify:* add
    owner accounts and an append-only admin audit trail before a second person gets the key.
17. **AI is a stored permission, not a feature.** `aiAutonomyEnabled` and `aiCompanionEnabled` can be
    switched on in `/admin`, but there is no provider, adapter, credential, data-processing agreement,
    budget, audit trail or synthetic-peer marker. Nothing sends text to a model, and an autonomous ban
    is not implemented. The hidden companion (D38) would also be the first feature whose honesty cannot
    be verified by a test: a model may break character, and the interface deliberately does not label it.
    *Verify:* choose a provider and terms, implement the adapter behind `apps/api/src/integrations/ai/`,
    test that the server switch is re-read at action time, that no User ID/session/report/archive reaches
    the provider, that a timeout fails closed, and that every synthetic chat is identifiable to the owner
    without being disclosed to the user. Until then, leaving both switches off is the only accurate
    description of the product.

## 15. Facts a reader can verify

```powershell
# The session cookie's attributes and the shape of the response
pnpm dev
curl.exe -i -X POST http://localhost:3001/api/v1/session -H 'Origin: http://localhost:3000'

# Nothing about a chat transcript is stored while the archive is off (reads the database)
pnpm --filter @anonlink/api test test/persistence.test.ts

# The archive: off by default, scope by parameters or User ID, and stopped by switching it off
pnpm --filter @anonlink/api test test/archive.test.ts

# Blocks survive a reconnect; a third party cannot touch someone else's chat
pnpm --filter @anonlink/api test test/moderation.test.ts
pnpm test:e2e -- specs/access.spec.ts

# Blocking is off by default; only the owner can enable it, and the server enforces it
pnpm --filter @anonlink/api test test/unit/platform.test.ts test/platform.test.ts
pnpm test:e2e -- specs/moderation.spec.ts

# Rate-limit behaviour, in isolation
pnpm --filter @anonlink/api test test/unit/rate-limit.test.ts

# Production configuration checks (point .env at production to see the refusal)
Get-Content apps/api/src/config/env.ts
Get-Content apps/api/src/identity/request.guard.ts
```
