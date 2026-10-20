import type {
  DeclaredProfile,
  SearchPreferences,
  SessionView,
  UserLookupView,
} from '@anonlink/shared';
import { ErrorCode } from '@anonlink/shared';
import type { ErrorPayload, MatchQueuedPayload } from '@anonlink/protocol';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { RealtimeClient, createIdentity, http, type TestIdentity } from './support/api-client.js';

/**
 * Filtered random search, against a real server.
 *
 * ## What these tests are for
 *
 * The filter rules themselves are unit-tested in `@anonlink/shared`, where they are pure
 * functions. What can only be checked here is that the *server actually applies them*:
 * that the queue consults the saved filters, that both sides are checked, that an
 * undeclared value never satisfies a filter, and that a filter which cannot be satisfied
 * leads to no match rather than to a silent one.
 *
 * ## Why the settings are written *after* connecting
 *
 * The matchmaker reads a cached copy of each identity (see `DirectoryService`) so that its
 * critical section stays synchronous. Writing the settings through HTTP after the socket is
 * open therefore proves something a unit test cannot: that changing a setting takes effect
 * immediately, instead of only after the next reconnect. A filter that appears to save but
 * is ignored until you reload is worse than one that is rejected outright.
 */

const open: RealtimeClient[] = [];

/**
 * Takes every client of a finished test out of the queue and out of its chat.
 *
 * Matchmaking is global to the server, so a user left waiting would be matched by the very
 * next test's first joiner — and the resulting failure would look like a broken filter.
 * Cancelling is also exactly what a polite client does when it goes away.
 */
afterEach(async () => {
  for (const client of open.splice(0)) {
    const started = client.eventsNamed('chat:started').at(-1) as
      { chat?: { chatId?: string } } | undefined;
    const chatId = started?.chat?.chatId;

    if (chatId) await client.emit('chat:leave', { chatId });
    await client.emit('match:cancel');
    client.close();
  }
});

afterAll(() => {
  for (const client of open.splice(0)) client.close();
});

const patchSettings = (identity: TestIdentity, body: unknown) =>
  http<SessionView>('/me/settings', { method: 'PATCH', cookie: identity.cookie, body });

const patchSettingsExpectingFailure = (identity: TestIdentity, body: unknown) =>
  http<{ error: ErrorPayload }>('/me/settings', { method: 'PATCH', cookie: identity.cookie, body });

/** A connected identity, optionally with a declared profile and saved filters. */
async function participant(
  input: { profile?: Partial<DeclaredProfile>; search?: Partial<SearchPreferences> } = {},
): Promise<RealtimeClient> {
  const identity = await createIdentity();
  const client = await RealtimeClient.connect(identity);
  open.push(client);

  if (input.profile || input.search) {
    const saved = await patchSettings(identity, {
      ...(input.profile ? { profile: input.profile } : {}),
      ...(input.search ? { search: input.search } : {}),
    });

    if (saved.status !== 200) {
      throw new Error(`PATCH /me/settings failed: ${saved.status} ${JSON.stringify(saved.body)}`);
    }
  }

  return client;
}

async function join(client: RealtimeClient): Promise<void> {
  const ack = await client.emit<{ queued: boolean; waitingSince: string }>('match:join');
  if (!ack.ok) throw new Error(`match:join failed: ${JSON.stringify(ack.error)}`);
}

/** Asserts that no chat starts for any of these clients within the window. */
async function expectNoChat(clients: RealtimeClient[], withinMs: number): Promise<void> {
  await Promise.all(
    clients.map(async (client) => {
      try {
        await client.waitFor('chat:started', { timeoutMs: withinMs, fromIndex: 0 });
      } catch {
        return;
      }
      throw new Error('A chat started, but the filters should have kept these users apart.');
    }),
  );
}

/** Waits for the two clients' `chat:started` and asserts they describe one and the same chat. */
async function expectSharedChat(a: RealtimeClient, b: RealtimeClient): Promise<{ chatId: string }> {
  const [left, right] = await Promise.all([
    a.waitFor<{ chat: { chatId: string } }>('chat:started', { timeoutMs: 8_000 }),
    b.waitFor<{ chat: { chatId: string } }>('chat:started', { timeoutMs: 8_000 }),
  ]);

  expect(left.chat.chatId).toBe(right.chat.chatId);
  return { chatId: left.chat.chatId };
}

