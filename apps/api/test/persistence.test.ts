import { randomUUID } from 'node:crypto';

import { ErrorCode } from '@anonlink/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  RealtimeClient,
  createIdentity,
  http,
  matchPair,
  sendMessage,
} from './support/api-client.js';

/**
 * What actually lands in PostgreSQL.
 *
 * The API runs in its own process, so these tests read the database directly — that is
 * the only way to verify the privacy claim ("by default, no transcripts are kept") rather
 * than trusting the code that makes it. The most important test in this file is the one
 * that searches *every* text column in the schema for a message that was sent.
 *
 * This file describes a **default installation**: archiving is off, so nothing is stored.
 * The owner can switch it on (`apps/api/test/archive.test.ts` covers that path), and the
 * precondition below fails loudly if a previous run left it on. */

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

const open: RealtimeClient[] = [];

async function client(): Promise<RealtimeClient> {
  const instance = await RealtimeClient.connect(await createIdentity());
  open.push(instance);
  return instance;
}

beforeAll(async () => {
  // Fail loudly rather than silently asserting about a development database.
  const { rows } = await pool.query<{ current_database: string }>('SELECT current_database()');
  expect(rows[0]?.current_database).toMatch(/_test$/);

  // And rather than asserting about an installation whose owner left archiving on: every
  // "the text is nowhere" claim below is only true while the archive is empty.
  const archives = await pool.query<{ count: string }>('SELECT count(*) FROM "ChatArchive"');
  expect(Number(archives.rows[0]?.count ?? '0')).toBe(0);
});

afterAll(async () => {
  for (const instance of open.splice(0)) instance.close();
  await pool.end();
});

/** Polls until a condition holds; used for the API's fire-and-forget writes. */
async function until<T>(read: () => Promise<T | null>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;

  while (Date.now() < deadline) {
    last = await read();
    if (last !== null) return last;
    await new Promise((done) => setTimeout(done, 100));
  }

  throw new Error(`Timed out after ${timeoutMs} ms waiting for the database to settle.`);
}

/**
 * Every text column in the schema that contains `needle`.
 *
 * Generic on purpose: hard-coding "check ChatSession" would keep passing after someone
 * added a `lastMessage` column somewhere else.
 */
async function findTextSomewhere(
  needle: string,
): Promise<Array<{ location: string; count: number }>> {
  const columns = await pool.query<{ table_name: string; column_name: string }>(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type IN ('text', 'character varying', 'character')
    ORDER BY table_name, column_name
  `);

  const labels = columns.rows.map((row) => `${row.table_name}.${row.column_name}`);
  const branches = columns.rows.map(
    (_row, index) =>
      `SELECT $${index + 1}::text AS location, count(*)::int AS count ` +
      `FROM "${columns.rows[index]?.table_name}" ` +
      `WHERE "${columns.rows[index]?.column_name}" LIKE $${labels.length + 1}`,
  );

  const result = await pool.query<{ location: string; count: number }>(
    `SELECT location, count FROM (${branches.join(' UNION ALL ')}) AS hits WHERE count > 0`,
    [...labels, `%${needle}%`],
  );

  return result.rows;
}

describe('chat lifecycle persistence', () => {
  it('records a chat start, then its end, without any message content', async () => {
    const a = await client();
    const b = await client();
    const { chatId } = await matchPair(a, b);

    const stored = await pool.query<{ status: string; kind: string; endedAt: Date | null }>(
      'SELECT status, kind, "endedAt" FROM "ChatSession" WHERE id = $1::uuid',
      [chatId],
    );
    expect(stored.rows[0]?.status).toBe('active');
    expect(stored.rows[0]?.kind).toBe('random');

    // Per-run unique text: the test database is not wiped between runs, and this
    // assertion is deliberately a *global* search, so the needle has to be unique or a
    // report left behind by an earlier run would be counted too.
    const marker = randomUUID();
    const secret = `совершенноСекретное-${marker}`;
    await sendMessage(a, chatId, secret);
    await sendMessage(a, chatId, 'второе');
    await sendMessage(b, chatId, 'третье');

    await a.emit('chat:leave', { chatId });

    const ended = await until(async () => {
      const { rows } = await pool.query<{
        status: string;
        endReason: string;
        messageCount: number;
        endedAt: Date | null;
      }>(
        'SELECT status, "endReason", "messageCount", "endedAt" FROM "ChatSession" WHERE id = $1::uuid',
        [chatId],
      );
      const row = rows[0];
      return row && row.status === 'ended' ? row : null;
    });

    expect(ended.endReason).toBe('left');
    expect(ended.messageCount).toBe(3);
    expect(ended.endedAt).not.toBeNull();

    // The counter is a number; the text itself is nowhere. Archiving is off in this suite
    // (the owner's archive has its own file), which is the state a new installation is in.
    expect(await findTextSomewhere(secret)).toEqual([]);
    expect(await findTextSomewhere('второе')).toEqual([]);
  });

  it('has no text column on ChatSession at all', async () => {
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ChatSession'`,
    );

    // A set comparison: the point is which columns exist, not what order the catalogue
    // happens to return them in.
    expect(new Set(columns.rows.map((row) => row.column_name))).toEqual(
      new Set([
        'id',
        'kind',
        'status',
        'startedAt',
        'endedAt',
        'endReason',
        'participantAId',
        'participantBId',
        'initiatorId',
        'messageCount',
      ]),
    );
  });
});

