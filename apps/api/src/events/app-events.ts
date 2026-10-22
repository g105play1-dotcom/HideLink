import { Injectable } from '@nestjs/common';
import type { FriendRequestStatus, MatchCancelReason, RequestStatus } from '@anonlink/protocol';
import type { RelaxableCriterion, SearchPreferences } from '@anonlink/shared';

import { log } from '../common/logger.js';
import type { ChatRecord, StoredMessage } from '../chat/chat.registry.js';
import type { ConnectionRequest } from '../chat/chat.requests.js';
import type { FriendRequest } from '../friends/friend-requests.js';
import type { FriendshipRecord } from '../friends/friends.service.js';

/**
 * The application's single in-process event bus.
 *
 * ## Why an event bus and not a direct call
 *
 * The chat service owns the *rules*; the gateway owns the *sockets*. If the chat
 * service imported the gateway, the dependency would point the wrong way and
 * create a cycle (the gateway already calls the chat service to act on inbound
 * events). Publishing events keeps the rules testable with no socket at all:
 * integration tests subscribe to the bus and assert on exactly the events a
 * browser would receive.
 *
 * ## Why events carry records, not rendered payloads
 *
 * The same fact is personalised per recipient — a message is `from: 'you'` for its
 * sender and `from: 'peer'` for everybody else, and a peer leaving reads as
 * `left` to the leaver and `peer_left` to the peer. Rendering therefore happens in
 * the gateway, once per socket, from the shared record.
 *
 * Events are process-local by design. AnonLink runs one API instance (the
 * matchmaking queue is in-process), so there is nothing to fan out across
 * processes; see docs/DECISIONS.md for what changes if that ever stops being true.
 */
export type AppEvent =
  // --- matchmaking ---------------------------------------------------------
  | {
      type: 'match.queued';
      userId: string;
      since: Date;
      criteria: SearchPreferences;
      relaxAfterMs: number | null;
    }
  | { type: 'match.cancelled'; userId: string; reason: MatchCancelReason }
  /**
   * Filters were dropped to widen a search that is taking too long.
   *
   * Carries the criteria *now* in force rather than a diff, so the interface can show
   * exactly what the server is applying without replaying the relaxation history.
   */
  | {
      type: 'match.relaxed';
      userId: string;
      dropped: RelaxableCriterion[];
      criteria: SearchPreferences;
    }
  // --- chat lifecycle ------------------------------------------------------
  | { type: 'chat.started'; chat: ChatRecord }
  | { type: 'chat.message'; chat: ChatRecord; message: StoredMessage }
  | { type: 'chat.ended'; chat: ChatRecord; reason: ChatEndReasonSource }
  | { type: 'chat.presence'; chat: ChatRecord; userId: string; present: boolean }
  // --- direct requests -----------------------------------------------------
  | { type: 'request.incoming'; request: ConnectionRequest }
  | {
      type: 'request.resolved';
      /** Who is being told about the outcome. */
      userId: string;
      requestId: string;
      status: RequestStatus;
      chat?: ChatRecord;
    }
  // --- friendships ---------------------------------------------------------
  /** A chat participant asked the other one to become friends. */
  | { type: 'friend.incoming'; request: FriendRequest }
  /**
   * The outcome of a friend request, addressed to both participants.
   *
   * On acceptance, `friendship` is present and each side is shown the *other* person's
   * User ID. On refusal, expiry or cancellation it is absent: nothing about the peer
   * beyond the per-chat alias has been disclosed.
   */
  | {
      type: 'friend.resolved';
      request: FriendRequest;
      status: FriendRequestStatus;
      friendship?: FriendshipRecord;
    }
  /** An explicit removal by the other side. `userId` is the person being told. */
  | { type: 'friend.removed'; userId: string; publicId: string }
  // --- moderation ----------------------------------------------------------
  /**
   * The owner suspended an identity.
   *
   * Carries no public reason: the peer of a live chat must not learn that the other side
   * was banned. The gateway ends the chat and closes the identity's sockets; the domain
   * never imports the gateway.
   */
  | { type: 'identity.banned'; userId: string }
  // --- session lifecycle ---------------------------------------------------
  /**
   * The identity behind these sockets was re-issued (the user asked for a new User
   * ID). Every existing socket is authenticated as the *old* identity and must be
   * closed, or it would keep acting with revoked credentials.
   */
  | { type: 'session.rotated'; previousUserId: string; publicId: string };

/** Reasons a chat can end, as seen by the domain (before per-viewer translation). */
export type ChatEndReasonSource =
  'left' | 'disconnected' | 'blocked' | 'reported' | 'banned' | 'server_shutdown' | 'expired';

export type AppEventListener = (event: AppEvent) => void;

@Injectable()
export class AppEventBus {
  private readonly listeners = new Set<AppEventListener>();

  /** Registers a listener. Returns a function that removes it again. */
  subscribe(listener: AppEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Publishes an event.
   *
   * A misbehaving listener (a socket that vanished mid-write, for instance) must
   * never corrupt the state machine that produced the event, so each listener is
   * isolated and its failures are logged rather than propagated.
   */
  emit(event: AppEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        log.error('events.listener_failed', error, { event: event.type });
      }
    }
  }
}
