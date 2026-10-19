# Decisions

Every entry records a choice that is not obvious from the code, why it was taken, and what it costs.
When a decision is reversed, add a new entry saying so instead of editing history.

Format: **Context** · **Decision** · **Consequences** · **Rejected alternatives**.

---

## D1. Storage is ephemeral: chat transcripts are never written to disk

**Context.** An anonymous chat service is judged by whether it keeps what people said. A reassuring
sentence in a privacy policy is worth nothing; the only credible version is a system that cannot
produce a transcript because none exists.

**Decision.** Messages live in the API process's memory only, bounded by
`CHAT_MEMORY_MESSAGE_LIMIT`, and are dropped when the chat ends. PostgreSQL holds identities,
sessions (hashes only), blocks, reports, security events and the voluntary profile/filters.

**Consequences.** No archive feature, no moderation by reading transcripts (only the snapshot
attached to a report, retained for `REPORT_RETENTION_DAYS`). A restart loses every ongoing chat.
`apps/api/test/persistence.test.ts` enforces the claim by searching every text column of every table
for a message that was sent.

**Rejected.** Storing transcripts "encrypted, for safety"; storing them behind an admin switch —
either way the data exists and can be read out.

**Superseded by D21** — the owner decided on 2026-10-19 that transcripts may be kept: off by default,
owner-only, and configured by hand. The reasoning behind this entry still stands, which is why the
archive is off until someone deliberately turns it on.

## D2. Anonymous identity: httpOnly cookie, `sha256(token)` in the database, public ID is not a secret

**Context.** There is no sign-up, so the identity is created on first use — and must survive reloads
without letting anyone take it over by guessing.

**Decision.** `anonlink_session` is an httpOnly cookie carrying 32 random bytes (base64url); only
`sha256(token)` is stored (`Session`). The public User ID (`AL` + 12 Crockford Base32 chars) is a
public handle: it grants nothing. `DELETE /session` revokes every session and issues a new identity.

**Consequences.** A stolen database cannot be replayed as a session; a leaked User ID cannot be used
to impersonate. Losing the cookie means losing the identity — accepted, and mitigated by the fact
that nothing important is attached to it.

**Rejected.** A JWT in localStorage (readable by any XSS); using the public ID as the credential
(catastrophic enumeration); device fingerprinting (a privacy-violating way to "help").

## D3. Filtered matching is strict and mutual

**Context.** "Find me women aged 25–35 in my city" is a promise. The two failure modes are matching
someone who does not fit, and matching nobody at all and never saying why.

**Decision.** A filter is satisfied only by a *declared* value: silence never satisfies a filter. Both
sides must accept each other (`preferencesFit` + `mutuallyCompatible` in `packages/shared`). Age is
stored as a birth year and compared to the current year; places are compared as normalized free text
(trim, case-fold, collapse spaces, ё→е) with no geocoding; the age filter floors at 18 (superseded by
D20: the bounds are technical, 0–120, and impose no policy).

**Consequences.** A user who declares nothing is eligible for unfiltered searches but invisible to
everyone's filters — which is the honest reading of "I did not say". Filter arithmetic is a pure
function shared by browser and server, so a preview cannot disagree with the server.

