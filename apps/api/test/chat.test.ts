import type { ChatMessageView, ChatView, SessionReadyPayload } from '@anonlink/protocol';
import { ErrorCode } from '@anonlink/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  RealtimeClient,
  createIdentity,
  joinQueue,
  matchPair,
  sendMessage,
} from './support/api-client.js';

/**
 * The conversation itself: delivery, ordering, limits, authorisation, and what
 * happens when a connection drops.
 *
 * `MESSAGE_MAX_LENGTH` is 200 and `PEER_RECONNECT_GRACE_MS` is 1500 in the test
 * environment (see `test/support/test-env.ts`), which is what makes the boundary and
 * reconnect cases cheap to assert precisely.
 */

const MESSAGE_MAX_LENGTH = 200;
const RECONNECT_GRACE_MS = 1500;

interface ChatStarted {
  chat: ChatView;
  messages: ChatMessageView[];
  initiator: boolean;
}

const open: RealtimeClient[] = [];

async function client(): Promise<RealtimeClient> {
  const instance = await RealtimeClient.connect(await createIdentity());
  open.push(instance);
  return instance;
}

async function pair(): Promise<{
  a: RealtimeClient;
  b: RealtimeClient;
  chatId: string;
}> {
  const a = await client();
  const b = await client();
  const { chatId } = await matchPair(a, b);
  return { a, b, chatId };
}

afterEach(() => {
  for (const instance of open.splice(0)) instance.close();
});

describe('chat messaging', () => {
  it('delivers messages both ways, labelled per recipient', async () => {
    const { a, b, chatId } = await pair();

    const bReceives = b.waitFor<ChatMessageView>('chat:message');
    const sent = await sendMessage(a, chatId, 'привет');
    expect(sent.ok).toBe(true);

    const received = await bReceives;
    expect(received.text).toBe('привет');
    expect(received.from).toBe('peer');
    expect(received.chatId).toBe(chatId);
    // The sender's own idempotency key is not echoed to the peer.
    expect(received.clientMessageId).toBeUndefined();
    expect(received.messageId).toBe(sent.ok ? sent.data.messageId : 'unreachable');

    const aReceives = a.waitFor<ChatMessageView>('chat:message', {
      // `a` already holds its own outgoing copy, so the wait must skip it.
      predicate: (payload) => (payload as ChatMessageView).from === 'peer',
    });
    const reply = await sendMessage(b, chatId, 'привет!');
    expect(reply.ok).toBe(true);

    const back = await aReceives;
    expect(back.text).toBe('привет!');
    expect(back.from).toBe('peer');

    // And the sender sees its own message, as the author.
    const own = a
      .eventsNamed('chat:message')
      .filter((event): event is ChatMessageView => (event as ChatMessageView).from === 'you');
    expect(own.map((message) => message.text)).toEqual(['привет']);
  });

  it('preserves order and timestamps', async () => {
    const { a, b, chatId } = await pair();

    const texts = ['первое', 'второе', 'третье', 'четвёртое'];

    // Registered before sending, with a predicate that only matches once the last one
    // has arrived: the assertion is then about the complete sequence, not a race.
    const allArrived = b.waitFor<ChatMessageView>('chat:message', {
      predicate: () => b.eventsNamed('chat:message').length >= texts.length,
      timeoutMs: 5_000,
    });

    for (const text of texts) {
      const result = await sendMessage(a, chatId, text);
      expect(result.ok).toBe(true);
    }

    await allArrived;

    const received = b.eventsNamed('chat:message') as ChatMessageView[];
    expect(received.map((message) => message.text)).toEqual(texts);

    const timestamps = received.map((message) => Date.parse(message.sentAt));
    for (let index = 1; index < timestamps.length; index += 1) {
      expect(timestamps[index] ?? 0).toBeGreaterThanOrEqual(timestamps[index - 1] ?? 0);
    }
  });

  it('accepts a message exactly at the limit and refuses one over it', async () => {
    const { a, b, chatId } = await pair();

    const atLimit = await sendMessage(a, chatId, 'x'.repeat(MESSAGE_MAX_LENGTH));
    expect(atLimit.ok).toBe(true);

    const tooLong = await sendMessage(a, chatId, 'x'.repeat(MESSAGE_MAX_LENGTH + 1));
    expect(tooLong.ok).toBe(false);

    if (!tooLong.ok) {
      // The service (not just the wire schema) enforces the deployment's limit.
      expect([ErrorCode.MESSAGE_TOO_LONG, ErrorCode.INVALID_INPUT]).toContain(tooLong.error.code);
    }

    // The peer sees exactly one message, not two.
    expect(b.eventsNamed('chat:message')).toHaveLength(1);
  });

  it('refuses an empty message', async () => {
    const { a, chatId } = await pair();

    const empty = await sendMessage(a, chatId, '   ');
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect([ErrorCode.MESSAGE_EMPTY, ErrorCode.INVALID_INPUT]).toContain(empty.error.code);
    }
  });

  it('treats a repeated client message id as the same message', async () => {
    const { a, b, chatId } = await pair();

    const first = await sendMessage(a, chatId, 'нажми ещё раз', 'retry-key-1');
    const second = await sendMessage(a, chatId, 'нажми ещё раз', 'retry-key-1');

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.ok && first.ok && second.data.messageId).toBe(
      first.ok ? first.data.messageId : '',
    );

    // A retry after a flaky connection must not produce a second bubble.
    expect(b.eventsNamed('chat:message')).toHaveLength(1);
  });

  it('refuses messages from someone who is not in the chat', async () => {
    const { a, chatId } = await pair();
    const outsider = await client();

    const attempt = await sendMessage(outsider, chatId, 'я тут лишний');
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error.code).toBe(ErrorCode.NOT_A_PARTICIPANT);

    // ...and nothing reached the participants.
    expect(a.eventsNamed('chat:message')).toHaveLength(0);
  });

  it('refuses to end a chat the caller is not part of', async () => {
    const { chatId } = await pair();
    const outsider = await client();

    const attempt = await outsider.emit('chat:leave', { chatId });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error.code).toBe(ErrorCode.NOT_A_PARTICIPANT);
  });

  it('refuses a message for a chat that does not exist', async () => {
    const { a } = await pair();

    const attempt = await sendMessage(a, '00000000-0000-4000-8000-000000000000', 'привет');
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error.code).toBe(ErrorCode.CHAT_NOT_FOUND);
  });
});

