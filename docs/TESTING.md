# Testing

What is verified, how to run it, and — the part that matters — what is **not** verified. Counts in
this file come from real runs and are updated when the suites change. If a number here disagrees with
a log, the log wins; this file is not allowed to describe a test that does not exist.

## 1. The gate

Run from the repository root. Each command is the one a reviewer should trust.

| Command | Scope | Needs |
| --- | --- | --- |
| `pnpm lint` | ESLint over every package (7 projects) | nothing but dependencies |
| `pnpm format:check` | Prettier (`*.md` is intentionally excluded) | — |
| `pnpm typecheck` | `tsc --noEmit` in every package, including the E2E specs | — |
| `pnpm test` | Vitest: `packages/shared`, `packages/protocol`, `apps/api` | **PostgreSQL** and a built API |
| `pnpm build` | Turbo build of shared → protocol → api → web | **PostgreSQL** (the API `prebuild` checks the DB) |
| `pnpm test:e2e` | Playwright browser journeys | ports **3200/3201** free, a built API/web |

`pnpm test` deliberately does **not** include Playwright. `tests/e2e` exposes `test:e2e`, not `test`,
so `turbo run test` cannot drag the whole browser suite into a unit-test run (this was a real trap:
the E2E package used to answer to `test`).

## 2. Test inventory (last full run)

| Suite | Files | Tests | Kind |
| --- | --- | --- | --- |
| `packages/shared` | 4 | **74** | pure unit |
| `packages/protocol` | 1 | **8** | pure unit |
| `apps/api` | 11 | **147** | 26 unit + 121 integration |
| `tests/e2e` | 6 | **20** | browser, two independent contexts |
| **Total** | **22** | **249** | |

`apps/api` unit files (`test/unit/chat-views.test.ts` 16, `test/unit/rate-limit.test.ts` 10) run
without a server; the nine integration files start a **real API process on port 3101** against the
`*_test` database.

**Last full run (2026-10-19, this machine).** `pnpm lint`, `pnpm format:check`, `pnpm typecheck`,
`pnpm test` and `pnpm build` all exit 0; `pnpm test:e2e` reports `20 passed (1.8m)`. The browser suite
is not decoration — the run before it failed on `filters.spec.ts` and exposed a real defect, described
under §5.

## 3. Unit suites

**`packages/shared` (74)** — the rules both ends depend on, so they are tested once, here:

- `preferences.test.ts` (27) — filter vocabulary, strict/mutual `preferencesFit`, `normalizePlace`
  folding (`Королёв` ≡ `  королев`), the relaxation ladder (`activeRelaxationOrder`, `relaxBySteps`,
  `relaxationStage`), and that an undeclared value never satisfies a filter.
- `ids.test.ts` (18) — `generatePublicId` shape (`AL` + 12 Crockford Base32), `normalizePublicId`
  accepting look-alikes (`O`→`0`, `I`/`L`→`1`, case), `isValidPublicId` rejecting malformed input.
- `schemas.test.ts` (16) — every Zod input contract, including the age-range `.refine`, unknown-field
  rejection, and the message-length ceiling.
- `archive.test.ts` (13) — the owner's policy: `archivePolicySchema`'s cross-field rules (enabling
  requires something to store; `criteria` requires at least one criterion; `selected` requires at
  least one ID; `ageMin ≤ ageMax`), `archiveSubjectMatches` treating an undeclared attribute as no
  match, and `shouldArchiveChat` selecting the whole chat when either participant matches.

**`packages/protocol` (8)** — `PROTOCOL_VERSION` and the exact client/server event-name maps, so a
renamed event cannot silently ship.

**`apps/api/test/unit` (26)** — `ChatRecord`/view logic (`chat-views`: per-recipient `from: 'you' |
'peer'`, dedup by `clientMessageId` scoped per sender, bounded history, `endedReasonFor`
asymmetries) and the token-bucket limiter (`rate-limit`: burst, continuous refill, per-key
independence, idle-key eviction, bounded key budget).

