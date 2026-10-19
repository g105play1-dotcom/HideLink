import type { ArchivePolicy } from './archive.js';
import type { ChatKind, IncomingRequestPolicy } from './limits.js';
import type { DeclaredProfile, SearchPreferences } from './preferences.js';

/**
 * REST response contracts.
 *
 * These live in `@anonlink/shared` — not in the API package — precisely because the
 * browser and the server must agree on them. If they were declared server-side, the
 * web app would have to re-declare them by hand and the two would drift silently:
 * the browser would keep compiling while rendering the wrong field.
 *
 * Every view here is *deliberately* minimal. A field that is not needed to render a
 * screen is not returned, because an unused field is still a leak: it lets a caller
 * who can see the response learn something the product never intended to expose.
 */

/** Public representation of the caller's own anonymous identity. */
export interface SessionView {
  publicId: string;
  createdAt: string;
  sessionExpiresAt: string;
  settings: IdentitySettingsView;
}

/**
 * The caller's own settings, as returned by `GET /session`, `POST /session` and
 * `PATCH /me/settings`.
 *
 * One object rather than three endpoints: these are the values the settings screen
 * edits, and they are always needed together — the search filters only mean anything
 * next to the declaration they are compared against.
 */
export interface IdentitySettingsView {
  incomingRequests: IncomingRequestPolicy;
  /**
   * Whether the user wants the "block a peer" action available.
   *
   * Off means the action is not offered and the server refuses new blocks. Blocks that
   * already exist are neither removed nor forgotten — see docs/DECISIONS.md D24.
   */
  blockingEnabled: boolean;
  /** What the owner says about themselves. Unverified; used only to evaluate filters. */
  profile: DeclaredProfile;
  /** How the owner wants random partners filtered. */
  search: SearchPreferences;
}

export interface CurrentSessionView {
  authenticated: boolean;
  session: SessionView | null;
}

/**
 * The result of looking a User ID up.
 *
 * Note what is absent: nothing about activity, ban state or account age. Returning
 * "exists but is banned" would turn the endpoint into an oracle, so a banned identity
 * is reported exactly like a normal one. `acceptsRequests` is included because it is
 * something the caller can act on (they should not bother sending a request).
 */
export interface UserLookupView {
  publicId: string;
  exists: boolean;
  acceptsRequests: boolean;
}

/** One entry in the caller's own block list. */
export interface BlockedUserView {
  publicId: string;
  blockedAt: string;
}

export interface BlockListResponse {
  blocks: BlockedUserView[];
}

// -----------------------------------------------------------------------------
// Owner (admin) surface
// -----------------------------------------------------------------------------
//
// Returned only by the admin endpoints, which are reachable only with the owner's key
// (see docs/SECURITY.md). Shared with the web app for the same reason as every other
// view: the browser must not re-declare the shape by hand, or the two drift silently.

/** Whether the owner surface exists at all, i.e. whether `ADMIN_TOKEN` is configured. */
export interface AdminStatusView {
  available: boolean;
}

/** One identity as the owner sees it. Deliberately minimal: an ID and a date. */
export interface AdminIdentityView {
  publicId: string;
  createdAt: string;
}

export interface AdminIdentityListResponse {
  identities: AdminIdentityView[];
}

/** One archived conversation, without its messages. */
export interface ArchivedChatSummaryView {
  chatId: string;
  kind: ChatKind;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  /** Messages exchanged, whether or not the policy stored their text. */
  messageCount: number;
  createdAt: string;
  /** `null` means "kept until the owner deletes it". */
  expiresAt: string | null;
  participants: Array<{ publicId: string; role: 'a' | 'b' }>;
}

export interface ArchiveListResponse {
  archives: ArchivedChatSummaryView[];
}

/** One stored message of an archived conversation. */
export interface ArchivedMessageView {
  seq: number;
  senderPublicId: string;
  /** `null` when the policy stores media only, which nothing can produce yet. */
  text: string | null;
  mediaKind: string | null;
  sentAt: string;
}

export interface ArchivedChatView {
  summary: ArchivedChatSummaryView;
  messages: ArchivedMessageView[];
}

/** How much a deletion removed. Messages are counted so the result is not misleading. */
export interface ArchiveDeletionResponse {
  deletedArchives: number;
  deletedMessages: number;
}

/** The policy as returned by the admin endpoints. */
export type ArchivePolicyView = ArchivePolicy;
