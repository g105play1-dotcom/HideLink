import { Module } from '@nestjs/common';

import { ChatModule } from '../chat/chat.module.js';
import { MaintenanceService } from './maintenance.service.js';

@Module({
  imports: [ChatModule],
  providers: [MaintenanceService],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
