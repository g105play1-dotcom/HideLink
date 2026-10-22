import { Inject, Injectable } from '@nestjs/common';
import {
  ADMIN_BAN_REASON_MAX_LENGTH,
  type AdminIdentityView,
  type AdminReportView,
  type BlockedUserView,
  type IncomingRequestPolicy,
  type ReportReason,
  type ReportStatus,
} from '@anonlink/shared';

import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { newReportId } from '../common/ids.js';
import { log } from '../common/logger.js';
import { DirectoryService } from '../directory/directory.service.js';
import { AppEventBus } from '../events/app-events.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ADMIN_IDENTITY_SELECT, toAdminIdentityView } from './admin-identity.js';

/**
 * Durable moderation state: blocks, abuse reports, identity suspensions and coarse
 * security events.
 *
 * This service owns database work, the in-memory block cache and the suspension bit.
 * It has no knowledge of chats or sockets, which is what keeps the module graph acyclic:
 * the chat layer depends on moderation, never the other way round. A suspension publishes
 * `identity.banned`; the gateway decides what that means for live sockets.
 */

export interface ReportInput {
  reporterId: string;
  targetId: string;
  chatId?: string;
  messageId?: string;
  /** Server-side snapshot of the reported message. Never taken from client input. */
  messageSnapshot?: string;
  reason: ReportReason;
  details?: string;
}

/** Coarse, low-volume security events. Never contains message text or addresses. */
export type SecurityEventType =
  | 'contact_blocked'
  | 'contact_self'
  | 'contact_disabled'
  | 'contact_offline'
  | 'chat_blocked'
  | 'report_created';

