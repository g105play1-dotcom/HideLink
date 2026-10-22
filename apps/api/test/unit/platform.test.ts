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
 * must never hand out a moderation action or an AI permission.
 */

interface PolicyRow {
  blockingEnabled: boolean;
  aiAutonomyEnabled: boolean;
  aiCompanionEnabled: boolean;
}

function serviceWith(row: PolicyRow | null): PlatformService {
  const prisma = {
    platformPolicy: {
      findUnique: vi.fn().mockResolvedValue(row),
    },
  } as unknown as PrismaService;

  return new PlatformService(prisma);
}

const OFF: PolicyRow = {
  blockingEnabled: false,
  aiAutonomyEnabled: false,
  aiCompanionEnabled: false,
};

describe('PlatformService', () => {
  it('starts with every switch off before anything is read', () => {
    const service = serviceWith(null);

    expect(service.blockingEnabled()).toBe(false);
    expect(service.aiAutonomyEnabled()).toBe(false);
    expect(service.aiCompanionEnabled()).toBe(false);
  });

  it('treats a missing row as the shipped default, which is off', async () => {
    const service = serviceWith(null);

    await service.reload();

    expect(service.current()).toEqual(OFF);
  });

  it('adopts explicitly stored values', async () => {
    const service = serviceWith({
      blockingEnabled: true,
      aiAutonomyEnabled: true,
      aiCompanionEnabled: false,
    });

    await service.reload();

    expect(service.blockingEnabled()).toBe(true);
    expect(service.aiAutonomyEnabled()).toBe(true);
    // The switches are independent: enabling one must not enable the other.
    expect(service.aiCompanionEnabled()).toBe(false);
  });

  it('keeps the AI permissions independent when the row says so', async () => {
    const service = serviceWith({
      blockingEnabled: false,
      aiAutonomyEnabled: false,
      aiCompanionEnabled: true,
    });

    await service.reload();

    expect(service.aiAutonomyEnabled()).toBe(false);
    expect(service.aiCompanionEnabled()).toBe(true);
  });
});
