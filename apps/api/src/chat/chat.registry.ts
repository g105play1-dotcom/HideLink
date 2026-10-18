import { Injectable } from '@nestjs/common';
import type { ChatEndReason, ChatKind } from '@anonlink/shared';
import { CHAT_MEMORY_MESSAGE_LIMIT, CHAT_TOMBSTONE_TTL_MS } from '@anonlink/shared';

import { peerAlias } from '../common/ids.js';
import { log } from '../common/logger.js';

/**
 * A message as it exists in server memory. Never written to the database except
 * as a report snapshot. See docs/SECURITY.md.
 */
export interface StoredMessage {
  readonly messageId: string;
  readonly senderId: string;
  readonly text: string;
  readonly sentAt: Date;
  /** Present when the sender supplied an idempotency key. */
  readonly clientMessageId?: string;
}

export interface CreateChatParams {
  chatId: string;
  kind: ChatKind;
  participantAId: string;
  participantBId: string;
  initiatorId: string;
  startedAt: Date;
  /**
   * Public User IDs of the participants.
   *
   * Only honoured for `direct` chats. For random chats the map is intentionally
   * left empty, so a future change cannot accidentally start disclosing the peer's
   * User ID in an anonymous conversation — the data simply is not there to leak.
   */
  publicIdByUser?: ReadonlyMap<string, string>;
}

/**
 * In-memory state of one chat.
 *
 * Holds the whole conversation, because AnonLink deliberately does not persist
 * transcripts. The window of retained messages is bounded
 * ({@link CHAT_MEMORY_MESSAGE_LIMIT}) so a very long chat cannot grow without
 * limit; `messageCount` keeps counting past the window and is the number written
 * to the database for flood detection.
 */
export class ChatRecord {
  readonly chatId: string;
  readonly kind: ChatKind;
  readonly participantAId: string;
  readonly participantBId: string;
  readonly initiatorId: string;
  readonly startedAt: Date;

  status: 'active' | 'ended' = 'active';
  endedAt: Date | null = null;
  endReason: ChatEndReason | null = null;
  /** Who triggered the end, when it was a participant rather than the server. */
  endedByUserId: string | null = null;

  /** Total messages exchanged, including any dropped from the window. */
  messageCount = 0;

  readonly messages: StoredMessage[] = [];
  private readonly clientMessageIndex = new Map<string, StoredMessage>();
  private readonly aliasByUser = new Map<string, string>();
  private readonly publicIdByUser = new Map<string, string>();

  constructor(params: CreateChatParams) {
    this.chatId = params.chatId;
    this.kind = params.kind;
    this.participantAId = params.participantAId;
    this.participantBId = params.participantBId;
    this.initiatorId = params.initiatorId;
    this.startedAt = params.startedAt;

    // Each participant gets an independent random alias for the other, so the
    // same person is unlinkable across two different chats.
    this.aliasByUser.set(params.participantAId, peerAlias());
    this.aliasByUser.set(params.participantBId, peerAlias());

    // Public IDs exist only where the chat is explicitly non-anonymous.
    if (params.kind === 'direct' && params.publicIdByUser) {
      for (const [userId, publicId] of params.publicIdByUser) {
        this.publicIdByUser.set(userId, publicId);
      }
    }
  }

  get participantIds(): readonly [string, string] {
    return [this.participantAId, this.participantBId];
  }

  get isActive(): boolean {
    return this.status === 'active';
  }

  hasParticipant(userId: string): boolean {
    return userId === this.participantAId || userId === this.participantBId;
  }

  peerOf(userId: string): string {
    return userId === this.participantAId ? this.participantBId : this.participantAId;
  }

  /** The alias *this viewer* should see for their peer. */
  aliasFor(peerId: string): string {
    return this.aliasByUser.get(peerId) ?? 'Stranger';
  }

  /**
   * The peer's public User ID, or `undefined` when it must not be disclosed.
   *
   * The single choke point for this decision: random chats never have the value,
   * so no call site can leak it by forgetting a check.
   */
  revealPublicId(userId: string): string | undefined {
    if (this.kind !== 'direct') return undefined;
    return this.publicIdByUser.get(userId);
  }

  findMessage(messageId: string): StoredMessage | undefined {
    return this.messages.find((message) => message.messageId === messageId);
  }

  /**
   * Appends a message, or returns the previously stored one when the same
   * `clientMessageId` is replayed.
   *
   * Retrying is normal (a client may resend after a reconnect), so the operation
   * is idempotent per sender instead of creating a duplicate bubble.
   */
  append(
    message: Omit<StoredMessage, 'readonly'>,
  ): { message: StoredMessage; duplicate: boolean } {
    if (message.clientMessageId) {
      const existing = this.clientMessageIndex.get(message.clientMessageId);
      if (existing && existing.senderId === message.senderId) {
        return { message: existing, duplicate: true };
      }
    }

    this.messages.push(message);
    this.messageCount += 1;

    if (message.clientMessageId) {
      this.clientMessageIndex.set(message.clientMessageId, message);
    }

    while (this.messages.length > CHAT_MEMORY_MESSAGE_LIMIT) {
      const dropped = this.messages.shift();
      if (dropped?.clientMessageId) this.clientMessageIndex.delete(dropped.clientMessageId);
    }

    return { message, duplicate: false };
  }
}

