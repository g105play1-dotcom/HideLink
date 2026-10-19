import { ErrorCode, PUBLIC_ID_PATTERN, PUBLIC_ID_PREFIX } from '@anonlink/shared';
import { beforeAll, describe, expect, it } from 'vitest';

import { type TestIdentity, createIdentity, http } from './support/api-client.js';

/**
 * The REST surface, exercised over real HTTP.
 *
 * These tests are as much about what *cannot* happen as about what can: a route that
 * leaks whether an identity exists, or one that forgot to require a session, is a
 * security bug rather than a missing feature.
 *
 * Two conventions used throughout:
 *  - the contract is the `code`, not the HTTP status, so assertions check the code and
 *    treat the status as a secondary detail;
 *  - every test creates its own identities, so the suite does not depend on the order
 *    the files are executed in.
 */

interface ErrorBody {
  error: { code: string; message: string; context?: string };
}

interface SessionBody {
  publicId: string;
  createdAt: string;
  sessionExpiresAt: string;
  settings: { incomingRequests: string; blockingEnabled: boolean };
}

interface CurrentSessionBody {
  authenticated: boolean;
  session: SessionBody | null;
}

let identity: TestIdentity;

beforeAll(async () => {
  identity = await createIdentity();
});

describe('health', () => {
  it('answers liveness without a session', async () => {
    const live = await http<{ status: string; uptimeSeconds: number }>('/health');

    expect(live.status).toBe(200);
    expect(live.body.status).toBe('ok');
    expect(typeof live.body.uptimeSeconds).toBe('number');
  });

  it('reports readiness including the single-instance constraint', async () => {
    const ready = await http<{ status: string; database: string; singleInstance: boolean }>(
      '/health/ready',
    );

    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('ok');
    expect(ready.body.database).toBe('ok');
    // Matchmaking lives in one process, so a deployment is exactly one instance. Saying
    // so out loud is the point: it is a constraint an operator must not have to guess.
    expect(ready.body.singleInstance).toBe(true);
  });
});

describe('POST /session', () => {
  it('creates an identity and sets an HttpOnly session cookie', async () => {
    const result = await http<SessionBody>('/session', { method: 'POST' });

    expect(result.status).toBe(201);
    expect(result.body.publicId).toMatch(PUBLIC_ID_PATTERN);
    expect(result.body.publicId.startsWith(PUBLIC_ID_PREFIX)).toBe(true);
    expect(result.body.settings.incomingRequests).toBe('everyone');

    const cookie = result.setCookie.find((value) => value.startsWith('anonlink_session'));
    expect(cookie).toBeDefined();
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/');
    // SameSite=Lax rather than Strict: the cookie must also be sent on the WebSocket
    // handshake, and `Strict` would drop it on a top-level navigation from elsewhere.
    expect(cookie).toContain('SameSite=Lax');
    // COOKIE_SECURE is false in the test environment (plain HTTP on loopback).
    expect(cookie).not.toContain('Secure');
  });

  it('does not expose the session token in the response body', async () => {
    const result = await http<Record<string, unknown>>('/session', { method: 'POST' });

    // The token exists only in the cookie. A JSON field carrying it would end up in
    // logs, screenshots and bug reports.
    const serialized = JSON.stringify(result.body);
    const token = result.setCookie[0]?.split(';')[0]?.split('=')[1] ?? '';
    expect(token.length).toBeGreaterThan(20);
    expect(serialized).not.toContain(token);
  });

  it('is idempotent: the same cookie yields the same identity', async () => {
    const first = await http<SessionBody>('/session', { method: 'POST' });
    const cookie = first.setCookie[0]?.split(';')[0] ?? '';

    const second = await http<SessionBody>('/session', { method: 'POST', cookie });

    expect(second.status).toBe(201);
    expect(second.body.publicId).toBe(first.body.publicId);
  });

  it('does not mint a second cookie for an existing identity', async () => {
    const first = await http<SessionBody>('/session', { method: 'POST' });
    const cookie = first.setCookie[0]?.split(';')[0] ?? '';

    const second = await http<SessionBody>('/session', { method: 'POST', cookie });

    expect(second.setCookie.filter((value) => value.startsWith('anonlink_session'))).toHaveLength(
      0,
    );
  });

  it('ignores a forged cookie and issues a brand-new identity', async () => {
    const forged = await http<SessionBody>('/session', {
      method: 'POST',
      cookie: 'anonlink_session=not-a-real-token',
    });

    expect(forged.body.publicId).toMatch(PUBLIC_ID_PATTERN);
    // A fresh cookie must be set, or the client would keep sending the junk one.
    expect(forged.setCookie.some((value) => value.startsWith('anonlink_session'))).toBe(true);
  });
});

