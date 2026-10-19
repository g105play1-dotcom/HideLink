import type { ChatView } from '@anonlink/protocol';
import { CONNECT_REQUEST_NOTE_MAX_LENGTH, ErrorCode } from '@anonlink/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { RealtimeClient, createIdentity, http } from './support/api-client.js';

/**
 * Direct contact by User ID.
 *
 * This is the one flow where an identity is *not* anonymous by construction: the
 * requester typed the recipient's User ID, so the recipient is told who is asking.
 * Everything else here is about the ways it must fail without becoming an oracle or a
 * way to send unsolicited messages.
 */

interface IncomingRequest {
  requestId: string;
  from: { alias: string; publicId: string };
  note?: string;
  expiresAt: string;
}

interface ResolvedRequest {
  requestId: string;
  status: string;
  chat?: ChatView;
}

const open: RealtimeClient[] = [];

async function client(): Promise<RealtimeClient> {
  const instance = await RealtimeClient.connect(await createIdentity());
  open.push(instance);
  return instance;
}

function sendRequest(from: RealtimeClient, publicId: string, note?: string) {
  return from.emit<{ requestId: string; expiresAt: string }>('request:send', {
    publicId,
    ...(note === undefined ? {} : { note }),
  });
}

afterEach(() => {
  for (const instance of open.splice(0)) instance.close();
});

describe('sending a direct request', () => {
  it('delivers an invitation with the sender User ID, because it is reciprocal', async () => {
    const sender = await client();
    const target = await client();

    const incoming = target.waitFor<IncomingRequest>('request:incoming');
    const ack = await sendRequest(sender, target.identity.publicId, '  привет!  ');

    expect(ack.ok).toBe(true);
    if (!ack.ok) return;
    expect(Date.parse(ack.data.expiresAt)).toBeGreaterThan(Date.now());

    const request = await incoming;
    expect(request.requestId).toBe(ack.data.requestId);
    expect(request.from.publicId).toBe(sender.identity.publicId);
    // The note is trimmed before it is stored and forwarded.
    expect(request.note).toBe('привет!');
  });

  it('rejects a note that is too long instead of truncating it', async () => {
    const sender = await client();
    const target = await client();

    const ack = await sendRequest(
      sender,
      target.identity.publicId,
      'x'.repeat(CONNECT_REQUEST_NOTE_MAX_LENGTH + 1),
    );

    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe(ErrorCode.INVALID_INPUT);

    await target.expectNoEvent('request:incoming', 300);
  });

  it('refuses an unknown User ID', async () => {
    const sender = await client();

    const ack = await sendRequest(sender, 'ALZZZZZZZZZZZZ');

    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe(ErrorCode.USER_NOT_FOUND);
  });

  it('refuses the caller own User ID', async () => {
    const sender = await client();

    const ack = await sendRequest(sender, sender.identity.publicId);

    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe(ErrorCode.SELF_TARGET_NOT_ALLOWED);
  });

  it('refuses a malformed User ID', async () => {
    const sender = await client();

    const ack = await sendRequest(sender, 'not-an-id');

    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe(ErrorCode.INVALID_INPUT);
  });

  it('refuses a target that is not online', async () => {
    const sender = await client();
    const target = await createIdentity();

    // `target` exists but has no open socket.
    const ack = await sendRequest(sender, target.publicId);

    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe(ErrorCode.USER_UNAVAILABLE);
  });

  it('refuses a target that turned invitations off', async () => {
    const sender = await client();
    const target = await client();

    const patched = await http('/me/settings', {
      method: 'PATCH',
      cookie: target.identity.cookie,
      body: { incomingRequests: 'nobody' },
    });
    expect(patched.status).toBe(200);

    const ack = await sendRequest(sender, target.identity.publicId);

    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe(ErrorCode.INCOMING_REQUESTS_DISABLED);

    await target.expectNoEvent('request:incoming', 300);
  });

  it('refuses a target that blocked the caller, without saying so', async () => {
    const sender = await client();
    const target = await client();

    const blocked = await http('/blocks', {
      method: 'POST',
      cookie: target.identity.cookie,
      body: { publicId: sender.identity.publicId },
    });
    expect(blocked.status).toBe(201);

    const ack = await sendRequest(sender, target.identity.publicId);

    expect(ack.ok).toBe(false);
    if (!ack.ok) {
      // Deliberately the same answer as "unavailable": a distinguishable
      // "you are blocked" would turn blocking into a way to send a message.
      expect(ack.error.code).toBe(ErrorCode.BLOCKED);
    }

    await target.expectNoEvent('request:incoming', 300);
  });

  it('refuses to start a direct request while already in a chat', async () => {
    const sender = await client();
    const target = await client();

    // Put the sender in a random chat with a third identity.
    const other = await client();
    const { chatId } = await (async () => {
      const startedSender = sender.waitFor<{ chat: ChatView }>('chat:started');
      const startedOther = other.waitFor<{ chat: ChatView }>('chat:started');
      await sender.emit('match:join');
      await other.emit('match:join');
      const [one] = await Promise.all([startedSender, startedOther]);
      return { chatId: one.chat.chatId };
    })();
    expect(chatId).toBeTruthy();

    const ack = await sendRequest(sender, target.identity.publicId);

    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe(ErrorCode.ALREADY_IN_CHAT);
  });

  it('cancels an outgoing invitation when the sender disconnects', async () => {
    const sender = await client();
    const target = await client();

    const incoming = target.waitFor<IncomingRequest>('request:incoming');
    const ack = await sendRequest(sender, target.identity.publicId);
    expect(ack.ok).toBe(true);

    const request = await incoming;
    const resolved = target.waitFor<ResolvedRequest>('request:resolved', {
      predicate: (payload) => (payload as ResolvedRequest).requestId === request.requestId,
    });

    sender.drop();

    // Nobody is left waiting on a request that can no longer be answered.
    await expect(resolved).resolves.toMatchObject({ status: 'cancelled' });
  });
});

