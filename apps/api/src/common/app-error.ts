import { ErrorCode } from '@anonlink/shared';

/**
 * A controlled, safe-to-expose application error.
 *
 * Every error that can reach a client must be an `AppError`: it carries a stable
 * {@link ErrorCode} and a message written for end users. Anything else that escapes
 * is treated as a bug and reported as a generic `INTERNAL_ERROR`, so stack traces,
 * SQL fragments and internal identifiers can never be leaked.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  /** Optional non-sensitive correlation hint, e.g. a `clientMessageId`. */
  readonly context?: string;

  constructor(
    code: ErrorCode,
    message?: string,
    options: { httpStatus?: number; context?: string; cause?: unknown } = {},
  ) {
    super(message ?? defaultMessage(code), { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? defaultStatus(code);
    this.context = options.context;
  }

  toPayload(): { code: ErrorCode; message: string; context?: string } {
    return this.context
      ? { code: this.code, message: this.message, context: this.context }
      : { code: this.code, message: this.message };
  }
}

/**
 * Messages are duplicated from `@anonlink/shared` on purpose: the shared package
 * is consumed by the browser bundle and must not import server-only code, while the
 * API wants the same wording available without a second lookup at every call site.
 */
function defaultMessage(code: ErrorCode): string {
  switch (code) {
    case ErrorCode.INVALID_INPUT:
      return 'The request contains invalid data.';
    case ErrorCode.IDENTITY_REQUIRED:
      return 'An anonymous identity is required for this action.';
    case ErrorCode.IDENTITY_NOT_FOUND:
      return 'The session is no longer valid.';
    case ErrorCode.IDENTITY_BANNED:
      return 'This identity has been suspended.';
    case ErrorCode.USER_NOT_FOUND:
      return 'No user with this User ID exists.';
    case ErrorCode.USER_UNAVAILABLE:
      return 'This user is currently unavailable.';
    case ErrorCode.SELF_TARGET_NOT_ALLOWED:
      return 'You cannot chat with yourself.';
    case ErrorCode.ALREADY_IN_CHAT:
      return 'You are already in a chat.';
    case ErrorCode.CHAT_NOT_FOUND:
      return 'This chat no longer exists.';
    case ErrorCode.NOT_A_PARTICIPANT:
      return 'You are not a participant of this chat.';
    case ErrorCode.CHAT_ENDED:
      return 'This chat has ended.';
    case ErrorCode.MESSAGE_TOO_LONG:
      return 'The message is too long.';
    case ErrorCode.MESSAGE_EMPTY:
      return 'The message is empty.';
    case ErrorCode.RATE_LIMITED:
      return 'Too many requests. Please slow down.';
    case ErrorCode.TOO_MANY_CONNECTIONS:
      return 'Too many open connections for this identity.';
    case ErrorCode.REQUEST_NOT_FOUND:
      return 'This connection request no longer exists.';
    case ErrorCode.REQUEST_EXPIRED:
      return 'This connection request has expired.';
    case ErrorCode.REQUEST_DECLINED:
      return 'The connection request was declined.';
    case ErrorCode.INCOMING_REQUESTS_DISABLED:
      return 'This user does not accept direct requests.';
    case ErrorCode.BLOCKED:
      return 'Communication with this user is not possible.';
    case ErrorCode.UNSUPPORTED_EVENT:
      return 'Unsupported event.';
    case ErrorCode.FORBIDDEN_ORIGIN:
      return 'This origin is not allowed to connect.';
    case ErrorCode.DATABASE_UNAVAILABLE:
      return 'The service is temporarily unavailable.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

function defaultStatus(code: ErrorCode): number {
  switch (code) {
    case ErrorCode.INVALID_INPUT:
    case ErrorCode.MESSAGE_TOO_LONG:
    case ErrorCode.MESSAGE_EMPTY:
      return 400;
    case ErrorCode.IDENTITY_REQUIRED:
    case ErrorCode.IDENTITY_NOT_FOUND:
      return 401;
    case ErrorCode.FORBIDDEN_ORIGIN:
    case ErrorCode.IDENTITY_BANNED:
      return 403;
    case ErrorCode.USER_NOT_FOUND:
    case ErrorCode.CHAT_NOT_FOUND:
    case ErrorCode.REQUEST_NOT_FOUND:
    case ErrorCode.REQUEST_EXPIRED:
      return 404;
    case ErrorCode.ALREADY_IN_CHAT:
    case ErrorCode.NOT_A_PARTICIPANT:
    case ErrorCode.CHAT_ENDED:
    case ErrorCode.USER_UNAVAILABLE:
    case ErrorCode.REQUEST_DECLINED:
    case ErrorCode.INCOMING_REQUESTS_DISABLED:
    case ErrorCode.BLOCKED:
    case ErrorCode.SELF_TARGET_NOT_ALLOWED:
      return 409;
    case ErrorCode.RATE_LIMITED:
    case ErrorCode.TOO_MANY_CONNECTIONS:
      return 429;
    case ErrorCode.DATABASE_UNAVAILABLE:
      return 503;
    default:
      return 500;
  }
}
