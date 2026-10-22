import { Controller, Get, Post } from '@nestjs/common';
import type { ReportWarningResponse } from '@anonlink/shared';

import type { AuthenticatedIdentity } from '../identity/identity.service.js';
import { CurrentIdentity } from '../identity/request-context.js';
import { ModerationService } from './moderation.service.js';

/**
 * The caller's own report warning.
 *
 * It is not a report inbox: it exposes only the fact that a complaint exists and when it
 * arrived. Reporter, chat, reason and message snapshot are the owner's evidence. The
 * socket event `report:warning` carries the same timestamp as a hint; this route is the
 * durable source, so a client that missed the event still sees the warning after a reload.
 */
@Controller('me')
export class ModerationController {
  constructor(private readonly moderation: ModerationService) {}

  @Get('report-warning')
  async warning(
    @CurrentIdentity() identity: AuthenticatedIdentity,
  ): Promise<ReportWarningResponse> {
    const reportedAt = await this.moderation.getReportWarning(identity.userId);
    return { warning: reportedAt ? { reportedAt: reportedAt.toISOString() } : null };
  }

  /** Dismisses the warning. Idempotent, so a double click is harmless. */
  @Post('report-warning/read')
  async acknowledge(
    @CurrentIdentity() identity: AuthenticatedIdentity,
  ): Promise<{ cleared: boolean }> {
    return { cleared: await this.moderation.acknowledgeReportWarning(identity.userId) };
  }
}
