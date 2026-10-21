import { randomUUID } from 'node:crypto';

import type { ChatView } from '@anonlink/protocol';
import { ErrorCode, type FriendListResponse, type FriendView } from '@anonlink/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  RealtimeClient,
  createIdentity,
  http,
  matchPair,
  setBlockingPolicy,
} from './support/api-client.js';

/**
 * Friendships, over the real protocol.
 *
 * The rules being proved here are the ones a user can feel:
 *  - a friendship appears only after both people agree, and only then are User IDs shown;
 *  - a declined or expired question closes that chat, so it cannot be used to nag;
 *  - removal is one-sided and immediate;
 *  - blocking, reporting and a panic-button rotation sever the link;
 *  - a reload does not lose a request the other side is still waiting to have answered.
 */

interface StartedChat {
  chat: ChatView;
  initiator: boolean;
}

interface IncomingFriend {
  requestId: string;
  chatId: string;
  alias: string;
  expiresAt: string;
}

interface ResolvedFriend {
  requestId: string;
  chatId: string;
  status: string;
  friend?: FriendView;
}

interface FriendRequestAck {
  requestId: string;
  chatId: string;
  expiresAt: string;
  accepted: boolean;
}

interface IncomingChatRequest {
  requestId: string;
}

interface ChatEnded {
  chatId: string;
  reason: string;
}

const open: RealtimeClient[] = [];
const chats: { client: RealtimeClient; chatId: string }[] = [];

async function client(): Promise<RealtimeClient> {
  const instance = await RealtimeClient.connect(await createIdentity());
  open.push(instance);
  return instance;
}

async function twoInChat(): Promise<{
  a: RealtimeClient;
  b: RealtimeClient;
  chatId: string;
  aStarted: StartedChat;
  bStarted: StartedChat;
}> {
  const a = await client();
  const b = await client();
  const { chatId, aStarted, bStarted } = await matchPair(a, b);
  chats.push({ client: a, chatId }, { client: b, chatId });
  return { a, b, chatId, aStarted, bStarted };
}

function sendFriendRequest(from: RealtimeClient, chatId: string) {
  return from.emit<FriendRequestAck>('friend:request', { chatId });
}

async function becomeFriends(
  a: RealtimeClient,
  b: RealtimeClient,
  chatId: string,
): Promise<IncomingFriend> {
  const incoming = b.waitFor<IncomingFriend>('friend:incoming');
  const sent = await sendFriendRequest(a, chatId);
  if (!sent.ok) throw new Error(`friend:request failed: ${JSON.stringify(sent.error)}`);

  const request = await incoming;
  const accepted = await b.emit<{ accepted: boolean }>('friend:respond', {
    requestId: request.requestId,
    accept: true,
  });
  if (!accepted.ok || !accepted.data.accepted) {
    throw new Error(`friend:respond failed: ${JSON.stringify(accepted)}`);
  }
  return request;
}

async function friendList(instance: RealtimeClient): Promise<FriendView[]> {
  const result = await http<FriendListResponse>('/friends', {
    cookie: instance.identity.cookie,
  });
  expect(result.status).toBe(200);
  return result.body.friends;
}

afterEach(async () => {
  for (const entry of chats.splice(0)) {
    // Best effort: an already-ended chat answers with an error, which is fine. What
    // matters is that no queued or active chat leaks into the next test.
    await entry.client.emit('chat:leave', { chatId: entry.chatId });
  }
  for (const instance of open.splice(0)) instance.close();
});

