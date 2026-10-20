import { describe, expect, it, vi } from 'vitest';

import { PlatformService } from '../../src/platform/platform.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';

/**
 * The shipped default of the platform policy.
 *
 * The integration suite turns blocking on in its fixture because most of it tests the
 * mechanics; this test is what keeps "off by default" from being quietly lost. A missing
 * row must mean `false` in both directions: the cached value a running process starts
 * with, and the fallback after a reload. Failing closed is deliberate — a database hiccup
 * must never hand out a moderation action.
 */

function serviceWith(row: { blockingEnabled: boolean } | null): PlatformService {
  const prisma = {
    platformPolicy: {
      findUnique: vi.fn().mockResolvedValue(row),
    },
  } as unknown as PrismaService;

  return new PlatformService(prisma);
}

describe('PlatformService', () => {
  it('starts with blocking off before anything is read', () => {
    const service = serviceWith(null);

    expect(service.blockingEnabled()).toBe(false);
  });

  it('treats a missing row as the shipped default, which is off', async () => {
    const service = serviceWith(null);

    await service.reload();

    expect(service.current()).toEqual({ blockingEnabled: false });
  });

  it('adopts an explicitly stored value', async () => {
    const service = serviceWith({ blockingEnabled: true });

    await service.reload();

    expect(service.blockingEnabled()).toBe(true);
  });
});
