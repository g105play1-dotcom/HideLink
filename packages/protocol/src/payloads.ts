import type {
  ChatEndReason,
  ChatKind,
  ChatMessageInput,
  ConnectRequestInput,
  ConnectRespondInput,
  ErrorCode,
  FriendRequestInput,
  FriendRespondInput,
  FriendView,
  IdentitySettingsView,
  RelaxableCriterion,
  ReportInput,
  SearchPreferences,
} from '@anonlink/shared';

/**
 * Payloads exchanged over the realtime channel.
 *
 * Privacy rules baked into these types (see docs/SECURITY.md):
 *  - The peer's public User ID is only ever disclosed in *direct* chats, where the
 *    user already knows it. Random matches stay fully anonymous, which removes the
 *    main stalking vector of "match until you find someone, then follow them".
 *  - A message is explicitly addressed `from: 'you' | 'peer'` instead of carrying the
 *    sender's identity, so the payload can never leak an identifier by accident.
 */

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  /** Optional machine-readable context, e.g. the `clientMessageId` that failed. */
  context?: string;
}

/** `{ ok: true }` / `{ ok: false }` discriminated union used by all acknowledgements. */
export type AckResult<T> = { ok: true; data: T } | { ok: false; error: ErrorPayload };

export type AckHandler<T> = (result: AckResult<T>) => void;

/**
 * The identity's own settings, exactly as the REST surface returns them.
 *
 * Aliased rather than re-declared: the socket and REST describe the same object, and two
 * declarations would drift the first time a field is added to one of them.
 */
export type IdentitySettings = IdentitySettingsView;

/** How a peer is presented to this client. */
export interface PeerView {
  /** Friendly per-chat label, e.g. `Stranger 7K3M`. */
  alias: string;
  /** Present only for direct chats. */
  publicId?: string;
}

export type { ChatKind };

export interface ChatView {
  chatId: string;
  kind: ChatKind;
  peer: PeerView;
  startedAt: string;
  /**
   * Present and `true` only when this is a direct chat between people who are already
   * friends. A new direct chat has to say so: `chat:started` is the only event the two
   * clients receive, and without this flag the button would offer "add friend" to a
   * friend until the next reload.
   *
   * Omitted for random chats, where a friendship cannot exist by construction, and for
   * direct chats whose participants are not friends.
   */
  friendsWithPeer?: boolean;
}

export interface ChatMessageView {
  messageId: string;
  chatId: string;
  from: 'you' | 'peer';
  text: string;
  /** ISO-8601 UTC timestamp assigned by the server. */
  sentAt: string;
  /**
   * Echoed back to the sender only, so an optimistic UI entry can be reconciled
   * without guessing. Never present on the peer's copy.
   */
  clientMessageId?: string;
}

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export interface SessionReadyPayload {
  protocolVersion: number;
  publicId: string;
  identityCreatedAt: string;
  /**
   * Whether the platform offers the "block a peer" action at all.
   *
   * A platform policy (D31), repeated on the socket handshake so a reconnecting tab does
   * not have to ask REST again. The client uses it only to hide the button; the server
   * refuses the action regardless.
   */
  blockingEnabled: boolean;
  settings: IdentitySettings;
  /**
   * Effective server limits.
   *
   * `messageMaxLength` is configurable per deployment, so the composer reads it from
   * here instead of hard-coding a number that could disagree with the server and
   * leave the user guessing why a message was rejected.
   */
  limits: { messageMaxLength: number };
  /** State the server already holds for this identity, so a reconnect is lossless. */
  queued: boolean;
  /**
   * The filters a running search is being matched with, and when they will be widened.
   *
   * Present only while `queued`. A reloaded tab has no memory of what it asked for, and
   * without this the waiting screen could not say which filters are in force — it would
   * have to show either nothing or the client's guess, and a guess is exactly what the
   * user must never be shown while the server is quietly dropping filters.
   */
  search?: SearchStatusPayload;
  activeChat?: ChatView;
  /**
   * Whether the caller and the other participant of `activeChat` are already friends.
   *
   * The button has no other way to know after a reload: a friendship is durable, while a
   * pending request is ephemeral. Without this a reload during a chat with a friend would
   * offer "add friend" again, and the server would have to refuse it.
   */
  friendsWithPeer?: boolean;
  /**
   * A friend request that was pending when this socket connected.
   *
   * Friend requests live in the API process, not in a mailbox, so a reload can otherwise
   * make one disappear from the screen while the other side is still waiting for an
   * answer. Restoring it is what makes a reload lossless.
   */
  pendingFriendRequest?: PendingFriendRequestPayload;
}

