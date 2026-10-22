import { z } from 'zod';

import { ErrorCode } from './errors.js';
import { PUBLIC_ID_PREFIX, isValidPublicId, normalizePublicId } from './ids.js';
import {
  ABSOLUTE_MESSAGE_MAX_LENGTH,
  ADMIN_BAN_REASON_MAX_LENGTH,
  ADMIN_BAN_REASON_MIN_LENGTH,
  CLIENT_MESSAGE_ID_MAX_LENGTH,
  CONNECT_REQUEST_NOTE_MAX_LENGTH,
  MESSAGE_MIN_LENGTH,
  OWNER_CONTACT_MAX_LENGTH,
  OWNER_MESSAGE_MAX_LENGTH,
  OWNER_MESSAGE_TOPICS,
  REPORT_REASONS,
  REPORT_STATUSES,
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

/** WebSocket: `friend:request` — ask the current chat peer to become a friend. */
export const friendRequestSchema = z.object({ chatId: chatIdSchema }).strict();

/** WebSocket: `friend:respond` */
export const friendRespondSchema = z
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
export type FriendRequestInput = z.infer<typeof friendRequestSchema>;
export type FriendRespondInput = z.infer<typeof friendRespondSchema>;
export type ReportInput = z.infer<typeof reportSchema>;
export type SettingsInput = SettingsUpdate;

/**
 * REST: `POST /api/v1/owner/messages` — the "contact the owner" form.
 *
 * The sender's identity is *not* part of the body: the server takes it from the session,
 * so a client cannot file a message as somebody else. `contact` stays free text on
 * purpose (see `OWNER_CONTACT_MAX_LENGTH`).
 */
export const ownerMessageSchema = z
  .object({
    topic: z.enum(OWNER_MESSAGE_TOPICS),
    text: z.string().trim().min(1).max(OWNER_MESSAGE_MAX_LENGTH),
    contact: z.string().trim().max(OWNER_CONTACT_MAX_LENGTH).optional(),
  })
  .strict();

export type OwnerMessageInput = z.infer<typeof ownerMessageSchema>;

// -----------------------------------------------------------------------------
// Owner (admin) surface
// -----------------------------------------------------------------------------

/**
 * REST: `POST /api/v1/admin/session`.
 *
 * The owner's key, sent once, in exchange for an HttpOnly cookie. Deliberately a plain
 * bounded string rather than the User ID schema: it is not a User ID, and normalising it
 * the way an ID is normalised would silently mangle a legitimate secret.
 */
export const adminSessionSchema = z.object({ token: z.string().min(1).max(512) }).strict();

/** REST: `GET /api/v1/admin/identities?q=` — find a User ID, or find by prefix. */
export const adminIdentityQuerySchema = z
  .object({ q: z.string().trim().max(64).optional() })
  .strict();

/** REST: `GET /api/v1/admin/archives?limit=` */
export const archiveListQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(200).optional() })
  .strict();

/** REST: `GET` / `DELETE /api/v1/admin/archives/:chatId` */
export const archiveParamsSchema = z.object({ chatId: chatIdSchema }).strict();

/**
 * REST: `POST /api/v1/admin/archives/delete-all`.
 *
 * Deleting the whole archive is irreversible, so the request has to say so explicitly.
 * A stray request (a retried one, a prefetched link) can then never wipe it.
 */
export const adminConfirmSchema = z.object({ confirm: z.literal(true) }).strict();

/** REST: `GET /api/v1/admin/messages?limit=` — the owner's inbox. */
export const ownerMessageListQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(200).optional() })
  .strict();

/** REST: `DELETE /api/v1/admin/messages/:id` */
export const ownerMessageParamsSchema = z.object({ id: z.uuid() }).strict();

/**
 * REST: `PUT /api/v1/admin/platform`.
 *
 * A whole object with three required switches, `.strict()`: a request that tries to set
 * anything the owner surface does not control is rejected rather than silently ignored.
 * A full replace is deliberate — the admin page always sends the complete policy it just
 * read, so one field cannot be changed while another is accidentally reset by a partial
 * body.
 */
export const adminPlatformSchema = z
  .object({
    blockingEnabled: z.boolean(),
    aiAutonomyEnabled: z.boolean(),
    aiCompanionEnabled: z.boolean(),
  })
  .strict();

/** REST: `GET /api/v1/admin/reports?limit=` */
export const adminReportListQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(200).optional() })
  .strict();

/** REST: `PATCH /api/v1/admin/reports/:id` */
export const adminReportParamsSchema = z.object({ id: z.uuid() }).strict();

/**
 * REST: `PATCH /api/v1/admin/reports/:id` body.
 *
 * Only the status is editable. Reason, text and participants are evidence: rewriting
 * them would make the record disagree with what the reporter actually sent.
 */
export const adminReportUpdateSchema = z.object({ status: z.enum(REPORT_STATUSES) }).strict();

/**
 * REST: `POST /api/v1/admin/identities/:publicId/ban` body.
 *
 * The reason is required and bounded: a ban is a manual decision whose explanation should
 * travel with it while it stands. Unbanning takes no body — it is the correction of a
 * mistake, not a second decision that needs a justification.
 */
export const adminBanSchema = z
  .object({
    reason: z.string().trim().min(ADMIN_BAN_REASON_MIN_LENGTH).max(ADMIN_BAN_REASON_MAX_LENGTH),
  })
  .strict();

export type AdminSessionInput = z.infer<typeof adminSessionSchema>;
export type AdminIdentityQuery = z.infer<typeof adminIdentityQuerySchema>;
export type ArchiveListQuery = z.infer<typeof archiveListQuerySchema>;
export type ArchiveParams = z.infer<typeof archiveParamsSchema>;
export type AdminConfirmInput = z.infer<typeof adminConfirmSchema>;
export type OwnerMessageListQuery = z.infer<typeof ownerMessageListQuerySchema>;
export type OwnerMessageParams = z.infer<typeof ownerMessageParamsSchema>;
export type AdminPlatformInput = z.infer<typeof adminPlatformSchema>;
export type AdminReportListQuery = z.infer<typeof adminReportListQuerySchema>;
export type AdminReportParams = z.infer<typeof adminReportParamsSchema>;
export type AdminReportUpdateInput = z.infer<typeof adminReportUpdateSchema>;
export type AdminBanInput = z.infer<typeof adminBanSchema>;