describe('filtered random search', () => {
  it('keeps a filtered searcher away from someone they excluded, then matches them with someone who fits', async () => {
    const seeker = await participant({
      profile: { gender: 'female' },
      search: { genders: ['female'] },
    });
    // Declares nothing about what *they* want, so only the seeker's filter can separate
    // them: a filter implemented on one side only would match this pair.
    const excluded = await participant({ profile: { gender: 'male' } });

    await join(seeker);
    await join(excluded);

    const queued = await seeker.waitFor<MatchQueuedPayload>('match:queued');
    expect(queued.criteria.genders).toEqual(['female']);

    await expectNoChat([seeker, excluded], 700);

    const fitting = await participant({ profile: { gender: 'female' } });
    const started = expectSharedChat(seeker, fitting);
    await join(fitting);
    await started;

    // The excluded candidate is still waiting: being passed over is not the same as being
    // removed from the queue.
    expect(excluded.eventsNamed('chat:started')).toEqual([]);
  });

  it('does not let an undeclared value satisfy a filter', async () => {
    const seeker = await participant({ search: { genders: ['male'] } });
    // Says nothing at all about gender. "Nobody declared anything" is not "everybody fits":
    // treating silence as a match would quietly overrule the setting.
    const silent = await participant();

    await join(seeker);
    await join(silent);
    await expectNoChat([seeker, silent], 700);

    const declared = await participant({ profile: { gender: 'male' } });
    const started = expectSharedChat(seeker, declared);
    await join(declared);
    await started;
  });

  it('applies the age filter to the declared year of birth', async () => {
    const thisYear = new Date().getUTCFullYear();
    const seeker = await participant({ search: { ageMin: 30, ageMax: 40 } });
    const tooYoung = await participant({ profile: { birthYear: thisYear - 22 } });

    await join(seeker);
    await join(tooYoung);
    await expectNoChat([seeker, tooYoung], 700);

    const inRange = await participant({ profile: { birthYear: thisYear - 35 } });
    const started = expectSharedChat(seeker, inRange);
    await join(inRange);
    await started;
  });

  it('compares declared places after folding case, spacing and ё/е — and nothing more', async () => {
    const seeker = await participant({ search: { cities: ['Королёв'] } });
    const anotherCity = await participant({ profile: { city: 'Москва' } });

    await join(seeker);
    await join(anotherCity);
    await expectNoChat([seeker, anotherCity], 700);

    // Same town, typed differently. Case, extra spaces and ё/е are folded; nothing else is,
    // because going further would mean guessing at geography.
    const sameTown = await participant({ profile: { city: '  королев ' } });
    const started = expectSharedChat(seeker, sameTown);
    await join(sameTown);
    await started;
  });

  it('accepts a peer matching any of the named places', async () => {
    const seeker = await participant({ search: { cities: ['Казань'], regions: ['Татарстан'] } });

    // City declared, region not: the union accepts them, and a region-only filter would
    // have refused — which is why the row is a list and not a single choice.
    const cityOnly = await participant({ profile: { city: 'Казань' } });

    await join(seeker);
    const started = expectSharedChat(seeker, cityOnly);
    await join(cityOnly);
    await started;
  });

  it('matches a declared country code, and refuses a country that was not declared', async () => {
    const seeker = await participant({ search: { countries: ['DE'] } });
    const france = await participant({ profile: { country: 'FR' } });

    await join(seeker);
    await join(france);
    await expectNoChat([seeker, france], 700);

    const germany = await participant({ profile: { country: 'DE' } });
    const started = expectSharedChat(seeker, germany);
    await join(germany);
    await started;
  });

  it('requires at least one shared language when a language filter is set', async () => {
    const seeker = await participant({ search: { languages: ['ru'] } });
    const englishOnly = await participant({ profile: { languages: ['en'] } });

    await join(seeker);
    await join(englishOnly);
    await expectNoChat([seeker, englishOnly], 700);

    const russianSpeaker = await participant({ profile: { languages: ['ru', 'en'] } });
    const started = expectSharedChat(seeker, russianSpeaker);
    await join(russianSpeaker);
    await started;
  });

  it('never widens a search on its own while the timing policy is disabled', async () => {
    // `MATCH_RELAX_AFTER_MS = 0` in this environment switches relaxation off entirely, which
    // is what makes the filter tests above deterministic. The assertion here is the other
    // half of that contract: allowing relaxation is *permission*, never an instruction, and
    // nothing may be dropped, or announced as dropped, without the server's timing policy.
    const seeker = await participant({
      search: { genders: ['female'], relaxAllowed: true },
    });
    const excluded = await participant({ profile: { gender: 'male' } });

    await join(seeker);
    await join(excluded);
    await expectNoChat([seeker, excluded], 1_200);

    expect(seeker.eventsNamed('match:relaxed')).toEqual([]);
    expect(excluded.eventsNamed('match:relaxed')).toEqual([]);
  });
});

