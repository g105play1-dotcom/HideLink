import { Module } from '@nestjs/common';

import { ArchiveModule } from '../archive/archive.module.js';
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
 *
 * `ArchiveModule` is imported for one reason: `ChatService` asks it, synchronously and
 * at chat start, whether this conversation is in the owner's archive scope, and hands it
 * each message afterwards. The archive never calls back, so the dependency is acyclic.
 */
@Module({
  imports: [ModerationModule, ArchiveModule],
  controllers: [ChatController],
  providers: [ChatRegistryService, MatchingService, ConnectionRequestService, ChatService],
  exports: [ChatService],
})
export class ChatModule {}
