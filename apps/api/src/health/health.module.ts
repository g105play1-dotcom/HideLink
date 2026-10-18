import { Module } from '@nestjs/common';

import { ChatModule } from '../chat/chat.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [ChatModule],
  controllers: [HealthController],
})
export class HealthModule {}
