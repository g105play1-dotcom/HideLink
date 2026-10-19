import { describe, expect, it } from 'vitest';

import { ClientEvent, PROTOCOL_VERSION, ServerEvent } from './events.js';
import type { ClientEventName, ServerEventName } from './events.js';
import type { ClientToServerEvents, ServerToClientEvents } from './payloads.js';

/**
 * The realtime contract.
 *
 * Two independent declarations describe the same set of events:
 *  - the `ClientEvent` / `ServerEvent` name maps, which the gateway and the browser use
 *    to register and emit handlers at runtime;
 *  - the `ClientToServerEvents` / `ServerToClientEvents` interfaces, which type every
 *    payload for the Socket.IO client.
 *
 * Nothing but these tests keeps them in step, and a mismatch is the kind of bug that
 * only shows up in production — a typo in a name map silently produces an event nobody
 * listens for.
 *
 * The two `satisfies` tables below do the heavy lifting at **compile time**: if a name
 * in a map is not also a key of its interface, `pnpm typecheck` fails. The assertions
 * then pin the wire names, because renaming an event is a breaking change against
 * `PROTOCOL_VERSION`.
 */

/** Compile-time: every client event name is a key of the client interface. */
const clientEventsSatisfyInterface = {
  [ClientEvent.MatchJoin]: ClientEvent.MatchJoin,
  [ClientEvent.MatchCancel]: ClientEvent.MatchCancel,
  [ClientEvent.ChatMessage]: ClientEvent.ChatMessage,
  [ClientEvent.ChatLeave]: ClientEvent.ChatLeave,
  [ClientEvent.ChatNext]: ClientEvent.ChatNext,
  [ClientEvent.RequestSend]: ClientEvent.RequestSend,
  [ClientEvent.RequestRespond]: ClientEvent.RequestRespond,
  [ClientEvent.ReportSend]: ClientEvent.ReportSend,
  [ClientEvent.BlockPeer]: ClientEvent.BlockPeer,
} satisfies Record<ClientEventName, keyof ClientToServerEvents>;

/** Compile-time: every server event name is a key of the server interface. */
const serverEventsSatisfyInterface = {
  [ServerEvent.SessionReady]: ServerEvent.SessionReady,
  [ServerEvent.SessionRotated]: ServerEvent.SessionRotated,
  [ServerEvent.MatchQueued]: ServerEvent.MatchQueued,
  [ServerEvent.MatchCancelled]: ServerEvent.MatchCancelled,
  [ServerEvent.MatchRelaxed]: ServerEvent.MatchRelaxed,
  [ServerEvent.ChatStarted]: ServerEvent.ChatStarted,
  [ServerEvent.ChatResumed]: ServerEvent.ChatResumed,
  [ServerEvent.ChatMessage]: ServerEvent.ChatMessage,
  [ServerEvent.ChatPeerAway]: ServerEvent.ChatPeerAway,
  [ServerEvent.ChatPeerBack]: ServerEvent.ChatPeerBack,
  [ServerEvent.ChatEnded]: ServerEvent.ChatEnded,
  [ServerEvent.RequestIncoming]: ServerEvent.RequestIncoming,
  [ServerEvent.RequestResolved]: ServerEvent.RequestResolved,
  [ServerEvent.PeerBlocked]: ServerEvent.PeerBlocked,
  [ServerEvent.Error]: ServerEvent.Error,
} satisfies Record<ServerEventName, keyof ServerToClientEvents>;

describe('protocol version', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});

describe('event names', () => {
  it('pins every client event name', () => {
    // Deliberately a snapshot. A rename is a breaking change for any client that is
    // already open in a browser tab, so it must be a conscious decision (and a
    // `PROTOCOL_VERSION` bump) rather than a tidy-up that slips through review.
    expect(Object.values(ClientEvent).sort()).toEqual([
      'block:peer',
      'chat:leave',
      'chat:message',
      'chat:next',
      'match:cancel',
      'match:join',
      'report:send',
      'request:respond',
      'request:send',
    ]);
  });

  it('pins every server event name', () => {
    expect(Object.values(ServerEvent).sort()).toEqual([
      'app:error',
      'chat:ended',
      'chat:message',
      'chat:peer-away',
      'chat:peer-back',
      'chat:resumed',
      'chat:started',
      'match:cancelled',
      'match:queued',
      'match:relaxed',
      'peer:blocked',
      'request:incoming',
      'request:resolved',
      'session:ready',
      'session:rotated',
    ]);
  });

  it('uses a `namespace:action` shape for every name', () => {
    for (const name of [...Object.values(ClientEvent), ...Object.values(ServerEvent)]) {
      expect(name).toMatch(/^[a-z]+:[a-z-]+$/);
    }
  });

  it('has no duplicate name inside a map', () => {
    const client = Object.values(ClientEvent);
    const server = Object.values(ServerEvent);

    expect(new Set(client).size).toBe(client.length);
    expect(new Set(server).size).toBe(server.length);
  });

  it('has no name that is both a client and a server event beyond the documented ones', () => {
    const client = new Set<string>(Object.values(ClientEvent));

    // `chat:message` is intentionally bidirectional; nothing else is.
    const shared = Object.values(ServerEvent).filter((name) => client.has(name));
    expect(shared).toEqual(['chat:message']);
  });

  it('exposes `app:error` as the single error channel', () => {
    // Every failure the client can observe other than an acknowledgement arrives here.
    // If this ever gains a sibling, the client's error handling has to learn about it.
    const errorChannels = Object.values(ServerEvent).filter((name) => name.startsWith('app:'));
    expect(errorChannels).toEqual(['app:error']);
  });
});

describe('compile-time coverage tables', () => {
  it('cover every runtime name', () => {
    // The tables exist for `typecheck`; this keeps them from silently going stale in a
    // way the compiler cannot see (a table entry that duplicates another).
    expect(Object.keys(clientEventsSatisfyInterface).sort()).toEqual(
      Object.values(ClientEvent).sort(),
    );
    expect(Object.keys(serverEventsSatisfyInterface).sort()).toEqual(
      Object.values(ServerEvent).sort(),
    );
  });
});
