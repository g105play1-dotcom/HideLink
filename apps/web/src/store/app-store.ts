import { create } from 'zustand';

import {
  ABSOLUTE_MESSAGE_MAX_LENGTH,
  type ChatEndReason,
  type ChatMediaView,
  type DeclaredProfile,
  type RelaxableCriterion,
  type SearchPreferences,
} from '@anonlink/shared';
import type {
  ChatKind,
  ChatMessageView,
  FriendRequestStatus,
  IncomingRequestPayload,
} from '@anonlink/protocol';

import { activeT } from '@/i18n';
import { randomId } from '@/lib/ids';

/**
 * Everything the UI renders.
 *
 * The store is deliberately a plain description of *what is on screen*. All
 * protocol knowledge (which event means what, which ack reconciles which optimistic
 * message) lives in `anonymous-client.ts`, so this file can be read as the UI's
 * specification and the two can be reasoned about separately.
 */

/** Where the connection to the API currently stands. */
export type ConnectionStatus =
  | 'booting'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'offline'
  /** The server refused this identity (suspended, or no valid session). */
  | 'rejected';

/** Which screen the user is on. */
export type AppPhase = 'idle' | 'searching' | 'chatting' | 'ended';

export interface SessionInfo {
  publicId: string;
  createdAt: string;
  incomingRequests: 'everyone' | 'nobody';
  /**
   * Whether the platform offers the block action at all.
   *
   * A policy the owner sets in `/admin` (D31), not a personal setting. The interface
   * only hides controls with it; the rule itself is enforced by the API, which refuses
   * a new block while the policy is off.
   */
  blockingEnabled: boolean;
  /** What this identity says about itself. Voluntary, unverified, never shown to peers. */
  profile: DeclaredProfile;
  /** How this identity wants its random partners filtered. */
  search: SearchPreferences;
}

export interface ChatInfo {
  chatId: string;
  kind: ChatKind;
  /** Friendly per-chat label, e.g. `Собеседник 7K3M`. */
  peerAlias: string;
  /** Present only in direct chats, where the user already knew this ID. */
  peerPublicId?: string;
  startedAt: string;
  /** `true` when this browser caused the chat (match or outgoing request). */
  initiator: boolean;
}

export type MessageStatus = 'sending' | 'sent' | 'failed';

export interface UiMessage {
  /** Stable React key: the server id once known, else the client id. */
  key: string;
  clientMessageId?: string;
  messageId?: string;
  from: 'you' | 'peer' | 'system';
  text: string;
  /** Attachment metadata; the bytes are fetched from the guarded API route. */
  media?: ChatMediaView;
  sentAt: string;
  status?: MessageStatus;
  failureReason?: string;
}

export interface IncomingRequest {
  requestId: string;
  publicId: string;
  alias: string;
  note?: string;
  expiresAt: string;
}

export interface OutgoingRequest {
  publicId: string;
  expiresAt: string;
}

/**
 * A friend request attached to the current chat.
 *
 * `alias` is the peer's per-chat label. The peer's User ID is deliberately absent:
 * it becomes known only after acceptance, through the friend list and `friend:resolved`.
 */
export interface FriendRequestState {
  requestId: string;
  chatId: string;
  alias: string;
  expiresAt: string;
}

export interface Notice {
  id: string;
  tone: 'info' | 'success' | 'error';
  text: string;
}

export interface EndedChat {
  chatId: string;
  peerAlias: string;
  reason: ChatEndReason;
}

export interface AppState {
  // --- connection ----------------------------------------------------------
  connection: ConnectionStatus;
  /** Extra explanation for a non-connected state, e.g. the rejection reason. */
  connectionDetail: string | null;
  bootError: string | null;
  protocolMismatch: boolean;

  // --- identity ------------------------------------------------------------
  session: SessionInfo | null;
  /**
   * Server-configured maximum message length.
   *
   * Starts at the absolute ceiling both ends share, then narrows to the deployment's
   * real limit as soon as `session:ready` arrives.
   */
  messageMaxLength: number;

  // --- conversation --------------------------------------------------------
  phase: AppPhase;
  chat: ChatInfo | null;
  messages: UiMessage[];
  /** `true` while the peer's connection is down but the chat is not over yet. */
  peerAway: boolean;
  /** When the current search started, for the elapsed-time readout. */
  searchingSince: string | null;
  endedChat: EndedChat | null;

