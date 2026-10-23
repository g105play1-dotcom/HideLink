import { ErrorCode } from '@anonlink/shared';
import { describe, expect, it, vi } from 'vitest';

import { ChatRegistryService } from '../src/chat/chat.registry.js';
import { ChatService } from '../src/chat/chat.service.js';
import { AppEventBus } from '../src/events/app-events.js';
import { FriendRequestService } from '../src/friends/friend-requests.js';

/**
 * The in-memory friend-request register.
 *
 * Expiry is one minute long in production, which is too slow for an integration test.
 * These are the pure rules that the API relies on: one request per chat, a deadline that
 * can be swept deterministically, and a closed chat that cannot be asked again.
 */
describe('FriendRequestService', () => {
  function request(
    service: FriendRequestService,
    overrides: Partial<{
      requestId: string;
      chatId: string;
      fromUserId: string;
      toUserId: string;
      ttlMs: number;
      now: number;
    }> = {},
  ) {
    return service.create({
      requestId: overrides.requestId ?? 'request-1',
      chatId: overrides.chatId ?? 'chat-1',
      fromUserId: overrides.fromUserId ?? 'user-a',
      toUserId: overrides.toUserId ?? 'user-b',
      fromAlias: 'Гость',
      ttlMs: overrides.ttlMs ?? 60_000,
      now: overrides.now ?? 1_000,
    });
  }

  it('keeps one request per chat and returns the existing one', () => {
    const service = new FriendRequestService();

    const first = request(service);
    const second = request(service, { requestId: 'request-2', now: 2_000 });

    expect(first.kind).toBe('created');
    expect(second.kind).toBe('existing');
    if (first.kind === 'created' && second.kind === 'existing') {
      expect(second.request.requestId).toBe(first.request.requestId);
    }
    expect(service.stats()).toEqual({ pending: 1, closedChats: 0 });
  });

  it('expires overdue requests, closes the chat and stops returning them', () => {
    const service = new FriendRequestService();
    const created = request(service, { ttlMs: 100, now: 5_000 });

    expect(service.sweep(5_099)).toEqual([]);
    expect(service.byChat('chat-1')).toBeDefined();

    const expired = service.sweep(5_100);
    expect(expired).toHaveLength(1);
    expect(expired[0]?.requestId).toBe(created.kind === 'created' ? created.request.requestId : '');
    expect(service.byChat('chat-1')).toBeUndefined();
    expect(service.isClosed('chat-1')).toBe(true);

    // Sweeping again must not report the same request twice.
    expect(service.sweep(99_999)).toEqual([]);
  });

  it('finds pending requests between the same two people in either direction', () => {
    const service = new FriendRequestService();
    request(service, { requestId: 'forward', chatId: 'chat-1' });
    request(service, {
      requestId: 'back',
      chatId: 'chat-2',
      fromUserId: 'user-b',
      toUserId: 'user-a',
    });
    request(service, {
      requestId: 'other',
      chatId: 'chat-3',
      fromUserId: 'user-a',
      toUserId: 'user-c',
    });

    const removed = service.takeBetween('user-a', 'user-b');

    expect(removed.map((item) => item.requestId).sort()).toEqual(['back', 'forward']);
    expect(service.byChat('chat-1')).toBeUndefined();
    expect(service.byChat('chat-2')).toBeUndefined();
    expect(service.byChat('chat-3')).toBeDefined();
  });

  it('forgets a closed chat when the conversation is over', () => {
    const service = new FriendRequestService();
    request(service, { requestId: 'request-1' });
    service.markClosed('chat-1');

    expect(service.isClosed('chat-1')).toBe(true);
    service.forgetChat('chat-1');
    expect(service.isClosed('chat-1')).toBe(false);
    expect(service.byChat('chat-1')).toBeUndefined();
  });
});

/**
 * The click that completes a mutual agreement has its own expiry gate.
 *
 * `respondToFriendRequest` checks the deadline, but the other participant can also
 * complete the agreement by pressing "add friend". That path used to accept a request
 * that was already past its deadline but not yet swept, which made the advertised
 * 60-second lifetime depend on the maintenance interval.
 */
describe('ChatService friend-request expiry', () => {
  it('does not auto-accept an expired request when the addressee presses add friend', async () => {
    const registry = new ChatRegistryService();
    const friendRequests = new FriendRequestService();
    const bus = new AppEventBus();
    const events: string[] = [];
    bus.subscribe((event) => events.push(event.type));

    const friends = {
      areFriends: vi.fn().mockResolvedValue(false),
      create: vi.fn(),
    };

    // Only the registry, friend services and bus are exercised by this path.
    const unused = null as never;
    const service = new ChatService(
      unused,
      registry,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      friends as never,
      friendRequests,
      unused,
      bus,
      unused,
    );

    const chat = registry.create({
      chatId: 'chat-1',
      kind: 'random',
      participantAId: 'user-a',
      participantBId: 'user-b',
      initiatorId: 'user-a',
      startedAt: new Date(),
    });

    friendRequests.create({
      requestId: 'request-1',
      chatId: chat.chatId,
      fromUserId: 'user-a',
      toUserId: 'user-b',
      fromAlias: 'Гость',
      ttlMs: 1,
      now: Date.now() - 10_000,
    });

    await expect(service.requestFriend('user-b', chat.chatId)).rejects.toMatchObject({
      code: ErrorCode.FRIEND_REQUEST_EXPIRED,
    });

    expect(friends.create).not.toHaveBeenCalled();
    expect(friendRequests.isClosed(chat.chatId)).toBe(true);
    expect(friendRequests.byChat(chat.chatId)).toBeUndefined();
    expect(events).toContain('friend.resolved');
  });
});