describe('asking to become friends', () => {
  it('creates a mutual link only after acceptance, revealing the other User ID to each side', async () => {
    const { a, b, chatId, bStarted } = await twoInChat();

    expect(await friendList(a)).toEqual([]);
    expect(await friendList(b)).toEqual([]);

    const incoming = b.waitFor<IncomingFriend>('friend:incoming');
    const sent = await sendFriendRequest(a, chatId);

    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.data.accepted).toBe(false);

    const request = await incoming;
    expect(request.requestId).toBe(sent.data.requestId);
    expect(request.chatId).toBe(chatId);
    // The recipient sees only the per-chat alias, never the requester's User ID.
    expect(request.alias).toBe(bStarted.chat.peer.alias);
    expect(request).not.toHaveProperty('publicId');

    const aResolved = a.waitFor<ResolvedFriend>('friend:resolved', {
      predicate: (payload) => (payload as ResolvedFriend).requestId === request.requestId,
    });
    const bResolved = b.waitFor<ResolvedFriend>('friend:resolved', {
      predicate: (payload) => (payload as ResolvedFriend).requestId === request.requestId,
    });

    const answered = await b.emit<{ accepted: boolean }>('friend:respond', {
      requestId: request.requestId,
      accept: true,
    });
    expect(answered.ok).toBe(true);
    if (answered.ok) expect(answered.data.accepted).toBe(true);

    const [forA, forB] = await Promise.all([aResolved, bResolved]);
    expect(forA).toMatchObject({ chatId, status: 'accepted' });
    expect(forB).toMatchObject({ chatId, status: 'accepted' });
    expect(forA.friend?.publicId).toBe(b.identity.publicId);
    expect(forB.friend?.publicId).toBe(a.identity.publicId);
    expect(Date.parse(forA.friend?.since ?? '')).not.toBeNaN();

    const aFriends = await friendList(a);
    const bFriends = await friendList(b);
    expect(aFriends.map((friend) => friend.publicId)).toEqual([b.identity.publicId]);
    expect(bFriends.map((friend) => friend.publicId)).toEqual([a.identity.publicId]);

    // A durable friendship is the end of the question: neither side can ask again.
    const again = await sendFriendRequest(a, chatId);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe(ErrorCode.ALREADY_FRIENDS);
  });

  it('tells both clients that a new direct chat is with an existing friend', async () => {
    const { a, b, chatId } = await twoInChat();
    await becomeFriends(a, b, chatId);

    const bEnded = b.waitFor<ChatEnded>('chat:ended', { fromIndex: b.received.length });
    const left = await a.emit('chat:leave', { chatId });
    expect(left.ok).toBe(true);
    await bEnded;

    const incoming = b.waitFor<IncomingChatRequest>('request:incoming', {
      fromIndex: b.received.length,
    });
    const startedA = a.waitFor<StartedChat>('chat:started', { fromIndex: a.received.length });
    const startedB = b.waitFor<StartedChat>('chat:started', { fromIndex: b.received.length });

    const sent = await a.emit<{ requestId: string }>('request:send', {
      publicId: b.identity.publicId,
    });
    expect(sent.ok).toBe(true);
    const request = await incoming;

    const accepted = await b.emit<{ accepted: boolean }>('request:respond', {
      requestId: request.requestId,
      accept: true,
    });
    expect(accepted.ok && accepted.data.accepted).toBe(true);

    const [forA, forB] = await Promise.all([startedA, startedB]);
    expect(forA.chat.chatId).toBe(forB.chat.chatId);
    expect(forA.chat.kind).toBe('direct');
    expect(forA.chat.friendsWithPeer).toBe(true);
    expect(forB.chat.friendsWithPeer).toBe(true);

    chats.push({ client: a, chatId: forA.chat.chatId }, { client: b, chatId: forB.chat.chatId });
  });

  it('treats the second person pressing "add friend" as consent, not as a second request', async () => {
    const { a, b, chatId } = await twoInChat();

    const incoming = b.waitFor<IncomingFriend>('friend:incoming');
    const sent = await sendFriendRequest(a, chatId);
    expect(sent.ok).toBe(true);

    const request = await incoming;
    const aResolved = a.waitFor<ResolvedFriend>('friend:resolved');
    const bResolved = b.waitFor<ResolvedFriend>('friend:resolved');

    const answered = await sendFriendRequest(b, chatId);
    expect(answered.ok).toBe(true);
    if (answered.ok) {
      expect(answered.data.accepted).toBe(true);
      expect(answered.data.requestId).toBe(request.requestId);
    }

    await expect(aResolved).resolves.toMatchObject({ status: 'accepted' });
    await expect(bResolved).resolves.toMatchObject({ status: 'accepted' });
    expect((await friendList(a)).map((friend) => friend.publicId)).toEqual([b.identity.publicId]);
  });

  it('declines once and refuses to ask again in the same chat', async () => {
    const { a, b, chatId } = await twoInChat();

    const incoming = b.waitFor<IncomingFriend>('friend:incoming');
    const sent = await sendFriendRequest(a, chatId);
    expect(sent.ok).toBe(true);
    const request = await incoming;

    const aResolved = a.waitFor<ResolvedFriend>('friend:resolved');
    const bResolved = b.waitFor<ResolvedFriend>('friend:resolved');
    const answered = await b.emit<{ accepted: boolean }>('friend:respond', {
      requestId: request.requestId,
      accept: false,
    });
    expect(answered.ok).toBe(true);
    if (answered.ok) expect(answered.data.accepted).toBe(false);

    await expect(aResolved).resolves.toMatchObject({ status: 'declined' });
    await expect(bResolved).resolves.toMatchObject({ status: 'declined' });
    expect(await friendList(a)).toEqual([]);
    expect(await friendList(b)).toEqual([]);

    const againFromSender = await sendFriendRequest(a, chatId);
    expect(againFromSender.ok).toBe(false);
    if (!againFromSender.ok) {
      expect(againFromSender.error.code).toBe(ErrorCode.FRIEND_REQUEST_NOT_FOUND);
    }

    const againFromRecipient = await sendFriendRequest(b, chatId);
    expect(againFromRecipient.ok).toBe(false);
    if (!againFromRecipient.ok) {
      expect(againFromRecipient.error.code).toBe(ErrorCode.FRIEND_REQUEST_NOT_FOUND);
    }
  });

  it('refuses to answer somebody else request', async () => {
    const { a, b, chatId } = await twoInChat();

    const incoming = b.waitFor<IncomingFriend>('friend:incoming');
    const sent = await sendFriendRequest(a, chatId);
    expect(sent.ok).toBe(true);
    const request = await incoming;

    const selfAnswer = await a.emit<{ accepted: boolean }>('friend:respond', {
      requestId: request.requestId,
      accept: true,
    });
    expect(selfAnswer.ok).toBe(false);
    if (!selfAnswer.ok) {
      expect(selfAnswer.error.code).toBe(ErrorCode.FRIEND_REQUEST_NOT_FOUND);
    }
    expect(await friendList(a)).toEqual([]);

    // The real addressee can still answer: a failed attempt must not consume the request.
    const accepted = await b.emit<{ accepted: boolean }>('friend:respond', {
      requestId: request.requestId,
      accept: true,
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.data.accepted).toBe(true);
  });

  it('refuses a chat the caller is not in, and an unknown chat', async () => {
    const { chatId } = await twoInChat();
    const outsider = await client();

    const foreign = await sendFriendRequest(outsider, chatId);
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe(ErrorCode.NOT_A_PARTICIPANT);

    const missing = await sendFriendRequest(outsider, randomUUID());
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe(ErrorCode.CHAT_NOT_FOUND);
  });

  it('cancels a pending request when the chat ends, for both sides', async () => {
    const { a, b, chatId } = await twoInChat();

    const incoming = b.waitFor<IncomingFriend>('friend:incoming');
    const sent = await sendFriendRequest(a, chatId);
    expect(sent.ok).toBe(true);
    const request = await incoming;

    const aResolved = a.waitFor<ResolvedFriend>('friend:resolved', {
      predicate: (payload) => (payload as ResolvedFriend).requestId === request.requestId,
    });
    const bResolved = b.waitFor<ResolvedFriend>('friend:resolved', {
      predicate: (payload) => (payload as ResolvedFriend).requestId === request.requestId,
    });

    const left = await b.emit('chat:leave', { chatId });
    expect(left.ok).toBe(true);

    await expect(aResolved).resolves.toMatchObject({ status: 'cancelled' });
    await expect(bResolved).resolves.toMatchObject({ status: 'cancelled' });
  });
});

