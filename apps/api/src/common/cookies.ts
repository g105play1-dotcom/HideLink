/**
 * Minimal, dependency-free cookie handling.
 *
 * Only one cookie is ever read (the session token), and its value is a
 * base64url string, so the full RFC 6265 parser is unnecessary. Keeping this
 * local means the exact same function is used for HTTP requests and for the
 * WebSocket handshake, which is where cookie parsing bugs usually hide.
 */

export const SESSION_COOKIE_NAME = 'anonlink_session';

/**
 * The owner's admin cookie.
 *
 * Holds the owner key itself, but only after it has been sent once over the API: the
 * browser's JavaScript never has to keep the secret, and an `HttpOnly` cookie cannot be
 * read by a script. `SameSite=Strict` keeps it off cross-site requests, on top of the
 * origin allow-list every state-changing request already passes through.
 */
export const ADMIN_COOKIE_NAME = 'anonlink_admin';

/**
 * Parses a `Cookie` header into a plain object.
 *
 * Later duplicates win, matching browser behaviour for the same name.
 * Malformed segments are skipped rather than throwing: a bad cookie must never
 * be able to crash the request pipeline.
 */
export function parseCookieHeader(header: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;

  for (const segment of header.split(';')) {
    const index = segment.indexOf('=');
    if (index <= 0) continue;

    const name = segment.slice(0, index).trim();
    if (!name) continue;

    let value = segment.slice(index + 1).trim();
    // A quoted cookie value is legal; strip one layer of surrounding quotes.
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    try {
      out[name] = decodeURIComponent(value);
    } catch {
      // Not percent-encoded; use as-is.
      out[name] = value;
    }
  }

  return out;
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  path?: string;
  domain?: string;
}

/**
 * Serialises a cookie for a `Set-Cookie` header.
 *
 * `SameSite=Lax` is the default: it keeps the session cookie off cross-site
 * POSTs, which is what makes cookie-authenticated state changes resistant to
 * cross-site request forgery.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  parts.push(`Path=${options.path ?? '/'}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (typeof options.maxAgeSeconds === 'number') {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  }
  if (options.httpOnly ?? true) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);

  return parts.join('; ');
}

/** Builds a cookie that immediately expires, for logout / identity rotation. */
export function serializeClearedCookie(
  name: string,
  options: Pick<CookieOptions, 'path' | 'domain' | 'secure' | 'sameSite'> = {},
): string {
  return serializeCookie(name, '', { ...options, maxAgeSeconds: 0, httpOnly: true });
}

/**
 * Produces a stable, low-cardinality fingerprint of the client address.
 *
 * `X-Forwarded-For` is only honoured when the operator explicitly opts in via
 * `TRUST_PROXY`, because trusting it by default would let a client forge the value.
 */
export function clientAddress(
  headers: Record<string, string | string[] | undefined>,
  socketAddress: string | undefined,
  trustProxy: boolean,
): string | undefined {
  if (trustProxy) {
    const forwarded = headers['x-forwarded-for'];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = raw?.split(',')[0]?.trim();
    if (first) return first;
  }
  return socketAddress;
}