## 4. Integration suites (`apps/api/test`, real server + database)

Each file below runs against the live process; the descriptions are the guarantees they check.

| File | Tests | What it guarantees |
| --- | --- | --- |
| `rest.test.ts` | 35 | Session lifecycle (HttpOnly cookie, hash-only storage, idempotency, forged cookie → new identity, rotation on `DELETE`), `GET /users/:publicId` never disclosing presence/ban/age, settings validation, blocks (idempotent, self-block refused, no third-party leak), security headers, error-shape consistency |
| `chat.test.ts` | 13 | Bidirectional delivery with per-recipient labels, ordering, length limits (exact-limit ok, over-limit refused), empty refused, `clientMessageId` dedup, non-participant refused, end-for-both, `chat:next`, reconnect within grace, end after grace, second tab isolation |
| `matching.test.ts` | 8 | Two waiters paired into one chat, **no identity in two chats at once**, never matching itself from two sockets, peer User ID never leaked, cancel removes from queue, re-match after leave, disconnected identity dropped, unknown event answered |
| `direct.test.ts` | 15 | Direct request delivery (sender ID disclosed because it is reciprocal), note length, unknown/self/malformed target, offline target, requests-off target, **blocked target refused without saying so**, blocked while in a chat, cancel on disconnect; accept (both IDs revealed), decline, wrong addressee, double answer, second-chat refusal |
| `moderation.test.ts` | 9 | Report ends the chat and is asymmetric, non-participant/unknown reason refused; block ends the chat and tells only the blocker, non-participant refused, immediate queue separation, own block list only, pending invitation cancelled |
| `persistence.test.ts` | 8 | Chat start/end persisted with no message content, no text column on `ChatSession`, exactly one copy of the reported message, only a token hash stored, identity kept on ID rotation, no contact columns, durable block, coarse security events; it also refuses to run against a database that is not `*_test` or whose archive is not empty, so its "nothing is stored" claims describe a default installation |
| `search-filters.test.ts` | 10 | Filters really steer *server* matching (exclude then match the compatible peer), undeclared never satisfies, age-from-birthYear, place folding, shared-language, **no widening while the timing policy is off**; inverted range rejected without touching saved filters, age floor/unknown language/unknown fields rejected, profile round-trip never exposed to another user |
| `archive.test.ts` | 13 | The owner surface is closed without the key (401 `ADMIN_AUTH_REQUIRED`), the key exchanges for an `HttpOnly`+`SameSite=Strict` cookie, `/admin/status` answers without a key, identity search by full ID and prefix, **nothing is stored while the switch is off**, a chat covered by `everyone` is stored in order with senders and an expiry, switching the switch off mid-conversation stops recording, `criteria` archives a declared person and not one who declared nothing, `selected` archives exactly the chosen IDs, an unknown ID in the selected list is refused without half-applying, deleting one transcript, deleting by expiry (the same query the sweep runs), and `delete-all` needing an explicit confirmation |
| `protocol.test.ts` | 10 | The nine client events are declared and each is routed to a handler |

Two deliberate test-environment switches make these deterministic and are the reason some behaviours
are *not* covered here (`apps/api/test/support/test-env.ts`): `MATCH_RELAX_AFTER_MS=0` and
`MAINTENANCE_INTERVAL_MS=0`. Filter widening and the retention sweep are therefore proved (or not)
elsewhere — see §6.

**Matchmaking is global to the process.** Every test that can leave an identity queued must
`match:cancel` and `chat:leave` in `afterEach`; otherwise the next test's first joiner receives the
leftover waiter and the failure looks like a filter bug.

## 5. End-to-end suites (`tests/e2e`, two independent browser contexts)

Playwright spawns its own stack — API on **3201**, web on **3200**, `*_test` database — in
`tests/e2e/global-setup.ts`. There is no Playwright `webServer`, so those ports must be free, and
`workers: 1` because matchmaking is global. Only two non-semantic hooks are permitted (`#own-user-id`
and `data-chat-id`); everything else is a real ARIA role or visible Russian text.

