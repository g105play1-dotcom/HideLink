import type { IncomingRequestPolicy } from './limits.js';
import type { DeclaredProfile, SearchPreferences } from './preferences.js';

/**
 * REST response contracts.
 *
 * These live in `@anonlink/shared` — not in the API package — precisely because the
 * browser and the server must agree on them. If they were declared server-side, the
 * web app would have to re-declare them by hand and the two would drift silently:
 * the browser would keep compiling while rendering the wrong field.
 *
 * Every view here is *deliberately* minimal. A field that is not needed to render a
 * screen is not returned, because an unused field is still a leak: it lets a caller
 * who can see the response learn something the product never intended to expose.
 */

/** Public representation of the caller's own anonymous identity. */
export interface SessionView {
  publicId: string;
  createdAt: string;
  sessionExpiresAt: string;
  settings: IdentitySettingsView;
}

/**
 * The caller's own settings, as returned by `GET /session`, `POST /session` and
 * `PATCH /me/settings`.
 *
 * One object rather than three endpoints: these are the values the settings screen
 * edits, and they are always needed together — the search filters only mean anything
 * next to the declaration they are compared against.
 */
export interface IdentitySettingsView {
  incomingRequests: IncomingRequestPolicy;
  /** What the owner says about themselves. Unverified; used only to evaluate filters. */
  profile: DeclaredProfile;
  /** How the owner wants random partners filtered. */
  search: SearchPreferences;
}

export interface CurrentSessionView {
  authenticated: boolean;
  session: SessionView | null;
}

/**
 * The result of looking a User ID up.
 *
 * Note what is absent: nothing about activity, ban state or account age. Returning
 * "exists but is banned" would turn the endpoint into an oracle, so a banned identity
 * is reported exactly like a normal one. `acceptsRequests` is included because it is
 * something the caller can act on (they should not bother sending a request).
 */
export interface UserLookupView {
  publicId: string;
  exists: boolean;
  acceptsRequests: boolean;
}

/** One entry in the caller's own block list. */
export interface BlockedUserView {
  publicId: string;
  blockedAt: string;
}

export interface BlockListResponse {
  blocks: BlockedUserView[];
}