/**
 * Registry of live chats.
 *
 * ## Why this is not in the database
 *
 * AnonLink promises that a conversation is not retained. Keeping the transcript
 * only in the process that serves it is the simplest way to make that promise
 * structurally true: there is no retained copy to leak, subpoena or misconfigure.
 * The database stores one lifecycle row per chat (participants, start/end times,
 * end reason, message count) and nothing else.
 *
 * ## Concurrency
 *
 * Every method here is synchronous. Node's single-threaded event loop therefore
 * makes each of them atomic with respect to other socket events, which is what
 * lets the matchmaker guarantee "never two chats per identity" without a lock.
 * Introducing an `await` into any of these methods would silently break that.
 */
@Injectable()
export class ChatRegistryService {
  private readonly chats = new Map<string, ChatRecord>();
  private readonly chatIdByUser = new Map<string, string>();
  private readonly endedAt = new Map<string, number>();

  /**
   * Creates a chat, refusing to attach an identity that is already in one.
   *
   * The refusal is a genuine invariant check, not an expected outcome: callers
   * verify availability first, and this guards against a race between that check
   * and this call.
   */
  create(params: CreateChatParams): ChatRecord {
    if (this.chatIdByUser.has(params.participantAId)) {
      throw new Error('participant A is already in a chat');
    }
    if (this.chatIdByUser.has(params.participantBId)) {
      throw new Error('participant B is already in a chat');
    }

    const chat = new ChatRecord(params);
    this.chats.set(chat.chatId, chat);
    this.chatIdByUser.set(params.participantAId, chat.chatId);
    this.chatIdByUser.set(params.participantBId, chat.chatId);

    log.info('chat.created', { chatId: chat.chatId, kind: chat.kind });
    return chat;
  }

  /** The chat this identity is currently *active* in, if any. */
  activeFor(userId: string): ChatRecord | undefined {
    const chatId = this.chatIdByUser.get(userId);
    if (!chatId) return undefined;
    return this.chats.get(chatId);
  }

  /** Any chat record this identity is part of, including recently ended ones. */
  byUser(userId: string): ChatRecord | undefined {
    const chatId = this.chatIdByUser.get(userId);
    if (chatId) return this.chats.get(chatId);

    // A user who just left still has a tombstoned chat for a short while; it is
    // only reachable by chat id, so scanning is bounded by the tombstone window.
    for (const chat of this.chats.values()) {
      if (chat.hasParticipant(userId)) return chat;
    }
    return undefined;
  }

  get(chatId: string): ChatRecord | undefined {
    return this.chats.get(chatId);
  }

  /** Every chat that is currently running. Used by graceful shutdown. */
  activeChats(): ChatRecord[] {
    return [...this.chats.values()].filter((chat) => chat.isActive);
  }

  /** Marks a chat as finished and frees both participants immediately. */
  end(chat: ChatRecord, reason: ChatEndReason, at: Date, endedByUserId?: string): void {
    if (chat.status === 'ended') return;

    chat.status = 'ended';
    chat.endedAt = at;
    chat.endReason = reason;
    chat.endedByUserId = endedByUserId ?? null;

    for (const userId of chat.participantIds) {
      if (this.chatIdByUser.get(userId) === chat.chatId) this.chatIdByUser.delete(userId);
    }
    this.endedAt.set(chat.chatId, at.getTime());

    log.info('chat.ended', {
      chatId: chat.chatId,
      reason,
      messages: chat.messageCount,
    });
  }

  /**
   * Removes a chat record entirely.
   *
   * Used to roll back when persisting the chat row failed: the in-memory state
   * must not survive an operation that the database rejected.
   */
  abort(chatId: string): void {
    const chat = this.chats.get(chatId);
    if (!chat) return;

    for (const userId of chat.participantIds) {
      if (this.chatIdByUser.get(userId) === chatId) this.chatIdByUser.delete(userId);
    }
    this.chats.delete(chatId);
    this.endedAt.delete(chatId);
    log.warn('chat.aborted', { chatId });
  }

  /** Drops ended chats once their tombstone has expired. */
  sweep(now: number = Date.now()): number {
    let removed = 0;
    for (const [chatId, endedAt] of this.endedAt) {
      if (now - endedAt < CHAT_TOMBSTONE_TTL_MS) continue;
      this.chats.delete(chatId);
      this.endedAt.delete(chatId);
      removed += 1;
    }
    return removed;
  }

  /** Diagnostics; contains no message content and no identifiers of users. */
  stats(): { activeChats: number; retainedChats: number; messagesInMemory: number } {
    let activeChats = 0;
    let messagesInMemory = 0;
    for (const chat of this.chats.values()) {
      if (chat.isActive) activeChats += 1;
      messagesInMemory += chat.messages.length;
    }
    return { activeChats, retainedChats: this.chats.size, messagesInMemory };
  }
}
