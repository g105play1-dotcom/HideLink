import { type INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { Server, ServerOptions } from 'socket.io';

import { log } from '../common/logger.js';

/**
 * The WebSocket transport policy.
 *
 * Three things are decided here rather than in the gateway, because they must be
 * enforced *before* a socket object exists:
 *
 *  1. **Origin allow-list.** `allowRequest` sees the raw HTTP upgrade request, so a
 *     page on an untrusted origin is refused at the handshake instead of being
 *     allowed to open a socket and then be told off. Browsers always send `Origin`
 *     for WebSocket upgrades, so this is reliable; non-browser clients that omit it
 *     cannot borrow a browser's cookie jar.
 *  2. **CORS with credentials.** `credentials: true` is required for the session
 *     cookie to be sent, and it is only safe *because* the origin list is an exact
 *     allow-list (a wildcard would be rejected by the browser anyway).
 *  3. **Payload ceiling.** `maxHttpBufferSize` caps a single packet, so a client
 *     cannot make the server allocate an arbitrary amount of memory.
 *
 * Note that `CORS_ORIGINS` is the same setting used by the HTTP layer: there is one
 * list to maintain, not two.
 */
export interface SocketTransportPolicy {
  allowedOrigins: readonly string[];
  maxPayloadBytes?: number;
}

export class ConfiguredSocketIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly policy: SocketTransportPolicy,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const allowed = new Set(this.policy.allowedOrigins);

    const merged = {
      ...options,
      cors: {
        origin: [...allowed],
        credentials: true,
        methods: ['GET', 'POST'],
      },
      maxHttpBufferSize: this.policy.maxPayloadBytes ?? 64 * 1024,
      connectTimeout: 10_000,
      // Polling is kept as a fallback for restrictive corporate networks; the
      // client upgrades to WebSocket as soon as it can.
      transports: ['websocket', 'polling'],
      allowRequest: (
        request: { headers: { origin?: string } },
        callback: (err: string | null | undefined, success: boolean) => void,
      ) => {
        const origin = request.headers.origin;
        if (!origin || allowed.has(origin)) {
          callback(null, true);
          return;
        }

        log.security('realtime.origin_rejected', {});
        callback('origin not allowed', false);
      },
      // `ServerOptions` marks several engine fields as required; the explicit cast
      // keeps the merged object readable while satisfying the base signature.
    } as ServerOptions;

    return super.createIOServer(port, merged);
  }
}
