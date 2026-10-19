import { z } from 'zod';

import { ErrorCode } from './errors.js';
import { PUBLIC_ID_PREFIX, isValidPublicId, normalizePublicId } from './ids.js';
import {
  ABSOLUTE_MESSAGE_MAX_LENGTH,
  CLIENT_MESSAGE_ID_MAX_LENGTH,
  CONNECT_REQUEST_NOTE_MAX_LENGTH,
  MESSAGE_MIN_LENGTH,
  REPORT_REASONS,
} from './limits.js';
import type { SettingsUpdate } from './preferences.js';

/**
 * Validation schemas shared by the REST API, the WebSocket gateway and the web
 * app. Rules are defined exactly once so both ends can never drift apart.
 */

/** Public User ID. Accepts decorative separators and lower case, returns canonical form. */
export const publicIdSchema = z
  .string()
  .trim()
  .min(PUBLIC_ID_PREFIX.length + 1)
  .max(32)
  // The same normaliser the server uses, so a value that passes validation here is
  // guaranteed to be the exact string the API will look up.
  .transform(normalizePublicId)
  .refine(isValidPublicId, { message: 'Invalid User ID format.' });

/**
 * Chat identifier: an opaque UUID issued by the server.
 *
 * Validated strictly so a malformed value is rejected before it can reach a query,
 * a log line or a client. Knowing a chat id is never sufficient to join it —
 * participation is checked server-side on every event.
 */
export const chatIdSchema = z.uuid();

export const clientMessageIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(CLIENT_MESSAGE_ID_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid client message id.');

/**
 * Chat message text.
 *
 * Note: this schema validates *shape only*. Control-character stripping and
 * normalisation happen on the server (see the API's `sanitizeMessageText`),
 * because the server must never trust the client-side pipeline.
 */
export const messageTextSchema = z
  .string()
  .min(MESSAGE_MIN_LENGTH, ErrorCode.MESSAGE_EMPTY)
  .max(ABSOLUTE_MESSAGE_MAX_LENGTH, ErrorCode.MESSAGE_TOO_LONG);

/** REST: POST /api/v1/session/rotate — no body. */
export const emptySchema = z.object({}).strict();

/** WebSocket: `match:join` */
export const matchJoinSchema = z.object({}).strict();

/** WebSocket: `chat:message` */
export const chatMessageSchema = z
  .object({
    chatId: chatIdSchema,
    clientMessageId: clientMessageIdSchema,
    text: messageTextSchema,
  })
  .strict();

/** WebSocket: `chat:leave` / `chat:next` */
export const chatLeaveSchema = z
  .object({
    chatId: chatIdSchema,
    /** Set when the user explicitly wants a new peer right away. */
    findNext: z.boolean().optional(),
  })
  .strict();

/** REST: GET /api/v1/users/:publicId */
export const userLookupParamsSchema = z.object({ publicId: publicIdSchema }).strict();

/** WebSocket: `request:send` — direct contact by User ID. */
export const connectRequestSchema = z
  .object({
    publicId: publicIdSchema,
    note: z.string().trim().max(CONNECT_REQUEST_NOTE_MAX_LENGTH).optional(),
  })
  .strict();

/** WebSocket: `request:respond` */
export const connectRespondSchema = z
  .object({
    requestId: z.uuid(),
    accept: z.boolean(),
  })
  .strict();

/** REST + WebSocket: report a message or a peer. */
export const reportSchema = z
  .object({
    chatId: chatIdSchema,
    /** Server-side id of the offending message when applicable. */
    messageId: z.uuid().optional(),
    reason: z.enum(REPORT_REASONS),
    details: z.string().trim().max(1000).optional(),
  })
  .strict();

/** REST + WebSocket: block a peer by User ID. */
export const blockSchema = z.object({ publicId: publicIdSchema }).strict();

/**
 * WebSocket: `block:peer` — block the peer of the *current* chat.
 *
 * Deliberately keyed by `chatId` rather than by User ID: in a random chat the
 * client does not know (and must not learn) the peer's public ID, so the server
 * resolves the peer from the chat the caller is actually a participant of.
 */
export const blockPeerSchema = z.object({ chatId: chatIdSchema }).strict();

/**
 * REST: `PATCH /api/v1/me/settings`.
 *
 * Declared in `preferences.ts` together with the profile and filter schemas it composes,
 * and re-exported here under its original name: one endpoint, one schema. Two definitions
 * of the same request body are how a field ends up accepted by one surface and rejected
 * by the other.
 */
export { settingsUpdateSchema as settingsSchema } from './preferences.js';

export type PublicId = z.infer<typeof publicIdSchema>;
export type ChatMessageInput = z.infer<typeof chatMessageSchema>;
export type ConnectRequestInput = z.infer<typeof connectRequestSchema>;
export type ConnectRespondInput = z.infer<typeof connectRespondSchema>;
export type ReportInput = z.infer<typeof reportSchema>;
export type SettingsInput = SettingsUpdate;
