import { ErrorCode, type ReportReason, type SessionView } from '@anonlink/shared';
import {
  PROTOCOL_VERSION,
  type AckResult,
  type ChatMessageView,
  type ChatView,
  type ClientToServerEvents,
  type ErrorPayload,
  type MatchJoinResult,
  type MatchCancelResult,
  type ChatMessageResult,
  type ChatLeaveResult,
  type ChatNextResult,
  type SendRequestResult,
  type RespondRequestResult,
  type ReportResult,
  type BlockPeerResult,
  type FriendRequestResult,
  type FriendRespondResult,
  type ServerToClientEvents,
  type SessionReadyPayload,
} from '@anonlink/protocol';
import { io, type Socket } from 'socket.io-client';

import { API_ORIGIN } from './config';
import { activeT, getActiveLocale } from '@/i18n';
import { describeError, describeMatchCancel, describeRequestStatus } from './error-text';
import { ApiError, apiRequest } from './http';
import { describeDroppedCriteria } from './labels';
import {
  toUiMessage,
  useAppStore,
  type ChatInfo,
  type SessionInfo,
  type UiMessage,
} from '@/store/app-store';

/**
 * Note the parameter order: a *client* socket is typed
 * `Socket<ListenEvents, EmitEvents>` — the opposite of the server's
 * `Server<EmitEvents, ListenEvents>`. Mixing them up still compiles at the call site
 * of `on`/`emit` but makes every event name mismatch, so the order matters.
 */
type AnonLinkSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * The one place where a *dynamic* event name is emitted.
 *
 * Socket.IO's typed `emit` resolves the acknowledgement type from a literal event
 * name, which a generic command helper cannot provide. Rather than sprinkling casts
 * through the call sites, the single unavoidable cast lives here, behind
 * {@link AnonymousClient.command}, which is the only code that uses it.
 */
interface RawEmitter {
  emit(event: string, ...args: unknown[]): void;
}

/** How long to wait for an acknowledgement before reporting a timeout. */
const COMMAND_TIMEOUT_MS = 12_000;

/** How many times to re-open a socket the server closed without an explanation. */
const MAX_SERVER_CLOSE_RETRIES = 5;

export type CommandOutcome = { ok: true } | { ok: false; error: string };

function toChatInfo(view: ChatView, initiator: boolean): ChatInfo {
  return {
    chatId: view.chatId,
    kind: view.kind,
    peerAlias: view.peer.alias,
    ...(view.peer.publicId ? { peerPublicId: view.peer.publicId } : {}),
    startedAt: view.startedAt,
    initiator,
  };
}

function toUiMessages(views: ChatMessageView[]): UiMessage[] {
  return views.map(toUiMessage);
}

/**
 * The single connection to AnonLink.
 *
 * It is a module-level singleton on purpose: the anonymous identity lives in one
 * `HttpOnly` cookie, so a second socket would only multiply connections for the same
 * user (and hit the per-identity socket cap).
 *
 * Responsibilities:
 *  - bootstrap the anonymous session over REST (the cookie is the only credential);
 *  - own the socket, its reconnection policy and its rejection handling;
 *  - translate every server push into store updates;
 *  - expose imperative commands to the UI.
 *
 * It never renders anything, and the store never talks to the network — which is what
 * keeps the UI components free of protocol details.
 */
class AnonymousClient {
  private socket: AnonLinkSocket | null = null;
  private booting = false;
  private booted = false;

  /** Set while the server is deliberately closing a socket we asked it to close. */
  private rotating = false;

  /** Set when the server refused this identity, to stop a reconnect loop. */
  private refused = false;

