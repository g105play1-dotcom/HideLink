# Roadmap

Status of the staged plan, what is deliberately deferred, and the decisions that are not the
builder's to take. Nothing here is a promise about dates — it is a list of what exists and what does
not.

## Where the work stands

| Stage | Scope | Status |
| --- | --- | --- |
| **A. Audit** | Inventory the existing code, environment and gaps; decide what to keep | **Done.** Existing stack preserved; the ephemeral storage model and the single-process matchmaker were kept and documented. |
| **B. Base fixes** | Real defects found by reading and by tests | **Done.** Fixed: a stale `incomingRequests` copy in the settings panel, a wrong response-field read in the same panel, a transient screen after "start search", an inverted-age-range that was accepted but matched nobody, and a type error in the protocol test. The browser suite later caught one more: the acknowledgement of "start search" re-announced the wait and wiped the criteria the server had just sent, so the waiting screen showed "без фильтров" while the server was filtering (fixed by making the screen idempotent, `apps/web/src/store/app-store.ts`). |
| **C. Full interface** | Every screen: main, search, settings, direct, chat, blocks, own User ID, loading/empty/error/disconnected states | **Done.** Every rendered control performs a real action. |
| **D. Filtered search** | Filters in the settings screen, enforced server-side, both directions | **Done.** See `docs/PRODUCT_SPEC.md` §5–§7. |
| **E. Full chat** | State machine, duplicate/race protection, disconnect ≠ leave | **Done.** Server-authoritative; `PEER_RECONNECT_GRACE_MS` before abandoning a chat. |
| **F. Direct contact** | Lookup by User ID, requests, availability policy, enumeration protection | **Done.** Contacts/friends list **not** done (see below). |
| **G. Social and protection** | Blocks, reports, voluntary contact disclosure | **Partially done.** Blocks and reports are complete; "friends/contacts" is not implemented. No contact is ever disclosed automatically. |
| **H. Stabilisation** | Tests, lint, types, build, documentation, compliance table | **Done for the scope above**, with the explicit gaps listed below. |
| **I. Growth preparation** | Redis seam, media seam, monetisation readiness, deployment sketch | **Partly done, on purpose.** Seams and documentation exist; no second instance, no media, no ads, no payments. |
| **J. Owner archive** | Owner-only storage of conversations, off by default, scope/content/retention chosen by hand (owner decision 2026-10-19) | **Done.** `DECISIONS.md` D21, `SECURITY.md` §13, `archive.test.ts`; the page at `/admin` is covered by `admin.spec.ts`. |
| **K. Contact the owner** | A form with subsections (жалобы, предложения, реклама, сотрудничество, …) writing into an owner-only inbox with a retention deadline (owner request 2026-10-19) | **Done.** `DECISIONS.md` D26, `SECURITY.md` §13.1, `owner-messages.test.ts`, `contact-owner.spec.ts`; the inbox is rendered on the same `/admin` page as the archive. |
| **L. Moderation** | Reports readable and actionable by the owner; blocking is a platform switch, **off** by default (owner request 2026-10-20) | **Panel done, accounts not.** `DECISIONS.md` D31, `SECURITY.md` §13.2, `platform.test.ts`, `moderation.test.ts`, `moderation.spec.ts`. No moderator accounts and no ban endpoint yet; the shared key means no per-person audit. |

## Verified by automation

`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test` (unit + integration) and `pnpm build`
pass. `pnpm test:e2e` runs the browser journeys. Exact counts and the honest list of what no test
covers are in `docs/TESTING.md`; requirement-by-requirement status is in `docs/COMPLIANCE.md`.

## Deliberately not built

