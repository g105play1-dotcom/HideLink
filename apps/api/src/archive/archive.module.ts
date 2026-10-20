import { Module } from '@nestjs/common';

import { ModerationModule } from '../moderation/moderation.module.js';
import { OwnerModule } from '../owner/owner.module.js';
import { AdminGuard } from './admin.guard.js';
import { AdminSessionController } from './admin-session.controller.js';
import { AdminController } from './admin.controller.js';
import { ArchiveService } from './archive.service.js';

/**
 * The owner's archive.
 *
 * Exported because the chat domain has to tell it about messages: `ChatService` decides
 * *whether* a chat is archived (synchronously, at chat start) and this module is the only
 * thing that writes the result. The dependency runs one way — chat knows about the
 * archive, the archive never knows about chat — so there is no cycle.
 *
 * `OwnerModule` is imported for the inbox: the admin controller shows the messages users
 * wrote to the owner next to the archive, because the owner's key opens one surface, not
 * two. The inbox does not know about archives, so this stays acyclic.
 */
@Module({
  imports: [OwnerModule, ModerationModule],
  controllers: [AdminSessionController, AdminController],
  providers: [ArchiveService, AdminGuard],
  exports: [ArchiveService],
})
export class ArchiveModule {}
