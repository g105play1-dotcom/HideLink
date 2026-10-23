import type { ChatMessageView } from '@anonlink/protocol';
import {
  ErrorCode,
  generatePublicId,
  type AdminOwnerChatListResponse,
  type AdminOwnerChatView,
  type AdminOwnerJoinResponse,
  type AdminOwnerReservationListResponse,
  type AdminUserListResponse,
} from '@anonlink/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  RealtimeClient,
  adminHttp,
  createIdentity,
  http,
  sendMessage,
  type HttpResult,
  type TestIdentity,
} from './support/api-client.js';

interface StartedPayload {
  chat: {
    chatId: string;
    kind: string;
    peer: { alias: string; publicId?: string };
  };
  initiator: boolean;
}

/**
 * The owner's people directory and hidden join (D39).
 *
 * These tests speak only the documented surfaces: the owner's REST cookie and the target's
 * real Socket.IO session. In particular they assert the privacy property that matters —
 * the target receives an ordinary random chat with an alias and no public User ID — not the
 * persona's database row.
 */

const open: RealtimeClient[] = [];

async function client(): Promise<RealtimeClient> {
  const instance = await RealtimeClient.connect(await createIdentity());
  open.push(instance);
  return instance;
}

afterEach(() => {
  for (const instance of open.splice(0)) instance.close();
});

async function saveSettings(identity: TestIdentity, body: unknown): Promise<void> {
  const saved = await http('/me/settings', {
    method: 'PATCH',
    cookie: identity.cookie,
    body,
  });
  if (saved.status !== 200) {
    throw new Error(`PATCH /me/settings failed: ${saved.status} ${JSON.stringify(saved.body)}`);
  }
}

function adminUsers(
  query: Record<string, string | number>,
): Promise<HttpResult<AdminUserListResponse>> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) params.set(key, String(value));
  return adminHttp<AdminUserListResponse>(`/admin/users?${params.toString()}`);
}