@Injectable()
export class ModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly directory: DirectoryService,
    private readonly bus: AppEventBus,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------------------
  // Blocks
  // ---------------------------------------------------------------------------

  /**
   * Records a block. Idempotent: blocking twice is not an error, because the user
   * may have tapped a stale "block" button.
   */
  async block(blockerId: string, blockedId: string): Promise<void> {
    // A block severs a friendship in the same transaction. Leaving the friendship row
    // behind would keep the blocked person in the blocker's friend list and let the list
    // offer a "write" action that can only fail.
    await this.prisma.$transaction([
      this.prisma.block.upsert({
        where: { blockerId_blockedId: { blockerId, blockedId } },
        create: { blockerId, blockedId },
        update: {},
      }),
      this.prisma.friendship.deleteMany({
        where: {
          OR: [
            { userIdA: blockerId, userIdB: blockedId },
            { userIdA: blockedId, userIdB: blockerId },
          ],
        },
      }),
    ]);

    this.directory.recordBlock(blockerId, blockedId);
    log.security('block.created', {});
  }

  /** Removes a block. Returns `false` when there was nothing to remove. */
  async unblock(blockerId: string, blockedId: string): Promise<boolean> {
    const result = await this.prisma.block.deleteMany({ where: { blockerId, blockedId } });
    this.directory.recordUnblock(blockerId, blockedId);
    if (result.count > 0) log.info('block.removed', {});
    return result.count > 0;
  }

  async listBlocks(blockerId: string): Promise<BlockedUserView[]> {
    const rows = await this.prisma.block.findMany({
      where: { blockerId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, blocked: { select: { publicId: true } } },
    });

    return rows.map((row) => ({
      publicId: row.blocked.publicId,
      blockedAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Whether either identity has blocked the other.
   *
   * Read from the database rather than from the cache, because this is used on
   * paths (REST lookups, direct requests) where the other identity may not be
   * loaded. Matchmaking uses the synchronous cached variant instead.
   */
  async isBlockedBetween(a: string, b: string): Promise<boolean> {
    const found = await this.prisma.block.findFirst({
      where: {
        OR: [
          { blockerId: a, blockedId: b },
          { blockerId: b, blockedId: a },
        ],
      },
      select: { id: true },
    });
    return found !== null;
  }

  // ---------------------------------------------------------------------------
  // Reports
  // ---------------------------------------------------------------------------

  /**
   * Stores an abuse report and returns its id.
   *
   * The report carries `expiresAt`, and the maintenance job hard-deletes expired
   * rows — including the message snapshot. That is what keeps AnonLink's
   * "we do not keep your conversations" promise honest while still letting a
   * human act on a complaint.
   */
  async createReport(input: ReportInput): Promise<string> {
    const reportId = newReportId();
    const reportedAt = new Date();
    const expiresAt = new Date(
      Date.now() + this.config.REPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    await this.prisma.$transaction([
      this.prisma.report.create({
        data: {
          id: reportId,
          reporterId: input.reporterId,
          targetId: input.targetId,
          reason: input.reason,
          status: 'open',
          expiresAt,
          ...(input.chatId ? { chatId: input.chatId } : {}),
          ...(input.messageId ? { messageId: input.messageId } : {}),
          ...(input.messageSnapshot ? { messageSnapshot: input.messageSnapshot } : {}),
          ...(input.details ? { details: input.details } : {}),
        },
      }),
      // The target is told that a complaint exists, without any evidence. This is
      // deliberately the opposite of the old "reports are silent" rule: the owner asked
      // for a warning with a possible-ban consequence (D38). A new report replaces an
      // older unread warning; acknowledging it means clearing the column, not deleting
      // the report.
      this.prisma.identity.update({
        where: { id: input.targetId },
        data: { reportWarningAt: reportedAt },
      }),
      // Reporting a friend is a safety action: the link must not survive it, or the
      // reported person would keep a one-click way back to the reporter.
      this.prisma.friendship.deleteMany({
        where: {
          OR: [
            { userIdA: input.reporterId, userIdB: input.targetId },
            { userIdA: input.targetId, userIdB: input.reporterId },
          ],
        },
      }),
    ]);

    // Deliberately logs no reason and no content: the report row is the record.
    log.security('report.created', { retentionDays: this.config.REPORT_RETENTION_DAYS });
    // The target may be offline; the stored timestamp is what the REST bootstrap reads.
    this.bus.emit({
      type: 'report.warning',
      userId: input.targetId,
      reportedAt: reportedAt.toISOString(),
    });
    return reportId;
  }

  /** The unread report warning for one identity, if any. */
  async getReportWarning(userId: string): Promise<Date | null> {
    const row = await this.prisma.identity.findUnique({
      where: { id: userId },
      select: { reportWarningAt: true },
    });
    return row?.reportWarningAt ?? null;
  }

  /**
   * Marks the warning as seen by clearing it.
   *
   * Idempotent: acknowledging with nothing pending is not an error. A report that arrives
   * between the read and this call replaces the timestamp, and this call clears the newer
   * one too; that is acceptable because the target is dismissing a warning they were just
   * shown, and the report itself is untouched.
   */
  async acknowledgeReportWarning(userId: string): Promise<boolean> {
    const result = await this.prisma.identity.updateMany({
      where: { id: userId, reportWarningAt: { not: null } },
      data: { reportWarningAt: null },
    });
    return result.count > 0;
  }

  /**
   * Reports still inside their retention window, newest first.
   *
   * Expired rows are filtered here even though the maintenance sweep deletes them: the
   * owner must never be shown a complaint the server has already promised to forget, and
   * between two sweep runs there is a window where the row still exists.
   */
  async listReports(limit: number): Promise<AdminReportView[]> {
    const rows = await this.prisma.report.findMany({
      where: { expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: REPORT_ADMIN_SELECT,
    });

    return rows.map(toReportView);
  }

  /**
   * Records what the owner did with a report.
   *
   * The status is the only editable field: reason, details, participants and the message
   * snapshot are evidence, and rewriting them would make the record disagree with what the
   * reporter sent. Returns `null` when the report is gone or already expired.
   */
  async setReportStatus(id: string, status: ReportStatus): Promise<AdminReportView | null> {
    const result = await this.prisma.report.updateMany({
      where: { id, expiresAt: { gt: new Date() } },
      data: { status },
    });
    if (result.count === 0) return null;

    const row = await this.prisma.report.findUnique({
      where: { id },
      select: REPORT_ADMIN_SELECT,
    });
    return row ? toReportView(row) : null;
  }

  // ---------------------------------------------------------------------------
  // Identity helpers
  // ---------------------------------------------------------------------------

  async findByPublicId(publicId: string): Promise<{
    id: string;
    publicId: string;
    banned: boolean;
    incomingRequests: IncomingRequestPolicy;
  } | null> {
    const found = await this.prisma.identity.findUnique({
      where: { publicId },
      select: { id: true, publicId: true, bannedAt: true, incomingRequests: true },
    });
    if (!found) return null;

    return {
      id: found.id,
      publicId: found.publicId,
      banned: found.bannedAt !== null,
      incomingRequests: found.incomingRequests,
    };
  }

  /** One identity in the shape the owner's panel renders. */
  async findAdminIdentity(publicId: string): Promise<AdminIdentityView | null> {
    const row = await this.prisma.identity.findUnique({
      where: { publicId },
      select: ADMIN_IDENTITY_SELECT,
    });
    return row ? toAdminIdentityView(row) : null;
  }

  /**
   * Suspends an identity by its public User ID, returning its new state.
   *
   * `null` means the User ID does not exist; the caller turns that into the same
   * `USER_NOT_FOUND` the public lookup uses.
   */
  async banByPublicId(publicId: string, reason: string): Promise<AdminIdentityView | null> {
    const row = await this.prisma.identity.findUnique({
      where: { publicId },
      select: { id: true },
    });
    if (!row) return null;

    await this.ban(row.id, reason);
    return this.findAdminIdentity(publicId);
  }

  /** Lifts a suspension. Idempotent: unbanning an active identity is not an error. */
  async unbanByPublicId(publicId: string): Promise<AdminIdentityView | null> {
    const row = await this.prisma.identity.findUnique({
      where: { publicId },
      select: { id: true },
    });
    if (!row) return null;

    await this.unban(row.id);
    return this.findAdminIdentity(publicId);
  }

  /**
   * Suspends an identity.
   *
   * ## Sessions are deliberately *not* revoked
   *
   * A ban is about the identity, not about one session. If the sessions were revoked, the
   * next `POST /session` would look like a stranger and mint a brand-new User ID — the
   * banned person would escape by pressing F5. Leaving the sessions in place means the
   * guard recognises the identity on every request and answers `IDENTITY_BANNED`; the
   * existing browser stays banned until its cookie is cleared or the session expires.
   * That is still not a ban of a *human* (see docs/SECURITY.md), but it is the strongest
   * promise an anonymous product can keep.
   *
   * The live sockets are closed through `identity.banned`; the gateway owns sockets and
   * this service must not import it. Friendships are deleted in the same transaction:
   * a banned person must not remain in someone's contact list with a "write" action that
   * can only fail.
   */
  async ban(userId: string, reason: string): Promise<void> {
    const friendships = await this.prisma.friendship.findMany({
      where: { OR: [{ userIdA: userId }, { userIdB: userId }] },
      select: {
        userIdA: true,
        userIdB: true,
        userA: { select: { publicId: true } },
        userB: { select: { publicId: true } },
      },
    });

    const removedFor = friendships.map((row) =>
      row.userIdA === userId
        ? { userId: row.userIdB, publicId: row.userA.publicId }
        : { userId: row.userIdA, publicId: row.userB.publicId },
    );

    await this.prisma.$transaction([
      this.prisma.identity.update({
        where: { id: userId },
        data: { bannedAt: new Date(), bannedReason: reason.slice(0, ADMIN_BAN_REASON_MAX_LENGTH) },
      }),
      this.prisma.friendship.deleteMany({
        where: { OR: [{ userIdA: userId }, { userIdB: userId }] },
      }),
    ]);

    this.directory.patch(userId, { banned: true });

    for (const peer of removedFor) {
      this.bus.emit({ type: 'friend.removed', userId: peer.userId, publicId: peer.publicId });
    }
    // The gateway ends any live chat and closes the sockets. The event carries no reason:
    // the peer must not learn that the other side was suspended.
    this.bus.emit({ type: 'identity.banned', userId });

    log.security('identity.banned', {});
  }

  /** Lifts a suspension. The identity's sessions were never revoked, so it can return. */
  async unban(userId: string): Promise<void> {
    const result = await this.prisma.identity.updateMany({
      where: { id: userId, bannedAt: { not: null } },
      data: { bannedAt: null, bannedReason: null },
    });

    this.directory.patch(userId, { banned: false });
    if (result.count > 0) log.security('identity.unbanned', {});
  }

  // ---------------------------------------------------------------------------
  // Security events
  // ---------------------------------------------------------------------------

  /**
   * Appends a coarse security event.
   *
   * Used only for low-frequency, high-signal actions. Rate-limit trips are *not*
   * recorded here: they happen thousands of times per attacker per minute, and
   * writing them would turn the database into a write amplifier that an attacker
   * could use against the service.
   */
  async recordSecurityEvent(
    type: SecurityEventType,
    identityId?: string,
    targetId?: string,
  ): Promise<void> {
    const expiresAt = new Date(
      Date.now() + this.config.SECURITY_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    try {
      await this.prisma.securityEvent.create({
        data: {
          type,
          expiresAt,
          ...(identityId ? { identityId } : {}),
          ...(targetId ? { targetId } : {}),
        },
      });
    } catch (error) {
      // Forensics must never break the user-facing path.
      log.warn('security_event.write_failed', { type });
      void error;
    }
  }

  /** Diagnostics only. */
  async openReportCount(): Promise<number> {
    return this.prisma.report.count({ where: { status: 'open' } });
  }
}

/** Exactly the columns the owner's report list reads. */
const REPORT_ADMIN_SELECT = {
  id: true,
  chatId: true,
  reason: true,
  status: true,
  details: true,
  messageId: true,
  messageSnapshot: true,
  createdAt: true,
  expiresAt: true,
  reporter: { select: { publicId: true } },
  target: { select: { publicId: true } },
} as const;

interface ReportAdminRow {
  id: string;
  chatId: string | null;
  reason: ReportReason;
  status: ReportStatus;
  details: string | null;
  messageId: string | null;
  messageSnapshot: string | null;
  createdAt: Date;
  expiresAt: Date;
  reporter: { publicId: string };
  target: { publicId: string };
}

function toReportView(row: ReportAdminRow): AdminReportView {
  return {
    id: row.id,
    chatId: row.chatId,
    reason: row.reason,
    status: row.status,
    details: row.details,
    messageId: row.messageId,
    messageSnapshot: row.messageSnapshot,
    reporterPublicId: row.reporter.publicId,
    targetPublicId: row.target.publicId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}