  // --- search (server-reported) --------------------------------------------
  /**
   * The filters the server says it is applying to the current search.
   *
   * Comes from the server rather than from the settings form, because after a relaxation
   * the form's values are no longer what is being applied — and telling the user the wrong
   * criteria would be worse than telling them nothing.
   */
  searchCriteria: SearchPreferences | null;
  /** Milliseconds until the server widens the search, or `null` when it will not. */
  relaxAfterMs: number | null;
  /** Filters the server has already dropped for this search, in the order it dropped them. */
  relaxedCriteria: RelaxableCriterion[];

  // --- direct requests -----------------------------------------------------
  incomingRequests: IncomingRequest[];
  outgoingRequest: OutgoingRequest | null;

  // --- friends -------------------------------------------------------------
  /** An unanswered request from the current chat peer, if any. */
  incomingFriendRequest: FriendRequestState | null;
  /** A request this client sent in the current chat, if any. */
  outgoingFriendRequest: FriendRequestState | null;
  /**
   * Why the friend question is closed for the current chat: declined, expired, or
   * impossible because the peer is unavailable. `null` means it can still be asked.
   */
  friendRequestOutcome: FriendRequestStatus | null;
  /** `true` once the server has confirmed a friendship in the current chat. */
  friendsInChat: boolean;
  /** Bumped when the friend list changes elsewhere, so a mounted list refetches. */
  friendsVersion: number;
  /** Bumped when a report warning arrives, so the dialog refetches it from REST. */
  reportWarningVersion: number;

  // --- feedback ------------------------------------------------------------
  notices: Notice[];

  // --- actions -------------------------------------------------------------
  setConnection: (status: ConnectionStatus, detail?: string | null) => void;
  setBootError: (message: string | null) => void;
  setProtocolMismatch: (mismatch: boolean) => void;

  setSession: (session: SessionInfo) => void;
  setMessageMaxLength: (length: number) => void;
  clearConversation: () => void;

  beginSearching: (since: string) => void;
  stopSearching: () => void;
  /** Records the criteria the server reported for the running search. */
  setSearchCriteria: (criteria: SearchPreferences, relaxAfterMs: number | null) => void;
  /** Records that the server widened the search, and by dropping what. */
  noteRelaxation: (dropped: RelaxableCriterion[], criteria: SearchPreferences) => void;

  startChat: (chat: ChatInfo, messages: UiMessage[]) => void;
  restoreChat: (chat: ChatInfo, messages: UiMessage[]) => void;
  /** Adds an optimistic outgoing message; returns its idempotency key. */
  queueOutgoingMessage: (text: string, media?: ChatMediaView) => string;
  receiveMessage: (view: ChatMessageView) => void;
  confirmMessage: (clientMessageId: string, messageId: string, sentAt: string) => void;
  failMessage: (clientMessageId: string, reason: string) => void;
  setPeerAway: (away: boolean) => void;
  endChat: (chatId: string, reason: ChatEndReason) => void;

  addIncomingRequest: (request: IncomingRequestPayload) => void;
  removeIncomingRequest: (requestId: string) => void;
  setOutgoingRequest: (request: OutgoingRequest | null) => void;

  setIncomingFriendRequest: (request: FriendRequestState | null) => void;
  setOutgoingFriendRequest: (request: FriendRequestState | null) => void;
  clearFriendRequest: (requestId: string) => void;
  setFriendRequestOutcome: (outcome: FriendRequestStatus | null) => void;
  setFriendsInChat: (friends: boolean) => void;
  bumpFriendsVersion: () => void;
  bumpReportWarningVersion: () => void;
  resetFriendRequests: () => void;

  notify: (tone: Notice['tone'], text: string) => void;
  dismissNotice: (id: string) => void;
}

/** Converts a wire message into a UI message, placed on the correct side. */
export function toUiMessage(view: ChatMessageView): UiMessage {
  return {
    key: view.messageId,
    ...(view.clientMessageId ? { clientMessageId: view.clientMessageId } : {}),
    messageId: view.messageId,
    from: view.from,
    text: view.text,
    ...(view.media ? { media: view.media } : {}),
    sentAt: view.sentAt,
    // Our own messages are already confirmed by the time they come back.
    ...(view.from === 'you' ? { status: 'sent' as const } : {}),
  };
}

function systemMessage(text: string): UiMessage {
  return { key: randomId(12), from: 'system', text, sentAt: new Date().toISOString() };
}

