import { randomUUID } from 'node:crypto';

import { OWNER_MESSAGE_MAX_LENGTH, ErrorCode } from '@anonlink/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createIdentity,
  http,
  type HttpOptions,
  type HttpResult,
  type TestIdentity,
} from './support/api-client.js';

/**
 * "Contact the owner" — the operator's inbox.
 *
 * ## What only these tests can prove
 *
 * The form is the *second* place in the product where user-written text is stored on
 * purpose (the first is a report's message snapshot), so the assertions here are mostly
 * about the boundaries around it:
 *  - the sender is taken from the session, never from the body — a client cannot file a
 *    message as somebody else;
 *  - the storage is bounded by the topic vocabulary, the text length and a per-identity
 *    daily budget;
 *  - the inbox is readable and deletable *only* with the owner key, which is exactly the
 *    surface the archive already uses.
 *
 * ## Why it deletes what it creates
 *
 * The inbox is global state for the whole suite, like the archive: leaving rows behind
 * would make the owner's view of a fresh installation a lie. Every created id is removed
 * again in `afterAll`.
 */

const OWNER_TOKEN = 'test-owner-key-not-a-real-secret-0001';
const OWNER_HEADERS = { authorization: `Bearer ${OWNER_TOKEN}` } as const;

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

/** Ids this file created, so the inbox is left exactly as it was found. */
const created: string[] = [];

beforeAll(async () => {
  // Fail loudly rather than asserting about a development database.
  const { rows } = await pool.query<{ current_database: string }>('SELECT current_database()');
  expect(rows[0]?.current_database).toMatch(/_test$/);
});

afterAll(async () => {
  if (created.length > 0) {
    await pool.query('DELETE FROM "OwnerMessage" WHERE id = ANY($1::uuid[])', [created]);
  }
  await pool.end();
});

/** An admin request, as the owner's browser or a script would send it. */
function owner<T = unknown>(path: string, options: HttpOptions = {}) {
  return http<T>(path, { ...options, headers: { ...OWNER_HEADERS, ...options.headers } });
}

interface ErrorBody {
  error: { code: ErrorCode; message: string };
}

interface SentBody {
  id: string;
  expiresAt: string;
  /** Present only when the request was refused, so one helper covers both outcomes. */
  error?: { code: ErrorCode; message: string };
}

/** Files one message and remembers it for cleanup. */
async function send(identity: TestIdentity, body: unknown): Promise<HttpResult<SentBody>> {
  const result = await http<SentBody>('/owner/messages', {
    method: 'POST',
    cookie: identity.cookie,
    body,
  });

  if (result.status === 201) created.push(result.body.id);
  return result;
}

