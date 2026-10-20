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
 * API enforces it. Keeping the value in `PlatformPolicy` means it survives a restart and
 * is visible in the same place as the archive and the reports.
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
 * A missing row, or a read that never happened, means `false`: the shipped default is
 * "blocking is off". A database hiccup must not silently grant a moderation action.
 */
@Injectable()
export class PlatformService implements OnModuleInit {
  private policy: AdminPlatformView = { blockingEnabled: false };

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
    log.info('platform.policy_loaded', { blockingEnabled: this.policy.blockingEnabled });
  }

  /** The policy currently in force. Synchronous on purpose; see the class comment. */
  current(): AdminPlatformView {
    return this.policy;
  }

  /** Whether the "block a peer" action is offered at all. */
  blockingEnabled(): boolean {
    return this.policy.blockingEnabled;
  }

  async reload(): Promise<void> {
    const row = await this.prisma.platformPolicy.findUnique({
      where: { id: POLICY_ID },
      select: { blockingEnabled: true },
    });

    this.policy = { blockingEnabled: row?.blockingEnabled ?? false };
  }

  async set(input: AdminPlatformView): Promise<AdminPlatformView> {
    const row = await this.prisma.platformPolicy.upsert({
      where: { id: POLICY_ID },
      create: { id: POLICY_ID, blockingEnabled: input.blockingEnabled },
      update: { blockingEnabled: input.blockingEnabled },
      select: { blockingEnabled: true },
    });

    this.policy = { blockingEnabled: row.blockingEnabled };
    log.info('platform.policy_changed', { blockingEnabled: row.blockingEnabled });
    return this.policy;
  }
}