export const useAppStore = create<AppState>((set) => ({
  connection: 'booting',
  connectionDetail: null,
  bootError: null,
  protocolMismatch: false,

  session: null,
  messageMaxLength: ABSOLUTE_MESSAGE_MAX_LENGTH,

  phase: 'idle',
  chat: null,
  messages: [],
  peerAway: false,
  searchingSince: null,
  endedChat: null,

  searchCriteria: null,
  relaxAfterMs: null,
  relaxedCriteria: [],

  incomingRequests: [],
  outgoingRequest: null,

  incomingFriendRequest: null,
  outgoingFriendRequest: null,
  friendRequestOutcome: null,
  friendsInChat: false,
  friendsVersion: 0,
  reportWarningVersion: 0,

  notices: [],

  setConnection: (status, detail = null) => set({ connection: status, connectionDetail: detail }),

  setBootError: (message) => set({ bootError: message }),

  setProtocolMismatch: (mismatch) => set({ protocolMismatch: mismatch }),

  setSession: (session) => set({ session }),

  setMessageMaxLength: (length) => set({ messageMaxLength: length }),

  beginSearching: (since) =>
    // A queued search is announced twice — by the `match:join` acknowledgement and by
    // the `match:queued` event — and the two can arrive in either order. The criteria
    // therefore start empty only when the screen is genuinely new; a second
    // announcement of the same search must not wipe what the server just reported, or
    // the screen would claim "no filters" (and lose the widening deadline) while the
    // server was still filtering.
    set((state) =>
      state.phase === 'searching'
        ? { searchingSince: state.searchingSince ?? since }
        : {
            phase: 'searching' as const,
            searchingSince: since,
            endedChat: null,
            peerAway: false,
            searchCriteria: null,
            relaxAfterMs: null,
            relaxedCriteria: [],
          },
    ),

  stopSearching: () =>
    set((state) =>
      state.phase === 'searching'
        ? {
            phase: 'idle' as const,
            searchingSince: null,
            searchCriteria: null,
            relaxAfterMs: null,
            relaxedCriteria: [],
          }
        : {},
    ),

  setSearchCriteria: (criteria, relaxAfterMs) => set({ searchCriteria: criteria, relaxAfterMs }),

  noteRelaxation: (dropped, criteria) =>
    set((state) => ({
      searchCriteria: criteria,
      // Appended, not replaced: each notice describes one step, and the user should be able
      // to see everything that was dropped over the life of the search. Re-listing a
      // criterion already reported would be a different lie, so duplicates are filtered out.
      relaxedCriteria: [
        ...state.relaxedCriteria,
        ...dropped.filter((criterion) => !state.relaxedCriteria.includes(criterion)),
      ],
    })),

  startChat: (chat, messages) =>
    set((state) => {
      // `chat:started` and `request:resolved` can both announce the same new chat;
      // treating the second one as a no-op stops it from wiping a message that was
      // sent in between.
      if (state.chat?.chatId === chat.chatId && state.phase === 'chatting') return {};

      return {
        phase: 'chatting' as const,
        chat,
        messages,
        peerAway: false,
        searchingSince: null,
        endedChat: null,
        searchCriteria: null,
        relaxAfterMs: null,
        relaxedCriteria: [],
        incomingRequests: [],
        outgoingRequest: null,
        incomingFriendRequest: null,
        outgoingFriendRequest: null,
        friendRequestOutcome: null,
        friendsInChat: false,
      };
    }),

  restoreChat: (chat, messages) =>
    set((state) => {
      // `session:ready` restores the friend request / friendship for the active chat, and
      // `chat:resumed` follows immediately. Replacing an existing same-chat state would
      // wipe that restoration; only a genuinely different chat starts from zero.
      const keepFriendState = state.chat?.chatId === chat.chatId;

      return {
        phase: 'chatting' as const,
        chat,
        messages,
        peerAway: false,
        searchingSince: null,
        endedChat: null,
        searchCriteria: null,
        relaxAfterMs: null,
        relaxedCriteria: [],
        ...(keepFriendState
          ? {}
          : {
              incomingFriendRequest: null,
              outgoingFriendRequest: null,
              friendRequestOutcome: null,
              friendsInChat: false,
            }),
      };
    }),

  clearConversation: () =>
    set({
      phase: 'idle',
      chat: null,
      messages: [],
      peerAway: false,
      searchingSince: null,
      endedChat: null,
      searchCriteria: null,
      relaxAfterMs: null,
      relaxedCriteria: [],
      incomingRequests: [],
      outgoingRequest: null,
      incomingFriendRequest: null,
      outgoingFriendRequest: null,
      friendRequestOutcome: null,
      friendsInChat: false,
    }),

  queueOutgoingMessage: (text, media) => {
    const clientMessageId = randomId(16);
    set((state) => ({
      messages: [
        ...state.messages,
        {
          key: clientMessageId,
          clientMessageId,
          from: 'you',
          text,
          ...(media ? { media } : {}),
          sentAt: new Date().toISOString(),
          status: 'sending',
        },
      ],
    }));
    return clientMessageId;
  },

  receiveMessage: (view) =>
    set((state) => {
      // The server echoes our own message back with the same `clientMessageId`;
      // replacing in place (rather than appending) keeps the transcript ordered and
      // makes the echo and the acknowledgement idempotent in either order.
      if (view.clientMessageId) {
        const index = state.messages.findIndex(
          (message) => message.clientMessageId === view.clientMessageId,
        );
        if (index >= 0) {
          const messages = [...state.messages];
          messages[index] = toUiMessage(view);
          return { messages };
        }
      }

      if (state.messages.some((message) => message.key === view.messageId)) {
        return {};
      }

      return { messages: [...state.messages, toUiMessage(view)] };
    }),

  confirmMessage: (clientMessageId, messageId, sentAt) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.clientMessageId === clientMessageId
          ? { ...message, key: messageId, messageId, sentAt, status: 'sent' as const }
          : message,
      ),
    })),

  failMessage: (clientMessageId, reason) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.clientMessageId === clientMessageId
          ? { ...message, status: 'failed' as const, failureReason: reason }
          : message,
      ),
    })),

  setPeerAway: (away) =>
    set((state) => {
      if (!state.chat || state.phase !== 'chatting' || state.peerAway === away) return {};

      return {
        peerAway: away,
        messages: [
          ...state.messages,
          systemMessage(
            away
              ? activeT('{alias} потерял соединение. Ждём восстановления…', {
                  alias: state.chat.peerAlias,
                })
              : activeT('{alias} снова на связи.', { alias: state.chat.peerAlias }),
          ),
        ],
      };
    }),

  endChat: (chatId, reason) =>
    set((state) => {
      // A late event for a chat that has already been replaced must not wipe the
      // current conversation.
      if (state.chat?.chatId !== chatId) return {};

      return {
        phase: 'ended' as const,
        peerAway: false,
        endedChat: { chatId, peerAlias: state.chat.peerAlias, reason },
        incomingRequests: [],
        outgoingRequest: null,
        incomingFriendRequest: null,
        outgoingFriendRequest: null,
        friendRequestOutcome: null,
        friendsInChat: false,
      };
    }),

  addIncomingRequest: (request) =>
    set((state) => ({
      incomingRequests: [
        ...state.incomingRequests.filter((item) => item.requestId !== request.requestId),
        {
          requestId: request.requestId,
          publicId: request.from.publicId ?? request.from.alias,
          alias: request.from.alias,
          ...(request.note ? { note: request.note } : {}),
          expiresAt: request.expiresAt,
        },
      ],
    })),

  removeIncomingRequest: (requestId) =>
    set((state) => ({
      incomingRequests: state.incomingRequests.filter((item) => item.requestId !== requestId),
    })),

  setOutgoingRequest: (request) => set({ outgoingRequest: request }),

  setIncomingFriendRequest: (request) => set({ incomingFriendRequest: request }),

  setOutgoingFriendRequest: (request) => set({ outgoingFriendRequest: request }),

  clearFriendRequest: (requestId) =>
    set((state) => ({
      incomingFriendRequest:
        state.incomingFriendRequest?.requestId === requestId ? null : state.incomingFriendRequest,
      outgoingFriendRequest:
        state.outgoingFriendRequest?.requestId === requestId ? null : state.outgoingFriendRequest,
    })),

  setFriendRequestOutcome: (outcome) => set({ friendRequestOutcome: outcome }),

  setFriendsInChat: (friends) => set({ friendsInChat: friends }),

  bumpFriendsVersion: () => set((state) => ({ friendsVersion: state.friendsVersion + 1 })),

  bumpReportWarningVersion: () =>
    set((state) => ({ reportWarningVersion: state.reportWarningVersion + 1 })),

  resetFriendRequests: () =>
    set({
      incomingFriendRequest: null,
      outgoingFriendRequest: null,
      friendRequestOutcome: null,
      friendsInChat: false,
    }),

  notify: (tone, text) =>
    set((state) => {
      // Never stack identical messages, e.g. a flapping connection.
      if (state.notices.some((notice) => notice.text === text && notice.tone === tone)) {
        return {};
      }

      return {
        notices: [...state.notices, { id: randomId(10), tone, text }].slice(-4),
      };
    }),

  dismissNotice: (id) =>
    set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) })),
}));
