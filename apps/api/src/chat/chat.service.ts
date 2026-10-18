import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import {
  CONNECT_REQUEST_TTL_MS,
  ErrorCode,
  type ChatMessageInput,
  type ReportReason,
} from '@anonlink/shared';
import type { SendRequestResult } from '@anonlink/protocol';

import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { AppError } from '../common/app-error.js';
import { newChatId, newMessageId, newRequestId } from '../common/ids.js';
import { log } from '../common/logger.js';
import { sanitizeMessageText } from '../common/sanitize.js';
import { DirectoryService } from '../directory/directory.service.js';
import { ModerationService } from '../moderation/moderation.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PresenceService } from '../presence/presence.service.js';
import { AppEventBus, type ChatEndReasonSource } from '../events/app-events.js';
import { ChatRegistryService, type ChatRecord, type StoredMessage } from './chat.registry.js';
import { MatchingService } from './chat.matching.js';
import { ConnectionRequestService } from './chat.requests.js';

export interface ChatState {
  queued: boolean;
  queuedSince?: Date;
  activeChat?: ChatRecord;
  /** Number of direct invitations waiting for this identity's answer. */
  pendingRequests: number;
}

export interface JoinRandomResult {
  kind: 'waiting' | 'matched';
  since: Date;
  chat?: ChatRecord;
}

/**
 * The chat domain facade.
 *
 * Everything that changes chat state goes through here, so the invariants live in
 * one place:
 *
 *  - an identity is in at most one active chat;
 *  - an identity is either in a chat or in the matchmaking queue, and joining one
 *    removes it from the other;
 *  - a chat only ever contains two identities, and every inbound event is checked
 *    against the participant list of the chat it names;
 *  - message text is normalised by the server, never by the client.
 *
 * ## Synchronous critical sections
 *
 * The matchmaking step is composed of synchronous calls only. That is what makes
 * "no identity is ever matched twice" true without a lock or a database
 * transaction: no other socket event can interleave between "pick a peer" and
 * "register the chat". Persistence happens *after* the in-memory decision and is
 * rolled back on failure, so a slow database can never stall matchmaking.
 */
@Injectable()
export class ChatService implements OnApplicationShutdown {
  /** `${chatId}:${userId}` -> timer waiting for a disconnected participant to return. */
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();
  /** In-flight fire-and-forget writes, awaitable by tests and shutdown. */
  private readonly pendingWrites = new Set<Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChatRegistryService,
    private readonly matching: MatchingService,
    private readonly requests: ConnectionRequestService,
    private readonly directory: DirectoryService,
    private readonly presence: PresenceService,
    private readonly moderation: ModerationService,
    private readonly bus: AppEventBus,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------------------
  // Random matchmaking
  // ---------------------------------------------------------------------------

  /**
   * The user pressed "start random chat".
   *
   * Either immediately pairs them with the longest-waiting eligible peer, or puts
   * them in the queue. Idempotent: pressing twice while waiting keeps the original
   * position instead of creating a second ticket.
   */
  async joinRandom(userId: string): Promise<JoinRandomResult> {
    await this.directory.ensureLoaded(userId);
    const facts = this.requireFacts(userId);

    if (facts.banned) throw new AppError(ErrorCode.IDENTITY_BANNED);
    if (this.registry.activeFor(userId)) throw new AppError(ErrorCode.ALREADY_IN_CHAT);

    // ---- critical section: no awaits below this line ----
    const outcome = this.matching.claimOrEnqueue(userId, (candidateId) => {
      if (this.registry.activeFor(candidateId)) return false;
      if (this.directory.isBanned(candidateId)) return false;
      return !this.directory.isBlockedBetween(userId, candidateId);
    });
    // ---- end of critical section ----

    if (outcome.kind === 'waiting') {
      this.bus.emit({ type: 'match.queued', userId, since: outcome.since });
      return { kind: 'waiting', since: outcome.since };
    }

    const chat = await this.createAndPersistChat({
      kind: 'random',
      participantAId: userId,
      participantBId: outcome.peerId,
      initiatorId: userId,
    });

    return { kind: 'matched', since: new Date(), chat };
  }