describe('reports', () => {
  it('stores exactly one copy of the reported message, and only that one', async () => {
    const a = await client();
    const b = await client();
    const { chatId } = await matchPair(a, b);

    const marker = randomUUID();
    const offendingText = `оскорблениеДляЖалобы-${marker}`;
    const harmlessText = `обычноеСловоБезЖалобы-${marker}`;

    await sendMessage(a, chatId, harmlessText);
    const offending = await sendMessage(b, chatId, offendingText);
    expect(offending.ok).toBe(true);

    const reported = await a.emit<{ reportId: string }>('report:send', {
      chatId,
      messageId: offending.ok ? offending.data.messageId : undefined,
      reason: 'abuse',
      details: 'подробности жалобы',
    });
    expect(reported.ok).toBe(true);
    if (!reported.ok) return;

    const row = await until(async () => {
      const { rows } = await pool.query<{
        reason: string;
        messageSnapshot: string | null;
        details: string | null;
        expiresAt: Date;
        status: string;
      }>(
        'SELECT reason, "messageSnapshot", details, "expiresAt", status FROM "Report" WHERE id = $1::uuid',
        [reported.data.reportId],
      );
      return rows[0] ?? null;
    });

    expect(row.reason).toBe('abuse');
    expect(row.status).toBe('open');
    // Taken from the server's own copy of the message, not from the request.
    expect(row.messageSnapshot).toBe(offendingText);
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // The reported message exists in exactly one place, and it is the report.
    expect(await findTextSomewhere(offendingText)).toEqual([
      { location: 'Report.messageSnapshot', count: 1 },
    ]);

    // A message that was never reported is nowhere at all: the archive is off, and the
    // report stores one snapshot, never the conversation around it.
    expect(await findTextSomewhere(harmlessText)).toEqual([]);
  });
});

