import {
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  StreamableFile,
} from '@nestjs/common';
import {
  ErrorCode,
  MEDIA_MAX_BYTES,
  chatMediaParamsSchema,
  chatMediaUploadParamsSchema,
  mediaUploadQuerySchema,
  type ChatMediaParams,
  type ChatMediaUploadParams,
  type ChatMediaView,
  type MediaUploadQuery,
} from '@anonlink/shared';
import type { Request } from 'express';

import { AppError } from '../common/app-error.js';
import { RateLimitService } from '../common/rate-limit.service.js';
import { zodParam, zodQuery } from '../common/zod-validation.pipe.js';
import { CurrentIdentity } from '../identity/request-context.js';
import type { AuthenticatedIdentity } from '../identity/identity.service.js';
import { ChatService } from './chat.service.js';

/**
 * Attachment upload and retrieval.
 *
 * Upload is a raw-body REST call, not a `chat:message` field and not multipart. Reasons:
 *  - a photo never has to fit through the socket's frame ceiling or block chat events;
 *  - the browser can show upload progress and retry the upload before creating a message;
 *  - multipart would add a parser dependency for one endpoint, while the metadata here is
 *    tiny and fits in the query string.
 *
 * Retrieval is a normal identity-guarded GET. It returns the bytes, not a URL: there is no
 * public, shareable address, and every fetch re-checks that the caller is a participant of
 * that chat.
 */
@Controller('chats')
export class ChatMediaController {
  constructor(
    private readonly chat: ChatService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Post(':chatId/media')
  @HttpCode(200)
  async upload(
    @CurrentIdentity() identity: AuthenticatedIdentity,
    @Param(zodParam(chatMediaUploadParamsSchema)) params: ChatMediaUploadParams,
    @Query(zodQuery(mediaUploadQuerySchema)) query: MediaUploadQuery,
    @Headers('content-type') contentType: string | undefined,
    @Req() request: Request,
  ): Promise<ChatMediaView> {
    // Checked before the body is read: a 16 MB audio upload must not be accepted from an
    // identity that has already sent its message budget for the window.
    this.rateLimit.enforce('chatMessage', `identity:${identity.userId}`);

    const bytes = await readRequestBody(request, MEDIA_MAX_BYTES[query.kind]);
    return this.chat.storeMedia(
      identity.userId,
      params.chatId,
      query.kind,
      contentType,
      bytes,
      query.durationMs,
    ).view;
  }

  @Get(':chatId/media/:mediaId')
  // `nosniff` is the second line of defence after the magic-byte check: even if a file
  // were mislabelled, the browser must not reinterpret it as HTML or a script.
  @Header('X-Content-Type-Options', 'nosniff')
  // Attachments are ephemeral and belong to one conversation; a shared or intermediary
  // cache retaining them would outlive the chat they were sent in.
  @Header('Cache-Control', 'no-store')
  download(
    @CurrentIdentity() identity: AuthenticatedIdentity,
    @Param(zodParam(chatMediaParamsSchema)) params: ChatMediaParams,
  ): StreamableFile {
    const stored = this.chat.readMedia(identity.userId, params.chatId, params.mediaId);
    return new StreamableFile(stored.bytes, {
      type: stored.view.mimeType,
      length: stored.view.size,
    });
  }
}

/**
 * Reads a request body with a hard ceiling.
 *
 * `Content-Length` is checked first so a known-oversized upload is refused before the API
 * allocates anything. The streaming check is the backstop for a chunked request: the body
 * is accumulated only while it fits, then the request is destroyed. The upload is bounded
 * by the same limit the store will enforce, so a valid body can never be rejected here and
 * a rejected body never reaches memory in full.
 */
async function readRequestBody(request: Request, maxBytes: number): Promise<Buffer> {
  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    request.resume();
    throw new AppError(ErrorCode.MEDIA_TOO_LARGE);
  }

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;

    if (total > maxBytes) {
      request.destroy();
      throw new AppError(ErrorCode.MEDIA_TOO_LARGE);
    }

    chunks.push(buffer);
  }

  if (total === 0) {
    throw new AppError(ErrorCode.INVALID_INPUT, 'The uploaded file is empty.');
  }

  return Buffer.concat(chunks, total);
}