| Spec | Tests | Focus |
| --- | --- | --- |
| `matching.spec.ts` | 4 | Random match and bidirectional messages; ending a chat with distinct reasons for both sides; "next" starting a clean conversation; cancelling a search with a running timer |
| `filters.spec.ts` | 3 | A filter keeping two waiters apart, then a visible widening that lets the previously excluded peer through; a filter that excludes; an impossible age range refused in the UI |
| `direct.spec.ts` | 4 | Request sent/accepted; request declined; incoming requests disabled (and the setting surviving a reload); self-request refused |
| `errors.spec.ts` | 3 | Malformed ID rejected locally; unknown ID reported as not found; a second lookup replacing the first |
| `access.spec.ts` | 2 | A third party cannot read/write/end/block someone else's chat; an identity cannot be hijacked by replaying another User ID |
| `resilience.spec.ts` | 4 | Reload mid-chat restores the same conversation without duplicates; a reload does not end the chat for the peer; the composer refuses an over-long message; losing the API and returning leaves no phantom conversation |

One of these tests found a defect rather than confirming one. `filters.spec.ts` asserts that immediately
after "start search" the screen shows the criteria the *server* reported (`Пол: Женский`). It failed
because the `match:join` acknowledgement called `beginSearching()` after the `match:queued` event had
already filled the criteria, and that call wiped them — so the waiting screen claimed "Без фильтров…"
while the server was filtering, and the widening countdown never appeared. A queued search is announced
twice (the acknowledgement and the event, in either order); the store now treats the second announcement
as idempotent (`apps/web/src/store/app-store.ts`). The assertion stays: "the screen reports what the
server is actually applying" is a product requirement, not a detail.

### 5.1 The brief's twenty scenarios, mapped honestly

| # | Required scenario | Where it is checked |
| --- | --- | --- |
| 1 | Two identities | every E2E spec (two contexts) |
| 2 | Distinct User IDs | `access.spec.ts`, `identity-card` visible id |
| 3 | Identity survives reload | `resilience.spec.ts` (same conversation after reload) |
| 4 | Random match | `matching.spec.ts` |
| 5 | Interest/language match | `filters.spec.ts` (matched only after the shared criterion holds) |
| 6 | Filters exclude | `filters.spec.ts` |
| 7 | No-match behaviour | `filters.spec.ts` (widening is announced) + `matching.spec.ts` (timer keeps running) |
| 8 | Cancel search | `matching.spec.ts` |
| 9 | Re-search with previous settings | `matching.spec.ts` ("next") + `filters.spec.ts` (edit a filter, search again) |
| 10 | Bidirectional messages | `matching.spec.ts` |
| 11 | End chat | `matching.spec.ts` |
| 12 | Lookup by ID | `direct.spec.ts`, `errors.spec.ts` |
| 13 | Unavailable user | `direct.spec.ts` (requests off), `errors.spec.ts` (unknown) |
| 14 | Availability setting | `direct.spec.ts` (setting survives reload) |
| 15 | Block + report | **Integration only**: `moderation.test.ts`, `rest.test.ts`. There is no browser journey for the positive block/report flow — see §6. |
| 16 | Disconnect / reconnect | `resilience.spec.ts` (reload; API restart) + `chat.test.ts` (grace) |
| 17 | No double assignment | `matching.test.ts` (server-level) |
| 18 | Third party cannot join | `access.spec.ts` |
| 19 | Filters really affect server matching | `search-filters.test.ts` (server) + `filters.spec.ts` |
| 20 | Retention cleanup | **Partly covered.** The E2E stack runs the sweep and asserts widening; nothing asserts that a report, session or security event is deleted. The **archive's** retention query *is* covered: `archive.test.ts` backdates one archive and calls the same `deleteExpired` the sweep calls. See §6. |

## 6. What is NOT covered

Listed so that no reader, and no future contributor, mistakes "green" for "complete".

