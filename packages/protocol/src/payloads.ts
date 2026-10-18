import type {
  ChatEndReason,
  ChatKind,
  ChatMessageInput,
  ConnectRequestInput,
  ConnectRespondInput,
  ErrorCode,
  IncomingRequestPolicy,
  ReportInput,
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

export interface IdentitySettings {
  incomingRequests: IncomingRequestPolicy;
}

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
  settings: IdentitySettings;
  /** State the server already holds for this identity, so a reconnect is lossless. */
  queued: boolean;
  activeChat?: ChatView;
}

export interface MatchQueuedPayload {
  queuedAt: string;
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
  'chat:leave': (payload: { chatId: string; findNext?: boolean }, ack?: AckHandler<ChatLeaveResult>) => void;
  'chat:next': (payload: { chatId: string }, ack?: AckHandler<ChatNextResult>) => void;
  'request:send': (payload: ConnectRequestInput, ack?: AckHandler<SendRequestResult>) => void;
  'request:respond': (payload: ConnectRespondInput, ack?: AckHandler<RespondRequestResult>) => void;
  'report:send': (payload: ReportInput, ack?: AckHandler<ReportResult>) => void;
  'block:peer': (payload: BlockPeerInput, ack?: AckHandler<BlockPeerResult>) => void;
}

/** Events the server may push. */
export interface ServerToClientEvents {
  'session:ready': (payload: SessionReadyPayload) => void;
  'session:rotated': (payload: { publicId: string }) => void;
  'match:queued': (payload: MatchQueuedPayload) => void;
  'match:cancelled': (payload: MatchCancelledPayload) => void;
  'chat:started': (payload: ActiveChatPayload) => void;
  'chat:resumed': (payload: ActiveChatPayload) => void;
  'chat:message': (payload: ChatMessageView) => void;
  'chat:ended': (payload: ChatEndedPayload) => void;
  'chat:peer-away': (payload: PeerPresencePayload) => void;
  'chat:peer-back': (payload: PeerPresencePayload) => void;
  'request:incoming': (payload: IncomingRequestPayload) => void;
  'request:resolved': (payload: RequestResolvedPayload) => void;
  'peer:blocked': (payload: PeerBlockedPayload) => void;
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
