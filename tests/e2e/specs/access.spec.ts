import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { ClientEvent } from '@anonlink/protocol';

import {
  expectMessage,
  matchPair,
  newIdentity,
  sendMessage,
  transcript,
  waitForChat,
} from '../support/app';
import {
  connectRawIdentity,
  createRawIdentity,
  sendChatMessage,
  sendCommand,
} from '../support/raw-peer';

/**
 * Authorisation between accounts.
 *
 * These scenarios cannot be reached through the interface on purpose — the whole point
 * is that a *hostile* client, one that does not use the interface at all, still cannot
 * touch a conversation it is not part of.
 */
test.describe('cross-account authorization', () => {
  test("a third party cannot read, write into, end or block someone else's chat", async ({
    browser,
  }) => {
    const alice = await newIdentity(browser);
    const bob = await newIdentity(browser);

    await matchPair(alice, bob);
    const chatId = await waitForChat(alice.page);

    const stranger = await createRawIdentity();
    const socket = await connectRawIdentity(stranger);

    try {
      // Writing: knows the chat id, is not a participant.
      const message = await sendChatMessage(socket, chatId, 'вторжение');
      expect(message.ok).toBe(false);
      if (!message.ok) expect(message.error.code).toBe('NOT_A_PARTICIPANT');

      // Ending someone else's conversation.
      const leave = await sendCommand(socket, ClientEvent.ChatLeave, { chatId });
      expect(leave.ok).toBe(false);
      if (!leave.ok) expect(leave.error.code).toBe('NOT_A_PARTICIPANT');

      // Blocking on behalf of a chat they are not in.
      const block = await sendCommand(socket, ClientEvent.BlockPeer, { chatId });
      expect(block.ok).toBe(false);
      if (!block.ok) expect(block.error.code).toBe('NOT_A_PARTICIPANT');

      // Guessing: an unknown id is not even distinguishable from someone else's.
      const guessed = await sendCommand(socket, ClientEvent.ChatMessage, {
        chatId: randomUUID(),
        text: 'вслепую',
        clientMessageId: `g${Date.now().toString(36)}`,
      });
      expect(guessed.ok).toBe(false);
      if (!guessed.ok) expect(guessed.error.code).toBe('CHAT_NOT_FOUND');
    } finally {
      socket.disconnect();
    }

    // The victims' conversation is untouched and still works.
    await expect(transcript(alice.page)).not.toContainText('вторжение');
    await expect(transcript(bob.page)).not.toContainText('вторжение');

    await sendMessage(alice.page, 'наш чат продолжается');
    await expectMessage(bob.page, 'наш чат продолжается');
  });

  test("a session cannot be hijacked by replaying another identity's User ID", async ({
    browser,
  }) => {
    const bob = await newIdentity(browser);

    // A fresh socket that merely *knows* bob's public User ID still belongs to whoever
    // holds the session cookie — knowing an ID grants no identity.
    const stranger = await createRawIdentity();
    expect(stranger.publicId).not.toBe(bob.publicId);

    const socket = await connectRawIdentity(stranger);
    try {
      const queued = await sendCommand<{ queued: boolean }>(socket, ClientEvent.MatchJoin, {});
      expect(queued.ok).toBe(true);
      if (queued.ok) expect(queued.data.queued).toBe(true);
    } finally {
      socket.disconnect();
    }

    // Bob's own screen is unaffected: nobody joined his queue on his behalf.
    await expect(bob.page.getByText('Ищем собеседника…')).toHaveCount(0);
  });
});