describe('GET /session', () => {
  it('answers 200 with authenticated:false instead of 401 when there is no session', async () => {
    const result = await http<CurrentSessionBody>('/session');

    // This is the bootstrap endpoint: the browser calls it before it has a cookie, so
    // "no identity yet" is a normal answer rather than an error.
    expect(result.status).toBe(200);
    expect(result.body.authenticated).toBe(false);
    expect(result.body.session).toBeNull();
  });

  it('returns the current identity for a valid cookie', async () => {
    const result = await http<CurrentSessionBody>('/session', { cookie: identity.cookie });

    expect(result.status).toBe(200);
    expect(result.body.authenticated).toBe(true);
    expect(result.body.session?.publicId).toBe(identity.publicId);
    expect(result.body.session?.settings.incomingRequests).toBeDefined();
    // The peer's identity and anything about which chat is active live on the socket,
    // not here; this view is only ever about the caller.
    expect(Object.keys(result.body.session ?? {}).sort()).toEqual([
      'createdAt',
      'publicId',
      'sessionExpiresAt',
      'settings',
    ]);
  });
});

describe('DELETE /session', () => {
  it('rotates the identity instead of leaving a dangling cookie', async () => {
    const original = await createIdentity();

    const rotated = await http<SessionBody>('/session', {
      method: 'DELETE',
      cookie: original.cookie,
    });

    expect(rotated.status).toBe(200);
    expect(rotated.body.publicId).toMatch(PUBLIC_ID_PATTERN);
    expect(rotated.body.publicId).not.toBe(original.publicId);

    const freshCookie = rotated.setCookie.find((value) => value.startsWith('anonlink_session'));
    expect(freshCookie).toBeDefined();

    // The old token must stop working immediately: a "delete my identity" that keeps
    // authenticating would be a lie.
    const stale = await http<CurrentSessionBody>('/session', { cookie: original.cookie });
    expect(stale.status).toBe(200);
    expect(stale.body.authenticated).toBe(false);

    const after = await http<CurrentSessionBody>('/session', {
      cookie: freshCookie?.split(';')[0] ?? '',
    });
    expect(after.body.session?.publicId).toBe(rotated.body.publicId);
  });

  it('requires a session', async () => {
    const result = await http<ErrorBody>('/session', { method: 'DELETE' });

    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe(ErrorCode.IDENTITY_REQUIRED);
  });
});

