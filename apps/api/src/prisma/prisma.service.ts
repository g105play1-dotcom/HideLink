import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { AppError } from '../common/app-error.js';
import { log } from '../common/logger.js';
import { ErrorCode } from '@anonlink/shared';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Database access.
 *
 * Notes specific to Prisma ORM 7:
 *  - the client is Rust-free and connects through a driver adapter, so the
 *    connection pool is the `pg` pool (`max`, `connectionTimeoutMillis` are
 *    explicit to reproduce Prisma 6's previous 5 s connect timeout);
 *  - query logging is deliberately disabled. Prisma can include statement
 *    parameters in its logs, and parameters can contain a reported message
 *    snapshot. Any logging of database activity is done through SafeLogger, whose
 *    metadata is restricted to scalars and whose sensitive keys are redacted.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({
      adapter: new PrismaPg({
        connectionString: config.DATABASE_URL,
        max: 10,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
      }),
      log: [],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    log.info('db.connected', { target: describeDatabaseTarget(process.env['DATABASE_URL']) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect().catch(() => {});
  }

  /**
   * Cheap liveness probe used by `/health/ready`.
   *
   * Translated into a {@link AppError} so an unreachable database surfaces as a
   * clean `503 DATABASE_UNAVAILABLE` rather than a 500 with a driver stack.
   */
  async ping(): Promise<void> {
    try {
      await this.$queryRaw`SELECT 1`;
    } catch (error) {
      throw new AppError(ErrorCode.DATABASE_UNAVAILABLE, undefined, { cause: error });
    }
  }
}

/**
 * Renders `host:port/database` for logs.
 *
 * Credentials are stripped on purpose: the connection string is a secret and must
 * never reach a log sink or an error report.
 */
export function describeDatabaseTarget(connectionString: string | undefined): string {
  if (!connectionString) return 'unconfigured';
  try {
    const url = new URL(connectionString);
    const database = url.pathname.replace(/^\//, '') || '(none)';
    return `${url.hostname}:${url.port || '5432'}/${database}`;
  } catch {
    return 'unparseable';
  }
}
