/**
 * Stable, machine-readable error codes shared by HTTP and WebSocket layers.
 *
 * Rules:
 *  - A code is part of the public API contract; never re-use one for a different meaning.
 *  - Messages returned to clients must never leak internals (stack traces, SQL, ids).
 */
export const ErrorCode = {
  INVALID_INPUT: 'INVALID_INPUT',
  IDENTITY_REQUIRED: 'IDENTITY_REQUIRED',
  IDENTITY_NOT_FOUND: 'IDENTITY_NOT_FOUND',
  IDENTITY_BANNED: 'IDENTITY_BANNED',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_UNAVAILABLE: 'USER_UNAVAILABLE',
  SELF_TARGET_NOT_ALLOWED: 'SELF_TARGET_NOT_ALLOWED',
  ALREADY_IN_CHAT: 'ALREADY_IN_CHAT',
  CHAT_NOT_FOUND: 'CHAT_NOT_FOUND',
  NOT_A_PARTICIPANT: 'NOT_A_PARTICIPANT',
  CHAT_ENDED: 'CHAT_ENDED',
  MESSAGE_TOO_LONG: 'MESSAGE_TOO_LONG',
  MESSAGE_EMPTY: 'MESSAGE_EMPTY',
  RATE_LIMITED: 'RATE_LIMITED',
  TOO_MANY_CONNECTIONS: 'TOO_MANY_CONNECTIONS',
  REQUEST_NOT_FOUND: 'REQUEST_NOT_FOUND',
  REQUEST_EXPIRED: 'REQUEST_EXPIRED',
  REQUEST_DECLINED: 'REQUEST_DECLINED',
  INCOMING_REQUESTS_DISABLED: 'INCOMING_REQUESTS_DISABLED',
  ALREADY_FRIENDS: 'ALREADY_FRIENDS',
  FRIEND_REQUEST_NOT_FOUND: 'FRIEND_REQUEST_NOT_FOUND',
  FRIEND_REQUEST_EXPIRED: 'FRIEND_REQUEST_EXPIRED',
  BLOCKED: 'BLOCKED',
  /**
   * The administration has switched the "block" action off for the whole platform.
   *
   * A separate code from `BLOCKED` on purpose: one means "you and that person are
   * separated", the other means "this action is not offered here at all". Collapsing
   * them would make a stale tab look like the other person's doing.
   */
  BLOCKING_DISABLED: 'BLOCKING_DISABLED',
  REPORT_NOT_FOUND: 'REPORT_NOT_FOUND',
  UNSUPPORTED_EVENT: 'UNSUPPORTED_EVENT',
  ADMIN_AUTH_REQUIRED: 'ADMIN_AUTH_REQUIRED',
  FORBIDDEN_ORIGIN: 'FORBIDDEN_ORIGIN',
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  DATABASE_UNAVAILABLE: 'DATABASE_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Default human-readable (and intentionally vague) message per code. */
const MESSAGES: Record<ErrorCode, string> = {
  INVALID_INPUT: 'The request contains invalid data.',
  IDENTITY_REQUIRED: 'An anonymous identity is required for this action.',
  IDENTITY_NOT_FOUND: 'The session is no longer valid. A new identity will be created.',
  IDENTITY_BANNED: 'This identity has been suspended.',
  USER_NOT_FOUND: 'No user with this User ID exists.',
  USER_UNAVAILABLE: 'This user is currently unavailable.',
  SELF_TARGET_NOT_ALLOWED: 'You cannot chat with yourself.',
  ALREADY_IN_CHAT: 'You are already in a chat.',
  CHAT_NOT_FOUND: 'This chat no longer exists.',
  NOT_A_PARTICIPANT: 'You are not a participant of this chat.',
  CHAT_ENDED: 'This chat has ended.',
  MESSAGE_TOO_LONG: 'The message is too long.',
  MESSAGE_EMPTY: 'The message is empty.',
  RATE_LIMITED: 'Too many requests. Please slow down.',
  TOO_MANY_CONNECTIONS: 'Too many open connections for this identity.',
  REQUEST_NOT_FOUND: 'This connection request no longer exists.',
  REQUEST_EXPIRED: 'This connection request has expired.',
  REQUEST_DECLINED: 'The connection request was declined.',
  INCOMING_REQUESTS_DISABLED: 'This user does not accept direct requests.',
  ALREADY_FRIENDS: 'You are already friends with this person.',
  FRIEND_REQUEST_NOT_FOUND: 'This friend request no longer exists.',
  FRIEND_REQUEST_EXPIRED: 'This friend request has expired.',
  BLOCKED: 'Communication with this user is not possible.',
  BLOCKING_DISABLED: 'Blocking is disabled by the administration.',
  REPORT_NOT_FOUND: 'This report no longer exists.',
  UNSUPPORTED_EVENT: 'Unsupported event.',
  ADMIN_AUTH_REQUIRED: 'The owner key is required for this endpoint.',
  FORBIDDEN_ORIGIN: 'This origin is not allowed to connect.',
  ROUTE_NOT_FOUND: 'This endpoint does not exist.',
  PAYLOAD_TOO_LARGE: 'The request body is too large.',
  INTERNAL_ERROR: 'Something went wrong. Please try again.',
  DATABASE_UNAVAILABLE: 'The service is temporarily unavailable.',
};

export function errorMessage(code: ErrorCode): string {
  return MESSAGES[code];
}