describe('GET /users/:publicId', () => {
  it('finds an existing identity', async () => {
    const target = await createIdentity();

    const result = await http<{ exists: boolean; publicId: string }>(`/users/${target.publicId}`, {
      cookie: identity.cookie,
    });

    expect(result.status).toBe(200);
    expect(result.body.exists).toBe(true);
    expect(result.body.publicId).toBe(target.publicId);
  });

  it('answers 200 with exists:false for an unknown id, so ids cannot be enumerated', async () => {
    // A well-formed id that nobody owns: a 404 here and a 200 there would turn this
    // endpoint into an existence oracle.
    const result = await http<{ exists: boolean }>('/users/ALZZZZZZZZZZZZ', {
      cookie: identity.cookie,
    });

    expect(result.status).toBe(200);
    expect(result.body.exists).toBe(false);
  });

  it('normalizes case and Crockford look-alikes before looking up', async () => {
    const target = await createIdentity();
    const transcribed = target.publicId.toLowerCase();

    const result = await http<{ exists: boolean; publicId: string }>(`/users/${transcribed}`, {
      cookie: identity.cookie,
    });

    expect(result.status).toBe(200);
    expect(result.body.exists).toBe(true);
    expect(result.body.publicId).toBe(target.publicId);
  });

  it('rejects a malformed id instead of searching for it', async () => {
    const result = await http<ErrorBody>('/users/not-an-id', { cookie: identity.cookie });

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe(ErrorCode.INVALID_INPUT);
    // The diagnostic names the source of the bad value, which is what makes a
    // validation failure debuggable from a log line.
    expect(result.body.error.context).toContain('param.publicId');
  });

  it('never discloses presence, ban state or account age', async () => {
    const target = await createIdentity();
    const result = await http<Record<string, unknown>>(`/users/${target.publicId}`, {
      cookie: identity.cookie,
    });

    expect(Object.keys(result.body).sort()).toEqual(['acceptsRequests', 'exists', 'publicId']);
  });

  it('reports the caller to themselves without leaking a self-lookup shortcut', async () => {
    const result = await http<{ exists: boolean; acceptsRequests: boolean }>(
      `/users/${identity.publicId}`,
      { cookie: identity.cookie },
    );

    expect(result.body.exists).toBe(true);
  });

  it('requires a session', async () => {
    const result = await http<ErrorBody>(`/users/${identity.publicId}`);

    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe(ErrorCode.IDENTITY_REQUIRED);
  });
});

describe('PATCH /me/settings', () => {
  it('updates the direct-request policy and reflects it back', async () => {
    const owner = await createIdentity();

    const patched = await http<SessionBody>('/me/settings', {
      method: 'PATCH',
      cookie: owner.cookie,
      body: { incomingRequests: 'nobody' },
    });

    expect(patched.status).toBe(200);
    expect(patched.body.settings.incomingRequests).toBe('nobody');

    const current = await http<CurrentSessionBody>('/session', { cookie: owner.cookie });
    expect(current.body.session?.settings.incomingRequests).toBe('nobody');
  });

  it('round-trips the blocking switch, and another field does not reset it', async () => {
    const owner = await createIdentity();

    const off = await http<SessionBody>('/me/settings', {
      method: 'PATCH',
      cookie: owner.cookie,
      body: { blockingEnabled: false },
    });
    expect(off.body.settings.blockingEnabled).toBe(false);

    // A partial patch is not a replacement: `false` is a real value, and a plain
    // truthiness check would silently switch the feature back on whenever any *other*
    // setting was saved — the user would find the button they removed reappear.
    const other = await http<SessionBody>('/me/settings', {
      method: 'PATCH',
      cookie: owner.cookie,
      body: { incomingRequests: 'nobody' },
    });
    expect(other.body.settings.blockingEnabled).toBe(false);
    expect(other.body.settings.incomingRequests).toBe('nobody');

    const current = await http<CurrentSessionBody>('/session', { cookie: owner.cookie });
    expect(current.body.session?.settings.blockingEnabled).toBe(false);
  });

  it('rejects unknown fields rather than silently dropping them', async () => {
    const result = await http<ErrorBody>('/me/settings', {
      method: 'PATCH',
      cookie: identity.cookie,
      body: { incomingRequests: 'everyone', isAdmin: true },
    });

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe(ErrorCode.INVALID_INPUT);
  });

  it('rejects a value outside the allowed set', async () => {
    const result = await http<ErrorBody>('/me/settings', {
      method: 'PATCH',
      cookie: identity.cookie,
      body: { incomingRequests: 'maybe' },
    });

    expect(result.status).toBe(400);
  });

  it('requires a session', async () => {
    const result = await http<ErrorBody>('/me/settings', {
      method: 'PATCH',
      body: { incomingRequests: 'nobody' },
    });

    expect(result.status).toBe(401);
  });
});