  private serverCloseRetries = 0;

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  /**
   * Ensures there is an identity and a live socket. Idempotent, so a React effect
   * that runs twice (React StrictMode in development does exactly that) is harmless.
   */
  async boot(): Promise<void> {
    if (this.booted || this.booting) return;
    if (typeof window === 'undefined') return;

    this.booting = true;
    const store = useAppStore.getState();

    try {
      // `POST /session` is idempotent: with a valid cookie it returns the existing
      // identity and consumes no rate limit, so this is safe on every page load.
      const session = await apiRequest<SessionView>('/session', { method: 'POST' });

      store.setSession(this.toSessionInfo(session));
      store.setBootError(null);
      store.setConnection('connecting');

      this.refused = false;
      this.booted = true;
      this.openSocket();
    } catch (error) {
      const message = describeThrown(error);
      store.setBootError(message);

      // A banned identity is not a network failure: retrying with the same cookie can
      // never succeed. Showing "Нет связи" would invite a retry loop; the "Доступ закрыт"
      // state explains what the server actually decided.
      if (error instanceof ApiError && error.code === ErrorCode.IDENTITY_BANNED) {
        this.refused = true;
        store.setConnection('rejected', message);
      } else {
        store.setConnection('offline', message);
      }
    } finally {
      this.booting = false;
    }
  }

  /** Retries a failed bootstrap (the "Повторить" button). */
  async retryBoot(): Promise<void> {
    this.closeSocket();
    this.booted = false;
    this.refused = false;
    useAppStore.getState().setConnection('booting');
    await this.boot();
  }

  /**
   * "Get a new User ID".
   *
   * Revolves every session of the current identity and adopts a brand-new one. The
   * old User ID stops working immediately, which is exactly the point: it is the
   * panic button after a bad conversation.
   */
  async rotateIdentity(): Promise<CommandOutcome> {
    try {
      this.rotating = true;

      const session = await apiRequest<SessionView>('/session', { method: 'DELETE' });

      // The conversation belonged to the previous identity; nothing about it may
      // survive into the new one.
      const store = useAppStore.getState();
      store.clearConversation();
      store.setSession(this.toSessionInfo(session));

      // The server has already closed our socket. Reconnecting is driven from here,
      // after the new cookie is in place, so the handshake cannot race the response.
      this.openSocket();

      store.notify('success', activeT('Вы получили новый User ID. Прошлый больше не действует.'));
      return { ok: true };
    } catch (error) {
      this.rotating = false;
      return this.failWith(describeThrown(error));
    }
  }

  // ---------------------------------------------------------------------------
  // Commands (UI -> server)
  // ---------------------------------------------------------------------------

  /** Starts random matchmaking. */
  async startMatching(): Promise<CommandOutcome> {
    const result = await this.command<MatchJoinResult>('match:join');
    if (!result.ok) return this.failed(result.error);

    // `match:queued` normally arrives first; this makes the button feel instant even
    // if the event is in flight. `queued: false` means a peer was found immediately,
    // in which case `chat:started` owns the screen and must not be overwritten.
    if (result.data.queued) useAppStore.getState().beginSearching(result.data.waitingSince);
    return { ok: true };
  }

  /** Stops random matchmaking. */
  async cancelMatching(): Promise<CommandOutcome> {
    const result = await this.command<MatchCancelResult>('match:cancel');
    if (!result.ok) return this.failed(result.error);

    useAppStore.getState().stopSearching();
    return { ok: true };
  }

  /** Sends a message. Optimistic: the bubble appears before the server answers. */
  sendMessage(text: string): void {
    const store = useAppStore.getState();
    const chatId = store.chat?.chatId;
    if (!chatId) return;

    const clientMessageId = store.queueOutgoingMessage(text);

    void this.command<ChatMessageResult>('chat:message', {
      chatId,
      clientMessageId,
      text,
    }).then((result) => {
      const current = useAppStore.getState();
      if (result.ok) {
        current.confirmMessage(clientMessageId, result.data.messageId, result.data.sentAt);
      } else {
        current.failMessage(clientMessageId, describeError(result.error, getActiveLocale()));
      }
    });
  }

  /** Ends the current chat and stays on the result screen. */
  async leaveChat(): Promise<CommandOutcome> {
    const chatId = useAppStore.getState().chat?.chatId;
    if (!chatId) return { ok: true };

    const result = await this.command<ChatLeaveResult>('chat:leave', { chatId });
    return result.ok ? { ok: true } : this.failed(result.error);
  }