describe('restoring a pending friend request after a reload', () => {
  it('replays the waiting question in session:ready and remembers an existing friendship', async () => {
    const { a, b, chatId, aStarted } = await twoInChat();

    const incoming = b.waitFor<IncomingFriend>('friend:incoming');
    const sent = await sendFriendRequest(a, chatId);
    expect(sent.ok).toBe(true);
    const request = await incoming;

    // A reload is a new socket with the same cookie while the chat is in its reconnect
    // grace period. Without replay the recipient would silently lose the question.
    b.close();
    const reloadedB = await RealtimeClient.connect(b.identity);
    open.push(reloadedB);

    expect(reloadedB.session.activeChat?.chatId).toBe(chatId);
    expect(reloadedB.session.pendingFriendRequest).toMatchObject({
      requestId: request.requestId,
      chatId,
      alias: request.alias,
      direction: 'incoming',
    });

    const reloadedA = await RealtimeClient.connect(a.identity);
    open.push(reloadedA);
    expect(reloadedA.session.pendingFriendRequest).toMatchObject({
      requestId: request.requestId,
      direction: 'outgoing',
      alias: aStarted.chat.peer.alias,
    });

    const accepted = await reloadedB.emit<{ accepted: boolean }>('friend:respond', {
      requestId: request.requestId,
      accept: true,
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.data.accepted).toBe(true);

    // A later reload must show the durable friendship, not offer "add friend" again.
    const laterA = await RealtimeClient.connect(a.identity);
    open.push(laterA);
    expect(laterA.session.activeChat?.chatId).toBe(chatId);
    expect(laterA.session.friendsWithPeer).toBe(true);
  });
});

describe('removing a friend', () => {
  it('removes one-sidedly, tells the other side, and is idempotent', async () => {
    const { a, b, chatId } = await twoInChat();
    await becomeFriends(a, b, chatId);

    const removed = a.waitFor<{ publicId: string }>('friend:removed');
    const result = await http<{ removed: boolean }>(
      `/friends/${encodeURIComponent(a.identity.publicId)}`,
      { method: 'DELETE', cookie: b.identity.cookie },
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ removed: true });

    // The person who was removed learns who removed them, so an open list cannot keep
    // offering a contact that no longer exists.
    await expect(removed).resolves.toEqual({ publicId: b.identity.publicId });
    expect(await friendList(a)).toEqual([]);
    expect(await friendList(b)).toEqual([]);

    const second = await http<{ removed: boolean }>(
      `/friends/${encodeURIComponent(a.identity.publicId)}`,
      { method: 'DELETE', cookie: b.identity.cookie },
    );
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ removed: false });
  });

  it('returns the caller own list only and never another identity list', async () => {
    const { a, b, chatId } = await twoInChat();
    const outsider = await client();
    await becomeFriends(a, b, chatId);

    expect(await friendList(a)).toHaveLength(1);
    expect(await friendList(outsider)).toEqual([]);
  });
});

