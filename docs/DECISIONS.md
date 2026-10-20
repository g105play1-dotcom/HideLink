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

## D22. One page, ages instead of years, typed dropdowns and two themes

**Context.** The first interface split the product into three tabs — random search, direct contact by
User ID, settings — with a large identity card at the top. The owner judged it wrong on his own screen
and described the replacement: everything on one page, a compact header with the User ID right next to
the product name, the "ID of the person you want to talk to" field directly underneath, the filters
behind a "Настройки" button below the main action, the "about you" and "whom to look for" halves side
by side, cities/regions/languages as dropdowns that still accept typing, an **age** rather than a year
of birth, and a dark/light switch.

**Decision.** The screen is one page (`home-screen.tsx`) whose composition is a pure function of the
store's `phase`; there are no tabs at all. Concretely:
- the header carries the product name, the User ID (clicking the ID copies it) and the connection
  badge, plus the theme switch;
- `DirectSearch` (the field, then the lookup, then "Отправить заявку") is rendered only while idle,
  because joining a chat is impossible while another one runs and a control that cannot be used is
  worse than an absent one;
- the filters are a disclosure under "Найти собеседника" (`aria-expanded`), and the collapsed state
  still *states* what is applied, so an invisible filter cannot be blamed on the search;
- **the field is an age, the column is a birth year.** `birthYearFromAge`/`ageFromBirthYear` convert in
  the settings component only, so a stored value cannot go stale and the matching engine keeps working
  on `prefAgeMin`/`prefAgeMax` unchanged;
- city and region are free text with a suggestion list (`data/places.ts`, opened by typing, never
  forced); languages stay a closed vocabulary because a language is compared for equality between two
  people and "русский"/"ru" must be one value;
- the gender vocabulary lost "другое": a value that no filter can express and that only ever produced
  "matches nobody" was a trap, and the DB enum was left untouched (additive migrations only) with the
  read paths dropping it;
- the theme is a `class` on `<html>` (`dark`), chosen once in `localStorage` (`anonlink.theme`), applied
  by an inline script before the first paint so there is no flash, and switched from the header. When
  the user has never chosen, the system preference decides and a later system change is followed —
  after an explicit choice it is not.

**Consequences.** Every message is drawn on its own opaque bubble, with timestamp and delivery state
inside it, and the chat header and composer are opaque bars: this is what keeps a background creative
from ever sitting behind a word the user has to read (see D23). The old components
(`identity-card`, `direct-panel`, `preferences-panel`, `search-preferences-panel`) are deleted rather
than left unused. The end-to-end suite had to change with the interface: the helpers now open the
settings disclosure instead of switching a tab, and "the summary states the filters" is asserted with
the disclosure *closed*, because the settings' own "будет применяться" preview says the same thing.

**Rejected.** Keeping the tabs and restyling them (the owner's complaint was precisely that the two
things a user can do were hidden behind a mode switch); a client-side age field stored as an age
(it would drift as the years pass, and the filter arithmetic is defined on a birth year); a mandatory
dropdown for the city (a list of cities is never complete, and being unable to answer would block the
save); auto-detecting the theme on every load without remembering the choice.

## D23. Advertising is a reserved seam, not a feature

**Context.** The owner wants the empty space beside the chat and, eventually, behind it to be usable
for advertising, and asked for the layout to be *technically ready* for that. Nothing about
advertising is decided: there is no provider, no creative, no money.

**Decision.** Three container types exist as real, sized elements — `AdSlot variant="rail"` in the
columns flanking the page (only on wide screens), `AdSlot variant="banner"` in the space under the
folded settings (D28), and `AdSlot variant="chat-background"` as a layer inside the conversation card.
All paint nothing while they are empty, and all are `aria-hidden`.
The chat card is `isolate relative` so the background layer paints *behind* the conversation rather
than over it.

**Consequences.** Filling a slot later is a change of content, not a change of layout, which is the
whole point. Readability is guaranteed by the messages themselves (opaque bubbles, opaque header and
composer), not by keeping the layer empty — so a creative cannot make a message unreadable even by
accident. What is *not* decided: any third-party script. Loading a tracker into a page whose promise is
anonymity is a privacy change, and it belongs in `docs/SECURITY.md` and a new decision before the first
network request is made — the comment in `ad-slot.tsx` says so where the code lives.

