import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { AdminPlatformView } from '@anonlink/shared';

import { log } from '../common/logger.js';
import { PrismaService } from '../prisma/prisma.service.js';

const POLICY_ID = 'default';

/**
 * Installation-wide switches the owner controls in `/admin`.
 *
 * ## Why this is a service and not a column
 *
 * Since 2026-10-20 (D31) the availability of blocking is a moderation decision, not a
 * personal preference: the owner sets it once, every user gets the same answer, and the
 * API enforces it. The same row now carries the two AI permissions (D38): whether an AI
 * moderator may act without a click, and whether an AI companion may stand in for a missing
 * human. Both are off until the owner enables them, and both will be enforced server-side
 * by the adapter that consumes them — never by a model's own claim.
 *
 * ## Why it is cached
 *
 * `blockPeerOfChat` runs inside the chat domain's synchronous critical section, which must
 * not `await` a database read (see `DirectoryService`). The value is loaded at boot and
 * replaced on every write, so the only staleness is the moment between a `PUT` reaching
 * the database and the cache being replaced — inside one request, in one process.
 *
 * ## Fail closed
 *
 * A missing row, or a read that never happened, means `false` for every switch: the
 * shipped default is "blocking off, AI permissions off". A database hiccup must not
 * silently grant a moderation action or an AI permission.
 */
@Injectable()
export class PlatformService implements OnModuleInit {
  private policy: AdminPlatformView = {
    blockingEnabled: false,
    aiAutonomyEnabled: false,
    aiCompanionEnabled: false,
  };

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
    log.info('platform.policy_loaded', {
      blockingEnabled: this.policy.blockingEnabled,
      aiAutonomyEnabled: this.policy.aiAutonomyEnabled,
      aiCompanionEnabled: this.policy.aiCompanionEnabled,
    });
  }

  /** The policy currently in force. Synchronous on purpose; see the class comment. */
  current(): AdminPlatformView {
    return this.policy;
  }

  /** Whether the "block a peer" action is offered at all. */
  blockingEnabled(): boolean {
    return this.policy.blockingEnabled;
  }

  /**
   * Whether an AI moderator may act without a human click.
   *
   * Exposed as a server-side getter so a future adapter cannot decide this from its own
   * configuration. No AI consumer exists yet; the value is stored and enforced by whichever
   * action path is added (D38).
   */
  aiAutonomyEnabled(): boolean {
    return this.policy.aiAutonomyEnabled;
  }

  /** Whether an AI companion may stand in when random matching finds no human. */
  aiCompanionEnabled(): boolean {
    return this.policy.aiCompanionEnabled;
  }

  async reload(): Promise<void> {
    const row = await this.prisma.platformPolicy.findUnique({
      where: { id: POLICY_ID },
      select: {
        blockingEnabled: true,
        aiAutonomyEnabled: true,
        aiCompanionEnabled: true,
      },
    });

    this.policy = {
      blockingEnabled: row?.blockingEnabled ?? false,
      aiAutonomyEnabled: row?.aiAutonomyEnabled ?? false,
      aiCompanionEnabled: row?.aiCompanionEnabled ?? false,
    };
  }

  async set(input: AdminPlatformView): Promise<AdminPlatformView> {
    const row = await this.prisma.platformPolicy.upsert({
      where: { id: POLICY_ID },
      create: {
        id: POLICY_ID,
        blockingEnabled: input.blockingEnabled,
        aiAutonomyEnabled: input.aiAutonomyEnabled,
        aiCompanionEnabled: input.aiCompanionEnabled,
      },
      update: {
        blockingEnabled: input.blockingEnabled,
        aiAutonomyEnabled: input.aiAutonomyEnabled,
        aiCompanionEnabled: input.aiCompanionEnabled,
      },
      select: {
        blockingEnabled: true,
        aiAutonomyEnabled: true,
        aiCompanionEnabled: true,
      },
    });

    this.policy = {
      blockingEnabled: row.blockingEnabled,
      aiAutonomyEnabled: row.aiAutonomyEnabled,
      aiCompanionEnabled: row.aiCompanionEnabled,
    };
    log.info('platform.policy_changed', {
      blockingEnabled: row.blockingEnabled,
      aiAutonomyEnabled: row.aiAutonomyEnabled,
      aiCompanionEnabled: row.aiCompanionEnabled,
    });
    return this.policy;
  }
}