/** A friend request restored after a reconnect, from this client's point of view. */
export interface PendingFriendRequestPayload {
  requestId: string;
  chatId: string;
  /** The peer's per-chat alias. Never a User ID. */
  alias: string;
  expiresAt: string;
  direction: 'incoming' | 'outgoing';
}

/** What the server is applying to a search, and when it will start widening it. */
export interface SearchStatusPayload {
  criteria: SearchPreferences;
  /** Milliseconds from now until the next filter is dropped, or `null` for never. */
  relaxAfterMs: number | null;
}

export interface MatchQueuedPayload extends SearchStatusPayload {
  queuedAt: string;
}

/**
 * Filters were dropped to widen a long search.
 *
 * Sent to the waiting user only, and only when they explicitly allowed it. `dropped`
 * names exactly what no longer applies, so the interface can say "ищем без фильтра по
 * языку" instead of silently handing over a partner outside the requested range.
 */
export interface MatchRelaxedPayload {
  dropped: RelaxableCriterion[];
  /** The criteria now in force. */
  criteria: SearchPreferences;
}

export type MatchCancelReason = 'user' | 'timeout' | 'chat_started';

export interface MatchCancelledPayload {
  reason: MatchCancelReason;
}

export interface ActiveChatPayload {
  chat: ChatView;
  messages: ChatMessageView[];
  /** `true` when this client triggered the chat (random match or outgoing request). */
  initiator: boolean;
}

export interface ChatEndedPayload {
  chatId: string;
  reason: ChatEndReason;
}

export interface PeerPresencePayload {
  chatId: string;
}

export interface IncomingRequestPayload {
  requestId: string;
  from: PeerView;
  note?: string;
  expiresAt: string;
}

export type RequestStatus =
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'cancelled'
  | 'unavailable'
  | 'blocked'
  | 'disabled'
  | 'self';

export interface RequestResolvedPayload {
  requestId: string;
  status: RequestStatus;
  /** Present when the request resulted in a chat. */
  chat?: ChatView;
}

export interface PeerBlockedPayload {
  publicId: string;
  /** Set when blocking also terminated an active chat. */
  chatId?: string;
}

/**
 * An in-chat friend request, as shown to the person being asked.
 *
 * It deliberately carries only the per-chat alias. The requester's User ID is disclosed
 * if and only if the request is accepted, at which point both sides learn each other's ID.
 */
export interface IncomingFriendPayload {
  requestId: string;
  chatId: string;
  alias: string;
  expiresAt: string;
}

export type FriendRequestStatus = 'accepted' | 'declined' | 'expired' | 'cancelled' | 'unavailable';

export interface FriendResolvedPayload {
  requestId: string;
  chatId: string;
  status: FriendRequestStatus;
  /** Present only when the request was accepted. */
  friend?: FriendView;
}

export interface FriendRemovedPayload {
  /** The User ID of the person who is no longer a friend. */
  publicId: string;
}

// ---------------------------------------------------------------------------
// Client -> server acknowledgement data
// ---------------------------------------------------------------------------

export interface MatchJoinResult {
  queued: boolean;
  waitingSince: string;
}

export interface MatchCancelResult {
  cancelled: boolean;
}

export interface ChatMessageResult {
  messageId: string;
  sentAt: string;
}

export interface ChatLeaveResult {
  ended: boolean;
}

export interface ChatNextResult {
  queued: boolean;
}

