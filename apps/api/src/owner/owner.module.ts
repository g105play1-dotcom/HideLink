import { Module } from '@nestjs/common';

import { OwnerController } from './owner.controller.js';
import { OwnerMessageService } from './owner.service.js';

/**
 * "Contact the owner": the operator's inbox.
 *
 * `OwnerMessageService` is exported because two other modules consume it, and neither
 * belongs here: `ArchiveModule` renders the inbox on the owner's admin API (the owner
 * surface is one place, not two), and `MaintenanceModule` enforces the retention deadline.
 * Nothing in this module imports a feature module, so the dependency graph stays acyclic.
 */
@Module({
  controllers: [OwnerController],
  providers: [OwnerMessageService],
  exports: [OwnerMessageService],
})
export class OwnerModule {}
