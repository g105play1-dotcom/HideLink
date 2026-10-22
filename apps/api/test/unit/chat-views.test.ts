import { CHAT_MEMORY_MESSAGE_LIMIT } from '@anonlink/shared';
import { describe, expect, it } from 'vitest';

import { ChatRecord } from '../../src/chat/chat.registry.js';
import {
  buildChatView,
  buildHistory,
  buildMessageView,
  buildPeerView,
  endedReasonFor,
} from '../../src/chat/chat.views.js';

/**
 * The translation from internal state to wire payloads.
 *
 * This is the file that decides whether an anonymous chat leaks its peer, so it is
 * worth testing directly — a mistake here is invisible in the UI and only shows up as a
 * privacy incident.
 */

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

function randomChat(): ChatRecord {
  return new ChatRecord({
    chatId: 'chat-1',
    kind: 'random',
    participantAId: A,
    participantBId: B,
    initiatorId: A,
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
}

function directChat(): ChatRecord {
  return new ChatRecord({
    chatId: 'chat-2',
    kind: 'direct',
    participantAId: A,
    participantBId: B,
    initiatorId: B,
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
    publicIdByUser: new Map([
      [A, 'AL7KM39PQ2XRZ4'],
      [B, 'ALZZZZZZZZZZZZ'],
    ]),
  });
}

describe('peer identity disclosure', () => {
  it('never discloses the peer of a random chat', () => {
    const chat = randomChat();

    expect(chat.revealPublicId(B)).toBeUndefined();
    expect(buildPeerView(chat, B)).toEqual({ alias: chat.aliasFor(B) });
    expect(buildChatView(chat, A).peer).not.toHaveProperty('publicId');
  });

  it('discloses both sides of a direct chat, which was never anonymous', () => {
    const chat = directChat();

    expect(buildChatView(chat, A).peer.publicId).toBe('ALZZZZZZZZZZZZ');
    expect(buildChatView(chat, B).peer.publicId).toBe('AL7KM39PQ2XRZ4');
  });

  it('stays closed when a direct chat was built without public ids', () => {
    // Defence in depth: if a caller forgot the map, the chat degrades to anonymous
    // rather than disclosing an empty or wrong value.
    const chat = new ChatRecord({
      chatId: 'chat-3',
      kind: 'direct',
      participantAId: A,
      participantBId: B,
      initiatorId: A,
      startedAt: new Date(),
    });

    expect(buildChatView(chat, A).peer.publicId).toBeUndefined();
  });

  it('gives each viewer their own alias for the same peer', () => {
    const chat = randomChat();

    // The alias is not a stable pseudonym: it is per chat and per direction, so two
    // chats with the same person cannot be linked by their alias.
    expect(chat.aliasFor(A)).toBeTruthy();
    expect(chat.aliasFor(B)).toBeTruthy();
  });
});

describe('message views', () => {
  it('labels the sender as "you" and the other side as "peer"', () => {
    const chat = randomChat();
    chat.append({ messageId: 'm1', senderId: A, text: 'hi', sentAt: new Date() });

    const mine = buildMessageView(chat, chat.messages[0]!, A);
    const theirs = buildMessageView(chat, chat.messages[0]!, B);

    expect(mine.from).toBe('you');
    expect(theirs.from).toBe('peer');
    // Identical text, opposite labels — the payload is built per recipient.
    expect(mine.text).toBe(theirs.text);
  });

  it('echoes the idempotency key to its author only', () => {
    const chat = randomChat();
    chat.append({
      messageId: 'm1',
      senderId: A,
      text: 'hi',
      sentAt: new Date(),
      clientMessageId: 'abc123',
    });

    expect(buildMessageView(chat, chat.messages[0]!, A).clientMessageId).toBe('abc123');
    expect(buildMessageView(chat, chat.messages[0]!, B).clientMessageId).toBeUndefined();
  });

  it('builds history in the order it was sent', () => {
    const chat = randomChat();
    for (const [index, text] of ['один', 'два', 'три'].entries()) {
      chat.append({
        messageId: `m${index}`,
        senderId: index % 2 === 0 ? A : B,
        text,
        sentAt: new Date(),
      });
    }

    const history = buildHistory(chat, A);
    expect(history.map((message) => message.text)).toEqual(['один', 'два', 'три']);
    expect(history.map((message) => message.from)).toEqual(['you', 'peer', 'you']);
  });
});

describe('ChatRecord.append', () => {
  it('treats a repeated key from the same sender as one message', () => {
    const chat = randomChat();
    const base = { messageId: 'm1', senderId: A, text: 'привет', clientMessageId: 'k1' } as const;

    const first = chat.append({ ...base, sentAt: new Date() });
    const second = chat.append({ ...base, messageId: 'm2', sentAt: new Date() });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.message.messageId).toBe('m1');
    expect(chat.messages).toHaveLength(1);
    expect(chat.messageCount).toBe(1);
  });

  it('does not let one participant impersonate a retry of another', () => {
    const chat = randomChat();
    chat.append({
      messageId: 'm1',
      senderId: A,
      text: 'from a',
      sentAt: new Date(),
      clientMessageId: 'k1',
    });

    const fromB = chat.append({
      messageId: 'm2',
      senderId: B,
      text: 'from b',
      sentAt: new Date(),
      clientMessageId: 'k1',
    });

    // The key is scoped per sender: A's key must not let B forge a duplicate.
    expect(fromB.duplicate).toBe(false);
    expect(chat.messages).toHaveLength(2);
  });

  it('bounds the retained transcript but keeps counting', () => {
    const chat = randomChat();
    const overflow = 5;

    for (let index = 0; index < CHAT_MEMORY_MESSAGE_LIMIT + overflow; index += 1) {
      chat.append({ messageId: `m${index}`, senderId: A, text: `#${index}`, sentAt: new Date() });
    }

    // Memory is bounded...
    expect(chat.messages).toHaveLength(CHAT_MEMORY_MESSAGE_LIMIT);
    // ...while the flood-detection counter keeps the true total.
    expect(chat.messageCount).toBe(CHAT_MEMORY_MESSAGE_LIMIT + overflow);
    expect(chat.messages[0]?.text).toBe(`#${overflow}`);
  });

  it('forgets a deduplication key once its message falls out of the window', () => {
    const chat = randomChat();

    chat.append({
      messageId: 'first',
      senderId: A,
      text: 'old',
      sentAt: new Date(),
      clientMessageId: 'k-old',
    });

    for (let index = 0; index < CHAT_MEMORY_MESSAGE_LIMIT; index += 1) {
      chat.append({ messageId: `m${index}`, senderId: A, text: `#${index}`, sentAt: new Date() });
    }

    // The index is bounded by the same window as the transcript, so replaying a key
    // from far in the past is treated as a new message rather than being deduplicated
    // against a message that is no longer there to compare with.
    const replay = chat.append({
      messageId: 'again',
      senderId: A,
      text: 'old',
      sentAt: new Date(),
      clientMessageId: 'k-old',
    });

    expect(replay.duplicate).toBe(false);
  });
});

describe('endedReasonFor', () => {
  it('distinguishes "I left" from "the peer left"', () => {
    const chat = randomChat();
    chat.endedByUserId = A;

    expect(endedReasonFor(chat, A, 'left')).toBe('left');
    expect(endedReasonFor(chat, B, 'left')).toBe('peer_left');
  });

  it('reports a block plainly to the blocker and as "peer left" to the blocked', () => {
    const chat = randomChat();
    chat.endedByUserId = A;

    expect(endedReasonFor(chat, A, 'blocked')).toBe('blocked');
    // Telling someone they were blocked invites retaliation, and tells them something
    // the product deliberately does not disclose.
    expect(endedReasonFor(chat, B, 'blocked')).toBe('peer_left');
  });

  it('reports a report plainly to the reporter and as "peer left" to the reported', () => {
    const chat = randomChat();
    chat.endedByUserId = A;

    expect(endedReasonFor(chat, A, 'reported')).toBe('reported');
    expect(endedReasonFor(chat, B, 'reported')).toBe('peer_left');
  });

  it('never discloses a suspension to either side', () => {
    const chat = randomChat();
    chat.endedByUserId = A;

    // The banned identity receives a fatal `IDENTITY_BANNED` error and is disconnected;
    // its peer must see an ordinary end, exactly as with a block. The durable row also
    // says `left`, so an archived transcript does not reveal the moderation action.
    expect(endedReasonFor(chat, A, 'banned')).toBe('peer_left');
    expect(endedReasonFor(chat, B, 'banned')).toBe('peer_left');
  });

  it('tells the side that stayed that the other one dropped off', () => {
    const chat = randomChat();
    chat.endedByUserId = A;

    expect(endedReasonFor(chat, A, 'disconnected')).toBe('left');
    // The surviving peer gets the accurate reason instead of a vague "they left".
    expect(endedReasonFor(chat, B, 'disconnected')).toBe('disconnected');
  });

  it('passes through reasons that are not person-specific', () => {
    const chat = randomChat();
    chat.endedByUserId = null;

    expect(endedReasonFor(chat, A, 'server_shutdown')).toBe('server_shutdown');
  });
});