export interface SendRequestResult {
  requestId: string;
  expiresAt: string;
}

export interface RespondRequestResult {
  accepted: boolean;
}

export interface ReportResult {
  reportId: string;
}

export interface BlockPeerResult {
  blocked: boolean;
  publicId: string;
}

/**
 * Acknowledgement of `friend:request`.
 *
 * `accepted` is `true` when the peer had already asked the same question and this call
 * therefore completed the mutual agreement. In that case `friend:resolved` follows for
 * both sides; the acknowledgement alone is enough to update the button.
 */
export interface FriendRequestResult {
  requestId: string;
  chatId: string;
  expiresAt: string;
  accepted: boolean;
}

export interface FriendRespondResult {
  accepted: boolean;
}

export interface BlockPeerInput {
  chatId: string;
}

// ---------------------------------------------------------------------------
// Socket.IO event maps
// ---------------------------------------------------------------------------

/**
 * Events a browser may emit.
 *
 * Payload types are the *client-side* shapes; the gateway re-validates every
 * payload with the matching schema from `@anonlink/shared` and never trusts
 * these types at runtime.
 */
export interface ClientToServerEvents {
  'match:join': (ack?: AckHandler<MatchJoinResult>) => void;
  'match:cancel': (ack?: AckHandler<MatchCancelResult>) => void;
  'chat:message': (payload: ChatMessageInput, ack?: AckHandler<ChatMessageResult>) => void;
  'chat:leave': (
    payload: { chatId: string; findNext?: boolean },
    ack?: AckHandler<ChatLeaveResult>,
  ) => void;
  'chat:next': (payload: { chatId: string }, ack?: AckHandler<ChatNextResult>) => void;
  'request:send': (payload: ConnectRequestInput, ack?: AckHandler<SendRequestResult>) => void;
  'request:respond': (payload: ConnectRespondInput, ack?: AckHandler<RespondRequestResult>) => void;
  'report:send': (payload: ReportInput, ack?: AckHandler<ReportResult>) => void;
  'block:peer': (payload: BlockPeerInput, ack?: AckHandler<BlockPeerResult>) => void;
  'friend:request': (payload: FriendRequestInput, ack?: AckHandler<FriendRequestResult>) => void;
  'friend:respond': (payload: FriendRespondInput, ack?: AckHandler<FriendRespondResult>) => void;
}

/** Events the server may push. */
export interface ServerToClientEvents {
  'session:ready': (payload: SessionReadyPayload) => void;
  'session:rotated': (payload: { publicId: string }) => void;
  'match:queued': (payload: MatchQueuedPayload) => void;
  'match:cancelled': (payload: MatchCancelledPayload) => void;
  'match:relaxed': (payload: MatchRelaxedPayload) => void;
  'chat:started': (payload: ActiveChatPayload) => void;
  'chat:resumed': (payload: ActiveChatPayload) => void;
  'chat:message': (payload: ChatMessageView) => void;
  'chat:ended': (payload: ChatEndedPayload) => void;
  'chat:peer-away': (payload: PeerPresencePayload) => void;
  'chat:peer-back': (payload: PeerPresencePayload) => void;
  'request:incoming': (payload: IncomingRequestPayload) => void;
  'request:resolved': (payload: RequestResolvedPayload) => void;
  'peer:blocked': (payload: PeerBlockedPayload) => void;
  'friend:incoming': (payload: IncomingFriendPayload) => void;
  'friend:resolved': (payload: FriendResolvedPayload) => void;
  'friend:removed': (payload: FriendRemovedPayload) => void;
  'app:error': (payload: ErrorPayload) => void;
}

export interface InterServerEvents {
  ping: () => void;
}

/**
 * Per-socket server-side state. `socket.data` is never serialised to clients,
 * so internal identifiers may live here.
 */
export interface SocketData {
  /** Internal database id of the identity. Never sent to the browser. */
  userId: string;
  /** Public User ID, safe to display. */
  publicId: string;
  /** Internal session id. */
  sessionId: string;
}
