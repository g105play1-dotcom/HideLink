/**
 * A participant that is not a browser: a session created over REST plus a raw Socket.IO
 * connection.
 *
 * Used only where the point of the test is to do something the interface deliberately
 * cannot do — currently, a third party trying to write into someone else's conversation.
 * Everything a real user can do is driven through the UI so the test exercises the same
 * code path the owner will.
 */
import { ClientEvent, ServerEvent, type AckResult } from '@anonlink/protocol';
import { io, type Socket } from 'socket.io-client';

import { E2E_API_BASE, E2E_API_ORIGIN, E2E_WEB_ORIGIN } from '../env';

export interface RawIdentity {
  publicId: string;
  /** A ready-to-send `Cookie` header value. */
  cookie: string;
}

/** Creates an anonymous identity the same way the browser bootstrap does. */
export async function createRawIdentity(): Promise<RawIdentity> {
  const response = await fetch(`${E2E_API_BASE}/session`, {
    method: 'POST',
    headers: { Origin: E2E_WEB_ORIGIN, 'Content-Type': 'application/json' },
    body: '{}',
  });

  if (!response.ok) {
    throw new Error(`POST /session failed with HTTP ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as { publicId?: unknown };
  if (typeof body.publicId !== 'string') {
    throw new Error('POST /session did not return a publicId');
  }

  // The session cookie is HttpOnly and must be replayed by hand: this client is Node,
  // not a browser with a cookie jar.
  const cookie = response.headers
    .getSetCookie()
    .map((header) => header.split(';')[0])
    .join('; ');

  return { publicId: body.publicId, cookie };
}

/** Connects as that identity and waits until the server has attached it to the socket. */
export async function connectRawIdentity(identity: RawIdentity): Promise<Socket> {
  const socket = io(E2E_API_ORIGIN, {
    transports: ['websocket'],
    reconnection: false,
    // The API validates `Origin` even for non-browser clients when it is present, so the
    // allow-listed web origin is sent explicitly rather than omitted.
    extraHeaders: { Origin: E2E_WEB_ORIGIN, Cookie: identity.cookie },
  });

  await waitForEvent(socket, 'connect', 15_000);
  await waitForEvent(socket, ServerEvent.SessionReady, 15_000);

  return socket;
}

/** Resolves with the payload of the next `event`. */
export function waitForEvent<T>(socket: Socket, event: string, timeoutMs = 10_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out after ${timeoutMs} ms waiting for "${event}"`));
    }, timeoutMs);

    function handler(payload: T): void {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }

    socket.on(event, handler);
  });
}

/** Emits a command and resolves with its acknowledgement. */
export function sendCommand<T>(
  socket: Socket,
  event: string,
  payload: unknown,
  timeoutMs = 10_000,
): Promise<AckResult<T>> {
  return new Promise<AckResult<T>>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no acknowledgement for "${event}" within ${timeoutMs} ms`)),
      timeoutMs,
    );

    socket.emit(event, payload, (result: AckResult<T>) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

/** Convenience: sends a chat message as the raw peer. */
export function sendChatMessage(
  socket: Socket,
  chatId: string,
  text: string,
): Promise<AckResult<{ messageId: string; sentAt: string }>> {
  return sendCommand(socket, ClientEvent.ChatMessage, {
    chatId,
    text,
    clientMessageId: `raw-${Date.now().toString(36)}`,
  });
}
