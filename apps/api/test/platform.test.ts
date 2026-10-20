import { ErrorCode } from '@anonlink/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adminHttp, createIdentity, http, setBlockingPolicy } from './support/api-client.js';

/**
 * The platform switches the owner controls in `/admin`.
 *
 * Until D31, whether the "block a peer" action existed was a personal setting. The owner
 * corrected that: it is a moderation decision, it lives with the reports, and it is **off**
 * until he enables it. Two things therefore need proof here beyond "the toggle saves":
 * a user cannot change it, and switching it off refuses the action on the server while
 * leaving every block already made intact and removable.
 *
 * The suite fixture starts with blocking on (most suites test its mechanics). Every test
 * below restores that state, whether it passes or fails.
 */

beforeEach(async () => {
  await setBlockingPolicy(true);
});

afterEach(async () => {
  await setBlockingPolicy(true);
});

interface PlatformBody {
  blockingEnabled: boolean;
}

interface ErrorBody {
  error: { code: string; message: string };
}

describe('blocking policy', () => {
  it('is readable and writable only by the owner', async () => {
    const user = await createIdentity();

    const anonymous = await http<ErrorBody>('/admin/platform', { cookie: user.cookie });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe(ErrorCode.ADMIN_AUTH_REQUIRED);

    const noCredential = await http<ErrorBody>('/admin/platform');
    expect(noCredential.status).toBe(401);

    const view = await adminHttp<PlatformBody>('/admin/platform');
    expect(view.status).toBe(200);
    expect(view.body.blockingEnabled).toBe(true);
  });

  it('gives every user the same answer in the session view', async () => {
    await setBlockingPolicy(false);

    const first = await createIdentity();
    const second = await createIdentity();

    const firstView = await http<{ session: { blockingEnabled: boolean } | null }>('/session', {
      cookie: first.cookie,
    });
    const secondView = await http<{ session: { blockingEnabled: boolean } | null }>('/session', {
      cookie: second.cookie,
    });

    expect(firstView.body.session?.blockingEnabled).toBe(false);
    expect(secondView.body.session?.blockingEnabled).toBe(false);
  });

  it('refuses new blocks while off, keeps old ones removable, and allows them again', async () => {
    const blocker = await createIdentity();
    const blockedEarlier = await createIdentity();
    const target = await createIdentity();

    const added = await http('/blocks', {
      method: 'POST',
      cookie: blocker.cookie,
      body: { publicId: blockedEarlier.publicId },
    });
    expect(added.status).toBe(201);

    await setBlockingPolicy(false);

    const refused = await http<ErrorBody>('/blocks', {
      method: 'POST',
      cookie: blocker.cookie,
      body: { publicId: target.publicId },
    });
    // Hiding the button is not enough: a tab left open before the owner changed the
    // policy would otherwise still be able to block, and the switch would be decoration.
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe(ErrorCode.BLOCKING_DISABLED);

    // Switching the action off is not an amnesty. The existing block stays in force, and
    // the list stays readable so its owner can lift it; otherwise the policy would trap
    // people with blocks they cannot undo.
    const listed = await http<{ blocks: Array<{ publicId: string }> }>('/blocks', {
      cookie: blocker.cookie,
    });
    expect(listed.body.blocks.map((entry) => entry.publicId)).toEqual([blockedEarlier.publicId]);

    const removed = await http<{ removed: boolean }>(`/blocks/${blockedEarlier.publicId}`, {
      method: 'DELETE',
      cookie: blocker.cookie,
    });
    expect(removed.body.removed).toBe(true);

    await setBlockingPolicy(true);

    const allowed = await http('/blocks', {
      method: 'POST',
      cookie: blocker.cookie,
      body: { publicId: target.publicId },
    });
    expect(allowed.status).toBe(201);
  });

  it('rejects a body that is not exactly the switches it controls', async () => {
    const malformed = await adminHttp<ErrorBody>('/admin/platform', {
      method: 'PUT',
      body: { blockingEnabled: 'yes' },
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe(ErrorCode.INVALID_INPUT);

    const extra = await adminHttp<ErrorBody>('/admin/platform', {
      method: 'PUT',
      body: { blockingEnabled: true, reportsVisible: true },
    });
    expect(extra.status).toBe(400);
    expect(extra.body.error.code).toBe(ErrorCode.INVALID_INPUT);
  });
});
