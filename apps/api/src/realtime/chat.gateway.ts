import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { WebSocketGateway } from '@nestjs/websockets';
import {
  ErrorCode,
  blockPeerSchema,
  chatLeaveSchema,
  chatMessageSchema,
  connectRequestSchema,
  connectRespondSchema,
  errorMessage,
  friendRequestSchema,
  friendRespondSchema,
  matchJoinSchema,
  reportSchema,
  type ChatMessageInput,
  type ConnectRequestInput,
  type ConnectRespondInput,
  type FriendRequestInput,
  type FriendRespondInput,
  type FriendView,
  type ReportInput,
} from '@anonlink/shared';
import {
  PROTOCOL_VERSION,
  type AckHandler,
  type ClientToServerEvents,
  type ErrorPayload,
  type InterServerEvents,
  type ServerToClientEvents,
  type SessionReadyPayload,
  type SocketData,
} from '@anonlink/protocol';
import type { Server, Socket } from 'socket.io';
import { ZodError, type ZodType } from 'zod';

import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { AppError } from '../common/app-error.js';
import { SESSION_COOKIE_NAME, parseCookieHeader } from '../common/cookies.js';
import { log } from '../common/logger.js';
import { RateLimitService, type RateLimitBucket } from '../common/rate-limit.service.js';
import { AppEventBus, type AppEvent } from '../events/app-events.js';
import { ChatService, type ChatState } from '../chat/chat.service.js';
import {
  buildChatView,
  buildHistory,
  buildMessageView,
  endedReasonFor,
} from '../chat/chat.views.js';
import { DirectoryService } from '../directory/directory.service.js';
import type { FriendshipRecord } from '../friends/friends.service.js';
import { IdentityService } from '../identity/identity.service.js';
import type { AuthenticatedIdentity } from '../identity/identity.service.js';
import { PresenceService } from '../presence/presence.service.js';
import { PlatformService } from '../platform/platform.service.js';

type AnonLinkSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

type AnonLinkServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/**
 * The minimum surface needed to address one socket.
 *
 * Socket.IO's typed `emit` cannot be used with a generic event name, so the
 * payload is typed by {@link ChatGateway.emitToUser} and cast once here, in a
 * single, reviewable place.
 */
interface SocketAddresser {
  to(room: string): { emit(event: string, payload: unknown): void };
}

/**
 * The realtime boundary.
 *
 * Responsibilities, and deliberately nothing else:
 *  - authenticate the socket from the session cookie on the handshake;
 *  - validate every inbound payload against the shared Zod schema;
 *  - rate limit per identity;
 *  - call the chat service, which owns all rules and authorisation;
 *  - render domain events into per-socket payloads.
 *
 * ## Why the event handlers are registered by hand
 *
 * `@SubscribeMessage` returns its value as the acknowledgement, which cannot
 * express "ack only if the client actually asked for one", nor a uniform
 * validation/rate-limit/error boundary. Registering the handlers directly gives one
 * explicit pipeline where every client event is validated and every failure is
 * reported in the same shape.
 *
 * ## Ordering
 *
 * Handlers are attached *synchronously* on connection, before the (async) session
 * lookup completes, and every handler awaits that lookup first. Without this, a
 * client that emits immediately after connecting could have its first payload
 * dropped because no listener existed yet.
 *
 * ## Why `@WebSocketGateway()`
 *
 * This decorator is what makes Nest create a Socket.IO server and hand it to
 * {@link ChatGateway.afterInit}. Without it the class is an ordinary provider, the
 * Socket.IO server is never attached to the HTTP server, and every handshake 404s —
 * a failure that looks like a client bug but is purely a wiring one. The transport
 * policy (origin allow-list, credentials, payload ceiling) comes from
 * `ConfiguredSocketIoAdapter`, which is registered in `main.ts` and overrides
 * `createIOServer` for exactly this gateway.
 */
@WebSocketGateway()
@Injectable()
export class ChatGateway implements OnModuleInit, OnModuleDestroy {
  private server: AnonLinkServer | null = null;
  private unsubscribe: (() => void) | null = null;

  /** Resolves once the socket's identity has been resolved (or rejected). */
  private readonly ready = new WeakMap<AnonLinkSocket, Promise<boolean>>();

  private readonly knownClientEvents = new Set<string>([
    'match:join',
    'match:cancel',
    'chat:message',
    'chat:leave',
    'chat:next',
    'request:send',
    'request:respond',
    'report:send',
    'block:peer',
    'friend:request',
    'friend:respond',
  ]);

