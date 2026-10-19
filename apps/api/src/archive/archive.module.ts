import { Module } from '@nestjs/common';

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
 */
@Module({
  controllers: [AdminSessionController, AdminController],
  providers: [ArchiveService, AdminGuard],
  exports: [ArchiveService],
})
export class ArchiveModule {}
