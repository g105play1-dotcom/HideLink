import { randomUUID } from 'node:crypto';

import type { ChatView } from '@anonlink/protocol';
import { ErrorCode, type AdminReportView } from '@anonlink/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  RealtimeClient,
  adminHttp,
  createIdentity,
  http,
  joinQueue,
  matchPair,
  sendMessage,
} from './support/api-client.js';

/**
 * Blocking and reporting, over real WebSockets.
 *
 * Two things matter here beyond "the button works": a block must take effect
 * immediately for matchmaking (not only for the next database read), and neither
 * action may tell the other side what happened — a block that can be *felt* is a way
 * to send a message to someone who does not want to hear from you.
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
  for (const instance of open.splice(0)) instance.close();
});

describe('reporting', () => {
  it('ends the chat for both sides and reports asymmetrically', async () => {
    const a = await client();
    const b = await client();
    const { chatId } = await matchPair(a, b);

    await sendMessage(a, chatId, 'грубое сообщение');
    const offending = await sendMessage(b, chatId, 'ответ');
    await a.waitFor('chat:message');

    const aEnded = a.waitFor<{ reason: string }>('chat:ended');
    const bEnded = b.waitFor<{ reason: string }>('chat:ended');

    const reported = await a.emit<{ reportId: string }>('report:send', {
      chatId,
      messageId: offending.ok ? offending.data.messageId : undefined,
      reason: 'abuse',
      details: 'оскорбления',
    });

    expect(reported.ok).toBe(true);
    expect(reported.ok && reported.data.reportId).toBeTruthy();

    // The reporter is told what they did; the other side is told the peer left.
    await expect(aEnded).resolves.toMatchObject({ reason: 'reported' });
    await expect(bEnded).resolves.toMatchObject({ reason: 'peer_left' });
  });

  it('refuses a report about a chat the caller is not in', async () => {
    const a = await client();
    const b = await client();
    const outsider = await client();
    const { chatId } = await matchPair(a, b);

    const attempt = await outsider.emit('report:send', { chatId, reason: 'spam' });

    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error.code).toBe(ErrorCode.NOT_A_PARTICIPANT);
  });

  it('refuses a report about a chat that never existed', async () => {
    const a = await client();

    const attempt = await a.emit('report:send', {
      chatId: '00000000-0000-4000-8000-000000000000',
      reason: 'spam',
    });

    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error.code).toBe(ErrorCode.CHAT_NOT_FOUND);
  });

  it('refuses a report with a reason that is not in the allowed set', async () => {
    const a = await client();
    const b = await client();
    const { chatId } = await matchPair(a, b);

    const attempt = await a.emit('report:send', { chatId, reason: 'i-just-do-not-like-it' });

    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error.code).toBe(ErrorCode.INVALID_INPUT);
  });
});

describe('the owner report list', () => {
  it('shows the filed report with its evidence, and records the owner decision', async () => {
    const a = await client();
    const b = await client();
    const { chatId } = await matchPair(a, b);

    // Unique per run: the test database is not wiped, and the list is global. A fixed
    // string would find a report left by an earlier run and assert against the wrong row.
    const marker = `жалоба-${randomUUID()}`;

    const reported = await a.emit<{ reportId: string }>('report:send', {
      chatId,
      reason: 'abuse',
      details: marker,
    });
    expect(reported.ok).toBe(true);
    if (!reported.ok) return;

    const list = await adminHttp<{ reports: AdminReportView[] }>('/admin/reports');
    expect(list.status).toBe(200);

    const found = list.body.reports.find((report) => report.id === reported.data.reportId);
    expect(found).toMatchObject({
      reason: 'abuse',
      status: 'open',
      details: marker,
      chatId,
      reporterPublicId: a.identity.publicId,
      targetPublicId: b.identity.publicId,
    });
    expect(typeof found?.expiresAt).toBe('string');

    const patched = await adminHttp<AdminReportView>(`/admin/reports/${reported.data.reportId}`, {
      method: 'PATCH',
      body: { status: 'actioned' },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.status).toBe('actioned');

    const again = await adminHttp<{ reports: AdminReportView[] }>('/admin/reports');
    const persisted = again.body.reports.find((report) => report.id === reported.data.reportId);
    expect(persisted?.status).toBe('actioned');
  });

  it('refuses an anonymous caller and an unknown report', async () => {
    const user = await createIdentity();

    const anonymous = await http('/admin/reports', { cookie: user.cookie });
    expect(anonymous.status).toBe(401);

    const missing = await adminHttp<{ error: { code: string } }>(`/admin/reports/${randomUUID()}`, {
      method: 'PATCH',
      body: { status: 'dismissed' },
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe(ErrorCode.REPORT_NOT_FOUND);
  });
});

describe('blocking the peer of a chat', () => {
  it('ends the chat, tells only the blocker, and returns the peer User ID', async () => {
    const a = await client();
    const b = await client();
    const { chatId } = await matchPair(a, b);

    const aEnded = a.waitFor<{ reason: string }>('chat:ended');
    const bEnded = b.waitFor<{ reason: string }>('chat:ended');
    const blockedNotice = a.waitFor<{ publicId: string; chatId: string }>('peer:blocked');

    const result = await a.emit<{ blocked: boolean; publicId: string }>('block:peer', { chatId });

    expect(result.ok).toBe(true);
    // In a random chat the blocker never learned the peer's User ID, so the server
    // hands it over at the moment it becomes actionable (the block list).
    if (result.ok) expect(result.data.publicId).toBe(b.identity.publicId);

    await expect(blockedNotice).resolves.toMatchObject({ chatId });
    await expect(aEnded).resolves.toMatchObject({ reason: 'blocked' });
    await expect(bEnded).resolves.toMatchObject({ reason: 'peer_left' });

    // The blocked side is never told that it was blocked.
    await b.expectNoEvent('peer:blocked', 300);
  });

  it('refuses to block the peer of a chat the caller is not in', async () => {
    const a = await client();
    const b = await client();
    const outsider = await client();
    const { chatId } = await matchPair(a, b);

    const attempt = await outsider.emit('block:peer', { chatId });

    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error.code).toBe(ErrorCode.NOT_A_PARTICIPANT);

    // The chat is untouched.
    const sent = await sendMessage(a, chatId, 'всё ещё вместе');
    expect(sent.ok).toBe(true);
  });

  it('keeps the two away from each other in the random queue immediately', async () => {
    const a = await client();
    const b = await client();
    const { chatId } = await matchPair(a, b);

    const result = await a.emit('block:peer', { chatId });
    expect(result.ok).toBe(true);

    // Both go back to looking for someone. Neither may be given the other, even
    // though the block happened only a moment ago and only in this process.
    const aJoin = await joinQueue(a);
    const bJoin = await joinQueue(b);

    expect(aJoin.ok && aJoin.data.queued).toBe(true);
    expect(bJoin.ok && bJoin.data.queued).toBe(true);

    await a.expectNoEvent('chat:started', 600);
    await b.expectNoEvent('chat:started', 600);

    // ...but a third person can still be matched with either of them.
    const c = await client();
    const aStarted = a.waitFor<ChatStarted>('chat:started', { fromIndex: a.received.length });
    const cStarted = c.waitFor<ChatStarted>('chat:started');

    const cJoin = await joinQueue(c);
    expect(cJoin.ok && cJoin.data.queued).toBe(false);

    const [startedA, startedC] = await Promise.all([aStarted, cStarted]);
    expect(startedA.chat.chatId).toBe(startedC.chat.chatId);
  });

  it('shows up in the blocker own block list and nowhere else', async () => {
    const a = await client();
    const b = await client();
    const bystander = await client();
    const { chatId } = await matchPair(a, b);

    await a.emit('block:peer', { chatId });

    const mine = await httpBlocks(a);
    expect(mine.map((entry) => entry.publicId)).toEqual([b.identity.publicId]);

    const theirs = await httpBlocks(b);
    expect(theirs).toEqual([]);

    const other = await httpBlocks(bystander);
    expect(other).toEqual([]);
  });

  it('cancels a pending invitation when the two block each other', async () => {
    const a = await client();
    const b = await client();

    const incoming = b.waitFor<{ requestId: string }>('request:incoming');
    const ack = await a.emit('request:send', { publicId: b.identity.publicId });
    expect(ack.ok).toBe(true);
    const request = await incoming;

    const resolved = a.waitFor<{ requestId: string; status: string }>('request:resolved', {
      predicate: (payload) => (payload as { requestId: string }).requestId === request.requestId,
    });

    // `b` blocks the sender by User ID while the invitation is still pending. Blocking
    // outside a chat happens over REST (there is no chat id to key it by).
    const blocked = await http('/blocks', {
      method: 'POST',
      cookie: b.identity.cookie,
      body: { publicId: a.identity.publicId },
    });
    expect(blocked.status).toBe(201);

    // The stale invitation is withdrawn rather than left to be answered later.
    await expect(resolved).resolves.toMatchObject({ status: 'blocked' });

    const again = await a.emit('request:send', { publicId: b.identity.publicId });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe(ErrorCode.BLOCKED);
  });
});

/** The blocker's own block list, read over REST with their session cookie. */
async function httpBlocks(instance: RealtimeClient): Promise<Array<{ publicId: string }>> {
  const response = await http<{ blocks: Array<{ publicId: string }> }>('/blocks', {
    cookie: instance.identity.cookie,
  });
  return response.body.blocks;
}
