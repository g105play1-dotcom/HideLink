/**
 * Runtime configuration.
 *
 * `NEXT_PUBLIC_API_URL` is inlined at build time by `next.config.ts`. The browser
 * talks to the API origin directly (no Next.js rewrite) so that the session cookie,
 * CORS and the Socket.IO handshake all behave exactly as they will in production.
 */
const rawApiUrl = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

/** Origin of the API, without a trailing slash. */
export const API_ORIGIN = rawApiUrl.replace(/\/+$/, '');

/** Base path of the REST API. */
export const API_BASE = `${API_ORIGIN}/api/v1`;