describe('answering a direct request', () => {
  it('starts a chat for both sides when accepted, revealing both User IDs', async () => {
    const sender = await client();
    const target = await client();

    const incoming = target.waitFor<IncomingRequest>('request:incoming');
    const ack = await sendRequest(sender, target.identity.publicId);
    expect(ack.ok).toBe(true);
    const request = await incoming;

    const senderResolved = sender.waitFor<ResolvedRequest>('request:resolved');
    const targetResolved = target.waitFor<ResolvedRequest>('request:resolved');

    const accepted = await target.emit<{ accepted: boolean }>('request:respond', {
      requestId: request.requestId,
      accept: true,
    });
    expect(accepted.ok && accepted.data.accepted).toBe(true);

    const [forSender, forTarget] = await Promise.all([senderResolved, targetResolved]);
    expect(forSender.status).toBe('accepted');
    expect(forTarget.status).toBe('accepted');
    expect(forSender.chat?.chatId).toBe(forTarget.chat?.chatId);
    expect(forSender.chat?.kind).toBe('direct');

    // A direct chat is explicitly *not* anonymous: both sides were already known to
    // each other by User ID, so the chat view reflects that.
    expect(forSender.chat?.peer.publicId).toBe(target.identity.publicId);
    expect(forTarget.chat?.peer.publicId).toBe(sender.identity.publicId);

    // ...and the conversation works.
    const chatId = forSender.chat?.chatId ?? '';
    const received = target.waitFor<{ text: string }>('chat:message');
    const sent = await sender.emit('chat:message', {
      chatId,
      text: 'ну привет',
      clientMessageId: 'direct-1',
    });
    expect(sent.ok).toBe(true);
    await expect(received).resolves.toMatchObject({ text: 'ну привет' });
  });

  it('tells both sides when the request is declined, and starts nothing', async () => {
    const sender = await client();
    const target = await client();

    const incoming = target.waitFor<IncomingRequest>('request:incoming');
    const ack = await sendRequest(sender, target.identity.publicId);
    expect(ack.ok).toBe(true);
    const request = await incoming;

    const senderResolved = sender.waitFor<ResolvedRequest>('request:resolved');
    const declined = await target.emit<{ accepted: boolean }>('request:respond', {
      requestId: request.requestId,
      accept: false,
    });

    expect(declined.ok && declined.data.accepted).toBe(false);
    const resolved = await senderResolved;
    expect(resolved.status).toBe('declined');
    expect(resolved.chat).toBeUndefined();

    await sender.expectNoEvent('chat:started', 300);
  });

  it('refuses an answer from somebody who is not the addressee', async () => {
    const sender = await client();
    const target = await client();
    const bystander = await client();

    const incoming = target.waitFor<IncomingRequest>('request:incoming');
    const ack = await sendRequest(sender, target.identity.publicId);
    expect(ack.ok).toBe(true);
    const request = await incoming;

    const attempt = await bystander.emit('request:respond', {
      requestId: request.requestId,
      accept: true,
    });

    expect(attempt.ok).toBe(false);
    if (!attempt.ok) {
      // The same error an unknown request id produces: a bystander learns nothing
      // about whether the request exists.
      expect(attempt.error.code).toBe(ErrorCode.REQUEST_NOT_FOUND);
    }

    // The request is still answerable by its real addressee.
    const accepted = await target.emit<{ accepted: boolean }>('request:respond', {
      requestId: request.requestId,
      accept: true,
    });
    expect(accepted.ok && accepted.data.accepted).toBe(true);
  });

  it('refuses to answer the same request twice', async () => {
    const sender = await client();
    const target = await client();

    const incoming = target.waitFor<IncomingRequest>('request:incoming');
    const ack = await sendRequest(sender, target.identity.publicId);
    expect(ack.ok).toBe(true);
    const request = await incoming;

    const first = await target.emit('request:respond', {
      requestId: request.requestId,
      accept: true,
    });
    expect(first.ok).toBe(true);

    const second = await target.emit('request:respond', {
      requestId: request.requestId,
      accept: true,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe(ErrorCode.REQUEST_NOT_FOUND);
  });

  it('reports unavailable instead of starting a second chat for the requester', async () => {
    const sender = await client();
    const target = await client();
    const other = await client();

    const incoming = target.waitFor<IncomingRequest>('request:incoming');
    const ack = await sendRequest(sender, target.identity.publicId);
    expect(ack.ok).toBe(true);
    const request = await incoming;

    // The requester stops waiting and takes a random chat instead — the addressee is
    // answering a request that was valid a moment ago.
    const startedSender = sender.waitFor<{ chat: ChatView }>('chat:started');
    const startedOther = other.waitFor<{ chat: ChatView }>('chat:started');
    await sender.emit('match:join');
    await other.emit('match:join');
    await Promise.all([startedSender, startedOther]);

    const resolved = sender.waitFor<ResolvedRequest>('request:resolved', {
      predicate: (payload) => (payload as ResolvedRequest).requestId === request.requestId,
    });
    const accepted = await target.emit<{ accepted: boolean }>('request:respond', {
      requestId: request.requestId,
      accept: true,
    });

    // Everything is re-validated at the moment of acceptance, precisely so a request
    // that went stale while it sat in the queue cannot put someone in two chats.
    expect(accepted.ok && accepted.data.accepted).toBe(false);

    const outcome = await resolved;
    expect(outcome.status).toBe('unavailable');
    expect(outcome.chat).toBeUndefined();
  });
});
