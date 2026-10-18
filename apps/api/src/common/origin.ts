/**
 * Origin policy shared by REST and WebSocket entry points.
 *
 * AnonLink authenticates with an HttpOnly cookie. Two layers protect against
 * cross-site abuse:
 *  1. `SameSite=Lax` on the cookie, which keeps it off cross-site POSTs;
 *  2. this allow-list, checked on state-changing requests and on the socket
 *     handshake.
 *
 * A missing `Origin` header is allowed: non-browser clients (curl, tests, server
 * to server) do not send one, and they cannot borrow a browser's cookie jar.
 */
export function isOriginAllowed(
  origin: string | undefined | null,
  allowedOrigins: readonly string[],
): boolean {
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}