1. **Retention / stale-state cleanup (brief scenario 20).** `MaintenanceService.runOnce` is the
   enforcement point for report, session, security-event, archive and queue deadlines. The integration
   suite disables it (`MAINTENANCE_INTERVAL_MS=0`) so nothing races an assertion, and the E2E stack does
   run it (250 ms) — but the only thing E2E asserts about it is that *widening* is announced. **No test
   asserts that a report, session or security event is actually deleted, and none calls `runOnce` by
   hand with a moved clock.** A test that advances a fake clock and asserts deletion is the single
   most valuable missing test. The archive is the one exception: `archive.test.ts` backdates an archive
   and calls `POST /admin/archives/delete-expired`, which runs the same `deleteExpired()` the sweep
   runs — so the *query* is proved, though not the timer. COMPLIANCE §5.7 is marked accordingly.
2. **Block/report in a browser.** The behaviour is enforced server-side and covered by integration
   tests, but no E2E journey clicks "Заблокировать"/"Пожаловаться" and then verifies the peer's
   screen. Only the negative (third party refused) is exercised in the browser.
3. **Only Chromium.** No Firefox, no WebKit, no mobile viewport.
4. **No accessibility audit.** ARIA roles are used and relied upon as locators, but there is no axe
   run, no keyboard-only pass, no screen-reader check.
5. **No load, soak or concurrency-at-scale test.** Nothing measures concurrent chats, memory per
   chat, or matchmaking latency under load. No scaling number appears anywhere in the docs because
   none was measured.
6. **No penetration test** and **`pnpm audit` has never run** in this environment (no registry access
   from the build machine). The CI security job exists but has never executed.
7. **No multi-instance coverage.** The Redis seam is documented, not exercised; every suite assumes
   one process.
8. **No test asserts log content.** `SafeLogger` structurally redacts forbidden keys; that a given
   code path cannot log an unexpected field is reviewed by reading, not enforced.
9. **No coverage threshold** and no coverage report is published.
10. **No property-based / fuzz testing** of the ID parser, the message sanitiser or the filter
    predicate; the cases are hand-picked.
11. **Timing-sensitive policy at real intervals.** Widening is proved with `MATCH_RELAX_AFTER_MS`
    compressed to seconds in E2E; nothing verifies the production defaults feel right.
12. **No backup / restore rehearsal, no monitoring test** — these need an environment that does not
    exist here.
13. **Web has no unit tests.** The Zustand store and the client state machine (`anonymous-client.ts`)
    are exercised only through E2E; there is no isolated test of their transitions.
14. **The owner's `/admin` page has no automated test.** Its API is covered by `archive.test.ts`, but
    no browser ever opens the page, types the key, saves a policy or reads a transcript. It is verified
    by hand. A spec with a second context (the owner) alongside a pair of users is the obvious next
    test, and it is listed as a gap rather than implied to work.

## 7. Reading a failure

- Playwright artifacts (screenshots, traces) are written under `tests/e2e/.results/`; the spawned
  server PIDs are in `tests/e2e/.results/run/servers.json`.
- To kill a stuck stack: `taskkill /pid <pid> /T /F` for the PIDs in that file.
- If a run "hangs" on a locator, check whether the element's accessible name is a *setting* or an
  *instruction*. A toggle whose label flipped with state once read as the opposite action; the label
  is now stable and the state lives in `aria-pressed` plus visible `Разрешено`/`Запрещено` text.
- Matchmaking is global: an interrupted run can leave a waiter queued. `pnpm test:e2e` restarts the
  API, which clears the in-memory queue; a stale process holding port 3200/3201 must be killed first.

## 8. Interpreting the result

`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test` and `pnpm build` passing means the
declared behaviour above is enforced on this machine, against a real database and a real server.
`pnpm test:e2e` passing means the browser journeys in §5 work. None of it is a statement that the
service is production-ready: the gaps in §6 — load, penetration, backup/restore, monitoring, HTTPS
and the retention test — are exactly the things that a public launch depends on.
