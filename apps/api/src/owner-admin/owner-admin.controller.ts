import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  adminOwnerChatParamsSchema,
  adminOwnerMessageSchema,
  adminUserQuerySchema,
  chatMediaParamsSchema,
  userLookupParamsSchema,
  type ChatMediaParams,
  type AdminOwnerChatListResponse,
  type AdminOwnerChatParams,
  type AdminOwnerChatView,
  type AdminOwnerJoinResponse,
  type AdminOwnerLeaveResponse,
  type AdminOwnerMessageInput,
  type AdminOwnerMessageSentView,
  type AdminOwnerReservationListResponse,
  type AdminUserListResponse,
  type AdminUserQuery,
} from '@anonlink/shared';

import { zodBody, zodParam, zodQuery } from '../common/zod-validation.pipe.js';
import { Anonymous } from '../identity/request-context.js';
import { AdminGuard } from '../archive/admin.guard.js';
import { OwnerAdminService } from './owner-admin.service.js';

/**
 * The owner's directory and hidden chats.
 *
 * A separate controller from `AdminController` because its dependencies run the other
 * way: this surface needs `ChatService`, while the chat module already imports the archive
 * module. A second class avoids a module cycle without weakening the guard — the whole
 * class is `@UseGuards(AdminGuard)` and `@Anonymous()`, exactly like the archive surface.
 */
@Controller('admin')
@Anonymous()
@UseGuards(AdminGuard)
export class OwnerAdminController {
  constructor(private readonly owner: OwnerAdminService) {}

  /** People matching any combination of declared attributes and search criteria. */
  @Get('users')
  async users(
    @Query(zodQuery(adminUserQuerySchema)) query: AdminUserQuery,
  ): Promise<AdminUserListResponse> {
    return this.owner.search(query);
  }

  /** Stars a person. The favorite list is the same search with `favorite=yes`. */
  @Put('users/:publicId/favorite')
  @HttpCode(200)
  async favorite(
    @Param(zodParam(userLookupParamsSchema)) params: { publicId: string },
  ): Promise<{ favorite: boolean }> {
    return this.owner.setFavorite(params.publicId, true);
  }

  @Delete('users/:publicId/favorite')
  async unfavorite(
    @Param(zodParam(userLookupParamsSchema)) params: { publicId: string },
  ): Promise<{ favorite: boolean }> {
    return this.owner.setFavorite(params.publicId, false);
  }

  /**
   * Joins a person if they are searching, or arms a reservation for their next search.
   *
   * `POST` because it creates a conversation or a reservation; it is idempotent in the
   * reserved case and never creates a second active chat for the same target.
   */
  @Post('users/:publicId/join')
  @HttpCode(200)
  async join(
    @Param(zodParam(userLookupParamsSchema)) params: { publicId: string },
  ): Promise<AdminOwnerJoinResponse> {
    return this.owner.join(params.publicId);
  }

  /** Hidden chats retained in memory, including recently ended ones. */
  @Get('chats')
  chats(): AdminOwnerChatListResponse {
    return { chats: this.owner.listChats() };
  }

  /** One hidden transcript. Polled by the admin page; text lives only in memory. */
  @Get('chats/:chatId')
  chat(
    @Param(zodParam(adminOwnerChatParamsSchema)) params: AdminOwnerChatParams,
  ): AdminOwnerChatView {
    return this.owner.readChat(params.chatId);
  }

  /**
   * An attachment the target sent to the hidden persona.
   *
   * The owner is not a chat participant, so the normal participant check cannot apply.
   * The guarded admin session plus the owner-chat index are the authorisation: only a
   * chat the owner themselves created through `join` can be read here.
   */
  @Get('chats/:chatId/media/:mediaId')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Cache-Control', 'no-store')
  media(@Param(zodParam(chatMediaParamsSchema)) params: ChatMediaParams): StreamableFile {
    const stored = this.owner.readMedia(params.chatId, params.mediaId);
    return new StreamableFile(stored.bytes, {
      type: stored.view.mimeType,
      length: stored.view.size,
    });
  }

  /** Sends as the hidden peer, through the same sanitisation as any other message. */
  @Post('chats/:chatId/messages')
  @HttpCode(200)
  message(
    @Param(zodParam(adminOwnerChatParamsSchema)) params: AdminOwnerChatParams,
    @Body(zodBody(adminOwnerMessageSchema)) body: AdminOwnerMessageInput,
  ): AdminOwnerMessageSentView {
    return this.owner.sendMessage(params.chatId, body.text);
  }

  /** Ends the hidden chat. The target sees an ordinary "peer left". */
  @Post('chats/:chatId/leave')
  @HttpCode(200)
  async leave(
    @Param(zodParam(adminOwnerChatParamsSchema)) params: AdminOwnerChatParams,
  ): Promise<AdminOwnerLeaveResponse> {
    await this.owner.leaveChat(params.chatId);
    return { ended: true };
  }

  /** Pending "first on next search" promises. */
  @Get('reservations')
  async reservations(): Promise<AdminOwnerReservationListResponse> {
    return this.owner.listReservations();
  }

  @Delete('reservations/:publicId')
  async cancelReservation(
    @Param(zodParam(userLookupParamsSchema)) params: { publicId: string },
  ): Promise<{ cancelled: boolean }> {
    return this.owner.cancelReservation(params.publicId);
  }
}