describe('the owner directory', () => {
  it('finds people by declared attributes and by what they search for, and keeps favorites', async () => {
    const target = await createIdentity();
    await saveSettings(target, {
      profile: {
        gender: 'female',
        birthYear: 1995,
        country: 'RU',
        city: 'Казань',
        region: 'Татарстан',
        languages: ['ru', 'en'],
      },
      search: {
        genders: ['male'],
        ageMin: 25,
        ageMax: 35,
        cities: ['Москва'],
        countries: ['RU'],
        languages: ['ru'],
        relaxAllowed: true,
      },
    });

    const declared = await adminUsers({
      declaredGender: 'female',
      declaredCity: 'Казань',
      declaredCountry: 'RU',
      declaredLanguage: 'ru',
    });
    expect(declared.status).toBe(200);

    const found = declared.body.users.find((row) => row.publicId === target.publicId);
    expect(found).toMatchObject({
      publicId: target.publicId,
      favorite: false,
      profile: {
        gender: 'female',
        country: 'RU',
        city: 'Казань',
        region: 'Татарстан',
        languages: ['ru', 'en'],
      },
      search: {
        genders: ['male'],
        ageMin: 25,
        ageMax: 35,
        cities: ['Москва'],
        countries: ['RU'],
        languages: ['ru'],
        relaxAllowed: true,
      },
    });
    // The declaration is self-reported and stored as a birth year; the panel turns it into
    // an age for display, while the API must not silently rewrite the stored value.
    expect(found?.profile.birthYear).toBe(1995);

    const seeks = await adminUsers({ prefGender: 'male', seeksAge: 30, prefCity: 'Москва' });
    expect(seeks.status).toBe(200);
    expect(seeks.body.users.map((row) => row.publicId)).toContain(target.publicId);

    const outsideRange = await adminUsers({ prefGender: 'male', seeksAge: 50 });
    expect(outsideRange.body.users.map((row) => row.publicId)).not.toContain(target.publicId);

    const relaxes = await adminUsers({ declaredCity: 'Казань', prefRelax: 'yes' });
    expect(relaxes.body.users.map((row) => row.publicId)).toContain(target.publicId);

    const strict = await adminUsers({ declaredCity: 'Казань', prefRelax: 'no' });
    expect(strict.body.users.map((row) => row.publicId)).not.toContain(target.publicId);

    const starred = await adminHttp<{ favorite: boolean }>(
      `/admin/users/${encodeURIComponent(target.publicId)}/favorite`,
      { method: 'PUT' },
    );
    expect(starred.status).toBe(200);
    expect(starred.body.favorite).toBe(true);

    const favorites = await adminUsers({ favorite: 'yes' });
    expect(favorites.body.users.map((row) => row.publicId)).toContain(target.publicId);
    expect(favorites.body.users.find((row) => row.publicId === target.publicId)?.favorite).toBe(
      true,
    );

    const unstarred = await adminHttp<{ favorite: boolean }>(
      `/admin/users/${encodeURIComponent(target.publicId)}/favorite`,
      { method: 'DELETE' },
    );
    expect(unstarred.status).toBe(200);
    expect(unstarred.body.favorite).toBe(false);

    const after = await adminUsers({ favorite: 'yes' });
    expect(after.body.users.map((row) => row.publicId)).not.toContain(target.publicId);
  });

  it('joins a searching person as a normal peer and carries the conversation both ways', async () => {
    const target = await client();

    const queued = await target.emit<{ queued: boolean }>('match:join');
    expect(queued.ok).toBe(true);

    const started = target.waitFor<StartedPayload>('chat:started');
    const joined = await adminHttp<AdminOwnerJoinResponse>(
      `/admin/users/${encodeURIComponent(target.identity.publicId)}/join`,
      { method: 'POST' },
    );
    expect(joined.status).toBe(200);
    expect(joined.body.kind).toBe('joined');
    expect(joined.body.chat?.targetPublicId).toBe(target.identity.publicId);
    expect(joined.body.chat?.status).toBe('active');

    const payload = await started;
    expect(payload.chat.kind).toBe('random');
    // Random chats never disclose a User ID, and a hidden persona is no exception.
    expect(payload.chat.peer.publicId).toBeUndefined();
    expect(payload.chat.peer.alias.length).toBeGreaterThan(0);

    const incoming = target.waitFor<ChatMessageView>('chat:message', {
      predicate: (event) => (event as ChatMessageView).from === 'peer',
    });
    const sent = await adminHttp<{ messageId: string; sentAt: string }>(
      `/admin/chats/${joined.body.chat?.chatId}/messages`,
      { method: 'POST', body: { text: 'Здравствуйте, это обычный чат.' } },
    );
    expect(sent.status).toBe(200);
    await expect(incoming).resolves.toMatchObject({
      from: 'peer',
      text: 'Здравствуйте, это обычный чат.',
    });

    const reply = await sendMessage(target, joined.body.chat?.chatId ?? '', 'Привет.');
    expect(reply.ok).toBe(true);

    const transcript = await adminHttp<AdminOwnerChatView>(
      `/admin/chats/${joined.body.chat?.chatId}`,
    );
    expect(transcript.status).toBe(200);
    expect(transcript.body.messages).toEqual([
      expect.objectContaining({ from: 'owner', text: 'Здравствуйте, это обычный чат.' }),
      expect.objectContaining({ from: 'target', text: 'Привет.' }),
    ]);

    const chats = await adminHttp<AdminOwnerChatListResponse>('/admin/chats');
    expect(chats.status).toBe(200);
    expect(chats.body.chats.map((chat) => chat.chatId)).toContain(joined.body.chat?.chatId);

    const ended = target.waitFor<{ reason: string }>('chat:ended');
    const left = await adminHttp<{ ended: true }>(
      `/admin/chats/${joined.body.chat?.chatId}/leave`,
      { method: 'POST' },
    );
    expect(left.status).toBe(200);
    await expect(ended).resolves.toMatchObject({ reason: 'peer_left' });
  });

  it('reserves an idle person and takes precedence over ordinary matchmaking on their next search', async () => {
    const target = await client();

    const reserved = await adminHttp<AdminOwnerJoinResponse>(
      `/admin/users/${encodeURIComponent(target.identity.publicId)}/join`,
      { method: 'POST' },
    );
    expect(reserved.status).toBe(200);
    expect(reserved.body).toEqual({ kind: 'reserved', chat: null });

    const pending = await adminHttp<AdminOwnerReservationListResponse>('/admin/reservations');
    expect(pending.status).toBe(200);
    expect(pending.body.reservations.map((row) => row.targetPublicId)).toContain(
      target.identity.publicId,
    );

    const started = target.waitFor<StartedPayload>('chat:started');
    const joined = await target.emit<{ chat: StartedPayload['chat'] }>('match:join');
    expect(joined.ok).toBe(true);

    const payload = await started;
    expect(payload.chat.kind).toBe('random');
    expect(payload.chat.peer.publicId).toBeUndefined();

    const gone = await adminHttp<AdminOwnerReservationListResponse>('/admin/reservations');
    expect(gone.body.reservations.map((row) => row.targetPublicId)).not.toContain(
      target.identity.publicId,
    );

    await target.emit('chat:leave', { chatId: payload.chat.chatId }).catch(() => undefined);
  });

  it('is owner-only, refuses unknown people and rejects loose input', async () => {
    const user = await createIdentity();

    const anonymous = await http<{ error: { code: string } }>('/admin/users?favorite=yes', {
      cookie: user.cookie,
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe(ErrorCode.ADMIN_AUTH_REQUIRED);

    // An empty search is not a request to dump the table.
    const empty = await adminHttp<AdminUserListResponse>('/admin/users');
    expect(empty.status).toBe(200);
    expect(empty.body.users).toEqual([]);

    // Four characters that normalize away to nothing are still an empty search, not a
    // criterion that happens to match the whole table.
    const punctuation = await adminUsers({ q: '!!!!' });
    expect(punctuation.status).toBe(200);
    expect(punctuation.body.users).toEqual([]);

    const missingFavorite = await adminHttp<{ error: { code: string } }>(
      `/admin/users/${encodeURIComponent(generatePublicId())}/favorite`,
      { method: 'PUT' },
    );
    expect(missingFavorite.status).toBe(404);
    expect(missingFavorite.body.error.code).toBe(ErrorCode.USER_NOT_FOUND);

    const missingJoin = await adminHttp<{ error: { code: string } }>(
      `/admin/users/${encodeURIComponent(generatePublicId())}/join`,
      { method: 'POST' },
    );
    expect(missingJoin.status).toBe(404);
    expect(missingJoin.body.error.code).toBe(ErrorCode.USER_NOT_FOUND);

    const looseQuery = await adminHttp<{ error: { code: string } }>('/admin/users?nope=1');
    expect(looseQuery.status).toBe(400);
    expect(looseQuery.body.error.code).toBe(ErrorCode.INVALID_INPUT);

    const looseBody = await adminHttp<{ error: { code: string } }>(
      '/admin/chats/00000000-0000-4000-8000-000000000000/messages',
      { method: 'POST', body: { text: 'привет', extra: true } },
    );
    expect(looseBody.status).toBe(400);
    expect(looseBody.body.error.code).toBe(ErrorCode.INVALID_INPUT);
  });
});
