import type { ChatView } from '@anonlink/protocol';
import { ErrorCode } from '@anonlink/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { RealtimeClient, createIdentity, joinQueue, matchPair } from './support/api-client.js';

/**
 * Random matchmaking, over real WebSockets.
 *
 * The properties asserted here are the ones that are easy to break and expensive to
 * notice: a user matched with themselves, a user in two chats at once, a "ghost"
 * (disconnected) user still sitting in the queue, or the peer's User ID leaking into
 * an anonymous chat.
 */

interface ChatStarted {
  chat: ChatView;
  messages: unknown[];
  initiator: boolean;
}

const open: RealtimeClient[] = [];

async function client(): Promise<RealtimeClient> {
  const instance = await RealtimeClient.connect(await createIdentity());
  open.push(instance);
  return instance;
}

afterEach(() => {
  // Closing the sockets also exercises disconnection handling for every test.
  for (const instance of open.splice(0)) instance.close();
});

describe('random matching', () => {
  it('pairs two waiting identities into one shared chat', async () => {
    const a = await client();
    const b = await client();

    const aQueued = a.waitFor<{ queuedAt: string }>('match:queued');
    const aStarted = a.waitFor<ChatStarted>('chat:started');
    const bStarted = b.waitFor<ChatStarted>('chat:started');

    const aJoin = await joinQueue(a);
    expect(aJoin.ok).toBe(true);
    // The first joiner waits.
    expect(aJoin.ok && aJoin.data.queued).toBe(true);
    await aQueued;

    const bJoin = await joinQueue(b);
    expect(bJoin.ok).toBe(true);
    // The second joiner is matched immediately, so it never sees `match:queued`.
    expect(bJoin.ok && bJoin.data.queued).toBe(false);

    const [startedA, startedB] = await Promise.all([aStarted, bStarted]);

    expect(startedA.chat.chatId).toBe(startedB.chat.chatId);
    expect(startedA.chat.kind).toBe('random');
    expect(startedA.chat.peer.alias).toBeTruthy();
    // Exactly one side opened the chat; the client uses this only for wording.
    expect(startedA.initiator).not.toBe(startedB.initiator);
  });

  it('never puts a random match in two chats at once', async () => {
    const a = await client();
    const b = await client();

    const { chatId } = await matchPair(a, b);

    // A third socket for `a`: the identity is already chatting, so it is refused
    // rather than given a second conversation.
    const second = await RealtimeClient.connect(a.identity);
    open.push(second);

    const join = await joinQueue(second);
    expect(join.ok).toBe(false);
    expect(join.ok === false && join.error.code).toBe(ErrorCode.ALREADY_IN_CHAT);

    const resumed = await second.waitFor<{ chat: ChatView }>('chat:resumed');
    expect(resumed.chat.chatId).toBe(chatId);
  });

  it('never matches an identity with itself, even from two sockets', async () => {
    const identity = await createIdentity();
    const first = await RealtimeClient.connect(identity);
    const second = await RealtimeClient.connect(identity);
    open.push(first, second);

    const firstJoin = await joinQueue(first);
    const secondJoin = await joinQueue(second);

    expect(firstJoin.ok && firstJoin.data.queued).toBe(true);
    expect(secondJoin.ok && secondJoin.data.queued).toBe(true);

    // Both sockets are the same person; neither may be handed a chat.
    await first.expectNoEvent('chat:started', 500);
    await second.expectNoEvent('chat:started', 500);
  });

  it('never leaks the peer User ID into an anonymous chat', async () => {
    const a = await client();
    const b = await client();

    const { chatId } = await matchPair(a, b);
    expect(chatId).toBeTruthy();

    // Each side may see its *own* id (it is announced in `session:ready`), but never
    // the other one's — that is the whole promise of a random match.
    const seenByA = JSON.stringify(a.received.map((event) => event.payload));
    const seenByB = JSON.stringify(b.received.map((event) => event.payload));

    expect(seenByA).not.toContain(b.identity.publicId);
    expect(seenByB).not.toContain(a.identity.publicId);

    const [startedByA] = a.eventsNamed('chat:started') as ChatStarted[];
    expect(startedByA?.chat.peer.publicId).toBeUndefined();
    expect(startedByA?.chat.peer.alias).toBeTruthy();
  });

  it('removes a cancelled search from the queue', async () => {
    const a = await client();
    await joinQueue(a);

    const cancelled = a.waitFor<{ reason: string }>('match:cancelled');
    const ack = await a.emit<{ cancelled: boolean }>('match:cancel');

    expect(ack.ok && ack.data.cancelled).toBe(true);
    await expect(cancelled).resolves.toEqual({ reason: 'user' });

    // Cancelling again is a no-op, not an error.
    const again = await a.emit<{ cancelled: boolean }>('match:cancel');
    expect(again.ok && again.data.cancelled).toBe(false);

    // Somebody arriving afterwards waits instead of being paired with a cancelled
    // search.
    const b = await client();
    const bJoin = await joinQueue(b);
    expect(bJoin.ok && bJoin.data.queued).toBe(true);
    await b.expectNoEvent('chat:started', 400);
  });

  it('lets an identity match again after leaving a chat', async () => {
    const a = await client();
    const b = await client();
    const c = await client();

    const { chatId } = await matchPair(a, b);

    const bEnded = b.waitFor<{ reason: string }>('chat:ended');
    const leave = await a.emit<{ ended: boolean }>('chat:leave', { chatId });
    expect(leave.ok && leave.data.ended).toBe(true);
    await expect(bEnded).resolves.toMatchObject({ reason: 'peer_left' });

    const aStarted = a.waitFor<ChatStarted>('chat:started', {
      // `a` still holds the `chat:started` of the chat it just left.
      fromIndex: a.received.length,
    });
    const cStarted = c.waitFor<ChatStarted>('chat:started');

    const rejoin = await joinQueue(a);
    expect(rejoin.ok && rejoin.data.queued).toBe(true);

    const cJoin = await joinQueue(c);
    expect(cJoin.ok && cJoin.data.queued).toBe(false);

    const [startedA, startedC] = await Promise.all([aStarted, cStarted]);
    expect(startedA.chat.chatId).toBe(startedC.chat.chatId);
    expect(startedA.chat.chatId).not.toBe(chatId);
  });

  it('drops a disconnected identity from the queue instead of matching a ghost', async () => {
    const a = await client();
    await joinQueue(a);

    a.drop();

    // The queue is cancelled synchronously by the socket-close handler, so this wait
    // only has to outlast the disconnection itself. It is deliberately short: if the
    // assertion below fails, the real defect is that a departed user stayed queued.
    await new Promise((done) => setTimeout(done, 300));

    const b = await client();
    const join = await joinQueue(b);

    expect(join.ok && join.data.queued).toBe(true);
    await b.expectNoEvent('chat:started', 400);
  });

  it('reports an unknown client event instead of ignoring it', async () => {
    const a = await client();

    const error = a.waitFor<{ code: string }>('app:error');
    a.emitRaw('definitely:not-an-event');

    await expect(error).resolves.toMatchObject({ code: ErrorCode.UNSUPPORTED_EVENT });
  });
});