| Feature | Why not | What would be needed |
| --- | --- | --- |
| Media (photos, video, voice) | Excluded from the MVP by the brief | Upload storage, moderation, per-message type in the protocol (the message shape already allows it, and the archive already has inert `storeMedia`/`mediaKind` fields waiting for it) |
| Contacts / friends list | Brief allows it only after the core chat is solid; nothing in the MVP creates permanent links | A permission model, request/accept flow, and a privacy decision about what a "contact" reveals |
| Chat archive *encryption and audit* | The archive itself is built (D21); protecting it further is separate work | Encryption at rest (a volume or a key outside the process), an audit trail of owner actions, and a rehearsed restore that treats transcripts as the sensitive asset |
| Moderation *accounts* and ban action | The report panel and the platform switch exist (D31), but a second person with the key would be indistinguishable from the owner | A moderator account model, per-person audit trail and a guarded ban endpoint; the panel is already the place they would live |
| Ads / Premium | Brief forbids fake monetisation; core chat comes first | Real entitlements enforced server-side |
| Redis-backed queue, multiple instances | No measured need; the seam is documented | Shared queue + presence, sticky sessions or a cross-process event bus, load tests first |
| Load/soak testing, monitoring, backups | Requires a target environment; not possible to claim from localhost | A deployment, an observability stack, and a restore rehearsal |
| Native mobile apps | Web-first | Nothing started |

## Next steps in order

1. **Owner decisions are settled** (minors, archives — items 1 and 2 below); nothing is waiting on
   them before the project can be operated.
2. **Deploy to a single host** behind HTTPS + a reverse proxy: `COOKIE_SECURE=true`, https-only
   `CORS_ORIGINS`, secrets outside the repository, `ADMIN_TOKEN` generated (only if the archive is
   used) and `ABUSE_HASH_SALT` decided on purpose.
3. **Operate it**: database backups with a rehearsed restore, log retention, uptime and error
   alerting, and a documented way to handle a report — the `/admin` moderation panel now provides the
   reading and status-changing half; the reply to the reporter is still manual.
4. **Measure before scaling**: a load test that establishes how many concurrent chats one process
   holds, then decide whether Redis (D5) is needed.
5. **Then** pick up a feature from the deferred list, starting with contacts/friends, which is the
   one the brief assumed and users will ask for first.

## Decisions needed from the owner

These are recorded as open because the alternatives differ in product meaning, legal exposure and
cost — not in code quality.

1. **Minors — decided (2026-10-19).** The service has no age restrictions; the filter bounds are the
   user's choice. The consequence (a self-declared minor can meet an adult, and declared age cannot be
   verified) is recorded in `docs/PRODUCT_SPEC.md` and `docs/SECURITY.md`, and the decision itself is
   `docs/DECISIONS.md` D20. No further input is needed unless the owner wants to revisit it.
2. **Chat archives — decided and built (2026-10-19).** Storage is possible, readable only by the owner,
   switchable for everyone, by parameters (age, gender, city, …) or for individually chosen users,
   with nothing said to users about it. It is off until the owner turns it on; the owner authenticates
   with `ADMIN_TOKEN` and the page at `/admin`. `docs/DECISIONS.md` D21 records the reversal of D1 and
   `docs/SECURITY.md` §13 records what it does **not** protect against. **Still outstanding, and not
   an owner decision:** encrypting the archive at rest, an audit trail of owner actions, and a restore
   rehearsal that treats transcripts as the sensitive asset. One decision remains genuinely open below
   (item 6).
3. **Retention defaults.** `REPORT_RETENTION_DAYS=30`, `SESSION_RETENTION_DAYS=7`,
   `SECURITY_EVENT_RETENTION_DAYS=90`, `OWNER_MESSAGE_RETENTION_DAYS=180` are placeholders chosen for
   reasonableness, not for any jurisdiction. They may need to match local law. The archive's
   `retentionDays` is chosen at `/admin` and starts at 90.
4. **Abuse investigation.** Whether `ABUSE_HASH_SALT` should be set in production (enables hashed
   IP/User-Agent correlation) or left unset (stores no client identifiers at all).
5. **Hosting and cost.** Everything currently runs locally with no paid or remote resources. A public
   launch needs a host, a domain, TLS, and a database backup destination.
6. **If the archive is enabled: how it is protected outside the process.** The code cannot decide
   whether the database volume is encrypted, who may read a backup, or how long a dump is retained —
   and those are the only things standing between a stored transcript and a third party.
6. **Monetisation direction.** Whether there is one at all; the code is ready for server-enforced
   entitlements but nothing is implemented.
7. **Third availability mode "only people who already know my ID".** Today an identity either accepts
   requests from anyone or from nobody (COMPLIANCE §6.8). The middle mode needs a definition of "knows
   me" (a first contact that has already happened, an explicit list, or a one-time sharing link) —
   without that definition the setting would be decoration.
