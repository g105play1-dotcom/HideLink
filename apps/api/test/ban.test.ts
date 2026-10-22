import {
  ErrorCode,
  generatePublicId,
  type AdminIdentityListResponse,
  type AdminIdentityView,
  type FriendListResponse,
} from '@anonlink/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  RealtimeClient,
  adminHttp,
  createIdentity,
  http,
  matchPair,
} from './support/api-client.js';

/**
 * The owner's ban action, over the real protocol.
 *
 * The important properties are not "the row got a timestamp": a banned identity must lose
 * its live socket, its chat and its friendships, its existing cookie must be refused
 * rather than silently exchanged for a new identity, and lifting the ban must actually
 * let that same identity back in. The last point is what distinguishes "suspend" from
 * "delete the session and hope".
 */

interface IncomingFriend {
  requestId: string;
  chatId: string;
}

interface ChatEnded {
  chatId: string;
  reason: string;
}

const open: RealtimeClient[] = [];

async function client(): Promise<RealtimeClient> {
  const instance = await RealtimeClient.connect(await createIdentity());
  open.push(instance);
  return instance;
}

afterEach(() => {
  for (const instance of open.splice(0)) instance.close();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function becomeFriends(a: RealtimeClient, b: RealtimeClient, chatId: string): Promise<void> {
  const incoming = b.waitFor<IncomingFriend>('friend:incoming');
  const sent = await a.emit('friend:request', { chatId });
  expect(sent.ok).toBe(true);

  const request = await incoming;
  const accepted = await b.emit('friend:respond', { requestId: request.requestId, accept: true });
  expect(accepted.ok).toBe(true);
}

describe('the owner ban action', () => {
  it('suspends the identity, closes its socket, severs friendships, and can be lifted', async () => {
    const target = await client();
    const peer = await client();
    const { chatId } = await matchPair(target, peer);
    await becomeFriends(target, peer, chatId);

    const before = await adminHttp<AdminIdentityListResponse>(
      `/admin/identities?q=${encodeURIComponent(target.identity.publicId)}`,
    );
    expect(
      before.body.identities.find((row) => row.publicId === target.identity.publicId),
    ).toMatchObject({ banned: false, bannedAt: null, bannedReason: null });

    const targetError = target.waitFor<{ code: string }>('app:error', {
      predicate: (payload) => (payload as { code?: string }).code === ErrorCode.IDENTITY_BANNED,
    });
    const peerEnded = peer.waitFor<ChatEnded>('chat:ended');
    const peerRemoved = peer.waitFor<{ publicId: string }>('friend:removed');

    const banned = await adminHttp<AdminIdentityView>(
      `/admin/identities/${encodeURIComponent(target.identity.publicId)}/ban`,
      { method: 'POST', body: { reason: 'оскорбления после жалобы' } },
    );
    expect(banned.status).toBe(200);
    expect(banned.body).toMatchObject({
      publicId: target.identity.publicId,
      banned: true,
      bannedReason: 'оскорбления после жалобы',
    });
    expect(banned.body.bannedAt).not.toBeNull();

    // The banned person is told why the transport closes; the peer is not told that a
    // suspension happened, only that the conversation ended.
    await expect(targetError).resolves.toMatchObject({ code: ErrorCode.IDENTITY_BANNED });
    await expect(peerEnded).resolves.toMatchObject({ reason: 'peer_left' });
    await expect(peerRemoved).resolves.toMatchObject({ publicId: target.identity.publicId });

    await sleep(100);
    expect(target.connected).toBe(false);

    const peerFriends = await http<FriendListResponse>('/friends', {
      cookie: peer.identity.cookie,
    });
    expect(peerFriends.status).toBe(200);
    expect(peerFriends.body.friends).toEqual([]);

    // The identity's session is deliberately left in place. A reload must therefore be
    // refused with IDENTITY_BANNED, not quietly turned into a fresh anonymous identity.
    const refused = await http<{ error: { code: string } }>('/session', {
      method: 'POST',
      cookie: target.identity.cookie,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe(ErrorCode.IDENTITY_BANNED);

    const unbanned = await adminHttp<AdminIdentityView>(
      `/admin/identities/${encodeURIComponent(target.identity.publicId)}/ban`,
      { method: 'DELETE' },
    );
    expect(unbanned.status).toBe(200);
    expect(unbanned.body).toMatchObject({
      publicId: target.identity.publicId,
      banned: false,
      bannedAt: null,
      bannedReason: null,
    });

    // The same cookie works again. Unbanning must restore the identity, not require the
    // person to invent a new one (that would make the action a deletion in disguise).
    const restored = await http<{ publicId: string }>('/session', {
      method: 'POST',
      cookie: target.identity.cookie,
    });
    expect([200, 201]).toContain(restored.status);
    expect(restored.body.publicId).toBe(target.identity.publicId);
  });

  it('is owner-only, validates the reason, and refuses an unknown User ID', async () => {
    const user = await createIdentity();

    const anonymous = await http<{ error: { code: string } }>(
      `/admin/identities/${encodeURIComponent(user.publicId)}/ban`,
      { method: 'POST', cookie: user.cookie, body: { reason: 'причина' } },
    );
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe(ErrorCode.ADMIN_AUTH_REQUIRED);

    const short = await adminHttp<{ error: { code: string } }>(
      `/admin/identities/${encodeURIComponent(user.publicId)}/ban`,
      { method: 'POST', body: { reason: 'x' } },
    );
    expect(short.status).toBe(400);
    expect(short.body.error.code).toBe(ErrorCode.INVALID_INPUT);

    const extra = await adminHttp<{ error: { code: string } }>(
      `/admin/identities/${encodeURIComponent(user.publicId)}/ban`,
      { method: 'POST', body: { reason: 'достаточная причина', extra: true } },
    );
    expect(extra.status).toBe(400);
    expect(extra.body.error.code).toBe(ErrorCode.INVALID_INPUT);

    const missing = await adminHttp<{ error: { code: string } }>(
      `/admin/identities/${generatePublicId()}/ban`,
      { method: 'POST', body: { reason: 'достаточная причина' } },
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe(ErrorCode.USER_NOT_FOUND);
  });
});