describe('blocks', () => {
  it('lists, adds and removes a blocked user', async () => {
    const owner = await createIdentity();
    const target = await createIdentity();

    const empty = await http<{ blocks: unknown[] }>('/blocks', { cookie: owner.cookie });
    expect(empty.status).toBe(200);
    expect(empty.body.blocks).toEqual([]);

    const added = await http<{ publicId: string }>('/blocks', {
      method: 'POST',
      cookie: owner.cookie,
      body: { publicId: target.publicId },
    });
    expect(added.status).toBe(201);
    expect(added.body.publicId).toBe(target.publicId);

    const listed = await http<{ blocks: Array<{ publicId: string; blockedAt: string }> }>(
      '/blocks',
      {
        cookie: owner.cookie,
      },
    );
    expect(listed.body.blocks.map((entry) => entry.publicId)).toEqual([target.publicId]);
    expect(typeof listed.body.blocks[0]?.blockedAt).toBe('string');

    const removed = await http<{ removed: boolean }>(`/blocks/${target.publicId}`, {
      method: 'DELETE',
      cookie: owner.cookie,
    });
    expect(removed.status).toBe(200);
    expect(removed.body.removed).toBe(true);

    const after = await http<{ blocks: unknown[] }>('/blocks', { cookie: owner.cookie });
    expect(after.body.blocks).toEqual([]);
  });

  it('is idempotent when blocking the same person twice', async () => {
    const owner = await createIdentity();
    const target = await createIdentity();

    await http('/blocks', {
      method: 'POST',
      cookie: owner.cookie,
      body: { publicId: target.publicId },
    });
    const again = await http<{ publicId: string }>('/blocks', {
      method: 'POST',
      cookie: owner.cookie,
      body: { publicId: target.publicId },
    });

    expect(again.status).toBe(201);

    const listed = await http<{ blocks: unknown[] }>('/blocks', { cookie: owner.cookie });
    expect(listed.body.blocks).toHaveLength(1);
  });

  it('accepts an id in any transcription form', async () => {
    const owner = await createIdentity();
    const target = await createIdentity();

    const added = await http<{ publicId: string }>('/blocks', {
      method: 'POST',
      cookie: owner.cookie,
      // Lower case and with the display dashes removed, as a user might paste it.
      body: { publicId: target.publicId.toLowerCase() },
    });

    expect(added.status).toBe(201);
    expect(added.body.publicId).toBe(target.publicId);
  });

  it('refuses to block yourself', async () => {
    const result = await http<ErrorBody>('/blocks', {
      method: 'POST',
      cookie: identity.cookie,
      body: { publicId: identity.publicId },
    });

    // The contract is the code; the status merely classifies it.
    expect(result.body.error.code).toBe(ErrorCode.SELF_TARGET_NOT_ALLOWED);
    expect(result.status).toBe(409);
  });

  it('reports a non-existent target exactly as the lookup endpoint does', async () => {
    const owner = await createIdentity();

    const result = await http<ErrorBody>('/blocks', {
      method: 'POST',
      cookie: owner.cookie,
      body: { publicId: 'ALZZZZZZZZZZZZ' },
    });

    // Blocking needs a row to point at, so an unknown id is a 404 — the same fact
    // `GET /users/:id` already tells the caller. This is why that endpoint and this one
    // are both rate limited per identity: with 2^60 possible ids, guessing is not the
    // threat; systematic scraping of ids obtained elsewhere is.
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe(ErrorCode.USER_NOT_FOUND);
  });

  it('rejects a malformed id', async () => {
    const result = await http<ErrorBody>('/blocks', {
      method: 'POST',
      cookie: identity.cookie,
      body: { publicId: 'nope' },
    });

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe(ErrorCode.INVALID_INPUT);
  });

  it('never reveals who has blocked whom to a third party', async () => {
    const blocker = await createIdentity();
    const target = await createIdentity();
    const bystander = await createIdentity();

    await http('/blocks', {
      method: 'POST',
      cookie: blocker.cookie,
      body: { publicId: target.publicId },
    });

    const list = await http<{ blocks: unknown[] }>('/blocks', { cookie: bystander.cookie });
    expect(list.body.blocks).toEqual([]);
  });

  it('requires a session', async () => {
    const result = await http<ErrorBody>('/blocks', { method: 'GET' });

    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe(ErrorCode.IDENTITY_REQUIRED);
  });

  it('refuses a new block while the feature is switched off, and leaves the old ones in place', async () => {
    const owner = await createIdentity();
    const blockedEarlier = await createIdentity();
    const target = await createIdentity();

    await http('/blocks', {
      method: 'POST',
      cookie: owner.cookie,
      body: { publicId: blockedEarlier.publicId },
    });

    const disabled = await http<{ settings: { blockingEnabled: boolean } }>('/me/settings', {
      method: 'PATCH',
      cookie: owner.cookie,
      body: { blockingEnabled: false },
    });
    expect(disabled.body.settings.blockingEnabled).toBe(false);

    const refused = await http<ErrorBody>('/blocks', {
      method: 'POST',
      cookie: owner.cookie,
      body: { publicId: target.publicId },
    });
    // Hiding the button is not enough: a tab left open before the setting changed would
    // otherwise still be able to block, and the setting would be decoration.
    expect(refused.body.error.code).toBe(ErrorCode.BLOCKING_DISABLED);
    expect(refused.status).toBe(409);

    // Switching the feature off means "I do not want this action", not "undo my blocks":
    // the existing block survives, and the list stays readable so it can be undone.
    const listed = await http<{ blocks: Array<{ publicId: string }> }>('/blocks', {
      cookie: owner.cookie,
    });
    expect(listed.body.blocks.map((entry) => entry.publicId)).toEqual([blockedEarlier.publicId]);

    const removed = await http<{ removed: boolean }>(`/blocks/${blockedEarlier.publicId}`, {
      method: 'DELETE',
      cookie: owner.cookie,
    });
    expect(removed.body.removed).toBe(true);
  });

  it('allows blocking again once the feature is switched back on', async () => {
    const owner = await createIdentity();
    const target = await createIdentity();

    await http('/me/settings', {
      method: 'PATCH',
      cookie: owner.cookie,
      body: { blockingEnabled: false },
    });
    await http('/me/settings', {
      method: 'PATCH',
      cookie: owner.cookie,
      body: { blockingEnabled: true },
    });

    const added = await http<{ publicId: string }>('/blocks', {
      method: 'POST',
      cookie: owner.cookie,
      body: { publicId: target.publicId },
    });
    expect(added.status).toBe(201);
  });
});

