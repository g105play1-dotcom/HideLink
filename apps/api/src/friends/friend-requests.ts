import { Injectable } from '@nestjs/common';

/**
 * A pending in-chat friend request.
 *
 * Deliberately *not* persisted. It is a question asked during one conversation:
 * it expires after {@link FRIEND_REQUEST_TTL_MS}, and the chat ending cancels it.
 * Persisting it would create a mailbox that could be used to send unsolicited
 * messages long after the conversation is over, which is exactly what the product
 * avoids for direct invitations too.
 *
 * The record contains no User ID. The requester's public ID is only revealed if the
 * recipient accepts, at which point both sides learn each other's ID through the
 * friendship itself.
 */
export interface FriendRequest {
  readonly requestId: string;
  readonly chatId: string;
  readonly fromUserId: string;
  readonly toUserId: string;
  /** The requester's alias *in this chat*, as the recipient sees it. */
  readonly fromAlias: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface CreateFriendRequestInput {
  requestId: string;
  chatId: string;
  fromUserId: string;
  toUserId: string;
  fromAlias: string;
  ttlMs: number;
  now?: number;
}

export type CreateFriendRequestOutcome =
  | { kind: 'created'; request: FriendRequest }
  /** The same chat already has a pending request; return it instead of adding another. */
  | { kind: 'existing'; request: FriendRequest };

/**
 * In-memory register of friend requests.
 *
 * One request per chat is enough: both participants are in the same conversation, and
 * once either side declines or lets it expire no further request is accepted in that
 * chat. That closes a nagging loop without a background block list: a declined request
 * cannot be re-sent every minute for the rest of the conversation.
 *
 * All methods are synchronous. The chat service relies on that to keep its concurrent
 * state transitions atomic on Node's event loop.
 */
@Injectable()
export class FriendRequestService {
  private readonly byId = new Map<string, FriendRequest>();
  private readonly requestIdByChat = new Map<string, string>();
  /**
   * Chats in which the friend question is closed — declined, expired or accepted.
   *
   * Cleared when the chat ends, because a tombstoned chat can never be resumed and
   * keeping the id forever would be a small memory leak.
   */
  private readonly closedChats = new Set<string>();

  get(requestId: string): FriendRequest | undefined {
    return this.byId.get(requestId);
  }

  byChat(chatId: string): FriendRequest | undefined {
    const requestId = this.requestIdByChat.get(chatId);
    return requestId ? this.byId.get(requestId) : undefined;
  }

  isClosed(chatId: string): boolean {
    return this.closedChats.has(chatId);
  }

  create(input: CreateFriendRequestInput): CreateFriendRequestOutcome {
    const existing = this.byChat(input.chatId);
    if (existing) return { kind: 'existing', request: existing };

    const now = input.now ?? Date.now();
    const request: FriendRequest = {
      requestId: input.requestId,
      chatId: input.chatId,
      fromUserId: input.fromUserId,
      toUserId: input.toUserId,
      fromAlias: input.fromAlias,
      createdAt: now,
      expiresAt: now + input.ttlMs,
    };

    this.byId.set(request.requestId, request);
    this.requestIdByChat.set(request.chatId, request.requestId);
    return { kind: 'created', request };
  }

  /** Removes and returns one request, if it still exists. */
  take(requestId: string): FriendRequest | undefined {
    const request = this.byId.get(requestId);
    if (!request) return undefined;

    this.byId.delete(requestId);
    if (this.requestIdByChat.get(request.chatId) === requestId) {
      this.requestIdByChat.delete(request.chatId);
    }
    return request;
  }

  /** Removes the pending request for a chat, if any. */
  takeByChat(chatId: string): FriendRequest | undefined {
    const requestId = this.requestIdByChat.get(chatId);
    return requestId ? this.take(requestId) : undefined;
  }

  /** Removes every pending request between two identities, regardless of chat. */
  takeBetween(a: string, b: string): FriendRequest[] {
    const matches = [...this.byId.values()].filter(
      (request) =>
        (request.fromUserId === a && request.toUserId === b) ||
        (request.fromUserId === b && request.toUserId === a),
    );
    for (const request of matches) this.take(request.requestId);
    return matches;
  }

  /** Marks the friend question closed for this chat. */
  markClosed(chatId: string): void {
    this.closedChats.add(chatId);
  }

  /**
   * Forgets everything about a chat that has ended.
   *
   * The caller emits the cancellation events *before* calling this; forgetting first
   * would lose the request that the event needs.
   */
  forgetChat(chatId: string): void {
    this.takeByChat(chatId);
    this.closedChats.delete(chatId);
  }

  /** Expires overdue requests and returns them so the caller can tell both sides. */
  sweep(now: number = Date.now()): FriendRequest[] {
    const expired: FriendRequest[] = [];
    for (const request of this.byId.values()) {
      if (request.expiresAt <= now) expired.push(request);
    }

    for (const request of expired) {
      this.take(request.requestId);
      this.markClosed(request.chatId);
    }
    return expired;
  }

  /** Diagnostics only. */
  stats(): { pending: number; closedChats: number } {
    return { pending: this.byId.size, closedChats: this.closedChats.size };
  }
}
