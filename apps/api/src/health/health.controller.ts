import { Controller, Get, HttpCode, Inject } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { RateLimitService } from '../common/rate-limit.service.js';
import { Anonymous } from '../identity/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ChatService } from '../chat/chat.service.js';

export interface HealthPayload {
  status: 'ok';
  uptimeSeconds: number;
}

export interface ReadinessPayload extends HealthPayload {
  database: 'ok';
  /**
   * AnonLink's matchmaking queue lives in one process, so a deployment runs exactly
   * one API instance. Reported here so the constraint is visible to whoever
   * operates the service instead of being discovered during an outage.
   */
  singleInstance: true;
  stats: Record<string, unknown>;
}

/**
 * Liveness and readiness.
 *
 * Deliberately anonymous: a health endpoint behind authentication cannot be used
 * by a load balancer or an uptime monitor. It exposes no configuration, no
 * identifiers and no per-user counts — only aggregate numbers, which is why it is
 * safe to leave open.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
    private readonly chat: ChatService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Liveness: the process is up. Never touches the database. */
  @Get()
  @Anonymous()
  liveness(): HealthPayload {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  /**
   * Readiness: the process can serve traffic.
   *
   * Answers `503` when the database is unreachable: a chat service that cannot
   * record a chat must not accept new ones.
   */
  @Get('ready')
  @Anonymous()
  @HttpCode(200)
  async readiness(): Promise<ReadinessPayload> {
    await this.prisma.ping();

    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      database: 'ok',
      singleInstance: true,
      stats: {
        environment: this.config.NODE_ENV,
        rateLimitKeys: this.rateLimit.stats(),
        chat: this.chat.stats(),
      },
    };
  }
}
