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
  type ServerToClientEvents,
  type SessionReadyPayload,
} from '@anonlink/protocol';
import { io, type Socket } from 'socket.io-client';

import { API_ORIGIN } from './config';
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
      store.setConnection('offline', message);
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

      store.notify('success', 'Вы получили новый User ID. Прошлый больше не действует.');
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
        current.failMessage(clientMessageId, describeError(result.error));
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
    const chatId = useAppStore.getState().chat?.chatId;
    if (!chatId) return this.failWith('Чат не найден.');

    const result = await this.command<ReportResult>('report:send', {
      chatId,
      reason,
      ...(details ? { details } : {}),
    });
    return result.ok ? { ok: true } : this.failed(result.error);
  }

  /** Blocks the peer of the current chat. Blocking also ends it, server-side. */
  async blockCurrentPeer(): Promise<CommandOutcome> {
    const chatId = useAppStore.getState().chat?.chatId;
    if (!chatId) return this.failWith('Чат не найден.');

    const result = await this.command<BlockPeerResult>('block:peer', { chatId });
    return result.ok ? { ok: true } : this.failed(result.error);
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
            .setConnection('offline', 'Сервер закрыл соединение. Нажмите «Повторить».');
          return;
        }

        this.serverCloseRetries += 1;
        this.reconnectSoon(400 * this.serverCloseRetries);
        return;
      }

      // Socket.IO reconnects on its own for transport-level failures.
      useAppStore.getState().setConnection('reconnecting', 'Соединение потеряно. Восстанавливаем…');
    });

    socket.on('connect_error', () => {
      useAppStore.getState().setConnection('reconnecting', 'Не удаётся подключиться. Повторяем…');
    });

    socket.io.on('reconnect_failed', () => {
      useAppStore
        .getState()
        .setConnection('offline', 'Не удалось восстановить соединение. Нажмите «Повторить».');
    });

    socket.on('session:ready', (payload) => this.onSessionReady(payload));
    socket.on('session:rotated', () => useAppStore.getState().clearConversation());

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
      store.notify('info', `Ищем шире: ${describeDroppedCriteria(payload.dropped)}.`);
    });

    socket.on('match:cancelled', (payload) => {
      useAppStore.getState().stopSearching();
      // `chat_started` is not worth a toast: the chat screen is already opening.
      if (payload.reason !== 'chat_started') {
        useAppStore.getState().notify('info', describeMatchCancel(payload.reason));
      }
    });

    socket.on('chat:started', (payload) => {
      useAppStore
        .getState()
        .startChat(toChatInfo(payload.chat, payload.initiator), toUiMessages(payload.messages));
    });

    socket.on('chat:resumed', (payload) => {
      useAppStore
        .getState()
        .restoreChat(toChatInfo(payload.chat, payload.initiator), toUiMessages(payload.messages));
    });

    socket.on('chat:message', (payload) => {
      useAppStore.getState().receiveMessage(payload);
    });

    socket.on('chat:peer-away', () => useAppStore.getState().setPeerAway(true));
    socket.on('chat:peer-back', () => useAppStore.getState().setPeerAway(false));

    socket.on('chat:ended', (payload) => {
      useAppStore.getState().endChat(payload.chatId, payload.reason);
      useAppStore.getState().setOutgoingRequest(null);
    });

    socket.on('request:incoming', (payload) => {
      useAppStore.getState().addIncomingRequest(payload);
      useAppStore.getState().notify('info', `${payload.from.alias} хочет начать чат.`);
    });

    socket.on('request:resolved', (payload) => {
      const store = useAppStore.getState();
      store.setOutgoingRequest(null);
      store.removeIncomingRequest(payload.requestId);

      if (payload.chat) {
        // The sender of an accepted request learns the chat from here; the recipient
        // learns it from `chat:started`. Either way the state is the same.
        store.startChat(toChatInfo(payload.chat, true), []);
        return;
      }

      if (payload.status !== 'accepted') {
        store.notify('info', describeRequestStatus(payload.status));
      }
    });

    socket.on('peer:blocked', () => {
      useAppStore.getState().notify('success', 'Пользователь заблокирован.');
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
      profile: payload.settings.profile,
      search: payload.settings.search,
    });
    store.setMessageMaxLength(payload.limits.messageMaxLength);

    if (payload.protocolVersion !== PROTOCOL_VERSION) {
      store.setProtocolMismatch(true);
      store.notify('error', 'Версия приложения устарела. Обновите страницу (Ctrl+F5).');
    }

    // `chat:resumed` normally arrives first with the transcript. This is the fallback
    // for the case where it has not been delivered yet.
    if (payload.activeChat && !useAppStore.getState().chat) {
      store.restoreChat(toChatInfo(payload.activeChat, false), []);
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
        'Соединение с сервером прервалось, чат закрыт. Найдите собеседника заново.',
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
        store.setConnection('rejected', describeError(payload));
        return;

      case ErrorCode.IDENTITY_REQUIRED:
        // The session is missing or expired. Cookies may be blocked outright, so this
        // offers a retry instead of bootstrapping in a loop.
        this.refused = true;
        store.setConnection(
          'offline',
          'Анонимная сессия не найдена. Нажмите «Повторить», чтобы начать заново.',
        );
        return;

      default:
        store.notify('error', describeError(payload));
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
          message: 'Нет соединения с сервером.',
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
            message: 'Сервер не ответил. Попробуйте ещё раз.',
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
    return this.failWith(describeError(error));
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
  if (error instanceof ApiError) return describeError(error);
  if (error instanceof Error && error.message) return error.message;
  return 'Что-то пошло не так. Попробуйте ещё раз.';
}

export const client = new AnonymousClient();