describe('unknown routes, headers and CORS', () => {
  it('answers with the same JSON error shape as every other failure', async () => {
    const result = await http<ErrorBody>('/definitely-not-a-route', { cookie: identity.cookie });

    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe(ErrorCode.ROUTE_NOT_FOUND);
    expect(typeof result.body.error.message).toBe('string');
  });

  it('sets the security headers the API is responsible for', async () => {
    const response = await fetch('http://127.0.0.1:3101/api/v1/health');

    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')?.toUpperCase()).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-powered-by')).toBeNull();
  });

  it('does not echo the origin for an origin that is not allowed', async () => {
    const response = await fetch('http://127.0.0.1:3101/api/v1/health', {
      headers: { origin: 'http://evil.example' },
    });

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows the configured origin with credentials', async () => {
    const response = await fetch('http://127.0.0.1:3101/api/v1/health', {
      headers: { origin: 'http://localhost:3000' },
    });

    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('lets the browser preflight every method the REST surface uses', async () => {
    // The browser, not the server, enforces this list. A method missing from
    // `access-control-allow-methods` makes the real request fail with `net::ERR_FAILED`
    // and leaves nothing in the server log, so a route can be fully implemented, fully
    // tested server-side, and still be a dead button. That happened once: `PUT` (the
    // owner's archive policy) was absent from the list.
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await fetch('http://127.0.0.1:3101/api/v1/me/settings', {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:3000',
          'access-control-request-method': method,
        },
      });

      const allowed = (response.headers.get('access-control-allow-methods') ?? '')
        .split(',')
        .map((entry) => entry.trim());

      expect(allowed, `preflight should allow ${method}`).toContain(method);
    }
  });

  it('does not accept a JSON body that is not an object', async () => {
    const owner = await createIdentity();

    const result = await http<ErrorBody>('/me/settings', {
      method: 'PATCH',
      cookie: owner.cookie,
      body: 'not-an-object',
    });

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe(ErrorCode.INVALID_INPUT);
  });
});
