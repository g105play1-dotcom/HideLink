import { Module } from '@nestjs/common';

import { ArchiveModule } from '../archive/archive.module.js';
import { ChatModule } from '../chat/chat.module.js';
import { OwnerModule } from '../owner/owner.module.js';
import { MaintenanceService } from './maintenance.service.js';

@Module({
  imports: [ChatModule, ArchiveModule, OwnerModule],
  providers: [MaintenanceService],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
