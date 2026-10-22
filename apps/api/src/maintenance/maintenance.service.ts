import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { log } from '../common/logger.js';
import { RateLimitService } from '../common/rate-limit.service.js';
import { ArchiveService } from '../archive/archive.service.js';
import { ChatService } from '../chat/chat.service.js';
import { OwnerMessageService } from '../owner/owner.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface MaintenanceReport {
  /** Matchmaking tickets dropped because their owner went quiet. */
  expiredTickets: number;
  /** Direct invitations that passed their deadline. */
  expiredRequests: number;
  /** In-chat friend requests that passed their deadline. */
  expiredFriendRequests: number;
  /** Finished chats evicted from memory after their tombstone expired. */
  prunedChats: number;
  /** Searches widened because their owner waited too long with filters on. */
  widenedSearches: number;
  /** Of those widened searches, how many found a partner immediately. */
  relaxedMatches: number;
  /** Reports deleted because their retention deadline passed. */
  deletedReports: number;
  /** Security events deleted because their retention deadline passed. */
  deletedSecurityEvents: number;
  /** Sessions deleted after expiring or being revoked long enough ago. */
  deletedSessions: number;
  /** Archived conversations deleted because the owner's retention ran out. */
  deletedArchives: number;
  /** Messages removed together with those archived conversations. */
  deletedArchivedMessages: number;
  /** "Contact the owner" messages deleted because their retention deadline passed. */
  deletedOwnerMessages: number;
  /** Unread report warnings cleared once the report's retention window has passed. */
  clearedReportWarnings: number;
}

/**
 * The periodic housekeeper.
 *
 * AnonLink holds state in two places — process memory and PostgreSQL — and both
 * need trimming, otherwise a long-running service slowly accumulates stale tickets,
 * finished chats and expired rows.
 *
 * It is also where the retention policy becomes real. Privacy statements are only
 * meaningful if something actually deletes the data, so `enforceRetention` is the
 * enforcement point for every deadline in the schema:
 *  - abuse reports (and their message snapshot) after `REPORT_RETENTION_DAYS`;
 *  - unread report warnings after the same window, so they cannot outlive the evidence;
 *  - security events after `SECURITY_EVENT_RETENTION_DAYS`;
 *  - sessions after `SESSION_RETENTION_DAYS` past becoming invalid;
 *  - archived conversations after the owner's own retention (`retentionDays`), when the
 *    owner has switched archiving on at all;
 *  - "contact the owner" messages after `OWNER_MESSAGE_RETENTION_DAYS`.
 *
 * Identity rows are deliberately never deleted here: they hold a random public ID
 * and timestamps and no personal data, and deleting one would cascade away the
 * reports that describe the abuse it may have committed. See docs/SECURITY.md.
 */
@Injectable()
export class MaintenanceService implements OnModuleInit, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chat: ChatService,
    private readonly archive: ArchiveService,
    private readonly ownerMessages: OwnerMessageService,
    private readonly rateLimit: RateLimitService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.config.MAINTENANCE_INTERVAL_MS;

    // Zero means "no periodic housekeeping". It is a configuration value rather than a
    // `NODE_ENV` check because the end-to-end stack is a real server that *does* need the
    // sweep to run, while the integration suite needs it never to run, so its assertions
    // cannot race a sweep. (Note: nothing drives `runOnce` by hand today — the integration
    // suite only proves that widening stays off, and retention is exercised solely where the
    // interval is enabled, i.e. the E2E stack. A dedicated sweep test is still missing; see
    // docs/TESTING.md §6.) One flag, set explicitly by whoever knows which of the two it is.
    if (intervalMs <= 0) {
      log.info('maintenance.disabled', {});
      return;
    }

    this.timer = setInterval(() => {
      void this.runOnce();
    }, intervalMs);

    // Housekeeping must never be the reason a process stays alive.
    this.timer.unref();
    log.info('maintenance.started', { intervalMs });
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass of every cleanup task. Never throws. */
  async runOnce(now: number = Date.now()): Promise<MaintenanceReport> {
    const empty: MaintenanceReport = {
      expiredTickets: 0,
      expiredRequests: 0,
      expiredFriendRequests: 0,
      prunedChats: 0,
      widenedSearches: 0,
      relaxedMatches: 0,
      deletedReports: 0,
      deletedSecurityEvents: 0,
      deletedSessions: 0,
      deletedArchives: 0,
      deletedArchivedMessages: 0,
      deletedOwnerMessages: 0,
      clearedReportWarnings: 0,
    };

    try {
      const swept = this.chat.sweep(now);
      // Widening runs before retention: it changes who the user is about to meet, which is
      // the most time-sensitive thing this job does.
      const relaxed = await this.chat.relax(now);
      this.rateLimit.sweep(now);
      const retention = await this.enforceRetention(now);

      const report: MaintenanceReport = {
        ...swept,
        ...retention,
        widenedSearches: relaxed.widened,
        relaxedMatches: relaxed.matched,
      };
      const touched = Object.values(report).some((count) => count > 0);
      if (touched) log.debug('maintenance.swept', { ...report });

      return report;
    } catch (error) {
      log.error('maintenance.failed', error);
      return empty;
    }
  }

  /** Deletes everything whose retention deadline has passed. */
  private async enforceRetention(
    now: number,
  ): Promise<
    Pick<
      MaintenanceReport,
      | 'deletedReports'
      | 'deletedSecurityEvents'
      | 'deletedSessions'
      | 'deletedArchives'
      | 'deletedArchivedMessages'
      | 'deletedOwnerMessages'
      | 'clearedReportWarnings'
    >
  > {
    const at = new Date(now);
    const sessionCutoff = new Date(now - this.config.SESSION_RETENTION_DAYS * DAY_MS);
    // The warning has no separate deadline: it is cleared when acknowledged, and otherwise
    // cannot outlive the report that caused it. Without this, an unread timestamp would
    // stay on the identity forever after the evidence itself was deleted (D38).
    const warningCutoff = new Date(now - this.config.REPORT_RETENTION_DAYS * DAY_MS);

    const [reports, securityEvents, sessions, archives, expiredOwnerMessages, warnings] =
      await Promise.all([
        this.prisma.report.deleteMany({ where: { expiresAt: { lt: at } } }),
        this.prisma.securityEvent.deleteMany({ where: { expiresAt: { lt: at } } }),
        this.prisma.session.deleteMany({
          where: {
            OR: [{ expiresAt: { lt: sessionCutoff } }, { revokedAt: { lt: sessionCutoff } }],
          },
        }),
        // The archive's own deadline is per policy rather than an environment value: the
        // owner sets it, `0` means "keep until I delete it", and `deleteExpired` is the one
        // query that both this sweep and the owner's "delete expired now" button call.
        this.archive.deleteExpired(now),
        this.ownerMessages.deleteExpired(now),
        this.prisma.identity.updateMany({
          where: { reportWarningAt: { lt: warningCutoff } },
          data: { reportWarningAt: null },
        }),
      ]);

    return {
      deletedReports: reports.count,
      deletedSecurityEvents: securityEvents.count,
      deletedSessions: sessions.count,
      deletedArchives: archives.deletedArchives,
      deletedArchivedMessages: archives.deletedMessages,
      deletedOwnerMessages: expiredOwnerMessages,
      clearedReportWarnings: warnings.count,
    };
  }
}
