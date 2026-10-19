import { ClientEvent } from '@anonlink/protocol';
import { ErrorCode } from '@anonlink/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { RealtimeClient, createIdentity } from './support/api-client.js';

/**
 * Every event the protocol declares is actually handled by the gateway.
 *
 * The event names live in two places — `@anonlink/protocol` (what clients may send) and
 * the gateway's handler registration (what the server listens for). A name that exists
 * in the protocol but has no handler is invisible: the client's `emit` returns nothing,
 * the promise just times out, and the feature looks broken in a way that is hard to
 * attribute. This suite emits each declared event with no payload, which is enough to
 * prove a handler is attached: the call is either accepted or rejected with a
 * validation error, but never answered with `UNSUPPORTED_EVENT`.
 */

const open: RealtimeClient[] = [];

afterEach(() => {
  for (const instance of open.splice(0)) instance.close();
});

describe('protocol coverage', () => {
  it('declares exactly the nine client events', () => {
    expect(Object.values(ClientEvent)).toHaveLength(9);
  });

  for (const name of Object.values(ClientEvent)) {
    it(`routes "${name}" to a handler`, async () => {
      const client = await RealtimeClient.connect(await createIdentity());
      open.push(client);

      // No payload at all: the point is that the event is *routed*, so an error about
      // the payload is a pass. `match:join` and `match:cancel` genuinely accept an
      // empty payload, so they may succeed instead.
      const ack = await client.emit(name);

      if (!ack.ok) {
        expect(ack.error.code).not.toBe(ErrorCode.UNSUPPORTED_EVENT);
      }

      // A timed-out acknowledgement is a failure of the *test harness*, not a protocol
      // result, so it must never be able to pass for one.
      const message = ack.ok ? null : ack.error.message;
      expect(message).not.toBe('acknowledgement timed out');
    });
  }
});