**Rejected.** Reserving the space with visible empty boxes (an empty bordered box reads as a broken
image); building an ad server now; putting a slot anywhere a message is drawn.

## D24. Blocking is an optional feature, and switching it off is not an amnesty

> **Superseded by D31** (2026-10-20): the owner moved this switch out of the user's settings into
> `/admin`, made it a platform policy that ships **off**, and kept the "not an amnesty" rule. The
> reasoning below about refusing new blocks while leaving old ones removable still holds; the
> per-user ownership and the `Identity.blockingEnabled` reader do not.

**Context.** The owner asked for the block function to be optional: with it switched on, the chat
button and the blocked list exist; with it off, neither the button nor the list should be needed. He
also asked for the feature to be switchable by the user.

**Decision.** `Identity.blockingEnabled` (default `true`, additive migration) carries the choice.
Switching it off hides the "Блокировать" action in a chat and the "Заблокированные" section in the
settings, and — because the server is the authority — `ChatService.assertBlockingAllowed` refuses a
*new* block with `ErrorCode.BLOCKING_DISABLED` (409). The check is deliberately absent from the unblock
path: wanting the button gone must never trap a user with a block they cannot remove, and it is not
applied to the list either, so the state stays visible and undoable. Turning the feature back on
restores both the button and the list, and the blocks made before are still there.

**Consequences.** `settingsUpdateSchema` gained a boolean, which is where a plain truthiness check would
have been a bug: `blockingEnabled: false` is a value the user asked for, not "absent", so both the
controller and the service test it with `!== undefined` (there is an integration test for exactly that).
The interface hides controls; the API enforces the rule; a tab left open before the setting changed
still gets the refusal rather than succeeding.

**Rejected.** Removing the block feature entirely (the owner wants it available, just optional);
deleting existing blocks when the feature is switched off (it would silently unblock people the user
had deliberately blocked); an interface-only rule.

## D25. Every filter row is a list with an explicit "Любой", and "Где искать" is a set

> **Superseded in part by D27** (2026-10-20): the place row no longer stores `city`/`region` modes but
> names the places themselves. The general rule below — a list, an explicit «Любой» chip, and "any" as
> the empty selection rather than a vocabulary member — still governs every filter row.

**Context.** The owner read the new settings screen and asked two questions about its filter rows:
why the "Пол собеседника" row had no "любой" button, and why "Где искать" was not the same kind of
list, able to hold several answers at once. Both rows were, in effect, the same complaint: the
neutral state was invisible, and one of the two filters could only say one thing.

**Decision.** A filter row renders its neutral state as a real, pressed chip — «Любой» — placed
first, before the values. It is a value of the *interface*, never of the wire: for both rows "any"
**is** the empty list. The shared vocabularies therefore have no `any` member
(`LOCATION_MODES = ['city', 'region']`, exactly as `GENDERS` has no "любой"), so there is one way to
express "no constraint" and the relaxation step ("drop this filter") always means the same thing:
empty the list.

`SearchPreferences.location: LocationMode` became `locations: readonly LocationMode[]`, an **or**:
a candidate is accepted if they share *either* selected place. That is not the same as the widest
single value — someone who declared a city but no region matches «Только мой город» and not «Только
мой регион» — which is why the set is worth having rather than collapsing to one mode.

The column moved with it: `prefLocation String @default("any")` became
`prefLocations String[] @default([])`, carrying every stored value across before the old column is
dropped (migration `20261019153000_search_multiple_places`, whose comment holds the rollback plan:
re-create `prefLocation` from the first element of the set, having exported the rows that hold two).

**Consequences.** The settings screen warns, without blocking the save, when a place filter is
switched on and the matching half of the comparison — the user's own city or region — is still
undeclared. The filter is not invalid and starts working the moment the place is declared, but a
filter that silently matches nobody looks exactly like a broken search. Reading the column narrows
each value through `isLocationMode` and re-orders through `LOCATION_MODES`; an unrecognised value
therefore disappears, which means "anywhere" — the same bounded fail-open as an unreadable gender
(stored by hand, never by the validated update path). A stored value of `'any'` from before this
decision also degrades to "anywhere", which is what it meant.

