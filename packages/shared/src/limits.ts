/** Shared numeric limits and defaults. Single source of truth for both apps. */

/** Fallback when `MESSAGE_MAX_LENGTH` is not configured. */
export const DEFAULT_MESSAGE_MAX_LENGTH = 2000;

/** Hard ceiling that configuration can never exceed. */
export const ABSOLUTE_MESSAGE_MAX_LENGTH = 4000;

export const MESSAGE_MIN_LENGTH = 1;

/** Maximum length of the client-generated idempotency key of a message. */
export const CLIENT_MESSAGE_ID_MAX_LENGTH = 64;

/** Maximum length of the optional greeting attached to a direct connection request. */
export const CONNECT_REQUEST_NOTE_MAX_LENGTH = 200;

/** How long a direct connection request stays actionable. */
export const CONNECT_REQUEST_TTL_MS = 60_000;

/** How long an idle matching ticket may stay in the queue before it is dropped. */
export const MATCH_TICKET_TTL_MS = 5 * 60_000;

/** How long a finished chat is kept in memory so late events can be answered. */
export const CHAT_TOMBSTONE_TTL_MS = 2 * 60_000;

/** Maximum number of messages retained in memory per active chat. */
export const CHAT_MEMORY_MESSAGE_LIMIT = 200;

/** Maximum number of participants' socket connections kept per chat. */
export const DEFAULT_MAX_SOCKETS_PER_USER = 4;

/** Length of the random session secret (bytes). 32 bytes = 256 bits. */
export const SESSION_TOKEN_BYTES = 32;

export const REPORT_REASONS = ['spam', 'abuse', 'sexual', 'violence', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export type IncomingRequestPolicy = 'everyone' | 'nobody';
export const INCOMING_REQUEST_POLICIES: readonly IncomingRequestPolicy[] = ['everyone', 'nobody'];

/** How a chat came to exist. */
export type ChatKind = 'random' | 'direct';
export const CHAT_KINDS: readonly ChatKind[] = ['random', 'direct'];

export type ChatEndReason =
  'left' | 'peer_left' | 'disconnected' | 'blocked' | 'reported' | 'server_shutdown' | 'expired';

export const CHAT_END_REASONS: readonly ChatEndReason[] = [
  'left',
  'peer_left',
  'disconnected',
  'blocked',
  'reported',
  'server_shutdown',
  'expired',
];