  /** Ends the current chat and immediately looks for another peer. */
  async nextPeer(): Promise<CommandOutcome> {
    const chatId = useAppStore.getState().chat?.chatId;
    if (!chatId) return { ok: true };

    const result = await this.command<ChatNextResult>('chat:next', { chatId });
    return result.ok ? { ok: true } : this.failed(result.error);
  }

  /** Asks a specific User ID for a direct chat. */
  async requestDirect(publicId: string, note?: string): Promise<CommandOutcome> {
    const result = await this.command<SendRequestResult>('request:send', {
      publicId,
      ...(note ? { note } : {}),
    });
    if (!result.ok) return this.failed(result.error);

    useAppStore.getState().setOutgoingRequest({ publicId, expiresAt: result.data.expiresAt });
    return { ok: true };
  }

  /** Accepts or declines an incoming request. */
  async respondToRequest(requestId: string, accept: boolean): Promise<CommandOutcome> {
    const result = await this.command<RespondRequestResult>('request:respond', {
      requestId,
      accept,
    });

    // The dialog is dismissed either way: a request that could not be answered is
    // gone from the user's point of view too.
    useAppStore.getState().removeIncomingRequest(requestId);
    return result.ok ? { ok: true } : this.failed(result.error);
  }

  /** Reports the current chat. Reporting also ends it, server-side. */
  async reportCurrentChat(reason: ReportReason, details?: string): Promise<CommandOutcome> {
    const state = useAppStore.getState();
    const chatId = state.chat?.chatId;
    if (!chatId) return this.failWith(activeT('Чат не найден.'));

    // The dialog promises that the last message is kept as evidence, and the server only
    // snapshots a message it is *told* about, from its own in-memory copy. Without this id
    // every report filed through the interface stored no text at all — the owner's panel
    // would show a complaint with nothing to review. The id is the server's; a client
    // cannot use it to point at another chat (the server checks membership and looks the
    // message up inside this conversation only).
    const lastMessageId = state.messages.findLast((message) => message.messageId)?.messageId;

    const result = await this.command<ReportResult>('report:send', {
      chatId,
      reason,
      ...(lastMessageId ? { messageId: lastMessageId } : {}),
      ...(details ? { details } : {}),
    });
    return result.ok ? { ok: true } : this.failed(result.error);
  }

  /** Blocks the peer of the current chat. Blocking also ends it, server-side. */
  async blockCurrentPeer(): Promise<CommandOutcome> {
    const chatId = useAppStore.getState().chat?.chatId;
    if (!chatId) return this.failWith(activeT('Чат не найден.'));

    const result = await this.command<BlockPeerResult>('block:peer', { chatId });
    return result.ok ? { ok: true } : this.failed(result.error);
  }

  // ---------------------------------------------------------------------------
  // Friends
  // ---------------------------------------------------------------------------

  /** Asks the current chat peer to become a friend. */
  async requestFriend(): Promise<CommandOutcome> {
    const state = useAppStore.getState();
    const chatId = state.chat?.chatId;
    if (!chatId) return this.failWith(activeT('Чат не найден.'));

    const result = await this.command<FriendRequestResult>('friend:request', { chatId });
    if (!result.ok) return this.failed(result.error);

    const current = useAppStore.getState();
    if (result.data.accepted) {
      current.setFriendsInChat(true);
      current.setOutgoingFriendRequest(null);
      current.setIncomingFriendRequest(null);
      current.bumpFriendsVersion();
      current.notify('success', activeT('Теперь вы друзья.'));
      return { ok: true };
    }

    current.setOutgoingFriendRequest({
      requestId: result.data.requestId,
      chatId: result.data.chatId,
      alias: current.chat?.chatId === result.data.chatId ? current.chat.peerAlias : '',
      expiresAt: result.data.expiresAt,
    });
    return { ok: true };
  }

