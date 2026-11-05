import type { ChatEndReason } from '@anonlink/shared';
import type { ChatMessageView, ChatView, PeerView } from '@anonlink/protocol';

import type { ChatEndReasonSource } from '../events/app-events.js';
import type { ChatRecord, StoredMessage } from './chat.registry.js';

/**
 * Turns internal chat state into per-recipient wire payloads.
 *
 * Everything that is personalised lives here so there is exactly one place to
 * audit for "could this leak who the other person is?".
 */

export function buildPeerView(chat: ChatRecord, peerId: string): PeerView {
  const alias = chat.aliasFor(peerId);
  // `revealPublicId` is the choke point: it returns `undefined` for every random
  // chat, so an anonymous match can never carry the peer's User ID.
  const publicId = chat.revealPublicId(peerId);

  return publicId ? { alias, publicId } : { alias };
}

export function buildChatView(chat: ChatRecord, viewerId: string): ChatView {
  return {
    chatId: chat.chatId,
    kind: chat.kind,
    peer: buildPeerView(chat, chat.peerOf(viewerId)),
    startedAt: chat.startedAt.toISOString(),
    ...(chat.friendsWithPeer ? { friendsWithPeer: true } : {}),
  };
}

export function buildMessageView(
  chat: ChatRecord,
  message: StoredMessage,
  viewerId: string,
): ChatMessageView {
  const isMine = message.senderId === viewerId;

  return {
    messageId: message.messageId,
    chatId: chat.chatId,
    from: isMine ? 'you' : 'peer',
    text: message.text,
    ...(message.media ? { media: message.media } : {}),
    sentAt: message.sentAt.toISOString(),
    // The idempotency key is echoed only to its author: it is meaningless to the
    // peer and would let one side correlate a sender's retries across chats.
    ...(isMine && message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}),
  };
}

export function buildHistory(chat: ChatRecord, viewerId: string): ChatMessageView[] {
  return chat.messages.map((message) => buildMessageView(chat, message, viewerId));
}

/**
 * Maps an end reason to the wording this particular viewer should see.
 *
 * Two reasons are deliberately asymmetric:
 *  - someone leaving is "I left" for them and "the other person left" for the peer;
 *  - a block or a report is reported plainly to whoever triggered it, while the
 *    other side sees an ordinary "peer left". Telling someone they were blocked
 *    invites retaliation, so the end reason stays silent.
 *
 * A report is the one exception outside this function: the reported side receives a
 * separate, evidence-free `report:warning` (D38), but their chat still ends as a plain
 * `peer_left`. The warning is not a new end reason and does not say who reported them.
 */
export function endedReasonFor(
  chat: ChatRecord,
  viewerId: string,
  reason: ChatEndReasonSource,
): ChatEndReason {
  const isActor = chat.endedByUserId === viewerId;

  switch (reason) {
    case 'left':
      return isActor ? 'left' : 'peer_left';
    case 'disconnected':
      // Reported honestly to the side that is still there: "the other person dropped
      // off", rather than a vague "they left", which reads like a decision. The side
      // that dropped sees an ordinary end — accurate enough, and it avoids telling a
      // returning user that *they* abandoned the chat.
      return isActor ? 'left' : 'disconnected';
    case 'blocked':
      return isActor ? 'blocked' : 'peer_left';
    case 'reported':
      return isActor ? 'reported' : 'peer_left';
    // A suspension is never disclosed to the other side. The banned person is closed
    // before the reason matters to them; their peer sees an ordinary end, exactly as
    // with a block or a report.
    case 'banned':
      return 'peer_left';
    default:
      return reason;
  }
}