**Rejected.** Keeping `'any'` inside the vocabulary as a fourth chip (a value whose meaning is "no
value", with the relaxation step then able to remove a filter that was never set); a UI-only
multi-select that stored just one mode (it would show the user two answers and act on one); leaving
the neutral state implicit (the owner read an empty row as a missing control, and a reader cannot
tell "not answered" from "answered: anything"); refusing to save until the city is declared (the
filters are legitimately set before the profile, and the server accepts the filter either way).

## D26. "Связаться с администрацией": a deliberate inbox with subsections, under a retention deadline

**Context.** The owner asked (2026-10-19) for a way for users to reach him, split into subsections
(жалобы, предложения, реклама, сотрудничество и т.д.). Abuse reports already existed, but they are
bound to a chat and a message, composed by the server, and they are a moderation record — there was
no way to send a suggestion, a defect report or an advertising enquiry at all.

**Decision.** One form, one storage table (`OwnerMessage`), and subsections expressed as a fixed
`OwnerMessageTopic` vocabulary (`abuse`, `suggestion`, `bug`, `advertising`, `partnership`, `other`)
rendered as radio chips in the form and as labels in the owner's inbox. The text is bounded
(`OWNER_MESSAGE_MAX_LENGTH = 2000`), the optional "how can we reach you" line is free text
(`OWNER_CONTACT_MAX_LENGTH = 200`, unvalidated), and the sender's User ID is taken from the session —
never from the body — so nobody can file a message as somebody else. The budget is per identity and
small (`RATE_LIMIT_OWNER_MESSAGE_PER_DAY`, default 5): an unlimited operator inbox is a spam target.

This is the second place user-written text is stored on purpose (the first is `Report.messageSnapshot`),
so it carries the obligation the archive does **not**: the form says, before sending, that the message
is stored, that the owner sees the sender's User ID, and that it is deleted after a retention period
(`OWNER_MESSAGE_RETENTION_DAYS`, default 180, enforced by the maintenance sweep). The owner reads the
inbox on the existing admin surface (`GET`/`DELETE /api/v1/admin/messages`), because the owner's key
opens one place, not two; `OwnerMessageService` is the storage, `ArchiveModule` renders it.

**Consequences.** The inbox is a growing table of user text until the sweep runs, readable by whoever
holds `ADMIN_TOKEN` — the same boundary as the archive, with the one difference that users are told.
Deleting is the only state change; there is no read/unread flag, because that would invite a workflow
this product does not have. The route needs a session like every other action, so a user whose browser
cannot obtain one cannot write in — worth revisiting only if that ever becomes the reason someone wants
to write. There is **no** notification: the owner finds messages by opening the page, and an answer goes
to whatever contact the sender chose to leave (or nowhere, if they left none).

**Wording.** The interface says «администрация» (the owner asked on 2026-10-20 for a formal word instead
of «хозяин», which his brief used), while the code and these documents say *owner* (`OwnerMessage`,
`OwnerModule`): one principal under two names — the formal one where users read it, the engineering one
where the boundary is defined. «Владелец» survives only as a description of who may open the archive,
never as the name of the inbox.

**Rejected.** Reusing `Report` with a nullable chat (a report is server-composed and tied to a message;
merging would have forced one retention policy and one status machine on two different things);
a free-text topic field (nothing to triage with, and the same word spelled five ways); requiring an
e-mail (a sign-up field in disguise, in a product whose point is that there is nothing to sign up
with); e-mailing the owner (a delivery mechanism the service does not have, and a copy of every
message outside its own retention); read/unread status (see above); making the route `@Anonymous()`
(the rate limit and the "who wrote this" both become guesswork).

## D27. "Где искать" names places, instead of comparing with the searcher's own

**Context.** D25 made the place row a set of two *modes* — «Только мой город», «Только мой регион» —
compared against the searcher's own declaration. The owner read the result (2026-10-20) and said it was
still buttons rather than a list: keep the «Любой» chip, but let the city and the region be the same
kind of multi-select as every other row, with a choice of several values.

**Decision.** `SearchPreferences.locations: LocationMode[]` became two lists of names,
`cities: readonly string[]` and `regions: readonly string[]`. The filter names the places a
candidate's *declared* city or region has to be one of; the union of both lists is an **or**, so
naming Moscow and Tatarstan accepts a candidate who matches either. An empty pair is "anywhere",
exactly as D25 required — the neutral chip is still a value of the interface only, never of the wire.
`preferencesFit` no longer takes the searcher's profile: with concrete names there is nothing to
compare "mine" against, and the declared city/region remain the *candidate* side of the comparison.

The columns moved with it: `prefLocations String[]` became `prefCities String[]` and
`prefRegions String[]` (migration `20261019210000_search_place_lists`). A stored `'city'` mode is
translated into the city the person had declared, and `'region'` into the declared region, so nobody's
intent is lost; a mode chosen without a declared place meant "matches nobody" and now means
"anywhere", which is the only honest translation and is stated in the migration. The rollback plan
(re-create the modes when a list still names the declared place) is in the same file.

**Consequences.** The "this filter cannot match anybody yet, because you have not declared your
place" warning is gone: a name filter does not depend on the searcher's profile, so there is no such
state. The interfaces are the same free-text-with-suggestions fields the declared city and region use,
bounded by `PROFILE_LIMITS.PLACE_MAX_LENGTH` and `PLACE_FILTER_MAX` (10 names per list), with the
folded comparison of `normalizePlace` — «Москва» and «москва » are one city, and the first spelling is
what the user sees back. A typed-but-not-yet-added name is included when the user saves, because
losing an unfinished entry silently is the same defect as a dead button.

**Rejected.** Keeping the modes and merely drawing them as a list (they were already a multi-select;
the owner's complaint was that the values were modes, not places); one combined list of "places" with
an invisible kind flag (a city name that happens to equal a region name would silently match the other
declaration, and the two are compared against different fields); geocoding or a canonical place
vocabulary (the product compares what two people typed; a vocabulary would have to be complete and
would make an unlisted town unsearchable); a list of *countries* (the profile has no such field, and
inventing one changes what the declaration means).

## D28. The space under the folded settings belongs to advertising

**Context.** The owner noticed (2026-10-20) that folding the settings leaves a large empty area below
the search button, and asked for it to be used by advertising rather than wasted. D23 had reserved the
columns beside the page and the layer behind a conversation, but not this one.

**Decision.** `AdSlot` gained a third variant, `banner`, rendered while the settings are closed in a
container with `min-h-40 flex-1`: it takes exactly the height the settings panel would have occupied,
so opening the settings never shifts a creative out of view and closing them never leaves a gap. The
container is `aria-hidden` and paints nothing while empty, for the same reasons as the rails (D23) —
an empty bordered box reads as a broken image, and an unfilled placeholder is not an ad.

**Consequences.** The slot is a stable hook (`data-ad-slot="under-settings"`), so adding a creative is
a change of content. The rules in `ad-slot.tsx` still apply unchanged: no word may be drawn on a
creative, nothing renders when empty, and no third-party script enters the page without a new decision
and an entry in `docs/SECURITY.md`. Advertising revenue remains an unproven assumption: no provider,
no creative, no money, and no claim in the interface that any of it exists.

**Rejected.** A visible "здесь может быть ваша реклама" box (the owner asked for the space to be used,
not decorated, and D23 already rejected visible empty boxes); putting the slot *inside* the settings
panel (it would be pushed down by the very content it is supposed to replace); showing a creative
while the user is searching (the waiting screen is the one place where attention belongs to the wait).

---

## D29. Browser translation is a supported path, not an accident

**Context.** The owner asked (2026-10-20) that both the interface and the chat transcript be
translatable by ordinary browser translators (Chrome, Edge, Yandex) — for every language we do not
ship ourselves. A reactive interface and a page translator both rewrite the same DOM, so this is a
structural requirement, not a setting.

**Decision.** The page stays fully translatable: no `translate="no"` on the document, no
`notranslate` meta, and `<html lang>` must always name the language actually rendered. Exactly three
things are marked `translate="no"`, because a translator would corrupt rather than translate them:
User IDs (a code, not a word), countdowns and the message-length counter (digits that change every
second), and nothing else.

Two rules follow from how translators work — per text node, per block:

1. **One sentence is one text node.** An ID used to sit inside a sentence as `<code>`, splitting it
   into three nodes that a translator receives as unrelated fragments (`direct-search.tsx`). The ID is
   now shown next to the sentence, not inside it. No `<code>`/`<strong>` inside a prose sentence in
   user-facing components.
2. **Volatile values live outside sentences and outside live regions.** A countdown is a label plus a
   value (`Истекает через: 00:42`), not a number inside a sentence — otherwise a screen reader
   announces it every second and a translator re-translates the sentence every second.

User-authored text (messages, request notes) carries `lang=""` — language unknown, detect per
message — and `dir="auto"`, so Arabic or Hebrew is not forced left-to-right by a Russian page.
Keyboard hints are visible text rather than `placeholder` text, because translators do not translate
placeholder attributes.

**Consequences.** React can still update a translated page: a string lives inside an element, so
removing it removes the element the translator rewrote, not a bare text node that no longer exists.
That is best-effort, not a guarantee — no automated test can run a browser translator. `docs/TESTING.md`
§9 is the manual checklist (translate to a language the app does not ship, exercise search, chat and
every dialog, confirm no error boundary and no mangled IDs). The interface's own translations remain
the primary path; browser translation is the fallback.

**Rejected.** `translate="no"` on the whole app — the usual React workaround for translator-induced
DOM mutations, and it makes the owner's requirement impossible; translating only the chat and not the
interface (the interface is most of the text); shipping our own "translate" button (a second, worse
translator, and it would need the very language list we are avoiding).

---

## D30. Languages and countries come from published vocabularies, not from memory

**Context.** The owner asked (2026-10-20) for every major language, each named in its own language,
and for a country selector, and said the lists should be taken ready-made from the internet rather
than composed by hand. The original language list was ten codes typed by hand, named in Russian only.

**Decision.** Both vocabularies are **generated and committed**, with the source URL and a snapshot
date in the file header, by `scripts/generate-vocabularies.mjs`:

- **Languages** (`packages/shared/src/languages.ts`): 76 ISO 639-1 codes — the most spoken languages
  plus those a Russian-first audience is most likely to meet. `native` comes from that language's own
  CLDR locale; `en`/`ru`/`zh` exist only to *search* the picker and are never displayed. The **code**
  is the domain value: `languageSchema` validates it, `declaredLanguages`/`prefLanguages` store it,
  matching compares it.
- **Countries** (`apps/web/src/data/countries.ts`): the 194 UN members from mledoze/countries with
  ISO 3166-1 alpha-2, the native common name, and en/ru/zh search aids.

Generated and committed, rather than fetched at build time or installed as a package, because the
build must not require GitHub, every dependency version here is pinned deliberately, and installing a
new package is blocked in this environment (pnpm cannot create symlinks). A generator with a fixed
source and a date is auditable; a list typed from memory is not.

Widening a vocabulary is additive in the only sense that matters: the wire and the database carry the
code, so stored rows stay valid. The language list therefore needed no migration.

**Consequences.** Native names are not translated — the interface language never changes «中文», and
that is the spelling a person looking for their own language recognises. Countries are a **closed
vocabulary**, not free text like a city: «Германия» and «Deutschland» must compare equal, and no
normalisation can promise that. So the country code, not the typed name, will be what the profile
stores and the filter compares; the server validates it against the same list. Until that wiring
lands (next change), the generated country file is data with no reader.

**Rejected.** A hand-written "major languages" list (wrong today for anyone whose language was
forgotten, wrong again within a year); a free-text country field (D27's place model works for cities
because both people can spell them, not for countries with several native names); fetching CLDR at
build (a build that needs the network fails offline); `countries-list` or `country-state-city` as a
dependency (a dependency for data we can generate once, and the second one drags in every city on
earth).

---

## D31. Moderation belongs to the administration: blocking is a platform switch, and reports are read in `/admin`

**Context.** The owner asked (2026-10-20) for the blocking switch to move out of the user's settings
into his admin panel, for it to be **off by default**, and for a moderation panel to be created —
users already filed reports, but nothing in the product could read them. He also said that real
moderator accounts are not needed yet. D24 had made blocking a personal preference, which in
retrospect gave an anonymous user a moderation capability and gave the owner no way to decide what
his own platform offered.

**Decision.**

1. **One platform policy row.** `PlatformPolicy` (migration `20261020120000_platform_policy`) holds
   the installation-wide switches, one row with the fixed id `default`. A missing row means the
   shipped defaults, so a fresh installation needs no seed. The first switch is
   `blockingEnabled Boolean @default(false)` — **off** until the owner turns it on.
2. **The owner controls it.** `GET/PUT /api/v1/admin/platform` are behind `AdminGuard`, validated by
   the shared `.strict()` `adminPlatformSchema`. `PlatformService` loads the row at boot, answers
   synchronously from a cached copy (the chat domain's critical section cannot await a query), and
   replaces the cache on every successful write.
3. **The server enforces it.** `ChatService.assertBlockingAllowed` consults `PlatformService` and
   refuses a *new* block with `ErrorCode.BLOCKING_DISABLED` (409), both for `block:peer` and for
   `POST /blocks`. The check is absent from the unblock path and from `GET /blocks`: switching the
   action off is not an amnesty, and it must never trap anyone with a block they cannot lift. The
   settings screen keeps showing the blocked list (with a line explaining that administration
   switched blocking off) precisely so it stays undoable.
4. **The wire follows the owner, not the user.** `SessionView` and `SessionReadyPayload` carry
   `blockingEnabled` at the top level, next to `settings`, because it is not a setting.
   `settingsUpdateSchema` no longer accepts it; a `PATCH /me/settings` that still tries is rejected
   with `INVALID_INPUT` rather than silently ignored. `Identity.blockingEnabled` stays in the schema
   (migrations are additive) but is no longer selected, read or written; users' old choices have no
   meaning under the new policy, and the column is documented as legacy.
5. **The moderation panel is the reports screen.** `GET /admin/reports?limit=` returns non-expired
   reports newest first (expired rows are filtered even before the sweep deletes them), and
   `PATCH /admin/reports/:id` edits **only** the status: `open`, `reviewed`, `actioned`,
   `dismissed`. Reason, text, participants and the server's message snapshot are evidence; rewriting
   them would make the record disagree with what the reporter sent. Both routes sit on the existing
   `AdminController`, next to the archive and the inbox, because the owner's key opens one surface.
   The panel shows the reason, the reporter's note, the snapshot, both User IDs and the retention
   date, and lets the owner move a report through the statuses.
6. **The report actually carries its evidence.** Writing the panel exposed a defect: the dialog
   promised that "the last message is kept", but `reportCurrentChat` never sent a `messageId`, so
   every report filed through the interface stored no snapshot at all. The client now sends the id
   of the latest message it holds; the server still looks that id up inside the reported chat and
   copies the text from its own memory, so a hostile client cannot point the snapshot at anything
   else.

**Consequences.** The default is now "blocking off", which is what the owner asked for; tests that
exercise the mechanics of blocking enable it through the owner route in the fixture (integration
`test/global-setup.ts`, E2E `global-setup.ts`), and `test/unit/platform.test.ts` proves the shipped
fallback is `false`. A tab left open across the switch keeps drawing the button until it reloads, but
the API refuses, which is the same "interface hides, server enforces" split as elsewhere. No
moderator accounts exist: the single shared `ADMIN_TOKEN` means the panel cannot attribute an action
to a person, so every status change is the owner's own. `docs/ROADMAP.md` records that gap; adding
roles is a new decision, not a side effect of this screen. Reports are still deleted only by the
retention sweep — the panel deliberately offers no delete button, because the record is the evidence.

**Rejected.** Keeping the switch per user (D24's shape: an anonymous person granting themselves a
moderation action, and no way for the owner to set a platform default); an environment variable
(it would need a restart and would not be visible where the reports are); a UI-only rule (a stale
tab would still block); deleting a block when the policy is switched off (an amnesty nobody asked
for); editing report evidence from the panel (the record must stay what the reporter sent); a
separate module and controller for moderation (the owner surface is already one guarded class, and
splitting it would duplicate the guard wiring without adding a boundary); building moderator
accounts now (the owner explicitly deferred them, and a fake role without an audit trail would be
worse than none).

## D32. The interface speaks Russian, English and Chinese; Russian is the default

**Context.** The owner asked (2026-10-20) for a language switch beside the theme switch, for
Russian, English and Chinese, with each language named in itself. He also set two constraints that
determine the design: **Russian is the default regardless of the browser's language**, and the
existing browser-translator path (D29) must keep working. Until now the interface was Russian-only,
and `PRODUCT_SPEC.md` §24 called built-in translations the next step.

**Decision.**

1. **Three built-in locales, one default.** `apps/web/src/i18n/config.ts` holds `ru`, `en`, `zh` and
   `DEFAULT_LOCALE = 'ru'`. `Accept-Language` is never consulted: an English or Chinese browser
   still opens the Russian interface until the person chooses otherwise. `/admin` is Russian-only
   (see point 6).
2. **The dictionary is hand-rolled.** `pnpm add next-intl@4.14.9` could not create its symlinks in
   this environment (`os error 5`), and installing a framework was not necessary for three locales;
   `apps/web/src/i18n/messages.ts` is a plain object plus a `translate()` function. No new
   dependency, no route restructuring.
3. **The Russian source string is the key.** `en` defines the key set, `zh` is typed as
   `Record<keyof typeof en, string>` and the Russian dictionary is derived from the same keys. A
   missing Chinese sentence is therefore a `pnpm typecheck` failure, and changing Russian wording
   points the compiler at every call site. Placeholders (`{count}`, `{alias}`) are compared at module
   load and a translation that drops one throws with the offending key, because TypeScript cannot
   see inside a string.
4. **Two ways to read the dictionary.** React components use `useI18n()` (locale, setter and `t`);
   code that runs outside React — the socket client and the store's notifications — uses
   `activeT`/`getActiveLocale`, a module-level mirror. Those notices are snapshots: a message already
   on screen keeps the language it was created in, which is acceptable for seven-second feedback.
   Durable text is always rendered from a key.
5. **Persistence is a cookie plus a `localStorage` mirror.** `anonlink.locale` (not `HttpOnly`; it
   is not a secret) is written by the switch and read by `app/layout.tsx` on the server, so
   `<html lang>` and the page's title/description are correct before React hydrates. `localStorage`
   keeps the choice where cookies are blocked. There is no locale in the URL and no per-account
   setting: the user is anonymous, and a URL prefix would rewrite every link in the product.
6. **Native names, and `/admin` stays Russian.** The switch is a native `<select>` labelled in the
   current interface language, with `Русский`, `English`, `中文` marked `translate="no"`. The owner's
   page keeps its hardcoded Russian text and forces `<html lang="ru">` while mounted, then restores
   the previous value; it has one reader, and a half-translated owner surface would be worse than a
   consistently Russian one.
7. **What is never translated by us.** User IDs, language names (both in the switch and in the
   profile vocabulary, D30), and chat messages. A message keeps its author's language and carries
   `lang=""` and `dir="auto"` (D29), so a browser translator still detects each message separately.
   Our own translations do not replace that path; they coexist with it.

**Consequences.** Adding any user-visible sentence now means adding it to `en` and `zh`; the
compiler enforces the second, and the runtime placeholder check protects both. The layout became
dynamic (it reads a cookie), which is the honest cost of a correct server-rendered `<html lang>` and
title. `apps/web/src/lib/error-text.ts`, `labels.ts` and `format.ts` take a `Locale`; the browser
renders Russian text for server error *codes* in every locale, while the API itself continues to send
codes and English messages. The E2E suite grows `language.spec.ts` (default Russian even under an
`en-US` browser, all three dictionaries, persistence across a reload, `<html lang>`/title, and
`/admin` remaining Russian).

**Rejected.** `next-intl` (the install is blocked and the framework is heavier than the problem);
locale detection from `Accept-Language` (directly contradicts "Russian by default"); `/ru`, `/en`,
`/zh` routing (every link and the E2E helpers would need a locale, for an app whose identity is a
cookie); storing the locale in the database (there is no account, and it would not survive the first
request); translating language names (people find their own language by recognising it); translating
chat messages on the server (it would change what the author said and break the per-message
translator path); using English or Chinese keys (the source in the code is Russian, and a second
copy would drift); a half-translated `/admin` (the owner reads Russian, and the moderation panel is
the one place where an ambiguous label is dangerous).