describe('sessions and identities', () => {
  it('stores only a hash of the session token', async () => {
    const identity = await createIdentity();
    const token = identity.cookie.split('=')[1] ?? '';
    expect(token.length).toBeGreaterThan(20);

    const { rows } = await pool.query<{
      tokenHash: string;
      ipHash: string | null;
      userAgentHash: string | null;
      revokedAt: Date | null;
    }>(
      `SELECT s."tokenHash", s."ipHash", s."userAgentHash", s."revokedAt"
       FROM "Session" s JOIN "Identity" i ON i.id = s."identityId"
       WHERE i."publicId" = $1`,
      [identity.publicId],
    );

    const session = rows[0];
    expect(session).toBeDefined();
    // A database leak must not hand out usable sessions.
    expect(session?.tokenHash).not.toBe(token);
    expect(session?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(session?.revokedAt).toBeNull();

    // ABUSE_HASH_SALT is deliberately unset in the test environment, so no client
    // identifier is recorded at all.
    expect(session?.ipHash).toBeNull();
    expect(session?.userAgentHash).toBeNull();

    // And the token itself is not stored anywhere.
    expect(await findTextSomewhere(token)).toEqual([]);
  });

  it('keeps the identity row when the User ID is rotated, revoking the old sessions', async () => {
    const original = await createIdentity();

    const rotated = await http<{ publicId: string }>('/session', {
      method: 'DELETE',
      cookie: original.cookie,
    });
    expect(rotated.status).toBe(200);

    const { rows } = await pool.query<{ publicId: string; sessions: string }>(
      `SELECT i."publicId", count(s.id)::text AS sessions
       FROM "Identity" i LEFT JOIN "Session" s ON s."identityId" = i.id AND s."revokedAt" IS NULL
       WHERE i."publicId" = $1
       GROUP BY i."publicId"`,
      [original.publicId],
    );

    // Rotating issues a *new* identity; the old row stays so that abuse reports and
    // blocks that point at it keep their integrity. It has no live sessions left.
    expect(rows[0]?.publicId).toBe(original.publicId);
    expect(rows[0]?.sessions).toBe('0');
  });

  it('holds no contact data, only what the user chose to declare about themselves', async () => {
    const columns = await pool.query<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'Identity'`,
    );

    // A set comparison: the point is which columns exist, not what order the catalogue
    // happens to return them in.
    //
    // Why this test was rewritten rather than deleted: it used to assert that *no*
    // personal data could be stored on an identity at all. Filtered search changed that
    // by design — gender, birth year, city/region and language are now stored, because a
    // filter can only be enforced server-side if the server has the values. What the test
    // still guarantees is the property that matters:
    //
    //   1. nothing is *captured* — no e-mail, phone, address, device or token column;
    //   2. everything declared is optional (see the nullability assertion below), so an
    //      identity that declares nothing is a first-class identity;
    //   3. none of it is ever shown to another user (`GET /users/:publicId` returns
    //      existence and availability only — see identity.test.ts).
    expect(new Set(columns.rows.map((row) => row.column_name))).toEqual(
      new Set([
        'id',
        'publicId',
        'createdAt',
        'lastSeenAt',
        'bannedAt',
        'bannedReason',
        'incomingRequests',
        // A preference like the one above, not data about the person: whether the block
        // action is offered at all (docs/DECISIONS.md D24).
        'blockingEnabled',
        // Declared, voluntary, and never displayed to a peer.
        'declaredGender',
        'declaredBirthYear',
        'declaredCountry',
        'declaredCity',
        'declaredRegion',
        'declaredLanguages',
        // The filters derived from those declarations.
        'prefGenders',
        'prefAgeMin',
        'prefAgeMax',
        'prefCities',
        'prefRegions',
        'prefCountries',
        'prefLanguages',
        'prefRelax',
      ]),
    );

    // No column may even be *named* like something captured from the client.
    const forbidden =
      /(email|phone|address|nickname|device|token|password|secret|latitude|longitude)/i;
    for (const column of columns.rows) {
      expect(column.column_name).not.toMatch(forbidden);
    }

    // Declaring anything has to stay optional: someone who fills in nothing is still a
    // first-class user, and it is what made this migration a plain additive one. So every
    // profile column must be either nullable or carry a database default.
    for (const column of columns.rows) {
      const profile =
        column.column_name.startsWith('declared') || column.column_name.startsWith('pref');
      if (!profile) continue;

      expect(column.is_nullable === 'YES' || column.column_default !== null).toBe(true);
    }
  });
});

describe('abuse protections are durable', () => {
  it('keeps a block after the sockets are gone', async () => {
    const a = await client();
    const b = await client();
    const { chatId } = await matchPair(a, b);

    const blocked = await a.emit<{ publicId: string }>('block:peer', { chatId });
    expect(blocked.ok).toBe(true);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "Block" bl
       JOIN "Identity" blocker ON blocker.id = bl."blockerId"
       JOIN "Identity" blocked ON blocked.id = bl."blockedId"
       WHERE blocker."publicId" = $1 AND blocked."publicId" = $2`,
      [a.identity.publicId, b.identity.publicId],
    );

    expect(rows[0]?.count).toBe('1');
  });

  it('records coarse security events without message content', async () => {
    const a = await client();
    const b = await client();

    // `contact_self` is written when a user targets their own User ID.
    const attempt = await a.emit('request:send', { publicId: a.identity.publicId });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error.code).toBe(ErrorCode.SELF_TARGET_NOT_ALLOWED);
    void b;

    const row = await until(async () => {
      const { rows } = await pool.query<{ type: string; expiresAt: Date }>(
        `SELECT type, "expiresAt" FROM "SecurityEvent" WHERE "identityId" IN (
           SELECT id FROM "Identity" WHERE "publicId" = $1
         ) ORDER BY "createdAt" DESC LIMIT 1`,
        [a.identity.publicId],
      );
      return rows[0] ?? null;
    });

    expect(row.type).toBe('contact_self');
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
