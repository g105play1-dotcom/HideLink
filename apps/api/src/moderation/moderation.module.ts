import { Module } from '@nestjs/common';

import { ModerationService } from './moderation.service.js';

/**
 * Durable moderation state. Not global: it has exactly one consumer (the chat
 * module), and an explicit import documents that relationship.
 */
@Module({
  providers: [ModerationService],
  exports: [ModerationService],
})
export class ModerationModule {}
