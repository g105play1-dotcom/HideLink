import { Module } from '@nestjs/common';

import { ModerationService } from './moderation.service.js';
import { ModerationController } from './moderation.controller.js';

/**
 * Durable moderation state.
 *
 * Not global: the chat module and the owner's surfaces import it explicitly, which keeps
 * the dependency direction visible (chat → moderation, never the other way round).
 */
@Module({
  controllers: [ModerationController],
  providers: [ModerationService],
  exports: [ModerationService],
})
export class ModerationModule {}
