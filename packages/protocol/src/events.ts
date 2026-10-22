/**
 * Wire-format version of the realtime contract.
 *
 * Bump whenever the meaning of an existing event or payload field changes.
 * The server rejects (in a backwards-compatible way: it just reports a
 * mismatch) clients that announce an incompatible version.
 */
export const PROTOCOL_VERSION = 1;

/** Client -> server event names. */
export const ClientEvent = {
  /** Start random matchmaking. */
  MatchJoin: 'match:join',
  /** Stop random matchmaking. */
  MatchCancel: 'match:cancel',
  /** Send a chat message. */
  ChatMessage: 'chat:message',
  /** End the current chat. */
  ChatLeave: 'chat:leave',
  /** End the current chat and immediately look for a new peer. */
  ChatNext: 'chat:next',
  /** Ask a specific User ID for a direct chat. */
  RequestSend: 'request:send',
  /** Accept or decline an incoming direct request. */
  RequestRespond: 'request:respond',
  /** Report the current chat or one of its messages. */
  ReportSend: 'report:send',
  /** Block the peer of the current chat. */
  BlockPeer: 'block:peer',
  /** Ask the current chat peer to become a friend. */
  FriendRequest: 'friend:request',
  /** Accept or decline an incoming friend request. */
  FriendRespond: 'friend:respond',
} as const;

export type ClientEventName = (typeof ClientEvent)[keyof typeof ClientEvent];

/** Server -> client event names. */
export const ServerEvent = {
  /** Handshake accepted; identity attached. */
  SessionReady: 'session:ready',
  /** The identity was rotated (old session invalidated). */
  SessionRotated: 'session:rotated',
  /** The socket is now in the matchmaking queue. */
  MatchQueued: 'match:queued',
  /** The socket was removed from the queue without a match. */
  MatchCancelled: 'match:cancelled',
  /**
   * Filters were dropped to widen a search that is taking a long time.
   *
   * Sent instead of a silent widening: the user chose those filters, so the server tells
   * them what it stopped applying rather than quietly handing over someone outside them.
   */
  MatchRelaxed: 'match:relaxed',
  /** A new chat started (random match or accepted direct request). */
  ChatStarted: 'chat:started',
  /** An already-active chat was re-attached after a reconnect. */
  ChatResumed: 'chat:resumed',
  /** An incoming chat message. */
  ChatMessage: 'chat:message',
  /** The peer's connection dropped; the chat is paused, not over. */
  ChatPeerAway: 'chat:peer-away',
  /** The peer came back within the reconnect grace period. */
  ChatPeerBack: 'chat:peer-back',
  /** The chat is over. */
  ChatEnded: 'chat:ended',
  /** Someone wants a direct chat with this identity. */
  RequestIncoming: 'request:incoming',
  /** Outcome of a direct request this client sent or answered. */
  RequestResolved: 'request:resolved',
  /** The peer was blocked; any shared chat is over. */
  PeerBlocked: 'peer:blocked',
  /** The current chat peer wants to become friends. */
  FriendIncoming: 'friend:incoming',
  /** Outcome of a friend request this client sent or answered. */
  FriendResolved: 'friend:resolved',
  /** The other side removed this client from their friends. */
  FriendRemoved: 'friend:removed',
  /** A report named this identity; shown as a warning with a mention of a possible ban. */
  ReportWarning: 'report:warning',
  /** Non-fatal error, always addressed to a single socket. */
  Error: 'app:error',
} as const;

export type ServerEventName = (typeof ServerEvent)[keyof typeof ServerEvent];
