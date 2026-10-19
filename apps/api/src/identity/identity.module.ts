import { Module } from '@nestjs/common';

import { DirectoryModule } from '../directory/directory.module.js';
import { IdentityController, UsersController } from './identity.controller.js';
import { IdentityService } from './identity.service.js';
import { RequestGuard } from './request.guard.js';

/**
 * Anonymous identities, sessions, User ID lookup and own-settings.
 *
 * `RequestGuard` is exported rather than registered here, because it must run
 * globally: `AppModule` registers it as `APP_GUARD` from this module's instance, so
 * there is one guard object behind every request.
 *
 * `DirectoryModule` is imported so the settings endpoint can keep the matchmaker's
 * cached view of this identity in step with what it just wrote — see
 * `UsersController.updateSettings`.
 */
@Module({
  imports: [DirectoryModule],
  controllers: [IdentityController, UsersController],
  providers: [IdentityService, RequestGuard],
  exports: [IdentityService, RequestGuard],
})
export class IdentityModule {}
