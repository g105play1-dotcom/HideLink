/**
 * Translation between the identity settings columns and the API/wire view.
 *
 * Centralised because three callers need exactly the same answer: the identity service
 * (REST), the directory (the matchmaker's synchronous view) and the tests. If each of
 * them mapped the columns itself, "what the user set" and "what the matchmaker applies"
 * could quietly diverge — the one bug that would make a filter look broken.
 *
 * Reading is defensive: values are narrowed against the shared vocabularies rather than
 * trusted, because a column can only be written through the validated update path but a
 * hand-edited database or a future rollback would not respect that. An unreadable
 * *filter* is treated as "no constraint" and logged, so the degradation is visible in
 * the logs instead of silently changing who gets matched.
 */
import {
  INCOMING_REQUEST_POLICIES,
  isGender,
  isLanguage,
  normalizePlaces,
  type DeclaredProfile,
  type Gender,
  type IdentitySettingsView,
  type IncomingRequestPolicy,
  type Language,
  type ProfileUpdate,
  type SearchPreferences,
} from '@anonlink/shared';

/**
 * The settings columns, structurally typed.
 *
 * Deliberately not the generated Prisma types: this file has to be usable from the
 * directory, and a structural shape keeps the mapping honest about what it actually
 * reads — a renamed or removed column breaks compilation here, which is the point.
 */
export interface IdentitySettingsRow {
  incomingRequests: string;
  blockingEnabled: boolean;
  declaredGender: string | null;
  declaredBirthYear: number | null;
  declaredCity: string | null;
  declaredRegion: string | null;
  declaredLanguages: readonly string[];
  prefGenders: readonly string[];
  prefAgeMin: number | null;
  prefAgeMax: number | null;
  prefCities: readonly string[];
  prefRegions: readonly string[];
  prefLanguages: readonly string[];
  prefRelax: boolean;
}

/** Exactly the columns `IdentitySettingsRow` describes, for `select`. */
export const IDENTITY_SETTINGS_SELECT = {
  incomingRequests: true,
  blockingEnabled: true,
  declaredGender: true,
  declaredBirthYear: true,
  declaredCity: true,
  declaredRegion: true,
  declaredLanguages: true,
  prefGenders: true,
  prefAgeMin: true,
  prefAgeMax: true,
  prefCities: true,
  prefRegions: true,
  prefLanguages: true,
  prefRelax: true,
} as const satisfies Record<keyof IdentitySettingsRow, true>;

function toIncomingRequests(value: string): IncomingRequestPolicy {
  return (INCOMING_REQUEST_POLICIES as readonly string[]).includes(value)
    ? (value as IncomingRequestPolicy)
    : 'everyone';
}

function languages(values: readonly string[]): Language[] {
  return values.filter(isLanguage);
}

/**
 * The place lists actually stored.
 *
 * `normalizePlaces` deduplicates by the folded spelling and drops unusable entries, so a
 * hand-edited row cannot make the matchmaker compare against a value no request could
 * have produced. An empty list means "anywhere" — the same bounded fail-open the other
 * filters have (see docs/DECISIONS.md D22/D27).
 */
function places(values: readonly string[]): string[] {
  return normalizePlaces(values);
}

export function toDeclaredProfile(row: IdentitySettingsRow): DeclaredProfile {
  return {
    gender: row.declaredGender !== null && isGender(row.declaredGender) ? row.declaredGender : null,
    birthYear: row.declaredBirthYear,
    city: row.declaredCity,
    region: row.declaredRegion,
    languages: languages(row.declaredLanguages),
  };
}

export function toSearchPreferences(row: IdentitySettingsRow): SearchPreferences {
  return {
    genders: row.prefGenders.filter(isGender),
    ageMin: row.prefAgeMin,
    ageMax: row.prefAgeMax,
    cities: places(row.prefCities),
    regions: places(row.prefRegions),
    languages: languages(row.prefLanguages),
    relaxAllowed: row.prefRelax,
  };
}

export function toSettingsView(row: IdentitySettingsRow): IdentitySettingsView {
  return {
    incomingRequests: toIncomingRequests(row.incomingRequests),
    blockingEnabled: row.blockingEnabled,
    profile: toDeclaredProfile(row),
    search: toSearchPreferences(row),
  };
}

// -----------------------------------------------------------------------------
// Writing
// -----------------------------------------------------------------------------

/**
 * A settings change that has already been merged with the stored values and validated.
 *
 * The merging lives in the controller because only it holds both halves: the stored
 * settings (from the authenticated identity) and the request. `search` therefore arrives
 * here complete rather than partial, which is what lets one field change be validated
 * against the stored value of another — `ageMin: 40` must be checked against the stored
 * `ageMax`, not on its own.
 */
export interface SettingsUpdateCommand {
  incomingRequests?: IncomingRequestPolicy;
  blockingEnabled?: boolean;
  profile?: ProfileUpdate;
  search?: SearchPreferences;
}

/** Column values for a settings write. Structural so Prisma can accept it directly. */
export interface IdentitySettingsData {
  incomingRequests?: IncomingRequestPolicy;
  blockingEnabled?: boolean;
  declaredGender?: Gender | null;
  declaredBirthYear?: number | null;
  declaredCity?: string | null;
  declaredRegion?: string | null;
  declaredLanguages?: Language[];
  prefGenders?: Gender[];
  prefAgeMin?: number | null;
  prefAgeMax?: number | null;
  prefCities?: string[];
  prefRegions?: string[];
  prefLanguages?: Language[];
  prefRelax?: boolean;
}

/**
 * Maps a partial profile update onto columns.
 *
 * `'field' in update` is deliberate rather than `update.field !== undefined`: an explicit
 * `null` means "I no longer want to say this", while an absent key means "leave it
 * alone". Collapsing the two would make it impossible to retract a declared city.
 */
export function profileToColumns(profile: ProfileUpdate): IdentitySettingsData {
  const data: IdentitySettingsData = {};

  if ('gender' in profile) data.declaredGender = profile.gender ?? null;
  if ('birthYear' in profile) data.declaredBirthYear = profile.birthYear ?? null;
  if ('city' in profile) data.declaredCity = profile.city ?? null;
  if ('region' in profile) data.declaredRegion = profile.region ?? null;
  if (profile.languages !== undefined) data.declaredLanguages = [...profile.languages];

  return data;
}

/** Maps the complete set of filters onto columns. Always writes every column. */
export function preferencesToColumns(search: SearchPreferences): IdentitySettingsData {
  return {
    prefGenders: [...search.genders],
    prefAgeMin: search.ageMin,
    prefAgeMax: search.ageMax,
    prefCities: [...search.cities],
    prefRegions: [...search.regions],
    prefLanguages: [...search.languages],
    prefRelax: search.relaxAllowed,
  };
}