describe('safety actions sever a friendship', () => {
  it('deletes the link when one side blocks the other', async () => {
    const { a, b, chatId } = await twoInChat();
    await becomeFriends(a, b, chatId);

    await setBlockingPolicy(true);
    try {
      const blocked = await a.emit<{ blocked: boolean; publicId: string }>('block:peer', {
        chatId,
      });
      expect(blocked.ok).toBe(true);
      if (blocked.ok) expect(blocked.data.publicId).toBe(b.identity.publicId);

      expect(await friendList(a)).toEqual([]);
      expect(await friendList(b)).toEqual([]);
    } finally {
      await setBlockingPolicy(true);
    }
  });

  it('deletes the link when one side reports the other', async () => {
    const { a, b, chatId } = await twoInChat();
    await becomeFriends(a, b, chatId);

    const reported = await a.emit<{ reportId: string }>('report:send', {
      chatId,
      reason: 'abuse',
    });
    expect(reported.ok).toBe(true);

    expect(await friendList(a)).toEqual([]);
    expect(await friendList(b)).toEqual([]);
  });

  it('deletes the old identity friendships silently on rotation', async () => {
    const { a, b, chatId } = await twoInChat();
    await becomeFriends(a, b, chatId);

    const rotated = await http<{ publicId: string }>('/session', {
      method: 'DELETE',
      cookie: a.identity.cookie,
    });
    expect(rotated.status).toBe(200);
    expect(rotated.body.publicId).not.toBe(a.identity.publicId);

    const newCookie = rotated.setCookie
      .find((value) => value.startsWith('anonlink_session='))
      ?.split(';')[0];
    expect(newCookie).toBeTruthy();

    const newList = await http<FriendListResponse>('/friends', { cookie: newCookie ?? '' });
    expect(newList.status).toBe(200);
    expect(newList.body.friends).toEqual([]);
    expect(await friendList(b)).toEqual([]);

    // The panic button must not notify the old contacts.
    await b.expectNoEvent('friend:removed', 300);
  });
});
