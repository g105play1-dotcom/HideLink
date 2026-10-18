import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { blockSchema, userLookupParamsSchema } from '@anonlink/shared';

import { zodBody, zodParam } from '../common/zod-validation.pipe.js';
import { CurrentIdentity } from '../identity/request-context.js';
import type { AuthenticatedIdentity } from '../identity/identity.service.js';
import { ModerationService, type BlockedUserView } from '../moderation/moderation.service.js';
import { ChatService } from './chat.service.js';

/**
 * Block management over REST.
 *
 * This lives in the chat module rather than in a "moderation" module because
 * blocking is not just a database row: it changes who can be matched with whom, it
 * cannot be undone by the other party, and it may terminate a chat that is running
 * right now. All of that is chat-domain behaviour.
 *
 * Blocking the peer of the *current* chat has its own socket event (`block:peer`),
 * because in a random chat the client does not know the peer's User ID.
 */
@Controller('blocks')
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly moderation: ModerationService,
  ) {}

  /** Everything this identity has blocked, newest first. */
  @Get()
  async list(@CurrentIdentity() identity: AuthenticatedIdentity): Promise<{ blocks: BlockedUserView[] }> {
    return { blocks: await this.moderation.listBlocks(identity.userId) };
  }

  /** Blocks a User ID. Idempotent, and effective in both directions. */
  @Post()
  async block(
    @CurrentIdentity() identity: AuthenticatedIdentity,
    @Body(zodBody(blockSchema)) body: { publicId: string },
  ): Promise<{ publicId: string }> {
    return this.chat.blockByPublicId(identity.userId, body.publicId);
  }

  /** Removes a block. `removed: false` when there was nothing to remove. */
  @Delete(':publicId')
  async unblock(
    @CurrentIdentity() identity: AuthenticatedIdentity,
    @Param('publicId', zodParam(userLookupParamsSchema)) params: { publicId: string },
  ): Promise<{ removed: boolean }> {
    return { removed: await this.chat.unblockByPublicId(identity.userId, params.publicId) };
  }
}