  /** Accepts or declines a friend request shown in the dialog. */
  async respondToFriendRequest(requestId: string, accept: boolean): Promise<CommandOutcome> {
    const result = await this.command<FriendRespondResult>('friend:respond', {
      requestId,
      accept,
    });

    const current = useAppStore.getState();
    current.clearFriendRequest(requestId);

    if (!result.ok) return this.failed(result.error);

    if (result.data.accepted) {
      current.setFriendsInChat(true);
      current.bumpFriendsVersion();
      current.notify('success', activeT('Теперь вы друзья.'));
    } else if (!accept) {
      current.setFriendRequestOutcome('declined');
    }

    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Socket lifecycle
  // ---------------------------------------------------------------------------

  private openSocket(): void {
    this.closeSocket();

    const socket: AnonLinkSocket = io(API_ORIGIN, {
      // Required for the anonymous session cookie to be sent on the handshake.
      withCredentials: true,
      autoConnect: false,
      // WebSocket first, with polling as the fallback for restrictive networks.
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
      timeout: 15_000,
    });

    this.socket = socket;
    this.attachListeners(socket);

    useAppStore.getState().setConnection('connecting');
    socket.connect();
  }

  private closeSocket(): void {
    const socket = this.socket;
    if (!socket) return;

    this.socket = null;
    socket.removeAllListeners();
    socket.disconnect();
  }

  /** Reconnects after a delay, used for closes we did not initiate ourselves. */
  private reconnectSoon(delayMs: number): void {
    setTimeout(() => {
      // A newer socket may have been opened while this timer was pending.
      if (this.socket && this.socket.connected) return;
      this.openSocket();
    }, delayMs);
  }

  private attachListeners(socket: AnonLinkSocket): void {
    socket.on('connect', () => {
      this.serverCloseRetries = 0;
      // The transport is up, but the identity is only confirmed by `session:ready`.
      useAppStore.getState().setConnection('connecting');
    });

    socket.on('disconnect', (reason) => {
      // We asked for this (rotation, shutdown) — not a failure to report.
      if (reason === 'io client disconnect') return;

      if (reason === 'io server disconnect') {
        if (this.refused) return;

        // A rotation reconnects from `rotateIdentity`, once the new cookie exists.
        if (this.rotating) return;

        if (this.serverCloseRetries >= MAX_SERVER_CLOSE_RETRIES) {
          useAppStore
            .getState()
            .setConnection('offline', activeT('Сервер закрыл соединение. Нажмите «Повторить».'));
          return;
        }

        this.serverCloseRetries += 1;
        this.reconnectSoon(400 * this.serverCloseRetries);
        return;
      }

      // Socket.IO reconnects on its own for transport-level failures.
      useAppStore
        .getState()
        .setConnection('reconnecting', activeT('Соединение потеряно. Восстанавливаем…'));
    });

    socket.on('connect_error', () => {
      useAppStore
        .getState()
        .setConnection('reconnecting', activeT('Не удаётся подключиться. Повторяем…'));
    });

    socket.io.on('reconnect_failed', () => {
      useAppStore
        .getState()
        .setConnection(
          'offline',
          activeT('Не удалось восстановить соединение. Нажмите «Повторить».'),
        );
    });

    socket.on('session:ready', (payload) => this.onSessionReady(payload));
    socket.on('session:rotated', () => {
      const store = useAppStore.getState();
      store.clearConversation();
      // The old identity's friendships were deleted silently, so the list must not keep
      // showing contacts that no longer belong to this User ID. The same applies to a
      // report warning: it belonged to the identity that was just replaced.
      store.bumpFriendsVersion();
      store.bumpReportWarningVersion();
    });

    socket.on('match:queued', (payload) => {
      const store = useAppStore.getState();
      store.beginSearching(payload.queuedAt);
      // The criteria come from the server, which is the only party that knows what is
      // actually being applied — including after a relaxation.
      store.setSearchCriteria(payload.criteria, payload.relaxAfterMs);
    });

    socket.on('match:relaxed', (payload) => {
      const store = useAppStore.getState();
      store.noteRelaxation(payload.dropped, payload.criteria);
      // Said out loud, every time. A silently widened search would hand the user exactly
      // the partner they had filtered out, which is worse than never matching at all.
      store.notify(
        'info',
        activeT('Ищем шире: {criteria}.', {
          criteria: describeDroppedCriteria(payload.dropped, getActiveLocale()),
        }),
      );
    });

    socket.on('match:cancelled', (payload) => {
      useAppStore.getState().stopSearching();
      // `chat_started` is not worth a toast: the chat screen is already opening.
      if (payload.reason !== 'chat_started') {
        useAppStore
          .getState()
          .notify('info', describeMatchCancel(payload.reason, getActiveLocale()));
      }
    });

    socket.on('chat:started', (payload) => {
      const store = useAppStore.getState();
      store.startChat(toChatInfo(payload.chat, payload.initiator), toUiMessages(payload.messages));
      // A direct chat with an existing friend must not offer "add friend" again.
      if (payload.chat.friendsWithPeer) store.setFriendsInChat(true);
    });

    socket.on('chat:resumed', (payload) => {
      const store = useAppStore.getState();
      store.restoreChat(
        toChatInfo(payload.chat, payload.initiator),
        toUiMessages(payload.messages),
      );
      if (payload.chat.friendsWithPeer) store.setFriendsInChat(true);
    });

    socket.on('chat:message', (payload) => {
      useAppStore.getState().receiveMessage(payload);
    });

    socket.on('chat:peer-away', () => useAppStore.getState().setPeerAway(true));
    socket.on('chat:peer-back', () => useAppStore.getState().setPeerAway(false));

    socket.on('chat:ended', (payload) => {
      const store = useAppStore.getState();
      store.endChat(payload.chatId, payload.reason);
      store.setOutgoingRequest(null);
      // A report or a block severs a friendship in the same database transaction. Bumping
      // the version makes an idle list in another tab refetch instead of offering a dead
      // contact.
      store.bumpFriendsVersion();
    });

    socket.on('request:incoming', (payload) => {
      useAppStore.getState().addIncomingRequest(payload);
      useAppStore
        .getState()
        .notify('info', activeT('{alias} хочет начать чат.', { alias: payload.from.alias }));
    });

    socket.on('request:resolved', (payload) => {
      const store = useAppStore.getState();
      store.setOutgoingRequest(null);
      store.removeIncomingRequest(payload.requestId);

      if (payload.chat) {
        // The sender of an accepted request learns the chat from here; the recipient
        // learns it from `chat:started`. Either way the state is the same.
        store.startChat(toChatInfo(payload.chat, true), []);
        if (payload.chat.friendsWithPeer) store.setFriendsInChat(true);
        return;
      }

      if (payload.status !== 'accepted') {
        store.notify('info', describeRequestStatus(payload.status, getActiveLocale()));
      }
    });

    socket.on('peer:blocked', () => {
      useAppStore.getState().notify('success', activeT('Пользователь заблокирован.'));
    });

    socket.on('friend:incoming', (payload) => {
      const store = useAppStore.getState();
      if (store.chat?.chatId !== payload.chatId) return;

      store.setIncomingFriendRequest({
        requestId: payload.requestId,
        chatId: payload.chatId,
        alias: payload.alias,
        expiresAt: payload.expiresAt,
      });
      store.notify(
        'info',
        activeT('{alias} хочет добавить вас в друзья.', { alias: payload.alias }),
      );
    });

    socket.on('friend:resolved', (payload) => {
      const store = useAppStore.getState();
      const wasOutgoing = store.outgoingFriendRequest?.requestId === payload.requestId;
      store.clearFriendRequest(payload.requestId);

      if (payload.status === 'accepted') {
        if (store.chat?.chatId === payload.chatId) store.setFriendsInChat(true);
        store.bumpFriendsVersion();
        store.notify('success', activeT('Теперь вы друзья.'));
        return;
      }

      // A late outcome for a chat that is already gone must not change the current one.
      if (store.chat?.chatId !== payload.chatId) return;

      if (payload.status === 'declined') {
        store.setFriendRequestOutcome('declined');
        if (wasOutgoing) {
          store.notify('info', activeT('Собеседник отклонил заявку в друзья.'));
        }
        return;
      }

      if (payload.status === 'expired') {
        store.setFriendRequestOutcome('expired');
        store.notify('info', activeT('Время заявки в друзья истекло.'));
        return;
      }

      if (payload.status === 'unavailable') {
        store.setFriendRequestOutcome('unavailable');
        store.notify('info', activeT('Сейчас нельзя добавить этого собеседника в друзья.'));
        return;
      }

      // `cancelled` accompanies the chat ending; the chat screen explains that already.
    });

    socket.on('friend:removed', () => {
      const store = useAppStore.getState();
      store.bumpFriendsVersion();
      store.notify('info', activeT('Контакт удалён из списка друзей.'));
    });

    socket.on('report:warning', () => {
      const store = useAppStore.getState();
      // The event carries no evidence, only the fact of a complaint. The dialog fetches
      // the durable warning from REST, so a missed event is recovered on the next load.
      store.bumpReportWarningVersion();
      store.notify('error', activeT('На вас поступила жалоба.'));
    });

    socket.on('app:error', (payload) => this.onServerError(payload));
  }

  private onSessionReady(payload: SessionReadyPayload): void {
    const store = useAppStore.getState();

    this.refused = false;
    store.setConnection('connected');
    store.setBootError(null);
    store.setSession({
      publicId: payload.publicId,
      createdAt: payload.identityCreatedAt,
      incomingRequests: payload.settings.incomingRequests,
      // Platform policy, not this user's setting (D31): the same answer for everybody.
      blockingEnabled: payload.blockingEnabled,
      profile: payload.settings.profile,
      search: payload.settings.search,
    });
    store.setMessageMaxLength(payload.limits.messageMaxLength);

    if (payload.protocolVersion !== PROTOCOL_VERSION) {
      store.setProtocolMismatch(true);
      store.notify('error', activeT('Версия приложения устарела. Обновите страницу (Ctrl+F5).'));
    }

    // `chat:resumed` normally arrives first with the transcript. This is the fallback
    // for the case where it has not been delivered yet.
    if (payload.activeChat && !useAppStore.getState().chat) {
      store.restoreChat(toChatInfo(payload.activeChat, false), []);
    }

    // The friend question is ephemeral on the server, while the friendship itself is
    // durable. A reload therefore has to ask the server both things: whether a request
    // is still waiting for an answer, and whether these two are already friends.
    const current = useAppStore.getState();
    current.resetFriendRequests();
    if (payload.activeChat) {
      if (payload.friendsWithPeer) current.setFriendsInChat(true);

      const pending = payload.pendingFriendRequest;
      if (pending && pending.chatId === payload.activeChat.chatId) {
        const request = {
          requestId: pending.requestId,
          chatId: pending.chatId,
          alias: pending.alias,
          expiresAt: pending.expiresAt,
        };
        if (pending.direction === 'incoming') {
          current.setIncomingFriendRequest(request);
          current.notify(
            'info',
            activeT('{alias} ждёт ответа на заявку в друзья.', { alias: pending.alias }),
          );
        } else {
          current.setOutgoingFriendRequest(request);
        }
      }
    }

    if (payload.queued && !useAppStore.getState().chat) {
      store.beginSearching(new Date().toISOString());
    }

    // A reloaded tab learns its filters from the server, because it has no memory of them
    // and the server may already have dropped some.
    if (payload.queued && payload.search) {
      store.setSearchCriteria(payload.search.criteria, payload.search.relaxAfterMs);
    }

    // The server is the authority on what is in progress, and it has just told us: no
    // active chat and no queue entry. Anything this tab still shows therefore belongs to
    // a process that no longer exists — the API was restarted, or the reconnect grace
    // expired while the tab was offline. Leaving it on screen would let the user type
    // into a conversation nobody is listening to and only learn about it from an error.
    if (!payload.activeChat && useAppStore.getState().chat) {
      store.clearConversation();
      store.notify(
        'error',
        activeT('Соединение с сервером прервалось, чат закрыт. Найдите собеседника заново.'),
      );
    }

    if (!payload.queued && useAppStore.getState().phase === 'searching') {
      store.stopSearching();
    }
  }

  /**
   * Handles a fatal, identity-level error from the server.
   *
   * These mean the socket is about to be closed and no retry can succeed, so they are
   * separated from ordinary per-action failures (which go to the caller's ack).
   */
  private onServerError(payload: ErrorPayload): void {
    const store = useAppStore.getState();

    switch (payload.code) {
      case ErrorCode.IDENTITY_BANNED:
      case ErrorCode.FORBIDDEN_ORIGIN:
      case ErrorCode.TOO_MANY_CONNECTIONS:
        this.refused = true;
        // The transport is about to close and nothing on this screen can be used. Leaving
        // the last conversation rendered would look like the chat survived the ban.
        store.clearConversation();
        store.setConnection('rejected', describeError(payload, getActiveLocale()));
        return;

      case ErrorCode.IDENTITY_REQUIRED:
        // The session is missing or expired. Cookies may be blocked outright, so this
        // offers a retry instead of bootstrapping in a loop.
        this.refused = true;
        store.setConnection(
          'offline',
          activeT('Анонимная сессия не найдена. Нажмите «Повторить», чтобы начать заново.'),
        );
        return;

      default:
        store.notify('error', describeError(payload, getActiveLocale()));
    }
  }

  // ---------------------------------------------------------------------------
  // Command plumbing
  // ---------------------------------------------------------------------------

  /**
   * Emits a client event and waits for its acknowledgement.
   *
   * A timeout is treated as a failure *and* is important for correctness: without it,
   * a message sent into a dead socket would stay "sending" forever.
   */
  private command<T>(event: string, payload?: unknown): Promise<AckResult<T>> {
    const socket = this.socket;
    if (!socket?.connected) {
      return Promise.resolve({
        ok: false,
        error: {
          code: ErrorCode.DATABASE_UNAVAILABLE,
          message: activeT('Нет соединения с сервером.'),
        },
      });
    }

    return new Promise<AckResult<T>>((resolve) => {
      let settled = false;

      // `function` rather than a `const` arrow so that it closes over `timer` below
      // while `timer` itself can still be a `const`. Both callers run after the
      // declaration, so the temporal-dead-zone is never reached.
      function finish(result: AckResult<T>): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }

      const timer = setTimeout(() => {
        finish({
          ok: false,
          error: {
            code: ErrorCode.DATABASE_UNAVAILABLE,
            message: activeT('Сервер не ответил. Попробуйте ещё раз.'),
          },
        });
      }, COMMAND_TIMEOUT_MS);

      const emitter = socket as unknown as RawEmitter;
      const callback = (result: AckResult<T>) => finish(result);

      // Events without a payload still take an acknowledgement callback — the server
      // identifies the payload and the callback by shape, not by position.
      if (payload === undefined) emitter.emit(event, callback);
      else emitter.emit(event, payload, callback);
    });
  }

