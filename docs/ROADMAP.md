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
| **F. Direct contact** | Lookup by User ID, requests, availability policy, enumeration protection | **Done.** See `docs/PRODUCT_SPEC.md` §5–§7 and §17. |
| **G. Social and protection** | Blocks, reports, voluntary contact disclosure, mutual friends | **Done.** Friends are created only by explicit agreement inside an active chat; blocks/reports/rotation sever the link (`docs/DECISIONS.md` D34). |
| **H. Stabilisation** | Tests, lint, types, build, documentation, compliance table | **Done for the scope above**, with the explicit gaps listed below. |
| **I. Growth preparation** | Redis seam, media seam, monetisation readiness, deployment sketch | **Partly done, on purpose.** Seams and documentation exist; no second instance, no media, no ads, no payments. |
| **J. Owner archive** | Owner-only storage of conversations, off by default, scope/content/retention chosen by hand (owner decision 2026-10-19) | **Done.** `DECISIONS.md` D21, `SECURITY.md` §13, `archive.test.ts`; the page at `/admin` is covered by `admin.spec.ts`. |
| **K. Contact the owner** | A form with subsections (жалобы, предложения, реклама, сотрудничество, …) writing into an owner-only inbox with a retention deadline (owner request 2026-10-19) | **Done.** `DECISIONS.md` D26, `SECURITY.md` §13.1, `owner-messages.test.ts`, `contact-owner.spec.ts`; the inbox is rendered on the same `/admin` page as the archive. |
| **L. Moderation** | Reports readable and actionable by the owner; blocking is a platform switch, **off** by default; a working ban of a User ID (owner request 2026-10-20/21) | **Panel and ban done, accounts not.** `DECISIONS.md` D31 and D36, `SECURITY.md` §10, `platform.test.ts`, `moderation.test.ts`, `ban.test.ts`, `moderation.spec.ts`, the ban journey in `admin.spec.ts`. Moderator accounts and per-person audit are still missing; the shared key cannot attribute a ban. |
| **M. Owner directory and hidden join** | Inspect every declared profile and search criterion, filter by them, keep favorites, and join a person's search as an ordinary peer (owner request 2026-10-22) | **Done.** `DECISIONS.md` D39, `SECURITY.md` §14, `owner-directory.test.ts`, `owner-directory.spec.ts`. Durable reservations make the owner the next match for an idle target; hidden-chat transcripts stay in memory (or the archive, if already on); an orphaned persona after a crash has no sweep. |

## Verified by automation

`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test` (unit + integration) and `pnpm build`
pass. `pnpm test:e2e` runs the browser journeys. Exact counts and the honest list of what no test
covers are in `docs/TESTING.md`; requirement-by-requirement status is in `docs/COMPLIANCE.md`.

## Deliberately not built

| Feature | Why not | What would be needed |
| --- | --- | --- |
| Media (photos, video, voice) | Excluded from the MVP by the brief | Upload storage, moderation, per-message type in the protocol (the message shape already allows it, and the archive already has inert `storeMedia`/`mediaKind` fields waiting for it) |
| VK / Telegram integration | The owner plans it, but no provider credentials, account-linking decision or platform review exists yet | A provider-verified `ExternalIdentity` link, optional bearer-token bootstrap for cookie-less embeds, adapters under `apps/api/src/integrations/` and `apps/web/src/integrations/`, secrets, retention/unlink policy, and platform moderation mapping. Seam: `docs/INTEGRATIONS.md`, D35 |
| Chat archive *encryption and audit* | The archive itself is built (D21); protecting it further is separate work | Encryption at rest (a volume or a key outside the process), an audit trail of owner actions, and a rehearsed restore that treats transcripts as the sensitive asset |
| AI moderator assistant / AI companion | The owner asked whether AI can moderate or chat; both are plausible, but neither provider nor data-processing terms are chosen. D37 fixes the assistant boundary (human-confirmed, read-only); D38 supersedes the companion: it is a hidden fallback after a failed search, gated by an off-by-default switch, and must receive the user's search criteria | A provider-agnostic adapter under `apps/api/src/integrations/ai/`, server-only credentials, redaction, timeouts/cost caps, an audit trail, a synthetic-peer marker, separately disclosed retention, and an explicit owner decision on provider and autonomy. The two permissions are stored but nothing consumes them yet |
| Moderation *accounts* and per-person audit | The report panel, blocking switch and ban endpoint exist (D31, D36), but a second person with the key would be indistinguishable from the owner | A moderator account model, an append-only audit trail, and an `AdminGuard` replacement that attaches the actor; ban semantics do not need to change |
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
5. **Then** pick up a feature from the deferred list. Friends are now built (D34); the next product
   gap the owner may want to revisit is a third availability mode, "only people who already know my
   User ID" (`docs/ROADMAP.md` below).
6. **Social-network integration (owner's plan, not started).** Before writing a VK or Telegram adapter,
   decide whether a platform account may be linked to an anonymous identity, how that is disclosed and
   unlinked, and whether the first shape is a hosted mini-app or a server-side bot. The provider-agnostic
   seam and checklist are in `docs/INTEGRATIONS.md` (D35). The chat itself does not need to change to
   prepare for this; an adapter needs `ExternalIdentity`, server-side proof verification, optional
   bearer bootstrap and provider secrets.
7. **AI, if the owner wants it (not started).** The smallest first step is the read-only moderation
   assistant in D37: it reads the report evidence the owner already sees, proposes a category/severity,
   and never acts. It needs a provider choice, credentials, a data-processing decision, redaction,
   timeouts, a cost cap and an audit trail. The companion is a separate product under D38: a hidden
   fallback only after real matching finds nobody, behind `aiCompanionEnabled`, receiving the user's
   active search criteria so its persona fits them. It is never a queue participant and must not displace
   a waiting human. The owner switches for autonomy and the companion already exist in `/admin` and are
   off; before either can mean anything, the adapter, synthetic-peer marker, retention rule and
   autonomous-ban audit must be built.

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
