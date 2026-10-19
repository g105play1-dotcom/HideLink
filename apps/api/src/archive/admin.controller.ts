import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  archiveListQuerySchema,
  archiveParamsSchema,
  archivePolicySchema,
  adminConfirmSchema,
  adminIdentityQuerySchema,
  ownerMessageListQuerySchema,
  ownerMessageParamsSchema,
  type AdminConfirmInput,
  type AdminIdentityListResponse,
  type AdminIdentityQuery,
  type ArchiveDeletionResponse,
  type ArchiveListQuery,
  type ArchiveListResponse,
  type ArchiveParams,
  type ArchivePolicy,
  type ArchivePolicyView,
  type ArchivedChatView,
  type OwnerMessageListQuery,
  type OwnerMessageListResponse,
  type OwnerMessageParams,
  ErrorCode,
} from '@anonlink/shared';

import { AppError } from '../common/app-error.js';
import { zodBody, zodParam, zodQuery } from '../common/zod-validation.pipe.js';
import { Anonymous } from '../identity/request-context.js';
import { OwnerMessageService } from '../owner/owner.service.js';
import { AdminGuard } from './admin.guard.js';
import { ArchiveService } from './archive.service.js';

/**
 * The owner's archive surface.
 *
 * Every route here is guarded by {@link AdminGuard} at the *class* level, so protection
 * is the default and a route added later cannot be left open by forgetting a decorator.
 * `@Anonymous()` only tells the global request guard not to demand an anonymous identity:
 * the owner is not a user, and has no User ID to present. Their key is checked instead.
 */
@Controller('admin')
@Anonymous()
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly archive: ArchiveService,
    private readonly inbox: OwnerMessageService,
  ) {}

  /** The policy in force, including who it currently covers. */
  @Get('policy')
  policy(): ArchivePolicyView {
    return this.archive.currentPolicy();
  }

  /** Replaces the policy. Validated as one object, so cross-field rules really hold. */
  @Put('policy')
  async setPolicy(
    @Body(zodBody(archivePolicySchema)) body: ArchivePolicy,
  ): Promise<ArchivePolicyView> {
    return this.archive.setPolicy(body);
  }

  /** Finds identities by User ID, or by a prefix of one, for the "selected users" list. */
  @Get('identities')
  async identities(
    @Query(zodQuery(adminIdentityQuerySchema)) query: AdminIdentityQuery,
  ): Promise<AdminIdentityListResponse> {
    return { identities: await this.archive.findIdentities(query.q ?? '') };
  }

  /** Archived conversations, newest first. */
  @Get('archives')
  async list(
    @Query(zodQuery(archiveListQuerySchema)) query: ArchiveListQuery,
  ): Promise<ArchiveListResponse> {
    return { archives: await this.archive.list(query.limit) };
  }

  /** One transcript, in order. */
  @Get('archives/:chatId')
  async read(
    @Param(zodParam(archiveParamsSchema)) params: ArchiveParams,
  ): Promise<ArchivedChatView> {
    const found = await this.archive.read(params.chatId);
    if (!found) throw new AppError(ErrorCode.CHAT_NOT_FOUND);
    return found;
  }

  /** Deletes one transcript. */
  @Delete('archives/:chatId')
  async remove(
    @Param(zodParam(archiveParamsSchema)) params: ArchiveParams,
  ): Promise<ArchiveDeletionResponse> {
    return this.archive.deleteChat(params.chatId);
  }

  /**
   * Deletes everything whose retention deadline has passed.
   *
   * Exposed so the owner is not forced to wait for the periodic sweep — and so the
   * retention query is exercised by an integration test rather than merely trusted.
   */
  @Post('archives/delete-expired')
  @HttpCode(200)
  async deleteExpired(): Promise<ArchiveDeletionResponse> {
    return this.archive.deleteExpired();
  }

  /** Deletes the whole archive. Requires `{ "confirm": true }`. */
  @Post('archives/delete-all')
  @HttpCode(200)
  async deleteAll(
    @Body(zodBody(adminConfirmSchema)) _body: AdminConfirmInput,
  ): Promise<ArchiveDeletionResponse> {
    return this.archive.deleteAll();
  }

  // ---------------------------------------------------------------------------
  // The inbox — "contact the owner"
  //
  // On this controller rather than one of its own because the *owner surface* is one
  // thing: whoever holds the key reads the archive and the messages users wrote in the
  // same place. The storage itself lives in `OwnerMessageService`.
  // ---------------------------------------------------------------------------

  /** Messages users wrote to the owner, newest first. */
  @Get('messages')
  async listMessages(
    @Query(zodQuery(ownerMessageListQuerySchema)) query: OwnerMessageListQuery,
  ): Promise<OwnerMessageListResponse> {
    return this.inbox.list(query.limit);
  }

  /** Deletes one message. Idempotent: `deleted: false` when it was already gone. */
  @Delete('messages/:id')
  async deleteMessage(
    @Param(zodParam(ownerMessageParamsSchema)) params: OwnerMessageParams,
  ): Promise<{ deleted: boolean }> {
    return this.inbox.delete(params.id);
  }
}