  constructor(
    private readonly identityService: IdentityService,
    private readonly chat: ChatService,
    private readonly presence: PresenceService,
    private readonly directory: DirectoryService,
    private readonly rateLimit: RateLimitService,
    private readonly bus: AppEventBus,
    private readonly platform: PlatformService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    // Subscribing here (rather than in `afterInit`) means no domain event can be
    // published before the gateway is listening.
    this.unsubscribe = this.bus.subscribe((event) => this.onAppEvent(event));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Called by Nest once the Socket.IO server exists. */
  afterInit(server: AnonLinkServer): void {
    this.server = server;
    server.on('connection', (socket: AnonLinkSocket) => {
      this.onConnection(socket);
    });
    log.info('realtime.listening', { singleInstance: true });
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  private onConnection(socket: AnonLinkSocket): void {
    // Attach first, authenticate second — see the class comment on ordering.
    this.attachHandlers(socket);
    this.ready.set(socket, this.authenticate(socket));

    socket.on('disconnect', (reason) => {
      this.onDisconnect(socket, reason);
    });
  }

  private async authenticate(socket: AnonLinkSocket): Promise<boolean> {
    try {
      const cookies = parseCookieHeader(socket.handshake.headers.cookie);
      const identity = await this.identityService.identify(cookies[SESSION_COOKIE_NAME]);

      if (!identity) {
        this.reject(socket, ErrorCode.IDENTITY_REQUIRED);
        return false;
      }
      if (identity.banned) {
        this.reject(socket, ErrorCode.IDENTITY_BANNED);
        return false;
      }

      const registration = this.presence.register(socket.id, identity.userId);

      if (registration.sockets > this.config.MAX_SOCKETS_PER_USER) {
        this.presence.unregister(socket.id);
        log.security('realtime.too_many_connections', { sockets: registration.sockets });
        this.reject(socket, ErrorCode.TOO_MANY_CONNECTIONS);
        return false;
      }

      socket.data.userId = identity.userId;
      socket.data.publicId = identity.publicId;
      socket.data.sessionId = identity.sessionId;

      this.identityService.touch(identity);

      // Resume an in-flight chat only the first time this identity comes online, so
      // opening a second tab does not re-trigger the peer's "back online" notice.
      if (registration.firstSocket) await this.chat.handleConnected(identity.userId);

      const state = this.chat.stateFor(identity.userId);
      const friendsWithPeer = state.activeChat
        ? await this.chat.areChatPeersFriends(identity.userId)
        : false;
      socket.emit('session:ready', this.buildSessionReady(identity, state, friendsWithPeer));

      // The transcript is re-attached for *every* socket, not just the first one:
      // otherwise a second tab, or a reconnect that reused an existing socket, would
      // show an empty conversation.
      if (state.activeChat) {
        socket.emit('chat:resumed', {
          chat: buildChatView(state.activeChat, identity.userId),
          messages: buildHistory(state.activeChat, identity.userId),
          initiator: state.activeChat.initiatorId === identity.userId,
        });
      }

      log.info('realtime.connected', { sockets: registration.sockets });
      return true;
    } catch (error) {
      log.error('realtime.connect_failed', error);
      this.reject(socket, ErrorCode.INTERNAL_ERROR);
      return false;
    }
  }

  private onDisconnect(socket: AnonLinkSocket, reason: string): void {
    const { userId, lastSocket } = this.presence.unregister(socket.id);
    if (!userId || !lastSocket) return;

    // The chat is *not* torn down here: the chat service starts a reconnect grace
    // period, because a page reload must not end the conversation.
    this.chat.handleDisconnected(userId);

    // The cached identity facts only exist to serve requests from this identity, so
    // they are released once its last socket is gone. Every code path that needs them
    // (`joinRandom`, `requestDirect`, `handleConnected`) loads them again first —
    // which also means a reconnect always sees fresh ban/block state rather than a
    // stale snapshot from before the disconnect.
    this.directory.forget(userId);

    log.info('realtime.disconnected', { reason, remaining: this.presence.stats().sockets });
  }

  private buildSessionReady(
    identity: AuthenticatedIdentity,
    state: ChatState,
    friendsWithPeer: boolean,
  ): SessionReadyPayload {
    return {
      protocolVersion: PROTOCOL_VERSION,
      publicId: identity.publicId,
      identityCreatedAt: identity.identityCreatedAt.toISOString(),
      blockingEnabled: this.platform.blockingEnabled(),
      settings: identity.settings,
      limits: { messageMaxLength: this.config.MESSAGE_MAX_LENGTH },
      queued: state.queued,
      // A reloaded tab has no memory of its filters; without this the waiting screen would
      // have to show nothing (or the client's guess) while the server is matching against
      // the real ones — and possibly dropping them one by one.
      ...(state.queued ? { search: this.chat.searchStatus(identity.userId) } : {}),
      ...(state.activeChat ? { activeChat: buildChatView(state.activeChat, identity.userId) } : {}),
      ...(state.activeChat ? { friendsWithPeer } : {}),
      ...(state.pendingFriendRequest
        ? {
            pendingFriendRequest: {
              requestId: state.pendingFriendRequest.requestId,
              chatId: state.pendingFriendRequest.chatId,
              alias: state.pendingFriendRequest.alias,
              expiresAt: state.pendingFriendRequest.expiresAt.toISOString(),
              direction: state.pendingFriendRequest.direction,
            },
          }
        : {}),
    };
  }

  /** Tells the client why the connection was refused, then closes it. */
  private reject(socket: AnonLinkSocket, code: ErrorCode): void {
    socket.emit('app:error', { code, message: errorMessage(code) });
    socket.disconnect(true);
  }

  // ---------------------------------------------------------------------------
  // Inbound event pipeline
  // ---------------------------------------------------------------------------

  private attachHandlers(socket: AnonLinkSocket): void {
    // Unknown events are reported instead of being silently ignored, which makes a
    // client/server protocol mismatch obvious in the browser console.
    socket.onAny((event: string, ...args: unknown[]) => {
      if (typeof event !== 'string' || this.knownClientEvents.has(event)) return;
      log.warn('realtime.unknown_event', { event: event.slice(0, 32) });
      socket.emit('app:error', {
        code: ErrorCode.UNSUPPORTED_EVENT,
        message: errorMessage(ErrorCode.UNSUPPORTED_EVENT),
      });
      void args;
    });

    socket.on('match:join', (...args) => {
      void this.guard(socket, 'match:join', args, matchJoinSchema, null, async (_input, userId) => {
        const result = await this.chat.joinRandom(userId);
        return { queued: result.kind === 'waiting', waitingSince: result.since.toISOString() };
      });
    });

    socket.on('match:cancel', (...args) => {
      void this.guard(socket, 'match:cancel', args, matchJoinSchema, null, (_input, userId) => ({
        cancelled: this.chat.cancelMatching(userId),
      }));
    });

    socket.on('chat:message', (...args) => {
      void this.guard(
        socket,
        'chat:message',
        args,
        chatMessageSchema,
        'chatMessage',
        (input: ChatMessageInput, userId) => {
          const { messageId, sentAt } = this.chat.sendMessage(userId, input);
          return { messageId, sentAt: sentAt.toISOString() };
        },
      );
    });

    socket.on('chat:leave', (...args) => {
      void this.guard(socket, 'chat:leave', args, chatLeaveSchema, null, async (input, userId) => {
        await this.chat.leaveChat(userId, input.chatId, false);
        return { ended: true };
      });
    });

    socket.on('chat:next', (...args) => {
      void this.guard(socket, 'chat:next', args, chatLeaveSchema, null, async (input, userId) => {
        const result = await this.chat.leaveChat(userId, input.chatId, true);
        return { queued: result.queued };
      });
    });

    socket.on('request:send', (...args) => {
      void this.guard(
        socket,
        'request:send',
        args,
        connectRequestSchema,
        'connectRequest',
        (input: ConnectRequestInput, userId) =>
          this.chat.requestDirect(userId, input.publicId, input.note),
      );
    });

    socket.on('request:respond', (...args) => {
      void this.guard(
        socket,
        'request:respond',
        args,
        connectRespondSchema,
        null,
        (input: ConnectRespondInput, userId) =>
          this.chat.respondToRequest(userId, input.requestId, input.accept),
      );
    });

    socket.on('report:send', (...args) => {
      void this.guard(
        socket,
        'report:send',
        args,
        reportSchema,
        null,
        async (input: ReportInput, userId) => ({
          reportId: await this.chat.reportChat(
            userId,
            input.chatId,
            input.reason,
            input.messageId,
            input.details,
          ),
        }),
      );
    });

    socket.on('block:peer', (...args) => {
      void this.guard(socket, 'block:peer', args, blockPeerSchema, null, async (input, userId) => {
        const { publicId } = await this.chat.blockPeerOfChat(userId, input.chatId);
        this.emitToUser(userId, 'peer:blocked', { publicId, chatId: input.chatId });
        return { blocked: true, publicId };
      });
    });

    socket.on('friend:request', (...args) => {
      void this.guard(
        socket,
        'friend:request',
        args,
        friendRequestSchema,
        'connectRequest',
        (input: FriendRequestInput, userId) => this.chat.requestFriend(userId, input.chatId),
      );
    });

    socket.on('friend:respond', (...args) => {
      void this.guard(
        socket,
        'friend:respond',
        args,
        friendRespondSchema,
        null,
        (input: FriendRespondInput, userId) =>
          this.chat.respondToFriendRequest(userId, input.requestId, input.accept),
      );
    });
  }

  /**
   * The single validation / authorisation / error boundary for inbound events.
   *
   * `args` is the raw Socket.IO argument list, because a client may send
   * `(payload, ack)`, `(ack)` or `(payload)` — the payload and the acknowledgement
   * are identified by shape rather than by position.
   */
  private async guard<TIn, TOut>(
    socket: AnonLinkSocket,
    handler: string,
    args: unknown[],
    schema: ZodType<TIn>,
    bucket: RateLimitBucket | null,
    run: (input: TIn, userId: string) => TOut | Promise<TOut>,
  ): Promise<void> {
    const ack = args.find((arg): arg is AckHandler<TOut> => typeof arg === 'function');
    const payload = args.find((arg) => typeof arg !== 'function');

    try {
      const authenticated = (await this.ready.get(socket)) ?? false;
      if (!authenticated) throw new AppError(ErrorCode.IDENTITY_REQUIRED);

      const userId = socket.data.userId;
      if (!userId) throw new AppError(ErrorCode.IDENTITY_REQUIRED);

      const parsed = schema.safeParse(payload ?? {});
      if (!parsed.success) throw new ZodError(parsed.error.issues);

      if (bucket) this.rateLimit.enforce(bucket, `identity:${userId}`);

      const data = await run(parsed.data, userId);
      if (ack) ack({ ok: true, data });
    } catch (error) {
      const payloadOut = this.toErrorPayload(error, handler);
      if (ack) ack({ ok: false, error: payloadOut });
      else socket.emit('app:error', payloadOut);
    }
  }

  /**
   * Converts any failure into a client-safe error payload.
   *
   * Only {@link AppError} messages are ever forwarded. Anything else is a bug, so
   * it is logged server-side and the client receives a generic message plus a short
   * correlation id the user can quote.
   */
  private toErrorPayload(error: unknown, handler: string): ErrorPayload {
    if (error instanceof AppError) {
      // A rate-limit trip is worth surfacing in logs, but without the identity.
      if (error.code === ErrorCode.RATE_LIMITED) log.security('realtime.rate_limited', { handler });
      return error.toPayload();
    }

    if (error instanceof ZodError) {
      const first = error.issues[0];
      return {
        code: ErrorCode.INVALID_INPUT,
        message: errorMessage(ErrorCode.INVALID_INPUT),
        ...(first ? { context: `${first.path.join('.') || 'payload'}: ${first.message}` } : {}),
      };
    }

    const correlationId = Math.random().toString(36).slice(2, 10);
    log.error('realtime.handler_failed', error, { handler, correlationId });
    return {
      code: ErrorCode.INTERNAL_ERROR,
      message: errorMessage(ErrorCode.INTERNAL_ERROR),
      context: correlationId,
    };
  }

  // ---------------------------------------------------------------------------
  // Outbound rendering
  // ---------------------------------------------------------------------------

  private onAppEvent(event: AppEvent): void {
    switch (event.type) {
      case 'match.queued':
        this.emitToUser(event.userId, 'match:queued', {
          queuedAt: event.since.toISOString(),
          criteria: event.criteria,
          relaxAfterMs: event.relaxAfterMs,
        });
        return;

      case 'match.cancelled':
        this.emitToUser(event.userId, 'match:cancelled', { reason: event.reason });
        return;

      case 'match.relaxed':
        // Only ever to the waiting user: this is about *their* filters, and the peer
        // they are about to meet has no business knowing what was dropped.
        this.emitToUser(event.userId, 'match:relaxed', {
          dropped: event.dropped,
          criteria: event.criteria,
        });
        return;

      case 'chat.started':
        // No `match:cancelled` is sent alongside: `chat:started` is what moves the
        // client out of the search screen, and two competing signals would only
        // create an ordering question.
        for (const userId of event.chat.participantIds) {
          this.emitToUser(userId, 'chat:started', {
            chat: buildChatView(event.chat, userId),
            messages: [],
            initiator: event.chat.initiatorId === userId,
          });
        }
        return;

      case 'chat.message':
        // Personalised per participant: the sender sees `from: 'you'` on every one
        // of their tabs, everybody else sees `from: 'peer'`.
        for (const userId of event.chat.participantIds) {
          this.emitToUser(
            userId,
            'chat:message',
            buildMessageView(event.chat, event.message, userId),
          );
        }
        return;

      case 'chat.presence': {
        const peerId = event.chat.peerOf(event.userId);
        this.emitToUser(peerId, event.present ? 'chat:peer-back' : 'chat:peer-away', {
          chatId: event.chat.chatId,
        });
        return;
      }

      case 'chat.ended':
        for (const userId of event.chat.participantIds) {
          this.emitToUser(userId, 'chat:ended', {
            chatId: event.chat.chatId,
            reason: endedReasonFor(event.chat, userId, event.reason),
          });
        }
        return;

      case 'request.incoming':
        this.emitToUser(event.request.toUserId, 'request:incoming', {
          requestId: event.request.requestId,
          // A direct request is inherently non-anonymous: the sender typed the
          // recipient's User ID, so showing theirs back is expected and reciprocal.
          from: { alias: event.request.fromPublicId, publicId: event.request.fromPublicId },
          ...(event.request.note ? { note: event.request.note } : {}),
          expiresAt: new Date(event.request.expiresAt).toISOString(),
        });
        return;

      case 'request.resolved':
        this.emitToUser(event.userId, 'request:resolved', {
          requestId: event.requestId,
          status: event.status,
          ...(event.chat ? { chat: buildChatView(event.chat, event.userId) } : {}),
        });
        return;

      case 'friend.incoming':
        // Only the per-chat alias crosses the wire here. The requester's User ID is
        // disclosed after acceptance, through the friendship itself.
        this.emitToUser(event.request.toUserId, 'friend:incoming', {
          requestId: event.request.requestId,
          chatId: event.request.chatId,
          alias: event.request.fromAlias,
          expiresAt: new Date(event.request.expiresAt).toISOString(),
        });
        return;

      case 'friend.resolved':
        for (const userId of [event.request.fromUserId, event.request.toUserId]) {
          const friend = event.friendship ? friendshipViewFor(event.friendship, userId) : undefined;
          this.emitToUser(userId, 'friend:resolved', {
            requestId: event.request.requestId,
            chatId: event.request.chatId,
            status: event.status,
            ...(friend ? { friend } : {}),
          });
        }
        return;

      case 'friend.removed':
        this.emitToUser(event.userId, 'friend:removed', { publicId: event.publicId });
        return;

      case 'identity.banned':
        // Tell the identity before closing the transport: a bare disconnect would look
        // like a network failure and the client would retry a session that can never work.
        this.chat.handleBanned(event.userId);
        this.emitToUser(event.userId, 'app:error', {
          code: ErrorCode.IDENTITY_BANNED,
          message: errorMessage(ErrorCode.IDENTITY_BANNED),
        });
        this.disconnectUser(event.userId);
        return;

      case 'session.rotated':
        // The sockets on this identity are authenticated as a session that no longer
        // exists; close them so nothing can act with revoked credentials.
        this.emitToUser(event.previousUserId, 'session:rotated', { publicId: event.publicId });
        this.disconnectUser(event.previousUserId);
        return;
    }
  }

  /**
   * Delivers one event to every socket of one identity.
   *
   * Socket.IO puts each socket in a room named after its own id, so `to(socketId)`
   * reaches exactly one connection — this is addressing, not broadcasting.
   */
  private emitToUser<E extends keyof ServerToClientEvents & string>(
    userId: string,
    event: E,
    payload: Parameters<ServerToClientEvents[E]>[0],
  ): void {
    const server = this.server;
    if (!server) return;

    const addresser = server as unknown as SocketAddresser;
    for (const socketId of this.presence.socketIds(userId)) {
      addresser.to(socketId).emit(event, payload);
    }
  }

  /** Closes every socket of one identity. Used when its credential stops being valid. */
  private disconnectUser(userId: string): void {
    for (const socketId of this.presence.socketIds(userId)) {
      const socket = this.server?.sockets.sockets.get(socketId);
      socket?.disconnect(true);
    }
  }
}

/** The friendship as one participant sees it: the *other* person's ID, and the date. */
function friendshipViewFor(record: FriendshipRecord, userId: string): FriendView | undefined {
  if (record.userIdA === userId) {
    return { publicId: record.publicIdB, since: record.createdAt.toISOString() };
  }
  if (record.userIdB === userId) {
    return { publicId: record.publicIdA, since: record.createdAt.toISOString() };
  }
  return undefined;
}
