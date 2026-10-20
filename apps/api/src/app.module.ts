import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { ArchiveModule } from './archive/archive.module.js';
import { ChatModule } from './chat/chat.module.js';
import { CommonModule } from './common/common.module.js';
import { HttpErrorFilter } from './common/http-error.filter.js';
import { SecurityHeadersInterceptor } from './common/http-hardening.js';
import { ConfigModule } from './config/config.module.js';
import { DirectoryModule } from './directory/directory.module.js';
import { EventsModule } from './events/events.module.js';
import { HealthModule } from './health/health.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { RequestGuard } from './identity/request.guard.js';
import { MaintenanceModule } from './maintenance/maintenance.module.js';
import { ModerationModule } from './moderation/moderation.module.js';
import { OwnerModule } from './owner/owner.module.js';
import { PlatformModule } from './platform/platform.module.js';
import { PresenceModule } from './presence/presence.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';

/**
 * The application root.
 *
 * The three global providers wired here are the cross-cutting boundaries:
 *  - **`APP_GUARD` = RequestGuard** — origin policy, identity resolution, rate
 *    limiting and authentication for *every* HTTP route. A route is protected by
 *    default; opting out requires an explicit `@Anonymous()`.
 *  - **`APP_FILTER` = HttpErrorFilter** — the only place an HTTP error body is
 *    shaped, which is what guarantees no internal detail can escape.
 *  - **`APP_INTERCEPTOR` = SecurityHeadersInterceptor** — security headers on every
 *    response, including the ones Nest generates itself.
 */
@Module({
  imports: [
    // Infrastructure (all global).
    ConfigModule,
    PrismaModule,
    CommonModule,
    DirectoryModule,
    EventsModule,
    PresenceModule,
    PlatformModule,

    // Features.
    IdentityModule,
    ModerationModule,
    ArchiveModule,
    OwnerModule,
    ChatModule,
    RealtimeModule,
    HealthModule,
    MaintenanceModule,
  ],
  providers: [
    { provide: APP_GUARD, useExisting: RequestGuard },
    { provide: APP_FILTER, useClass: HttpErrorFilter },
    { provide: APP_INTERCEPTOR, useClass: SecurityHeadersInterceptor },
  ],
})
export class AppModule {}
