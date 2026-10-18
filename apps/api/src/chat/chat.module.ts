import { Module } from '@nestjs/common';

import { ModerationModule } from '../moderation/moderation.module.js';
import { ChatController } from './chat.controller.js';
import { MatchingService } from './chat.matching.js';
import { ChatRegistryService } from './chat.registry.js';
import { ConnectionRequestService } from './chat.requests.js';
import { ChatService } from './chat.service.js';

/**
 * The chat domain.
 *
 * The three storage services (`ChatRegistryService`, `MatchingService`,
 * `ConnectionRequestService`) hold the ephemeral state; `ChatService` is the only
 * thing that mutates it, which is what keeps the invariants in one file.
 */
@Module({
  imports: [ModerationModule],
  controllers: [ChatController],
  providers: [ChatRegistryService, MatchingService, ConnectionRequestService, ChatService],
  exports: [ChatService],
})
export class ChatModule {}