  /** The user cancelled the search. */
  cancelMatching(userId: string): boolean {
    const cancelled = this.matching.cancel(userId);
    if (cancelled) this.bus.emit({ type: 'match.cancelled', userId, reason: 'user' });
    return cancelled;
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  /**
   * Stores and fans out one message.
   *
   * All authorisation happens here rather than in the gateway, because the gateway
   * must never be the only thing standing between a socket and someone else's chat.
   */
  sendMessage(userId: string, input: ChatMessageInput): { messageId: string; sentAt: Date } {
    const chat = this.registry.get(input.chatId);
    if (!chat) throw new AppError(ErrorCode.CHAT_NOT_FOUND);
    if (!chat.hasParticipant(userId)) throw new AppError(ErrorCode.NOT_A_PARTICIPANT);
    if (!chat.isActive) throw new AppError(ErrorCode.CHAT_ENDED);

    const sanitized = sanitizeMessageText(input.text, this.config.MESSAGE_MAX_LENGTH);
    if (sanitized.empty) throw new AppError(ErrorCode.MESSAGE_EMPTY);

    const candidate: StoredMessage = {
      messageId: newMessageId(),
      senderId: userId,
      text: sanitized.text,
      sentAt: new Date(),
      ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
    };

    const { message, duplicate } = chat.append(candidate);

    // A replayed message is acknowledged but not broadcast again, so a retry after
    // a flaky connection cannot produce a duplicate bubble on the peer's screen.
    if (!duplicate) this.bus.emit({ type: 'chat.message', chat, message });

    return { messageId: message.messageId, sentAt: message.sentAt };
  }

  // ---------------------------------------------------------------------------
  // Leaving and continuing
  // ---------------------------------------------------------------------------

  /** Ends the current chat; optionally immediately searches for a new peer. */
  async leaveChat(userId: string, chatId: string, findNext = false): Promise<{ queued: boolean }> {
    const chat = this.registry.get(chatId);
    if (!chat) throw new AppError(ErrorCode.CHAT_NOT_FOUND);
    if (!chat.hasParticipant(userId)) throw new AppError(ErrorCode.NOT_A_PARTICIPANT);

    this.cancelGraceTimersFor(chat.chatId, userId);
    this.endChat(chat, 'left', userId);

    if (!findNext) return { queued: false };

    const result = await this.joinRandom(userId);
    return { queued: result.kind === 'waiting' };
  }

  // ---------------------------------------------------------------------------
  // Direct requests ("chat with this User ID")
  // ---------------------------------------------------------------------------

  /**
   * Asks a specific User ID for a chat.
   *
   * Every failure mode is answered explicitly instead of silently, because the
   * requester typed an ID and deserves to know why nothing happened: the ID does
   * not exist, the person is offline, they turned invitations off, or contact is
   * not possible. The last case is deliberately vague — a blocked user must not be
   * able to distinguish "they blocked me" from "they are busy", or blocking would
   * become a way to send a message.
   */
  async requestDirect(userId: string, publicId: string, note?: string): Promise<SendRequestResult> {
    await this.directory.ensureLoaded(userId);
    const facts = this.requireFacts(userId);

    if (facts.banned) throw new AppError(ErrorCode.IDENTITY_BANNED);
    if (publicId === facts.publicId) {
      await this.moderation.recordSecurityEvent('contact_self', userId);
      throw new AppError(ErrorCode.SELF_TARGET_NOT_ALLOWED);
    }
    if (this.registry.activeFor(userId)) throw new AppError(ErrorCode.ALREADY_IN_CHAT);

    const target = await this.moderation.findByPublicId(publicId);
    if (!target) throw new AppError(ErrorCode.USER_NOT_FOUND);
    if (target.id === userId) throw new AppError(ErrorCode.SELF_TARGET_NOT_ALLOWED);

    if (await this.moderation.isBlockedBetween(userId, target.id)) {
      await this.moderation.recordSecurityEvent('contact_blocked', userId, target.id);
      throw new AppError(ErrorCode.BLOCKED);
    }

    if (target.banned || !this.presence.isOnline(target.id)) {
      await this.moderation.recordSecurityEvent('contact_offline', userId, target.id);
      throw new AppError(ErrorCode.USER_UNAVAILABLE);
    }

    if (target.incomingRequests === 'nobody') {
      await this.moderation.recordSecurityEvent('contact_disabled', userId, target.id);
      throw new AppError(ErrorCode.INCOMING_REQUESTS_DISABLED);
    }

    const outcome = this.requests.create({
      requestId: newRequestId(),
      fromUserId: userId,
      fromPublicId: facts.publicId,
      toUserId: target.id,
      toPublicId: target.publicId,
      ...(note ? { note } : {}),
      ttlMs: CONNECT_REQUEST_TTL_MS,
      maxPending: this.config.MAX_PENDING_REQUESTS_PER_USER,
    });

    if (outcome.kind === 'target_busy') throw new AppError(ErrorCode.USER_UNAVAILABLE);

    if (outcome.kind === 'created') {
      this.bus.emit({ type: 'request.incoming', request: outcome.request });
    }

    return {
      requestId: outcome.request.requestId,
      expiresAt: new Date(outcome.request.expiresAt).toISOString(),
    };
  }

  /** The target accepts or declines an invitation. */
  async respondToRequest(
    userId: string,
    requestId: string,
    accept: boolean,
  ): Promise<{ accepted: boolean }> {
    const request = this.requests.get(requestId);

    // Only the addressee may answer, and a wrong addressee learns nothing.
    if (!request || request.toUserId !== userId) throw new AppError(ErrorCode.REQUEST_NOT_FOUND);

    if (request.expiresAt <= Date.now()) {
      this.requests.take(requestId);
      this.bus.emit({
        type: 'request.resolved',
        userId: request.fromUserId,
        requestId,
        status: 'expired',
      });
      throw new AppError(ErrorCode.REQUEST_EXPIRED);
    }

    this.requests.take(requestId);

    if (!accept) {
      this.bus.emit({ type: 'request.resolved', userId, requestId, status: 'declined' });
      this.bus.emit({
        type: 'request.resolved',
        userId: request.fromUserId,
        requestId,
        status: 'declined',
      });
      return { accepted: false };
    }

    // Re-validate everything: the request may have been sitting for up to a minute
    // while either side changed state.
    await this.directory.ensureLoaded(request.fromUserId);
    const requester = this.directory.get(request.fromUserId);

    const blocked = this.directory.isBlockedBetween(userId, request.fromUserId);
    const unavailable =
      !requester ||
      requester.banned ||
      !this.presence.isOnline(request.fromUserId) ||
      this.registry.activeFor(userId) !== undefined ||
      this.registry.activeFor(request.fromUserId) !== undefined;

    if (blocked || unavailable) {
      const status = blocked ? 'blocked' : 'unavailable';
      this.bus.emit({ type: 'request.resolved', userId, requestId, status });
      this.bus.emit({ type: 'request.resolved', userId: request.fromUserId, requestId, status });
      return { accepted: false };
    }

    const publicIdByUser = new Map<string, string>([
      [userId, request.toPublicId],
      [request.fromUserId, request.fromPublicId],
    ]);

    const chat = await this.createAndPersistChat({
      kind: 'direct',
      participantAId: userId,
      participantBId: request.fromUserId,
      initiatorId: request.fromUserId,
      publicIdByUser,
    });

    this.bus.emit({ type: 'request.resolved', userId, requestId, status: 'accepted', chat });
    this.bus.emit({
      type: 'request.resolved',
      userId: request.fromUserId,
      requestId,
      status: 'accepted',
      chat,
    });

    return { accepted: true };
  }

  /** Cancels every invitation this identity has sent, telling the addressees. */
  cancelOutgoingRequests(userId: string): void {
    for (const request of this.requests.takeBySender(userId)) {
      this.bus.emit({
        type: 'request.resolved',
        userId: request.toUserId,
        requestId: request.requestId,
        status: 'cancelled',
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Blocking and reporting
  // ---------------------------------------------------------------------------

  /** Blocks the peer of the chat the caller is in, ending the chat as a side effect. */
  async blockPeerOfChat(blockerId: string, chatId: string): Promise<{ publicId: string }> {
    const chat = this.registry.get(chatId);
    if (!chat) throw new AppError(ErrorCode.CHAT_NOT_FOUND);
    if (!chat.hasParticipant(blockerId)) throw new AppError(ErrorCode.NOT_A_PARTICIPANT);

    const peerId = chat.peerOf(blockerId);
    // The peer is always in the directory while a chat is running (they had a
    // socket), so the fallback is only a safety net for a mid-flight teardown.
    const peerPublicId = this.directory.get(peerId)?.publicId ?? (await this.resolvePublicId(peerId));

    await this.moderation.block(blockerId, peerId);
    await this.moderation.recordSecurityEvent('chat_blocked', blockerId, peerId);

    // A block must also clear any pending invitation between the two, so a stale
    // request cannot open a new chat with someone the user just blocked.
    for (const request of this.requests.takeBetween(blockerId, peerId)) {
      this.bus.emit({
        type: 'request.resolved',
        userId: request.fromUserId === blockerId ? request.toUserId : request.fromUserId,
        requestId: request.requestId,
        status: 'blocked',
      });
    }

    this.endChat(chat, 'blocked', blockerId);
    return { publicId: peerPublicId };
  }

  /** Blocks a User ID outside of a chat (e.g. after a declined invitation). */
  async blockByPublicId(blockerId: string, publicId: string): Promise<{ publicId: string }> {
    await this.directory.ensureLoaded(blockerId);
    const facts = this.requireFacts(blockerId);

    if (publicId === facts.publicId) throw new AppError(ErrorCode.SELF_TARGET_NOT_ALLOWED);

    const target = await this.moderation.findByPublicId(publicId);
    if (!target) throw new AppError(ErrorCode.USER_NOT_FOUND);

    await this.moderation.block(blockerId, target.id);

    for (const request of this.requests.takeBetween(blockerId, target.id)) {
      this.bus.emit({
        type: 'request.resolved',
        userId: request.fromUserId === blockerId ? request.toUserId : request.fromUserId,
        requestId: request.requestId,
        status: 'blocked',
      });
    }

    // If they happen to be chatting right now, that chat is over.
    const chat = this.registry.activeFor(blockerId);
    if (chat && chat.peerOf(blockerId) === target.id) {
      this.endChat(chat, 'blocked', blockerId);
    }

    return { publicId: target.publicId };
  }

  async unblockByPublicId(blockerId: string, publicId: string): Promise<boolean> {
    const target = await this.moderation.findByPublicId(publicId);
    if (!target) throw new AppError(ErrorCode.USER_NOT_FOUND);
    return this.moderation.unblock(blockerId, target.id);
  }

  /**
   * Reports the current chat, or one message in it, and ends the chat.
   *
   * The message snapshot is taken from the server's own copy of the message —
   * never from client input — so a report cannot be used to inject arbitrary text
   * into the moderation record.
   */
  async reportChat(
    reporterId: string,
    chatId: string,
    reason: ReportReason,
    messageId?: string,
    details?: string,
  ): Promise<string> {
    const chat = this.registry.get(chatId);
    if (!chat) throw new AppError(ErrorCode.CHAT_NOT_FOUND);
    if (!chat.hasParticipant(reporterId)) throw new AppError(ErrorCode.NOT_A_PARTICIPANT);

    const targetId = chat.peerOf(reporterId);
    const snapshot = messageId ? chat.findMessage(messageId)?.text : undefined;

    const reportId = await this.moderation.createReport({
      reporterId,
      targetId,
      chatId: chat.chatId,
      ...(messageId ? { messageId } : {}),
      ...(snapshot ? { messageSnapshot: snapshot } : {}),
      reason,
      ...(details ? { details } : {}),
    });

    this.endChat(chat, 'reported', reporterId);
    return reportId;
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle (called by the gateway)
  // ---------------------------------------------------------------------------

  /** The identity opened its first socket. */
  async handleConnected(userId: string): Promise<void> {
    await this.directory.refresh(userId);

    const chat = this.registry.activeFor(userId);
    if (!chat) return;

    // They came back inside the grace window: cancel the pending teardown and tell
    // both sides, so the peer stops seeing "reconnecting…".
    this.cancelGraceTimersFor(chat.chatId, userId);
    this.bus.emit({ type: 'chat.presence', chat, userId, present: true });
    this.bus.emit({ type: 'chat.resumed', chat, userId });
  }

  /**
   * The identity closed its last socket.
   *
   * The chat is *not* ended immediately: a page reload, a tunnel or a phone
   * switching networks all look like a disconnect. Instead the peer is told the
   * other side is away, and the chat is torn down only if the grace period expires.
   */
  handleDisconnected(userId: string): void {
    this.matching.cancel(userId);
    this.cancelOutgoingRequests(userId);

    const chat = this.registry.activeFor(userId);
    if (!chat) return;

    this.startGrace(chat, userId);
  }

  /** Current state of an identity, used to answer `session:ready` after a reconnect. */
  stateFor(userId: string): ChatState {
    return {
      queued: this.matching.isQueued(userId),
      ...(this.matching.queuedSince(userId) ? { queuedSince: this.matching.queuedSince(userId) } : {}),
      ...(this.registry.activeFor(userId) ? { activeChat: this.registry.activeFor(userId) } : {}),
      pendingRequests: this.requests.pendingCountFor(userId),
    };
  }

  // ---------------------------------------------------------------------------
  // Maintenance
  // ---------------------------------------------------------------------------

  /** Drops everything that has expired. Returns counters for logging. */
  sweep(now: number = Date.now()): {
    expiredTickets: number;
    expiredRequests: number;
    prunedChats: number;
  } {
    const expiredTickets = this.matching.sweep(now);
    for (const userId of expiredTickets) {
      this.bus.emit({ type: 'match.cancelled', userId, reason: 'timeout' });
    }

    const expiredRequests = this.requests.sweep(now);
    for (const request of expiredRequests) {
      this.bus.emit({
        type: 'request.resolved',
        userId: request.fromUserId,
        requestId: request.requestId,
        status: 'expired',
      });
    }

    return {
      expiredTickets: expiredTickets.length,
      expiredRequests: expiredRequests.length,
      prunedChats: this.registry.sweep(now),
    };
  }

  /**
   * Ends every live chat on the way out.
   *
   * Without this a restart would leave rows marked `active` in the database
   * forever, and the peers of those chats would never be told the conversation is
   * over. Writes are flushed before returning so the shutdown is not a lie.
   */
  async onApplicationShutdown(): Promise<void> {
    for (const chat of this.registry.activeChats()) {
      this.endChat(chat, 'server_shutdown');
    }

    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();

    await this.flushWrites();
  }

  /** Awaits fire-and-forget writes. Used by tests and graceful shutdown. */
  async flushWrites(): Promise<void> {
    while (this.pendingWrites.size > 0) {
      await Promise.allSettled([...this.pendingWrites]);
    }
  }

  /** Diagnostics only. */
  stats(): Record<string, unknown> {
    return {
      chatQueue: this.matching.depth(),
      ...this.registry.stats(),
      ...this.presence.stats(),
      pendingRequests: this.requests.stats().pending,
      graceTimers: this.graceTimers.size,
      pendingWrites: this.pendingWrites.size,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private requireFacts(userId: string): { publicId: string; banned: boolean } {
    const facts = this.directory.get(userId);
    if (!facts) throw new AppError(ErrorCode.IDENTITY_NOT_FOUND);
    return facts;
  }

  /**
   * Creates the chat in memory, then persists the lifecycle row.
   *
   * The in-memory creation is synchronous, which is what preserves the atomicity
   * of matchmaking. Persistence is a *consequence*: if it fails, the in-memory chat
   * is rolled back and both identities return to the queue rather than being left
   * in a chat that the database does not know about.
   */
  private async createAndPersistChat(params: {
    kind: 'random' | 'direct';
    participantAId: string;
    participantBId: string;
    initiatorId: string;
    publicIdByUser?: ReadonlyMap<string, string>;
  }): Promise<ChatRecord> {
    const chatId = newChatId();
    const startedAt = new Date();

    this.matching.cancel(params.participantAId);
    this.matching.cancel(params.participantBId);

    const chat = this.registry.create({
      chatId,
      kind: params.kind,
      participantAId: params.participantAId,
      participantBId: params.participantBId,
      initiatorId: params.initiatorId,
      startedAt,
      ...(params.publicIdByUser ? { publicIdByUser: params.publicIdByUser } : {}),
    });

    try {
      await this.prisma.chatSession.create({
        data: {
          id: chatId,
          kind: params.kind,
          participantAId: params.participantAId,
          participantBId: params.participantBId,
          initiatorId: params.initiatorId,
          startedAt,
        },
      });
    } catch (error) {
      this.registry.abort(chatId);

      // Put both back in the random queue: they were waiting for a chat, and the
      // service failing is not their fault. Re-queueing may pair them with someone
      // else immediately, which is the desired behaviour.
      this.matching.enqueue(params.participantAId);
      this.matching.enqueue(params.participantBId);

      log.error('chat.persist_failed', error, { kind: params.kind });
      throw new AppError(ErrorCode.INTERNAL_ERROR, undefined, { cause: error });
    }

    this.bus.emit({ type: 'chat.started', chat });
    return chat;
  }

  /** Ends a chat in memory, tells the participants, and records it in the database. */
  private endChat(chat: ChatRecord, reason: ChatEndReasonSource, endedBy?: string): void {
    if (!chat.isActive) return;

    this.registry.end(chat, reason, new Date(), endedBy);
    this.cancelGraceTimersFor(chat.chatId);

    this.bus.emit({ type: 'chat.ended', chat, reason });

    this.trackWrite(
      this.persistChatEnd(chat).catch((error) => {
        log.error('chat.end_persist_failed', error, { chatId: chat.chatId });
      }),
    );
  }

  private async persistChatEnd(chat: ChatRecord): Promise<void> {
    await this.prisma.chatSession.update({
      where: { id: chat.chatId },
      data: {
        status: 'ended',
        endedAt: chat.endedAt ?? new Date(),
        endReason: chat.endReason ?? 'left',
        messageCount: chat.messageCount,
      },
    });
  }

  private startGrace(chat: ChatRecord, userId: string): void {
    const key = `${chat.chatId}:${userId}`;
    if (this.graceTimers.has(key)) return;

    this.bus.emit({ type: 'chat.presence', chat, userId, present: false });

    const timer = setTimeout(() => {
      this.graceTimers.delete(key);
      if (!chat.isActive) return;

      log.info('chat.reconnect_grace_expired', { chatId: chat.chatId });
      this.endChat(chat, 'disconnected', userId);
    }, this.config.PEER_RECONNECT_GRACE_MS);

    // Never keep the process alive just to expire a chat.
    timer.unref?.();
    this.graceTimers.set(key, timer);
  }

  private cancelGraceTimersFor(chatId: string, userId?: string): void {
    for (const [key, timer] of this.graceTimers) {
      const matchesChat = key.startsWith(`${chatId}:`);
      if (!matchesChat) continue;
      if (userId && key !== `${chatId}:${userId}`) continue;

      clearTimeout(timer);
      this.graceTimers.delete(key);
    }
  }

  private async resolvePublicId(userId: string): Promise<string> {
    const found = await this.prisma.identity.findUnique({
      where: { id: userId },
      select: { publicId: true },
    });
    return found?.publicId ?? '';
  }

  private trackWrite(promise: Promise<unknown>): void {
    this.pendingWrites.add(promise);
    void promise.finally(() => this.pendingWrites.delete(promise));
  }
}
