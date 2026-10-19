import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ARCHIVE_POLICY,
  ErrorCode,
  type AdminIdentityListResponse,
  type AdminStatusView,
  type ArchiveDeletionResponse,
  type ArchivePolicy,
  type ArchivePolicyView,
  type ArchivedChatView,
  type DeclaredProfile,
} from '@anonlink/shared';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  RealtimeClient,
  createIdentity,
  http,
  matchPair,
  sendMessage,
  type HttpOptions,
  type TestIdentity,
} from './support/api-client.js';

/**
 * The owner's archive, exercised through the documented HTTP protocol only.
 *
 * ## What only these tests can prove
 *
 * The policy arithmetic is unit-tested in `@anonlink/shared`. What cannot be checked
 * there is that the *server* applies it to a real conversation: that a chat is archived
 * when the policy covers a participant, that nothing is stored when it does not, that
 * switching the switch off stops recording mid-conversation, and that the owner — and
 * nobody else — can read it back.
 *
 * ## Why every test leaves the archive off and empty
 *
 * Archiving is global state, exactly like the match queue. A leftover transcript would
 * make `persistence.test.ts` describe an installation that no longer exists, and a
 * leftover *policy* would silently record the next file's conversations. `afterEach` puts
 * both back, so the suite as a whole always ends in the default, nothing-stored state.
 */

const OWNER_TOKEN = 'test-owner-key-not-a-real-secret-0001';
const OWNER_HEADERS = { authorization: `Bearer ${OWNER_TOKEN}` } as const;

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

const open: RealtimeClient[] = [];

/** An admin request, as the owner's browser or a script would send it. */
function owner<T = unknown>(path: string, options: HttpOptions = {}) {
  return http<T>(path, { ...options, headers: { ...OWNER_HEADERS, ...options.headers } });
}

function policy(overrides: Partial<ArchivePolicy> = {}): ArchivePolicy {
  return { ...DEFAULT_ARCHIVE_POLICY, ...overrides };
}

async function setPolicy(next: ArchivePolicy): Promise<void> {
  const result = await owner<ArchivePolicy>('/admin/policy', { method: 'PUT', body: next });
  if (result.status !== 200) {
    throw new Error(`PUT /admin/policy failed: ${result.status} ${JSON.stringify(result.body)}`);
  }
}