describe('filter and profile validation', () => {
  it('rejects an inverted age range and leaves the saved filters untouched', async () => {
    const identity = await createIdentity();

    const saved = await patchSettings(identity, { search: { ageMax: 30 } });
    expect(saved.status).toBe(200);
    expect(saved.body.settings.search.ageMax).toBe(30);

    // Merged with the stored `ageMax` this becomes 40..30, which describes nobody. The
    // request must fail *before* anything is written.
    const inverted = await patchSettingsExpectingFailure(identity, { search: { ageMin: 40 } });
    expect(inverted.status).toBe(400);
    expect(inverted.body.error.code).toBe(ErrorCode.INVALID_INPUT);

    const current = await http<{ authenticated: boolean; session: SessionView }>('/session', {
      cookie: identity.cookie,
    });
    expect(current.body.session.settings.search.ageMin).toBeNull();
    expect(current.body.session.settings.search.ageMax).toBe(30);
  });

  it('rejects an age that cannot exist, an unknown language and unknown fields', async () => {
    const identity = await createIdentity();

    expect((await patchSettingsExpectingFailure(identity, { search: { ageMin: -1 } })).status).toBe(
      400,
    );
    expect(
      (await patchSettingsExpectingFailure(identity, { search: { languages: ['klingon'] } }))
        .status,
    ).toBe(400);
    expect((await patchSettingsExpectingFailure(identity, { search: { nope: true } })).status).toBe(
      400,
    );
    expect((await patchSettingsExpectingFailure(identity, { nope: true })).status).toBe(400);
    expect(
      (await patchSettingsExpectingFailure(identity, { profile: { city: '   ' } })).status,
    ).toBe(400);
  });

  it('round-trips a profile and filters, and never exposes them to another user', async () => {
    const identity = await createIdentity();

    const saved = await patchSettings(identity, {
      profile: {
        gender: 'female',
        birthYear: 1996,
        country: 'DE',
        city: 'Москва',
        region: null,
        languages: ['ru'],
      },
      search: {
        genders: ['male'],
        ageMin: 25,
        ageMax: 45,
        cities: ['Москва'],
        countries: ['DE'],
        languages: ['ru'],
        relaxAllowed: true,
      },
    });

    expect(saved.status).toBe(200);
    expect(saved.body.settings.profile.country).toBe('DE');
    expect(saved.body.settings.profile.city).toBe('Москва');
    expect(saved.body.settings.profile.languages).toEqual(['ru']);
    expect(saved.body.settings.search.ageMin).toBe(25);
    expect(saved.body.settings.search.cities).toEqual(['Москва']);
    expect(saved.body.settings.search.countries).toEqual(['DE']);
    expect(saved.body.settings.search.relaxAllowed).toBe(true);

    // Knowing somebody's User ID must not reveal a single thing about how they describe
    // themselves: the lookup answers existence and availability, and nothing else.
    const stranger = await createIdentity();
    const lookup = await http<UserLookupView>(`/users/${identity.publicId}`, {
      cookie: stranger.cookie,
    });

    expect(lookup.status).toBe(200);
    expect(Object.keys(lookup.body).sort()).toEqual(['acceptsRequests', 'exists', 'publicId']);
  });

  it('ignores a filter change made while connected only if it is invalid', async () => {
    // The counterpart of `participant()`: a *valid* change must be visible immediately,
    // which is checked by every filtering test above. This one pins the reverse — an
    // invalid change must not be half-applied, leaving the user filtered by something
    // they never chose.
    const identity = await createIdentity();
    const client = await RealtimeClient.connect(identity);
    open.push(client);

    const good = await patchSettings(identity, { search: { regions: ['Татарстан'], ageMin: 20 } });
    expect(good.status).toBe(200);

    const bad = await patchSettingsExpectingFailure(identity, { search: { ageMax: 19 } });
    expect(bad.status).toBe(400);

    const current = await http<{ authenticated: boolean; session: SessionView }>('/session', {
      cookie: identity.cookie,
    });
    expect(current.body.session.settings.search.regions).toEqual(['Татарстан']);
    expect(current.body.session.settings.search.ageMin).toBe(20);
    expect(current.body.session.settings.search.ageMax).toBeNull();
  });
});
