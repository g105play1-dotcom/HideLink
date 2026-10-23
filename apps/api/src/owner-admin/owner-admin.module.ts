import { Module } from '@nestjs/common';

import { AdminGuard } from '../archive/admin.guard.js';
import { ChatModule } from '../chat/chat.module.js';
import { OwnerMatchModule } from '../owner-match/owner-match.module.js';
import { OwnerAdminController } from './owner-admin.controller.js';
import { OwnerAdminService } from './owner-admin.service.js';

/**
 * The owner's people directory, favorites and hidden chats.
 *
 * Imported after `ChatModule` and depends on it one way. `AdminGuard` is provided here
 * rather than exported from `ArchiveModule`: it has no state, and duplicating one
 * stateless guard object is cheaper than making the archive module a dependency of this
 * one for a class that reads only configuration.
 */
@Module({
  imports: [ChatModule, OwnerMatchModule],
  controllers: [OwnerAdminController],
  providers: [OwnerAdminService, AdminGuard],
})
export class OwnerAdminModule {}
