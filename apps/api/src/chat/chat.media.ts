import { Injectable } from '@nestjs/common';
import {
  ErrorCode,
  MEDIA_MAX_BYTES,
  MEDIA_MAX_BYTES_PER_CHAT,
  MEDIA_MAX_BYTES_TOTAL,
  MEDIA_MAX_ITEMS_PER_CHAT,
  MEDIA_UNATTACHED_TTL_MS,
  mediaMaxDurationMs,
  type ChatMediaKind,
  type ChatMediaView,
} from '@anonlink/shared';

import { AppError } from '../common/app-error.js';
import { newMediaId } from '../common/ids.js';

/**
 * One attachment held in this API process.
 *
 * The bytes are never written to disk or PostgreSQL. `messageId` is set exactly once, when
 * a validated `chat:message` claims the upload; until then the entry is an orphan with a
 * short TTL.
 */
export interface StoredMedia {
  readonly chatId: string;
  readonly uploaderId: string;
  readonly bytes: Buffer;
  readonly createdAt: Date;
  readonly view: ChatMediaView;
  messageId: string | null;
}

/**
 * In-memory attachment store.
 *
 * Synchronous by contract, like the chat registry: claiming a media id and creating the
 * message around it happen in one event-loop turn, so two sockets cannot attach the same
 * upload. A database-backed store would introduce an await between those two steps and
 * make the "one upload, one message" rule a race.
 */
@Injectable()
export class ChatMediaStoreService {
  private readonly media = new Map<string, StoredMedia>();
  private readonly mediaIdsByChat = new Map<string, Set<string>>();
  private readonly bytesByChat = new Map<string, number>();
  private totalBytes = 0;

  create(params: {
    chatId: string;
    uploaderId: string;
    kind: ChatMediaKind;
    mimeType: string;
    bytes: Buffer;
    durationMs?: number;
    now?: Date;
  }): StoredMedia {
    if (params.bytes.length === 0) throw new AppError(ErrorCode.INVALID_INPUT);

    const maxBytes = MEDIA_MAX_BYTES[params.kind];
    if (params.bytes.length > maxBytes) throw new AppError(ErrorCode.MEDIA_TOO_LARGE);

    this.validateDuration(params.kind, params.durationMs);

    const ids = this.mediaIdsByChat.get(params.chatId) ?? new Set<string>();
    const chatBytes = this.bytesByChat.get(params.chatId) ?? 0;

    // Refuse rather than evict. Evicting the oldest photo would turn a message the user
    // can still scroll to into a broken image, without warning either side.
    if (
      ids.size >= MEDIA_MAX_ITEMS_PER_CHAT ||
      chatBytes + params.bytes.length > MEDIA_MAX_BYTES_PER_CHAT ||
      this.totalBytes + params.bytes.length > MEDIA_MAX_BYTES_TOTAL
    ) {
      throw new AppError(ErrorCode.MEDIA_LIMIT_REACHED);
    }

    const mediaId = newMediaId();
    const view: ChatMediaView = {
      mediaId,
      kind: params.kind,
      mimeType: params.mimeType,
      size: params.bytes.length,
      ...(params.durationMs !== undefined ? { durationMs: params.durationMs } : {}),
    };

    const stored: StoredMedia = {
      chatId: params.chatId,
      uploaderId: params.uploaderId,
      bytes: params.bytes,
      createdAt: params.now ?? new Date(),
      view,
      messageId: null,
    };

    this.media.set(mediaId, stored);
    ids.add(mediaId);
    this.mediaIdsByChat.set(params.chatId, ids);
    this.bytesByChat.set(params.chatId, chatBytes + params.bytes.length);
    this.totalBytes += params.bytes.length;

    return stored;
  }

  /**
   * Claims an upload for a message.
   *
   * Any mismatch — unknown id, another chat, another uploader, already attached — is the
   * same `MEDIA_NOT_FOUND`. The caller is a participant in *some* chat, and telling them
   * which of those four things went wrong would help enumerate other chats.
   */
  attach(params: {
    mediaId: string;
    chatId: string;
    uploaderId: string;
    messageId: string;
  }): ChatMediaView {
    const stored = this.media.get(params.mediaId);
    if (
      !stored ||
      stored.chatId !== params.chatId ||
      stored.uploaderId !== params.uploaderId ||
      stored.messageId !== null
    ) {
      throw new AppError(ErrorCode.MEDIA_NOT_FOUND);
    }

    stored.messageId = params.messageId;
    return stored.view;
  }