describe('ending a chat', () => {
  it('ends it for both sides when one leaves', async () => {
    const { a, b, chatId } = await pair();

    const aEnded = a.waitFor<{ reason: string }>('chat:ended');
    const bEnded = b.waitFor<{ reason: string }>('chat:ended');

    const leave = await a.emit<{ ended: boolean }>('chat:leave', { chatId });
    expect(leave.ok && leave.data.ended).toBe(true);

    await expect(aEnded).resolves.toMatchObject({ reason: 'left' });
    await expect(bEnded).resolves.toMatchObject({ reason: 'peer_left' });

    // The conversation is over: neither side can add to it.
    const after = await sendMessage(a, chatId, 'ещё одно');
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.code).toBe(ErrorCode.CHAT_ENDED);
  });

  it('queues the caller for a new peer with chat:next', async () => {
    const { a, b, chatId } = await pair();
    const c = await client();

    const bEnded = b.waitFor<{ reason: string }>('chat:ended');
    const next = await a.emit<{ queued: boolean }>('chat:next', { chatId });

    expect(next.ok && next.data.queued).toBe(true);
    await expect(bEnded).resolves.toMatchObject({ reason: 'peer_left' });

    const aStarted = a.waitFor<ChatStarted>('chat:started', {
      // `a` still holds the `chat:started` of the chat it just left.
      fromIndex: a.received.length,
    });
    const cStarted = c.waitFor<ChatStarted>('chat:started');

    const cJoin = await joinQueue(c);
    expect(cJoin.ok && cJoin.data.queued).toBe(false);

    const [startedA, startedC] = await Promise.all([aStarted, cStarted]);
    expect(startedA.chat.chatId).toBe(startedC.chat.chatId);
    expect(startedA.chat.chatId).not.toBe(chatId);
  });
});

describe('connection loss', () => {
  it('survives a brief reconnect and re-attaches the transcript', async () => {
    const { a, b, chatId } = await pair();

    await sendMessage(a, chatId, 'до обрыва');
    await b.waitFor('chat:message');

    const peerAway = b.waitFor<{ chatId: string }>('chat:peer-away');
    a.drop();
    await expect(peerAway).resolves.toMatchObject({ chatId });

    const peerBack = b.waitFor<{ chatId: string }>('chat:peer-back');
    const resumed = a.waitFor<{ chat: ChatView; messages: ChatMessageView[] }>('chat:resumed');

    await a.resume();

    await expect(peerBack).resolves.toMatchObject({ chatId });

    const restored = await resumed;
    expect(restored.chat.chatId).toBe(chatId);
    expect(restored.messages.map((message) => message.text)).toEqual(['до обрыва']);
    expect(restored.messages[0]?.from).toBe('you');

    // The conversation is still usable in both directions.
    const received = b.waitFor<ChatMessageView>('chat:message', {
      predicate: (payload) => (payload as ChatMessageView).text === 'после обрыва',
    });
    const after = await sendMessage(a, chatId, 'после обрыва');
    expect(after.ok).toBe(true);
    await expect(received).resolves.toMatchObject({ text: 'после обрыва', from: 'peer' });
  });

  it('ends the chat once the grace period expires', async () => {
    const { a, b, chatId } = await pair();

    const bEnded = b.waitFor<{ chatId: string; reason: string }>('chat:ended', {
      timeoutMs: RECONNECT_GRACE_MS + 4_000,
    });

    a.drop();

    // Only the side that stayed can be told: the dropped socket has nowhere to receive
    // anything. It is told plainly that the other one fell off, rather than a vague
    // "they left" that reads like a decision.
    await expect(bEnded).resolves.toMatchObject({ chatId, reason: 'disconnected' });

    // Coming back after the grace period finds the conversation gone.
    const ready = a.waitFor<SessionReadyPayload>('session:ready');
    await a.resume();
    expect((await ready).activeChat).toBeUndefined();
    expect(b.connected).toBe(true);
  });

  it('does not disturb the peer when the same identity opens a second tab', async () => {
    const { a, b, chatId } = await pair();
    await sendMessage(a, chatId, 'из первой вкладки');
    await b.waitFor('chat:message');

    const secondTab = await RealtimeClient.connect(a.identity);
    open.push(secondTab);

    // The new socket receives the full conversation, labelled as the author's view.
    const resumed = secondTab.waitFor<{ chat: ChatView; messages: ChatMessageView[] }>(
      'chat:resumed',
    );
    const restored = await resumed;

    expect(restored.chat.chatId).toBe(chatId);
    expect(restored.messages.map((message) => message.text)).toEqual(['из первой вкладки']);

    // `session:ready` already reported the active chat, so the client can render the
    // chat screen before the transcript arrives.
    expect(secondTab.session.activeChat?.chatId).toBe(chatId);

    // Opening a tab is not "coming back online": the peer is not told anything.
    await b.expectNoEvent('chat:peer-back', 400);
    await b.expectNoEvent('chat:peer-away', 400);
  });
});
