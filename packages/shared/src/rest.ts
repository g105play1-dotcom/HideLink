import type { ArchivePolicy } from './archive.js';
import type {
  ChatKind,
  IncomingRequestPolicy,
  OwnerMessageTopic,
  ReportReason,
  ReportStatus,
} from './limits.js';
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
  /**
   * Whether the platform offers the "block a peer" action at all.
   *
   * A platform policy, not a personal setting (docs/DECISIONS.md D31): the owner turns
   * it on or off in `/admin`, and the same answer is given to every user. The interface
   * uses it only to hide a button that the server would refuse anyway.
   */
  blockingEnabled: boolean;
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

/**
 * The warning shown to a person a report named.
 *
 * Deliberately carries only the time: the reporter, the chat, the reason and the text are
 * moderation evidence and must not be disclosed to the target. A single warning is kept;
 * a new report replaces it.
 */
export interface ReportWarningView {
  reportedAt: string;
}

export interface ReportWarningResponse {
  warning: ReportWarningView | null;
}

/** One entry in the caller's own block list. */
export interface BlockedUserView {
  publicId: string;
  blockedAt: string;
}

export interface BlockListResponse {
  blocks: BlockedUserView[];
}

/**
 * One entry in the caller's own friend list.
 *
 * A friendship is a *mutual, persistent* link created only when both people agreed
 * while chatting. It reveals exactly two things to each side: the other person's User
 * ID and the date the link was created. There is no nickname, presence, shared chat
 * history or anything else to leak. See docs/DECISIONS.md D34.
 */
export interface FriendView {
  publicId: string;
  /** When both sides agreed, as an ISO-8601 timestamp. */
  since: string;
}

export interface FriendListResponse {
  friends: FriendView[];
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

/**
 * One identity as the owner sees it: an ID, a date and the ban state the owner set.
 *
 * The reason is included so the owner can review a suspension without opening the
 * database, and so unbanning is an informed action rather than a guess.
 */
export interface AdminIdentityView {
  publicId: string;
  createdAt: string;
  banned: boolean;
  bannedAt: string | null;
  bannedReason: string | null;
}

export interface AdminIdentityListResponse {
  identities: AdminIdentityView[];
}

/**
 * One person as the owner's directory sees them (D39).
 *
 * This is the one place where the declared profile and filters are returned to somebody
 * other than their owner. It is reachable only with the owner key, and the fields are
 * necessary to answer the questions the owner asked: what this person declared, whom they
 * are looking for, and whether they can be joined right now. `ownerChatId` is not the
 * person's chat id; it is the *owner's* hidden chat with them, or null.
 */
export interface AdminUserView extends AdminIdentityView {
  incomingRequests: IncomingRequestPolicy;
  profile: DeclaredProfile;
  search: SearchPreferences;
  favorite: boolean;
  favoriteSince: string | null;
  online: boolean;
  searching: boolean;
  chatting: boolean;
  /** A pending "join on next search" reservation exists for this person. */
  reserved: boolean;
  ownerChatId: string | null;
}

export interface AdminUserListResponse {
  users: AdminUserView[];
}

/** One hidden conversation between the owner and a user, as the owner sees it. */
export interface AdminOwnerChatSummaryView {
  chatId: string;
  /** The person the owner joined. Random chats never show this to the peer. */
  targetPublicId: string;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  status: 'active' | 'ended';
  messageCount: number;
  lastMessageAt: string | null;
}

export interface AdminOwnerChatView {
  chat: AdminOwnerChatSummaryView;
  messages: Array<{
    messageId: string;
    /** From the owner's point of view; the target sees the normal `peer` role. */
    from: 'owner' | 'target';
    text: string;
    sentAt: string;
  }>;
}

export interface AdminOwnerChatListResponse {
  chats: AdminOwnerChatSummaryView[];
}

export interface AdminOwnerMessageSentView {
  messageId: string;
  sentAt: string;
}

export interface AdminOwnerLeaveResponse {
  ended: true;
}

/**
 * The result of pressing "join" in the directory.
 *
 * `joined` means a chat exists now and `chat` is it. `reserved` means the person was not
 * searching, so the server will put the owner first on their next random search; there is
 * no chat to read yet.
 */
export interface AdminOwnerJoinResponse {
  kind: 'joined' | 'reserved';
  chat: AdminOwnerChatSummaryView | null;
}

/** A pending next-search reservation, shown so the owner can see or cancel it. */
export interface AdminOwnerReservationView {
  targetPublicId: string;
  createdAt: string;
  online: boolean;
  searching: boolean;
  chatting: boolean;
}

export interface AdminOwnerReservationListResponse {
  reservations: AdminOwnerReservationView[];
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

/**
 * One message a user sent the owner through the "contact the owner" form.
 *
 * Unlike a chat message this text *is* stored — the user wrote it precisely so that a
 * human would read it — which is why the form says so and why the row carries a retention
 * deadline. See docs/DECISIONS.md D26 and docs/SECURITY.md.
 */
export interface OwnerMessageView {
  id: string;
  topic: OwnerMessageTopic;
  text: string;
  /** How the owner was asked to reply, in the sender's own words. `null` = nothing left. */
  contact: string | null;
  /** The sender's User ID, or `null` when the identity row is gone. */
  publicId: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface OwnerMessageListResponse {
  messages: OwnerMessageView[];
}

/** What the sender is told after filing a message: an id and when it will be gone. */
export interface OwnerMessageCreatedResponse {
  id: string;
  expiresAt: string;
}

/**
 * Platform switches the owner controls in `/admin`.
 *
 * Kept apart from `IdentitySettingsView` on purpose: these are not the caller's settings,
 * and a client must not be able to patch them through `/me/settings`.
 */
export interface AdminPlatformView {
  /** Whether the "block a peer" action exists for anybody at all. Off by default. */
  blockingEnabled: boolean;
  /** Whether an AI moderator may act without a human click. Off by default. */
  aiAutonomyEnabled: boolean;
  /** Whether an AI companion may stand in when no human is found. Off by default. */
  aiCompanionEnabled: boolean;
}

/** One abuse report as the owner sees it. */
export interface AdminReportView {
  id: string;
  reason: ReportReason;
  status: ReportStatus;
  /** The reporter's own words, when they added any. */
  details: string | null;
  /** Server-side snapshot of the reported message, when the report named one. */
  messageSnapshot: string | null;
  /** Server-side id of the reported message. Never accepted from a client. */
  messageId: string | null;
  chatId: string | null;
  reporterPublicId: string;
  targetPublicId: string;
  createdAt: string;
  /** Retention deadline; the maintenance sweep hard-deletes the row then. */
  expiresAt: string;
}

export interface AdminReportListResponse {
  reports: AdminReportView[];
}

/** The only field of a report the owner edits. The rest is evidence. */
export interface AdminReportUpdate {
  status: ReportStatus;
}