  get(mediaId: string): StoredMedia | undefined {
    return this.media.get(mediaId);
  }

  /** Deletes an upload that never became a message. */
  pruneUnattached(now: number = Date.now()): number {
    let removed = 0;
    for (const stored of this.media.values()) {
      if (
        stored.messageId === null &&
        now - stored.createdAt.getTime() >= MEDIA_UNATTACHED_TTL_MS
      ) {
        this.remove(stored);
        removed += 1;
      }
    }
    return removed;
  }

  /** Drops media for chats the registry no longer retains. */
  pruneTo(retainedChatIds: ReadonlySet<string>): number {
    let removed = 0;
    for (const chatId of [...this.mediaIdsByChat.keys()]) {
      if (retainedChatIds.has(chatId)) continue;
      removed += this.pruneChat(chatId);
    }
    return removed;
  }

  pruneChat(chatId: string): number {
    const ids = this.mediaIdsByChat.get(chatId);
    if (!ids) return 0;

    const count = ids.size;
    for (const mediaId of [...ids]) {
      const stored = this.media.get(mediaId);
      if (stored) this.remove(stored);
    }
    return count;
  }

  clear(): void {
    this.media.clear();
    this.mediaIdsByChat.clear();
    this.bytesByChat.clear();
    this.totalBytes = 0;
  }

  /** Diagnostics only: no ids, no bytes. */
  stats(): { mediaInMemory: number; mediaBytes: number; mediaChats: number } {
    return {
      mediaInMemory: this.media.size,
      mediaBytes: this.totalBytes,
      mediaChats: this.mediaIdsByChat.size,
    };
  }

  private validateDuration(kind: ChatMediaKind, durationMs: number | undefined): void {
    if (kind === 'image') {
      if (durationMs !== undefined) throw new AppError(ErrorCode.INVALID_INPUT);
      return;
    }

    if (kind === 'voice' && durationMs === undefined) {
      throw new AppError(ErrorCode.INVALID_INPUT);
    }
    if (durationMs === undefined) return;

    const max = mediaMaxDurationMs(kind);
    if (durationMs < 1 || (max !== null && durationMs > max)) {
      throw new AppError(ErrorCode.INVALID_INPUT);
    }
  }

  private remove(stored: StoredMedia): void {
    this.media.delete(stored.view.mediaId);
    this.totalBytes -= stored.bytes.length;

    const ids = this.mediaIdsByChat.get(stored.chatId);
    if (ids) {
      ids.delete(stored.view.mediaId);
      if (ids.size === 0) this.mediaIdsByChat.delete(stored.chatId);
    }

    const chatBytes = (this.bytesByChat.get(stored.chatId) ?? 0) - stored.bytes.length;
    if (chatBytes > 0) this.bytesByChat.set(stored.chatId, chatBytes);
    else this.bytesByChat.delete(stored.chatId);
  }
}

/**
 * Detects the container from its first bytes.
 *
 * `Content-Type` is supplied by the client, so it is only a hint. The bytes decide which
 * canonical type is stored and served, and the declared type must agree with them. This is
 * the line that keeps an HTML document with an image extension from being served as an
 * image (and `X-Content-Type-Options: nosniff` is the second).
 */
export function sniffMediaMime(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 6) {
    const header = bytes.subarray(0, 6).toString('ascii');
    if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif';
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF') {
    const format = bytes.subarray(8, 12).toString('ascii');
    if (format === 'WEBP') return 'image/webp';
    if (format === 'WAVE') return 'audio/wav';
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'OggS') {
    return 'audio/ogg';
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return 'audio/webm';
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    return 'audio/mp4';
  }
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString('ascii') === 'ID3') {
    return 'audio/mpeg';
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
    // MPEG audio frame sync and ADTS both start with eleven/ twelve set bits. ADTS has a
    // different layer field, checked first so an AAC file is not mislabelled as MP3.
    if ((bytes[1]! & 0xf6) === 0xf0) return 'audio/aac';
    return 'audio/mpeg';
  }

  return null;
}
