# Social-network integrations

**Status: not implemented.** This document is the design constraint that keeps VK, Telegram and any
future host from requiring a fork of the chat. It is a checklist for the first integration, not a
claim that one exists. The decision behind it is `docs/DECISIONS.md` D35.

The product is an anonymous chat with a REST bootstrap, an authenticated Socket.IO session and an
optional owner panel. VK Mini Apps and Telegram Mini Apps are webviews/mini-apps; a Telegram bot or a
VK community bot is a server-side client. Those are two different trust boundaries, and only the
server may decide who a platform user is.

## What is already integration-friendly

| Property | Where | Why it matters |
| --- | --- | --- |
| Stable JSON REST views and `{ error: { code, message } }` | `packages/shared`, `apps/api/src/common/http-error.filter.ts` | An adapter renders platform UI from codes, not by scraping English prose. |
| Stable Socket.IO event names and `PROTOCOL_VERSION` | `packages/protocol`, `apps/web/src/lib/config.ts` | A client can detect a version mismatch instead of half-working. |
| Public User ID is not a credential | `packages/shared/src/ids.ts`, `identity.service.ts` | A social profile can display or share an ID without granting access. |
| All match/chat/friend rules are server-side | `apps/api/src/chat`, `apps/api/src/friends` | A bot or mini-app cannot bypass filters, blocks, rate limits or consent. |
| Configurable API origin and CORS allow-list | `apps/web/src/lib/config.ts`, `CORS_ORIGINS` | The same web app can be served from the platform origin or our own. |
| Multiple interface languages | `apps/web/src/i18n` | A platform locale can be mapped to `ru`/`en`/`zh` without translating server messages. |
| Admin surface is separate | `apps/web/src/app/admin` | A social integration never receives the owner key. |

## Two supported shapes

### A. Hosted web app in a platform webview (VK Mini Apps, Telegram Mini App)

The existing Next.js app is loaded from our own HTTPS origin and uses the normal cookie session. A
thin adapter in `apps/web/src/integrations/<provider>/` may:

- read the platform theme and set the existing theme class;
- wire the platform back button to the app's own navigation;
- pass a launch proof to the **server** for verification;
- offer a share action;
- map the platform locale to an interface language (Russian remains the default when unknown).

It may **not** call Prisma, decide who a user is, or send messages without going through the normal
client commands.

If the host embeds the app as a third-party iframe where cookies are blocked, that needs a separate
token-bootstrap mode:

1. The adapter sends the platform proof to a new `POST /api/v1/integrations/<provider>/session`.
2. The server verifies the proof, resolves or creates the linked identity, and issues a **short-lived**
   access token.
3. The browser sends that token in an `Authorization` header and in the Socket.IO handshake `auth`
   payload; the guard and socket adapter must both accept it. The existing HttpOnly cookie stays the
   default for the standalone site.

This mode is deliberately **not** built. Turning it on requires a decision about token storage in the
browser (memory vs. storage), refresh/rotation, revocation, and the effect on the anonymity promise.
Disabling `HttpOnly`/`SameSite` globally to make an iframe work is rejected in D35.

### B. Server-side bot / community adapter

A Telegram bot, VK community or other platform bot is a server-side client:

- `apps/api/src/integrations/<provider>/` verifies the platform webhook signature/secret.
- It maps the platform conversation to a chat through a future `ExternalIdentity` link, then calls the
  same `ChatService` operations (or a narrow, tested facade) as the gateway.
- It must not write `ChatSession`, `Friendship`, `Block` or `Report` directly, keep a second transcript,
  or relax a filter. The server remains authoritative.
- Inbound messages are deduplicated by platform message id; outbound messages are retried idempotently.
  The chat's own `clientMessageId` dedup is the model.
- Platform rate limits are additional, never a replacement for `RateLimitService`.
- A bot cannot create a friendship without the same explicit in-chat agreement; a bot button is not
  consent by itself.

A bot that only forwards text is still subject to the same archive/privacy rules. If the owner's
archive is off, the bot may keep the message only in platform memory long enough to deliver it — not
in a new database table. That is a design requirement, not an implementation detail to decide later.