**Rejected.** Treating an undeclared value as a wildcard (silently overrules the user's filter);
fuzzy place matching (guessing geography produces wrong matches that look arbitrary); storing an age
number (goes stale).

## D4. Widening a long search is opt-in, stepwise, and always announced

**Context.** Waiting forever behind a filter is a bad experience; silently dropping the filter hands
the user the exact person they excluded, which is worse.

**Decision.** Per-user `relaxAllowed`. When enabled and the wait exceeds `MATCH_RELAX_AFTER_MS`, the
maintenance sweep drops *one* filter (`MATCH_RELAX_STEP_MS` apart) in the order
`languages → location → age → genders`, and pushes `match:relaxed` naming what was dropped. The
ladder only contains filters the user actually set, so an unset filter never "uses up" a step.

**Consequences.** The waiting screen shows the effective criteria, a countdown to the first drop,
and a persistent "already dropped" list. Relaxation can be switched off entirely with
`MATCH_RELAX_AFTER_MS=0`, which is what makes the integration tests deterministic; the end-to-end
stack is where the behaviour itself is proved.

**Rejected.** Silent widening (the worst option); widening everything at once; letting `joinRandom`
trigger it (timing-dependent, untestable).

## D5. Matchmaking state is in-process; Redis is a documented seam, not a dependency

**Context.** A queue, active chats and presence need shared state. Redis would be the textbook answer.

**Decision.** Single-instance, in-process state (`ChatRegistryService`, `MatchingService`,
`DirectoryService`). Operations are synchronous so the event loop is the atomicity mechanism;
database writes happen *after* the in-memory decision with an explicit rollback
(`registry.abort` + re-enqueue both sides). The Redis-shaped alternative is described in
`apps/api/src/chat/chat.matching.ts`.

**Consequences.** No extra infrastructure, no network hop in the hot path, and no cache-coherence
bugs. The service cannot be scaled horizontally as-is; that is stated in `docs/ARCHITECTURE.md`
rather than hidden. `pnpm dev` needs only Node and PostgreSQL.

**Rejected.** Adding Redis immediately (unmeasured need); a database-backed queue (a round trip per
candidate).

## D6. The directory is a dumb cache; policy lives in the chat domain

**Context.** Eligibility needs user facts (availability policy, declared profile, filters, blocks).
Reading them from PostgreSQL inside the matching critical section would make it asynchronous.

**Decision.** `DirectoryService` caches facts with `load`/`patch`/`sides`/`forget` and makes no
decisions. `ChatService.isEligible` decides. Facts are patched synchronously on every settings write
(so a new filter applies immediately) and dropped when a user's last socket disconnects, so a
disconnected user can never be matched (fail closed).

**Consequences.** One rule owner, testable in isolation. A reconnect reloads facts. A stale cache is
impossible to hide behind: `sides()` returns `null` (no match) rather than guessing.

**Rejected.** Putting block/filter checks inside the directory (two places would then decide
eligibility); matching from database rows (async critical section); keeping facts forever
(a disconnected user could be matched into an empty chat).

## D7. Bans are absolute; rate-limit trips are not persisted

**Context.** Abuse protection must not become a data-collection mechanism.

**Decision.** A banned identity is refused on every route and every socket event. Rate-limit trips
are answered with `RATE_LIMITED` and are *not* written to the database. Client IP / User-Agent are
hashed only when `ABUSE_HASH_SALT` is deliberately set, and unset is the default.

**Consequences.** Operating the service in the default configuration stores no client identifiers at
all. Abuse investigation is limited unless the operator opts in — a trade-off made explicitly.

**Rejected.** Log-and-continue on bans; storing every 429 "just in case"; collecting raw IPs by
default.

## D8. In-house pieces instead of four popular dependencies

**Context.** Every dependency is an upgrade, a supply-chain and a configuration surface.

**Decision.** Replaced with small, tested in-repo code: `@nestjs/throttler` → `RateLimitService`
(token bucket), `@nestjs/config` → a zod-validated `AppConfig` behind the `APP_CONFIG` symbol,
`helmet` → `SecurityHeadersInterceptor`, `cookie-parser` → two functions in
`apps/api/src/common/cookies.ts`. Reports are sent over the WebSocket instead of REST, so there is
one path with one authorization story.

**Consequences.** Fewer moving parts and rules that fail closed in the code we own; the cost is that
these pieces need their own tests (`apps/api/test/unit/rate-limit.test.ts`, `protocol.test.ts`).

**Rejected.** Adopting a framework plugin for a 60-line need; carrying `helmet`'s full header set
without reading it.

## D9. Prisma 7 with the driver adapter, an additive migration, and a generated client

**Context.** Prisma 7 changed the generator and the client shape; the schema change added the
voluntary profile and filters.

**Decision.** `provider = "prisma-client"`, output `apps/api/src/generated/prisma` (git-ignored,
`@ts-nocheck`), `@prisma/adapter-pg` with `pg`, configuration in `apps/api/prisma7.config.ts`, and
`migrate deploy` as the only unattended migration command. All 11 new columns are nullable or
defaulted, so the migration is a plain `ADD COLUMN` with no rewrite and no data backfill.

**Consequences.** `pnpm setup` and CI can migrate without prompts; existing rows keep working; the
schema is inspectable and the client is regenerated, not hand-written.

**Rejected.** `prisma db push` (no migration history, destructive risk); a `NOT NULL` profile column
(would break every existing identity).

## D10. The browser talks to the API directly (CORS allowlist), not through a Next.js proxy

**Context.** A same-origin proxy would hide CORS entirely and simplify cookies.

**Decision.** The browser calls the API origin directly with `credentials: 'include'`, and the API
enforces an exact-origin allowlist for both REST and the Socket.IO Origin check, from one
`CORS_ORIGINS` value.

**Consequences.** One policy, applied to both transports; the API can be deployed separately from the
web app. Operators must list the real origin(s) — a misconfiguration fails loudly instead of
silently.

**Rejected.** Next.js rewrites (two origins to configure, cookies and WebSocket upgrades are easy to
get subtly wrong); `Access-Control-Allow-Origin: *` (incompatible with credentialed requests and
dishonest about intent).

## D11. Errors are machine codes; the interface owns the Russian text

**Decision.** Every failure is `{ error: { code, message, context? } }` with a code from the shared
`ErrorCode` enum. The browser maps codes to Russian text and never displays the server's message.

**Consequences.** Server wording can change without leaving half-translated UI, and a compromised or
mismatched server cannot inject arbitrary text into the page. The mapping is exhaustive, so a new
code is a compile error in the web app until it has a human sentence.

## D12. Testing split: rules in `packages/shared`, behaviour in `apps/api`, journeys in `tests/e2e`

**Context.** Matching rules are pure; the interesting failures are integration-shaped (state machine,
concurrency, authorization) and journey-shaped (can a person actually do this?).

**Decision.** Unit tests for pure rules; integration tests that spawn a real API against a real
`*_test` database and speak only the documented protocol; Playwright specs driving two independent
browser contexts. Timing-dependent behaviour is switched off in integration tests
(`MATCH_RELAX_AFTER_MS=0`, `MAINTENANCE_INTERVAL_MS=0`) and exercised end to end instead.

**Consequences.** Tests are slower but they catch what mocks cannot. The test database is never
wiped, so every test must be self-contained (per-run UUID needles; queue cleanup in `afterEach`
because matchmaking is global to the server).

**Rejected.** Mocking the repository layer (would have missed the double-assignment and disconnect
bugs); a single E2E-only suite (too slow to be the only feedback).

## D13. Windows-first developer tooling the owner can run

**Decision.** `pnpm setup` and `pnpm diagnose` are plain Node scripts with Russian output that check
Node, PostgreSQL reachability, `.env`, ports and build artefacts, and print the exact command to fix
what they find. `pnpm doctor` is shadowed by pnpm's own command, so the canonical name is
`pnpm diagnose`.

**Consequences.** The owner never edits code or reads a stack trace to get running. The scripts must
stay honest: they report a problem with a next step, never a vague failure.

## D14. Every dependency version is pinned, and install scripts are allow-listed

**Context.** `latest` currently resolves to pre-release majors for several core tools
(`typescript@7`, `prisma@8-rc`), and unapproved install scripts are a supply-chain risk.

**Decision.** Exact versions everywhere; `pnpm-workspace.yaml` uses an `allowBuilds` map (only
`prisma`, `@prisma/engines`, `esbuild` approved) and `strictPeerDependencies: false`. Upgrades are
deliberate acts recorded here.

**Consequences.** Reproducible installs and no surprise majors. A security patch requires an
explicit bump.

## D15. Documentation is bilingual by audience

**Decision.** Owner-facing documents (`README.md`, `docs/PRODUCT_SPEC.md`, `docs/COMPLIANCE.md`) are
Russian, because the project owner is Russian-speaking and not a programmer. Engineering documents
and all code comments are English, matching the code.

**Consequences.** Two languages on purpose; a change to behaviour usually touches one of each.
`*.md` is excluded from Prettier so that tables written by hand are not reflowed.

## D16. No Docker, no paid or remote resources

**Context.** The master prompt forbids changing remote or paid resources and requires the owner to be
able to run everything locally.

**Decision.** PostgreSQL is installed natively (service `postgresql-x64-18`, port 5432); there is no
container requirement and no cloud dependency. Deployment sketches live in `infrastructure/` and are
marked unverified until someone runs them.

**Consequences.** `pnpm setup` needs a local PostgreSQL, and its failure message says exactly how to
start it. Anything in `infrastructure/` must not be presented as tested.

## D17. Relaxation is triggered only by the maintenance sweep

**Context.** Widening could be attempted when a candidate arrives, or on a timer.

**Decision.** Only `MaintenanceService` widens a search, on `MAINTENANCE_INTERVAL_MS`.

**Consequences.** Integration tests disable the sweep and become deterministic; the end-to-end stack
runs it at 250 ms to prove the behaviour in seconds. A user waiting alone is still widened on
schedule, which is what makes the "widening is announced before any match" test possible.

**Rejected.** Widening inside `joinRandom` (the behaviour would then depend on who happens to
arrive, which is untestable and unfair).

## D18. Minors policy: not decided, and deliberately not faked

**Context.** Age filters, a self-declared birth year, and no registration. A "18+" checkbox would be
trivially bypassed and would imply a verification that does not exist.

**Decision.** No age gate is implemented. The filter floor (18) is enforced, declared data is labelled
as unverified everywhere it is shown, and the question is recorded as needing an owner decision in
`docs/PRODUCT_SPEC.md`, `docs/ROADMAP.md` and `docs/COMPLIANCE.md`.

**Consequences.** An adult can, with no age filter set, be matched with someone who declared
themselves a minor. This is stated plainly rather than papered over. The alternatives (a hard 18+
gate on the whole service, a separate minors mode, or moderation rules) are product decisions with
legal and operational implications and are not the builder's to take silently.

**Superseded by D20** — the owner took the decision on 2026-10-19.

## D19. Prettier ignores generated files

**Decision.** `.prettierignore` covers build output, the lockfile and `apps/web/next-env.d.ts`.

**Consequences.** `pnpm format:check` reflects authored code only, and does not fail depending on
which packages happen to have been built. Formatting the lockfile would create churn on every
install.

## D20. No age restriction: the filter bounds are the user's choice (reverses D18)

**Context.** D18 left the minors question open and refused to fake an age gate. The owner has now
answered the product question directly: the chat has no age restrictions, and where the filters begin
and end is decided by the users themselves.

**Decision.** The service imposes no age policy. `PROFILE_LIMITS.AGE_MIN` and `AGE_MAX` are technical
bounds (`0` and `120`) that only reject values which cannot be an age; they are not a rule about who
may be searched for or who may use the service. The interface no longer claims any age limit — it says
that both the bounds and leaving them empty are the user's own decision.

**Consequences.** A self-declared minor can be matched with an adult, and declared age cannot be
verified (there is no registration and no document check). This is now a deliberate product decision,
recorded in `docs/PRODUCT_SPEC.md` (§ «Противоречия», п. 2) and stated plainly in `docs/SECURITY.md`
§14. Nothing in the code pretends otherwise; if an age gate or a minors mode is wanted later, that is a
new decision rather than a bug fix.

## D21. Chat archives: off by default, owner-only, and decided by hand (reverses D1)

**Context.** D1 rejected storing transcripts because a promise of privacy is only credible while the
data does not exist. The owner — the person who operates the service — has decided he wants to be able
to keep conversations: for everyone, for some users by parameters (age, gender, city, …), or for
individually chosen users; and to decide by hand whether text or attachments are kept and for how
long. He also decided that users must not be told, and that the sentences promising the opposite must
be removed from the interface.

**Decision.** The archive is a separate subsystem (`apps/api/src/archive`, the `ArchivePolicy`,
`ArchiveSubject`, `ChatArchive` and `ArchivedMessage` tables) and is **off** until the owner switches
it on. The policy is data, edited at `/admin`, and every part of it is bounded:
- **scope** — everyone, declared parameters (gender, age range, cities, regions, languages), or an
  explicit list of User IDs;
- **content** — message text and, for the day attachments exist, which attachment kinds (`storeMedia`
  is inert today because nothing in the product produces an attachment);
- **retention** — `retentionDays`, `0` meaning "keep until the owner deletes it", enforced by the
  maintenance sweep and by an explicit "delete expired now" action;
- **either participant in scope is enough**, because the owner selects people and a selected person's
  conversation cannot be half-recorded.
The owner authenticates with a key (`ADMIN_TOKEN`, at least 32 characters, environment only) entered
once at `/admin` and exchanged for an `HttpOnly`, `SameSite=Strict` cookie. With no key configured the
admin routes do not exist (404), so an installation that never opts in cannot be attacked through a
surface it never built. The five user-facing sentences promising "переписка не сохраняется" were
deleted rather than reworded: the product now says nothing about storage.

**Consequences.** The privacy guarantee is now *conditional on an owner action*, and the documentation
says so everywhere instead of repeating the old promise. A stored transcript is plaintext in
PostgreSQL, readable by anyone who can read the database or the key: the owner surface is a high-value
target, and `docs/SECURITY.md` §13 lists exactly what is and is not done about it. `persistence.test.ts`
now enforces the **default** (nothing stored) at the database level, and `archive.test.ts` proves the
opt-in path end to end, including that switching the switch off stops recording immediately. Existing
conversations are never retroactively archived, and switching off does not delete what is already kept
(only retention or an explicit deletion does).

**Rejected.** Storing everything silently with no off switch (no way to honour D1's intent);
per-user consent prompts (the owner explicitly asked that users not be told); a separate admin login
and password (an account, a reset flow and a second identity model for a product that has none — a key
is enough for one operator); encrypting the archive with a key held by the same process (a false sense
of protection: the process must decrypt it to serve the owner).