  private failed(error: ErrorPayload): CommandOutcome {
    return this.failWith(describeError(error, getActiveLocale()));
  }

  private failWith(message: string): CommandOutcome {
    useAppStore.getState().notify('error', message);
    return { ok: false, error: message };
  }

  private toSessionInfo(session: SessionView): SessionInfo {
    return {
      publicId: session.publicId,
      createdAt: session.createdAt,
      incomingRequests: session.settings.incomingRequests,
      blockingEnabled: session.blockingEnabled,
      profile: session.settings.profile,
      search: session.settings.search,
    };
  }

  /**
   * Adopts a session the REST layer just returned.
   *
   * Used by both `POST /session` (on boot and after rotation) and `PATCH /me/settings`:
   * whichever endpoint wrote the change, the browser's copy of the settings comes from
   * the server's answer rather than from what the form happened to send.
   */
  applySession(session: SessionView): void {
    useAppStore.getState().setSession(this.toSessionInfo(session));
  }
}

/** Best-effort user-facing text for anything thrown outside a socket command. */
function describeThrown(error: unknown): string {
  if (error instanceof ApiError) return describeError(error, getActiveLocale());
  if (error instanceof Error && error.message) return error.message;
  return activeT('Что-то пошло не так. Попробуйте ещё раз.');
}

export const client = new AnonymousClient();