## Identity linking (planned, not created)

Do not add this table until an integration is actually being built and the owner has decided whether
linking is optional, how it is disclosed and how it can be removed.

```prisma
model ExternalIdentity {
  id         String   @id @default(uuid())
  provider   String   // "telegram" | "vk" | ...
  externalId String   // platform user id, never shown publicly
  identityId String
  createdAt  DateTime @default(now())
  identity   Identity @relation(fields: [identityId], references: [id], onDelete: Cascade)

  @@unique([provider, externalId])
  @@unique([provider, identityId])
  @@index([identityId])
}
```

Rules for the future implementation:

- The platform proof is verified **server-side**. Telegram `initData` is checked with the bot token's
  HMAC; VK launch parameters are checked with the application's secret. A client-supplied
  `externalId` is never trusted.
- One internal identity may have at most one link per provider. Linking is opt-in and shown to the
  user; unlinking must be possible without deleting the anonymous identity or its friendships.
- The external id is not a public User ID and is not put in the chat protocol, archive criteria or
  logs. It is personal data; it needs a retention/unlink story before the first row is written.
- A platform account must not become a way to bypass a block, a report or an identity rotation. The
  link belongs to the internal identity; rotating that identity deletes the link with it.
- A user who never links a platform account keeps exactly the current anonymous experience.

## Deep links and notifications

The app is intentionally a single page and has no route for a person or a chat. A future share flow
needs a stable URL (for example `/i/<publicId>` or `/?id=<publicId>`) that opens the existing lookup,
never a URL that grants a session or a chat. Do not put a token in a query string.

Push notifications, platform message notifications and "friend is online" alerts are **not built**.
They would reveal presence the current product deliberately does not expose, and each platform needs
its own permission and retention model. Treat them as a product decision, not an adapter detail.

## Required changes before the first integration

| Area | Change | Why |
| --- | --- | --- |
| Identity | `ExternalIdentity` plus provider verification endpoint | Server-side proof, one link per provider |
| Auth | Optional short-lived bearer token for embedded contexts; cookie remains default | Third-party iframe cookies are unreliable |
| Socket | Accept the same token in the handshake `auth` payload; reject on the same rules | A token-authenticated REST call must not open an unauthenticated socket |
| Web | `apps/web/src/integrations/<provider>/` adapter, theme/back/share only | Platform SDK never enters chat components |
| API | Provider module under `apps/api/src/integrations/<provider>/` | Keeps provider code out of `ChatGateway` |
| Config | `VK_*` / `TELEGRAM_*` secrets in root `.env`, described in `.env.example` | No secrets in the repository or browser bundle |
| CORS | Add the platform origin only if we intentionally allow it | The allow-list is exact, not wildcard |
| Data | Retention and unlink policy for the external link | Platform ids are personal data |
| Moderation | Platform report/ban mapping is a separate decision | A platform ban is not automatically an AnonLink ban |
| Ops | Multi-instance/Redis if bot webhooks can hit any instance | Presence, queue and event bus are currently per process |

## What not to do

- Do not make `ChatGateway` or `ChatService` import a provider SDK.
- Do not put `vk_id`, `telegram_id` or a platform username in `publicId`, `ChatView`, `FriendView` or a
  protocol payload.
- Do not create a second database or a second queue for a bot.
- Do not trust a launch proof because it arrived over HTTPS from the browser.
- Do not post to a social network on the user's behalf without a separate, explicit action.
- Do not claim in the interface that a platform account is linked until the server has verified it.

## Verification when it is built

An integration is not "ready" because a bot answers. It needs:

- unit tests for signature verification (valid, invalid, replayed, wrong provider);
- API tests for link/unlink, one link per provider, rotation deleting the link, and a forged proof;
- tests that a bot cannot bypass a block, a filter, a rate limit or the friend-consent rule;
- an E2E or platform-simulator test for the hosted mode, with the same two-independent-context
  discipline as `tests/e2e`;
- a written note about what the platform itself can read, retain and moderate, in `docs/SECURITY.md`.