async function clearArchive(): Promise<void> {
  const result = await owner<ArchiveDeletionResponse>('/admin/archives/delete-all', {
    method: 'POST',
    body: { confirm: true },
  });
  if (result.status !== 200) {
    throw new Error(
      `POST /admin/archives/delete-all failed: ${result.status} ${JSON.stringify(result.body)}`,
    );
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for a fire-and-forget archive write to land.
 *
 * Storing a message deliberately does not block the sender, so the ack arrives before the
 * row exists. Polling the owner endpoint is what an impatient owner would do, and it keeps
 * the test honest: it asserts the *observable* result, not an internal promise.
 */
async function waitForArchive(
  chatId: string,
  messageCount: number,
  timeoutMs = 5_000,
): Promise<ArchivedChatView> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;

  while (Date.now() < deadline) {
    const result = await owner<ArchivedChatView>(`/admin/archives/${chatId}`);
    lastStatus = result.status;
    if (result.status === 200 && result.body.messages.length >= messageCount) return result.body;
    await sleep(40);
  }

  throw new Error(
    `Archive ${chatId} never reached ${messageCount} message(s); last status ${lastStatus}.`,
  );
}

/** A connected identity, optionally with a declared profile. */
async function participant(profile?: Partial<DeclaredProfile>): Promise<RealtimeClient> {
  const identity = await createIdentity();
  const client = await RealtimeClient.connect(identity);
  open.push(client);

  if (profile) {
    const saved = await http('/me/settings', {
      method: 'PATCH',
      cookie: identity.cookie,
      body: { profile },
    });
    if (saved.status !== 200) {
      throw new Error(`PATCH /me/settings failed: ${saved.status} ${JSON.stringify(saved.body)}`);
    }
  }

  return client;
}

async function connectExisting(identity: TestIdentity): Promise<RealtimeClient> {
  const client = await RealtimeClient.connect(identity);
  open.push(client);
  return client;
}

beforeAll(async () => {
  // A previous interrupted run may have left a policy behind. Start from the default.
  await setPolicy(DEFAULT_ARCHIVE_POLICY);
  await clearArchive();
});

afterEach(async () => {
  // Matchmaking is global: a user left queued or in a chat would be handed to the next
  // test's first joiner. This is the same cleanup `search-filters.test.ts` does.
  for (const client of open.splice(0)) {
    const started = client.eventsNamed('chat:started').at(-1) as
      { chat?: { chatId?: string } } | undefined;
    const chatId = started?.chat?.chatId;

    if (chatId) await client.emit('chat:leave', { chatId });
    await client.emit('match:cancel');
    client.close();
  }

  // Archiving is global too, and the privacy suite that runs after this file must see the
  // default installation: switch off, nothing stored.
  await setPolicy(DEFAULT_ARCHIVE_POLICY);
  await clearArchive();
});

afterAll(async () => {
  await pool.end();
});

describe('the owner surface', () => {
  it('refuses every archive route without the owner key', async () => {
    const anonymous = await http<{ error: { code: string } }>('/admin/archives');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe(ErrorCode.ADMIN_AUTH_REQUIRED);

    const wrong = await http<{ error: { code: string } }>('/admin/policy', {
      headers: { authorization: 'Bearer not-the-owner-key' },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe(ErrorCode.ADMIN_AUTH_REQUIRED);
  });

  it('says whether it is configured, without asking for the key', async () => {
    // The page has to be able to say "архив выключен" before the owner types anything.
    const status = await http<AdminStatusView>('/admin/status');
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ available: true });
  });

  it('exchanges the key for an HttpOnly, SameSite=Strict cookie — and only for the right key', async () => {
    const wrong = await http('/admin/session', { method: 'POST', body: { token: 'wrong' } });
    expect(wrong.status).toBe(401);
    expect(wrong.setCookie).toEqual([]);

    const right = await http('/admin/session', { method: 'POST', body: { token: OWNER_TOKEN } });
    expect(right.status).toBe(204);

    const raw = right.setCookie[0] ?? '';
    const lowered = raw.toLowerCase();
    expect(raw).toContain('anonlink_admin=');
    expect(lowered).toContain('httponly');
    expect(lowered).toContain('samesite=strict');

    // From here the cookie is the credential; the key never has to be sent again.
    const viaCookie = await http<ArchivePolicyView>('/admin/policy', {
      cookie: raw.split(';')[0],
    });
    expect(viaCookie.status).toBe(200);
    expect(viaCookie.body.enabled).toBe(false);
  });

  it('refuses to wipe the archive without an explicit confirmation', async () => {
    const result = await owner<{ error: { code: string } }>('/admin/archives/delete-all', {
      method: 'POST',
      body: {},
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe(ErrorCode.INVALID_INPUT);
  });

  it('finds a User ID by full value and by prefix', async () => {
    const identity = await createIdentity();

    const exact = await owner<AdminIdentityListResponse>(
      `/admin/identities?q=${encodeURIComponent(identity.publicId)}`,
    );
    expect(exact.status).toBe(200);
    expect(exact.body.identities.map((row) => row.publicId)).toContain(identity.publicId);

    const prefix = await owner<AdminIdentityListResponse>(
      `/admin/identities?q=${encodeURIComponent(identity.publicId.slice(0, 6))}`,
    );
    expect(prefix.body.identities.map((row) => row.publicId)).toContain(identity.publicId);
  });
});

describe('the archive policy', () => {
  it('stores nothing while the switch is off', async () => {
    const alice = await participant();
    const bob = await participant();
    const { chatId } = await matchPair(alice, bob);

    const ack = await sendMessage(alice, chatId, `off-${randomUUID()}`);
    expect(ack.ok).toBe(true);
    // The peer received it; the conversation is real. Only storage is off.
    await bob.waitFor('chat:message', { predicate: () => true });

    // Fire-and-forget writes land within milliseconds. A grace period is enough to catch
    // the bug this test exists for: a write that should never have been scheduled.
    await sleep(300);

    const read = await owner<{ error: { code: string } }>(`/admin/archives/${chatId}`);
    expect(read.status).toBe(404);
    expect(read.body.error.code).toBe(ErrorCode.CHAT_NOT_FOUND);
  });

  it('stores the transcript, in order and with senders, when the audience is everyone', async () => {
    await setPolicy(policy({ enabled: true, audience: 'everyone', retentionDays: 90 }));

    const alice = await participant({ gender: 'female', city: 'Москва' });
    const bob = await participant();
    const { chatId } = await matchPair(alice, bob);

    const first = `first-${randomUUID()}`;
    const second = `second-${randomUUID()}`;
    expect((await sendMessage(alice, chatId, first)).ok).toBe(true);
    expect((await sendMessage(bob, chatId, second)).ok).toBe(true);

    const stored = await waitForArchive(chatId, 2);

    expect(stored.messages.map((message) => message.text)).toEqual([first, second]);
    expect(stored.messages[0]?.senderPublicId).toBe(alice.identity.publicId);
    expect(stored.messages[1]?.senderPublicId).toBe(bob.identity.publicId);
    // The summary names both sides, in whatever order the server assigned them.
    expect(stored.summary.participants.map((row) => row.publicId).sort()).toEqual(
      [alice.identity.publicId, bob.identity.publicId].sort(),
    );
    // A 90-day policy must produce a deadline, not an indefinitely kept transcript.
    expect(stored.summary.expiresAt).not.toBeNull();
  });

  it('stops recording as soon as the switch is turned off, mid-conversation', async () => {
    await setPolicy(policy({ enabled: true, audience: 'everyone' }));

    const alice = await participant();
    const bob = await participant();
    const { chatId } = await matchPair(alice, bob);

    const kept = `kept-${randomUUID()}`;
    const dropped = `dropped-${randomUUID()}`;

    expect((await sendMessage(alice, chatId, kept)).ok).toBe(true);
    await waitForArchive(chatId, 1);

    await setPolicy(DEFAULT_ARCHIVE_POLICY);
    expect((await sendMessage(bob, chatId, dropped)).ok).toBe(true);
    await sleep(300);

    const stored = await owner<ArchivedChatView>(`/admin/archives/${chatId}`);
    expect(stored.status).toBe(200);
    expect(stored.body.messages.map((message) => message.text)).toEqual([kept]);
  });

  it('archives a person by declared attributes, and never one who declared nothing', async () => {
    await setPolicy(
      policy({
        enabled: true,
        audience: 'criteria',
        criteria: {
          genders: ['female'],
          ageMin: null,
          ageMax: null,
          cities: [],
          regions: [],
          languages: [],
        },
      }),
    );

    const declared = await participant({ gender: 'female' });
    const partner = await participant();
    const first = await matchPair(declared, partner);
    expect((await sendMessage(declared, first.chatId, `declared-${randomUUID()}`)).ok).toBe(true);
    await waitForArchive(first.chatId, 1);

    // Nobody in the second pair declared a gender. "Did not say" is not a match — the same
    // strict rule the search filters use.
    const silentA = await participant();
    const silentB = await participant();
    const second = await matchPair(silentA, silentB);
    expect((await sendMessage(silentA, second.chatId, `silent-${randomUUID()}`)).ok).toBe(true);
    await sleep(300);

    const untouched = await owner(`/admin/archives/${second.chatId}`);
    expect(untouched.status).toBe(404);
  });

  it('archives exactly the User IDs the owner selected', async () => {
    const chosenIdentity = await createIdentity();
    await setPolicy(
      policy({
        enabled: true,
        audience: 'selected',
        selectedPublicIds: [chosenIdentity.publicId],
      }),
    );

    const chosen = await connectExisting(chosenIdentity);
    const partner = await participant();
    const archived = await matchPair(chosen, partner);
    expect((await sendMessage(partner, archived.chatId, `chosen-${randomUUID()}`)).ok).toBe(true);
    await waitForArchive(archived.chatId, 1);

    const outsiderA = await participant();
    const outsiderB = await participant();
    const untouched = await matchPair(outsiderA, outsiderB);
    expect((await sendMessage(outsiderA, untouched.chatId, `outsider-${randomUUID()}`)).ok).toBe(
      true,
    );
    await sleep(300);

    expect((await owner(`/admin/archives/${untouched.chatId}`)).status).toBe(404);
  });

  it('refuses a selected list containing a User ID that does not exist', async () => {
    const result = await owner<{ error: { code: string } }>('/admin/policy', {
      method: 'PUT',
      body: {
        ...DEFAULT_ARCHIVE_POLICY,
        audience: 'selected',
        // Syntactically valid, but nobody has it. Silently dropping it would leave the
        // owner believing a person was being recorded.
        selectedPublicIds: ['AL000000000000'],
      },
    });

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe(ErrorCode.INVALID_INPUT);

    const current = await owner<ArchivePolicyView>('/admin/policy');
    expect(current.body.enabled).toBe(false);
    expect(current.body.selectedPublicIds).toEqual([]);
  });
});

describe('retention and deletion', () => {
  async function archiveOneMessage(): Promise<string> {
    await setPolicy(policy({ enabled: true, audience: 'everyone', retentionDays: 1 }));

    const alice = await participant();
    const bob = await participant();
    const { chatId } = await matchPair(alice, bob);

    expect((await sendMessage(alice, chatId, `retention-${randomUUID()}`)).ok).toBe(true);
    await waitForArchive(chatId, 1);
    return chatId;
  }

  it('deletes one transcript on request, and reports what went with it', async () => {
    const chatId = await archiveOneMessage();

    const deleted = await owner<ArchiveDeletionResponse>(`/admin/archives/${chatId}`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ deletedArchives: 1, deletedMessages: 1 });

    expect((await owner(`/admin/archives/${chatId}`)).status).toBe(404);
  });

  it('deletes archives whose retention ran out', async () => {
    const chatId = await archiveOneMessage();

    // The periodic sweep is disabled for this suite (`MAINTENANCE_INTERVAL_MS=0`), so the
    // deadline is moved into the past directly. `delete-expired` runs exactly the query
    // the sweep runs — that is why the endpoint exists rather than only the timer.
    await pool.query(
      `UPDATE "ChatArchive" SET "expiresAt" = now() - interval '1 day' WHERE "chatId" = $1`,
      [chatId],
    );

    const purged = await owner<ArchiveDeletionResponse>('/admin/archives/delete-expired', {
      method: 'POST',
    });
    expect(purged.status).toBe(200);
    expect(purged.body.deletedArchives).toBeGreaterThanOrEqual(1);

    expect((await owner(`/admin/archives/${chatId}`)).status).toBe(404);
  });
});
