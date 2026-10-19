import { ErrorCode } from '@anonlink/shared';
import type {
  AckResult,
  ClientToServerEvents,
  ServerToClientEvents,
  SessionReadyPayload,
} from '@anonlink/protocol';
import { io, type Socket } from 'socket.io-client';

import { TEST_API_BASE, TEST_API_URL } from './test-env.js';

/**
 * Test doubles for the two real clients of the API.
 *
 * These speak the *documented* protocol — HTTP with the session cookie, Socket.IO with
 * `extraHeaders` — and nothing else. They deliberately do not import the server's
 * internals: the tests then fail when the contract changes, which is precisely the
 * signal that a browser (or a future mobile client) would break too.
 */

const SESSION_COOKIE_NAME = 'anonlink_session';

export interface TestIdentity {
  publicId: string;
  /** Ready-to-send `Cookie` request header, e.g. `anonlink_session=…`. */
  cookie: string;
}

export interface HttpResult<T> {
  status: number;
  body: T;
  /** Raw `Set-Cookie` headers, so a test can assert on the cookie's attributes. */
  setCookie: string[];
}

export interface HttpOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  cookie?: string;
  body?: unknown;
  origin?: string;
  headers?: Record<string, string>;
}

/** Calls the API over HTTP, exactly as the browser would. */
export async function http<T = unknown>(
  path: string,
  options: HttpOptions = {},
): Promise<HttpResult<T>> {
  const { method = 'GET', cookie, body, origin, headers = {} } = options;

  const response = await fetch(`${TEST_API_BASE}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
      ...(origin ? { origin } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();

  return {
    status: response.status,
    body: (text.length > 0 ? JSON.parse(text) : null) as T,
    setCookie: response.headers.getSetCookie(),
  };
}

/** Creates a fresh anonymous identity. Every test starts from one of these. */
export async function createIdentity(): Promise<TestIdentity> {
  const result = await http<{ publicId: string }>('/session', { method: 'POST' });

  if (result.status !== 200 && result.status !== 201) {
    throw new Error(`POST /session failed: ${result.status} ${JSON.stringify(result.body)}`);
  }

  const cookie = result.setCookie.find((value) => value.startsWith(SESSION_COOKIE_NAME));
  if (!cookie) throw new Error('POST /session did not set a session cookie.');

  return { publicId: result.body.publicId, cookie: cookie.split(';')[0] ?? '' };
}

type RealtimeSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface ReceivedEvent {
  name: string;
  payload: unknown;
}

interface Waiter {
  name: string;
  predicate: ((payload: unknown) => boolean) | undefined;
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/** A real Socket.IO client, with the ergonomics tests need. */
export class RealtimeClient {
  private readonly events: ReceivedEvent[] = [];
  private readonly waiters = new Set<Waiter>();
  private readyPayload: SessionReadyPayload | null = null;

  private constructor(
    readonly socket: RealtimeSocket,
    readonly identity: TestIdentity,
  ) {
    // `onAny` rather than one `on` per event: it cannot drift out of sync with the
    // protocol, and it lets a test assert about events it did not think to list.
    this.socket.onAny((name: string, ...args: unknown[]) => {
      const payload = args[0];
      if (name === 'session:ready') this.readyPayload = payload as SessionReadyPayload;
      this.events.push({ name, payload });

      for (const waiter of [...this.waiters]) {
        if (waiter.name !== name) continue;
        if (waiter.predicate && !waiter.predicate(payload)) continue;
        this.waiters.delete(waiter);
        waiter.resolve(payload);
      }
    });
  }

  /** Connects and resolves once the server has confirmed the identity. */
  static async connect(identity: TestIdentity): Promise<RealtimeClient> {
    const socket: RealtimeSocket = io(TEST_API_URL, {
      // Websocket only: the polling upgrade path is Socket.IO's own business, and
      // testing it here would add latency and flakiness without adding coverage.
      transports: ['websocket'],
      // The session cookie is the only credential; there is no query-string token to
      // leak into logs.
      extraHeaders: { cookie: identity.cookie },
      // Reconnection is asserted explicitly by the tests, never left to the client.
      reconnection: false,
      forceNew: true,
      autoConnect: false,
    });

    const client = new RealtimeClient(socket, identity);
    const ready = client.waitFor('session:ready', { timeoutMs: 10_000 });
    socket.connect();
    await ready;

    return client;
  }

  get session(): SessionReadyPayload {
    if (!this.readyPayload) throw new Error('The socket has not received `session:ready` yet.');
    return this.readyPayload;
  }

  get connected(): boolean {
    return this.socket.connected;
  }

  /** All events received, in order. */
  get received(): readonly ReceivedEvent[] {
    return this.events;
  }

  /**
   * Waits for an event that has not arrived yet.
   *
   * `fromIndex` skips events already received, which is what "the *next* one" means.
   * The default of `0` also matches an event that is already in the buffer, so a
   * waiter registered before an asynchronous action still resolves if the event beat
   * it there.
   */
  waitFor<T = unknown>(
    name: string,
    options: {
      predicate?: (payload: unknown) => boolean;
      timeoutMs?: number;
      fromIndex?: number;
    } = {},
  ): Promise<T> {
    const { predicate, timeoutMs = DEFAULT_TIMEOUT_MS, fromIndex = 0 } = options;

    const existing = this.events
      .slice(fromIndex)
      .find((event) => event.name === name && (!predicate || predicate(event.payload)));
    if (existing) return Promise.resolve(existing.payload as T);

    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        name,
        predicate,
        resolve: (payload) => {
          clearTimeout(timer);
          resolve(payload as T);
        },
        reject,
      };

      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(
          new Error(
            `Timed out after ${timeoutMs} ms waiting for "${name}". Received: ` +
              (this.events.map((event) => event.name).join(', ') || '(nothing)'),
          ),
        );
      }, timeoutMs);

      this.waiters.add(waiter);
    });
  }

  /** Everything received under one event name, in order. */
  eventsNamed(name: string): unknown[] {
    return this.events.filter((event) => event.name === name).map((event) => event.payload);
  }

  /** Asserts that no *new* event arrives within the window. */
  async expectNoEvent(name: string, withinMs = 400): Promise<void> {
    try {
      await this.waitFor(name, { timeoutMs: withinMs, fromIndex: this.events.length });
    } catch {
      return;
    }
    throw new Error(`Expected no new "${name}" event, but one arrived.`);
  }

  /** Emits a client event and waits for its acknowledgement. */
  emit<T = unknown>(event: string, payload?: unknown): Promise<AckResult<T>> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          ok: false,
          error: { code: ErrorCode.DATABASE_UNAVAILABLE, message: 'acknowledgement timed out' },
        });
      }, DEFAULT_TIMEOUT_MS);

      const callback = (result: AckResult<T>) => {
        clearTimeout(timer);
        resolve(result);
      };

      const emitter = this.socket as unknown as { emit(event: string, ...args: unknown[]): void };
      if (payload === undefined) emitter.emit(event, callback);
      else emitter.emit(event, payload, callback);
    });
  }

  /**
   * Emits an event without waiting for an acknowledgement.
   *
   * Used to speak to the server with something the *typed* client does not know about,
   * which is exactly what a hostile or out-of-date client would do.
   */
  emitRaw(event: string, payload?: unknown): void {
    const emitter = this.socket as unknown as { emit(name: string, ...args: unknown[]): void };
    if (payload === undefined) emitter.emit(event);
    else emitter.emit(event, payload);
  }

  /** Drops the connection without closing the identity, as a lost network would. */
  drop(): void {
    this.socket.disconnect();
  }

  /** Reconnects and waits for the server to re-establish the session. */
  async resume(): Promise<void> {
    const ready = this.waitFor('session:ready', { timeoutMs: 10_000 });
    this.socket.connect();
    await ready;
  }

  close(): void {
    this.socket.removeAllListeners();
    this.socket.disconnect();
    for (const waiter of this.waiters) {
      waiter.reject(new Error('The client was closed while waiting.'));
    }
    this.waiters.clear();
  }
}

/** Joins the random queue and returns the acknowledgement. */
export function joinQueue(client: RealtimeClient) {
  return client.emit<{ queued: boolean; waitingSince: string }>('match:join');
}

/** Sends a chat message and returns the acknowledgement. */
export function sendMessage(
  client: RealtimeClient,
  chatId: string,
  text: string,
  clientMessageId?: string,
) {
  return client.emit<{ messageId: string; sentAt: string }>('chat:message', {
    chatId,
    text,
    clientMessageId: clientMessageId ?? `test-${Math.random().toString(36).slice(2, 12)}`,
  });
}

/**
 * Matches two identities through the real queue and returns both chat views.
 *
 * Used by most tests: matching is exercised thoroughly in its own suite, so the rest
 * just need "two people in a chat".
 */
export async function matchPair(
  a: RealtimeClient,
  b: RealtimeClient,
): Promise<{
  chatId: string;
  aStarted: { chat: { chatId: string }; initiator: boolean };
  bStarted: { chat: { chatId: string }; initiator: boolean };
}> {
  const aStarted = a.waitFor<{ chat: { chatId: string }; initiator: boolean }>('chat:started');
  const bStarted = b.waitFor<{ chat: { chatId: string }; initiator: boolean }>('chat:started');

  const aJoin = await joinQueue(a);
  if (!aJoin.ok) throw new Error(`match:join (a) failed: ${JSON.stringify(aJoin.error)}`);

  const bJoin = await joinQueue(b);
  if (!bJoin.ok) throw new Error(`match:join (b) failed: ${JSON.stringify(bJoin.error)}`);

  const [aPayload, bPayload] = await Promise.all([aStarted, bStarted]);
  if (aPayload.chat.chatId !== bPayload.chat.chatId) {
    throw new Error('The two participants were placed in different chats.');
  }

  return { chatId: aPayload.chat.chatId, aStarted: aPayload, bStarted: bPayload };
}