describe('sending a message to the owner', () => {
  it('stores the text, the topic and the sender taken from the session', async () => {
    const identity = await createIdentity();
    const marker = randomUUID();
    const text = `Хочу разместить рекламу — ${marker}`;

    const result = await send(identity, {
      topic: 'advertising',
      text,
      contact: 'telegram: @anonlink_ads',
    });

    expect(result.status).toBe(201);
    expect(result.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(result.body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const { rows } = await pool.query<{
      topic: string;
      text: string;
      contact: string | null;
      publicId: string | null;
      expiresAt: Date;
    }>(
      `SELECT m.topic, m.text, m.contact, i."publicId", m."expiresAt"
         FROM "OwnerMessage" m
         LEFT JOIN "Identity" i ON i.id = m."identityId"
        WHERE m.id = $1::uuid`,
      [result.body.id],
    );

    expect(rows[0]?.topic).toBe('advertising');
    expect(rows[0]?.text).toBe(text);
    expect(rows[0]?.contact).toBe('telegram: @anonlink_ads');
    // The sender is the session's identity, which is what lets the owner answer.
    expect(rows[0]?.publicId).toBe(identity.publicId);
    expect(rows[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('accepts a message with no contact details and no topic quirk', async () => {
    const identity = await createIdentity();

    const result = await send(identity, { topic: 'suggestion', text: 'Добавьте тёмную тему.' });

    expect(result.status).toBe(201);

    const { rows } = await pool.query<{ contact: string | null }>(
      'SELECT contact FROM "OwnerMessage" WHERE id = $1::uuid',
      [result.body.id],
    );
    expect(rows[0]?.contact).toBeNull();
  });

  it('requires a session', async () => {
    const result = await http<ErrorBody>('/owner/messages', {
      method: 'POST',
      body: { topic: 'other', text: 'анонимно' },
    });

    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe(ErrorCode.IDENTITY_REQUIRED);
  });
});

describe('validation', () => {
  it('rejects an unknown topic, empty text, over-long text and unknown fields', async () => {
    const identity = await createIdentity();

    const badTopic = await send(identity, { topic: 'not-a-topic', text: 'привет' });
    expect(badTopic.status).toBe(400);
    expect(badTopic.body.error?.code).toBe(ErrorCode.INVALID_INPUT);

    const empty = await send(identity, { topic: 'other', text: '   ' });
    expect(empty.status).toBe(400);

    const tooLong = await send(identity, {
      topic: 'other',
      text: 'x'.repeat(OWNER_MESSAGE_MAX_LENGTH + 1),
    });
    expect(tooLong.status).toBe(400);

    // `.strict()`: a client cannot file a message as somebody else by adding a User ID,
    // and cannot smuggle an unexpected field past the server either.
    const forged = await send(identity, {
      topic: 'abuse',
      text: 'жалоба',
      publicId: 'ANON-0000000000',
    });
    expect(forged.status).toBe(400);
  });

  it('refuses the sixth message of the day from the same identity', async () => {
    const identity = await createIdentity();

    // The default budget is five per day; the sixth must not reach the database.
    for (let index = 0; index < 5; index += 1) {
      const allowed = await send(identity, { topic: 'other', text: `сообщение ${index}` });
      expect(allowed.status).toBe(201);
    }

    const refused = await send(identity, { topic: 'other', text: 'шестое' });
    expect(refused.status).toBe(429);
    expect(refused.body.error?.code).toBe(ErrorCode.RATE_LIMITED);
  });
});

describe("the owner's inbox", () => {
  it('is readable and deletable only with the owner key', async () => {
    const identity = await createIdentity();
    const marker = randomUUID();
    const filed = await send(identity, { topic: 'bug', text: `Сломалось — ${marker}` });
    expect(filed.status).toBe(201);

    const anonymous = await http<ErrorBody>('/admin/messages');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe(ErrorCode.ADMIN_AUTH_REQUIRED);

    const wrongKey = await http<ErrorBody>('/admin/messages', {
      headers: { authorization: 'Bearer not-the-owner-key' },
    });
    expect(wrongKey.status).toBe(401);

    const inbox = await owner<{ messages: Array<Record<string, unknown>> }>('/admin/messages');
    expect(inbox.status).toBe(200);

    const mine = inbox.body.messages.find((message) => message.id === filed.body.id);
    expect(mine).toBeDefined();
    expect(mine?.topic).toBe('bug');
    expect(mine?.publicId).toBe(identity.publicId);
    // Newest first: the message just filed is at the top.
    expect(inbox.body.messages[0]?.id).toBe(filed.body.id);

    const removed = await owner<{ deleted: boolean }>(`/admin/messages/${filed.body.id}`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(200);
    expect(removed.body.deleted).toBe(true);

    // Deleting is idempotent, and the row is really gone.
    const again = await owner<{ deleted: boolean }>(`/admin/messages/${filed.body.id}`, {
      method: 'DELETE',
    });
    expect(again.body.deleted).toBe(false);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM "OwnerMessage" WHERE id = $1::uuid',
      [filed.body.id],
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('validates the id it is asked to delete', async () => {
    const result = await owner(`/admin/messages/${randomUUID()}`, { method: 'DELETE' });
    expect(result.status).toBe(200);

    const bad = await owner('/admin/messages/not-a-uuid', { method: 'DELETE' });
    expect(bad.status).toBe(400);
  });
});
