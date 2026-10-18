import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { log } from '../common/logger.js';
import { RateLimitService } from '../common/rate-limit.service.js';
import { ChatService } from '../chat/chat.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 15_000;

export interface MaintenanceReport {
  /** Matchmaking tickets dropped because their owner went quiet. */
  expiredTickets: number;
  /** Direct invitations that passed their deadline. */
  expiredRequests: number;
  /** Finished chats evicted from memory after their tombstone expired. */
  prunedChats: number;
  /** Reports deleted because their retention deadline passed. */
  deletedReports: number;
  /** Security events deleted because their retention deadline passed. */
  deletedSecurityEvents: number;
  /** Sessions deleted after expiring or being revoked long enough ago. */
  deletedSessions: number;
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
 *  - security events after `SECURITY_EVENT_RETENTION_DAYS`;
 *  - sessions after `SESSION_RETENTION_DAYS` past becoming invalid.
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
    private readonly rateLimit: RateLimitService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    // Tests drive `runOnce` explicitly so that cleanup never races an assertion.
    if (this.config.isTest) return;

    this.timer = setInterval(() => {
      void this.runOnce();
    }, SWEEP_INTERVAL_MS);

    // Housekeeping must never be the reason a process stays alive.
    this.timer.unref();
    log.info('maintenance.started', { intervalMs: SWEEP_INTERVAL_MS });
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
      prunedChats: 0,
      deletedReports: 0,
      deletedSecurityEvents: 0,
      deletedSessions: 0,
    };

    try {
      const swept = this.chat.sweep(now);
      this.rateLimit.sweep(now);
      const retention = await this.enforceRetention(now);

      const report: MaintenanceReport = { ...swept, ...retention };
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
  ): Promise<Omit<MaintenanceReport, 'expiredTickets' | 'expiredRequests' | 'prunedChats'>> {
    const at = new Date(now);
    const sessionCutoff = new Date(now - this.config.SESSION_RETENTION_DAYS * DAY_MS);

    const [reports, securityEvents, sessions] = await Promise.all([
      this.prisma.report.deleteMany({ where: { expiresAt: { lt: at } } }),
      this.prisma.securityEvent.deleteMany({ where: { expiresAt: { lt: at } } }),
      this.prisma.session.deleteMany({
        where: {
          OR: [{ expiresAt: { lt: sessionCutoff } }, { revokedAt: { lt: sessionCutoff } }],
        },
      }),
    ]);

    return {
      deletedReports: reports.count,
      deletedSecurityEvents: securityEvents.count,
      deletedSessions: sessions.count,
    };
  }
}
