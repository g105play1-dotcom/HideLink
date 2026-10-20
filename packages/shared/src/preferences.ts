/**
 * Voluntary profile data and the search filters built on top of it.
 *
 * ## One rule that shapes everything here
 *
 * Every value in this file is **self-declared and unverified**. AnonLink has no
 * sign-up, so there is nothing to verify it against: a user can say they are 30, in
 * Moscow, and call themselves whatever they like. The product therefore treats this
 * data as a *preference hint for matchmaking*, never as a fact about a person, and it
 * is never shown to the peer — the peer only ever sees an alias. Both the interface
 * and docs/PRODUCT_SPEC.md say so plainly rather than implying any verification.
 *
 * ## Why the rules live here
 *
 * `preferencesFit` and the relaxation ladder are pure functions shared by the API (the
 * authority) and the web app (which previews what a filter means before saving it).
 * Written once, they cannot disagree, and they are unit-testable without a server.
 *
 * ## Why filters are strict by default
 *
 * A filter that cannot be checked against a declaration is *not* satisfied — filtering
 * for women does not match someone who never said their gender. The alternative
 * ("nobody declared anything, so let everyone through") silently breaks the promise the
 * setting makes, which is the one behaviour users would report as a bug.
 */
import { z } from 'zod';

import { LANGUAGES, type Language } from './languages.js';

// -----------------------------------------------------------------------------
// Vocabularies
// -----------------------------------------------------------------------------

/**
 * Declared genders.
 *
 * `other` was removed on the owner's instruction (docs/DECISIONS.md D22): the interface
 * offered it as a third chip, and almost nobody picked it, while it made every gender
 * filter a three-way choice. Values already stored as `other` are not rewritten — the
 * read paths narrow them through {@link isGender}, so they degrade to "not stated",
 * which never satisfies a filter (fail-closed, see the module comment).
 */
export const GENDERS = ['female', 'male'] as const;
export type Gender = (typeof GENDERS)[number];

/**
 * Languages a chat can be held in.
 *
 * A fixed list rather than free text: it feeds a multi-select, it is validated on the
 * server, and comparing two free-text spellings of the same language would match nothing.
 *
 * The list itself lives in `languages.ts` because it is *generated* from CLDR rather than
 * maintained by hand (`scripts/generate-vocabularies.mjs`): every language is named in its
 * own language, and widening the list is additive — the wire and the database carry the
 * ISO code, so a stored value never becomes invalid.
 */

export const PROFILE_LIMITS = {
  /** Longest accepted place name. Free text, but bounded. */
  PLACE_MAX_LENGTH: 64,
  /**
   * How many places one filter list may name.
   *
   * A bound, not a policy: the lists feed a multi-select over hints, and an unbounded
   * payload is a payload nobody validated. Ten covers "все города, где у меня есть
   * дела" and keeps the request small.
   */
  PLACE_FILTER_MAX: 10,
  BIRTH_YEAR_MIN: 1900,
  /**
   * Age-filter bounds are *technical*, not a policy.
   *
   * The owner decided the service imposes no age restriction: where a filter starts and
   * ends is the user's own choice. These two numbers exist only so a value has to look
   * like an age at all (`-1`, `1000` are refused); they do not restrict who may be
   * searched for.
   */
  AGE_MIN: 0,
  AGE_MAX: 120,
} as const;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** What an identity says about itself. Every field is optional. */
export interface DeclaredProfile {
  gender: Gender | null;
  /** Year of birth, not age: an age would silently go stale. */
  birthYear: number | null;
  city: string | null;
  region: string | null;
  languages: readonly Language[];
}

export const EMPTY_PROFILE: DeclaredProfile = {
  gender: null,
  birthYear: null,
  city: null,
  region: null,
  languages: [],
};

/**
 * Where a random search looks, and what it must not assume.
 *
 * The first version of this filter was two *modes* — «только мой город» and «только мой
 * регион» — compared against the searcher's own declaration. The owner rejected that on
 * 2026-10-20: the row has to be the same kind of list as the other filters, a multi-select
 * of concrete places, with «Любой» as the neutral chip (docs/DECISIONS.md D27).
 *
 * So the filter names places, and the candidate's *declared* city/region is what it is
 * compared against. The searcher's own declaration no longer takes part: "искать в
 * Москве и Казани" does not depend on where the searcher lives.
 */
export interface SearchPreferences {
  genders: readonly Gender[];
  ageMin: number | null;
  ageMax: number | null;
  /**
   * City names a candidate's declared city must be one of. Empty = no constraint.
   *
   * Compared through `normalizePlace`, and the union of `cities` and `regions` is an
   * **or**: naming both accepts a candidate who matches either. A candidate who declared
   * nothing never satisfies a place filter — guessing would match strangers.
   */
  cities: readonly string[];
  /** Region names, with the same rules as {@link cities}. */
  regions: readonly string[];
  languages: readonly Language[];
  /**
   * Whether the server may drop filters, visibly, after a long wait.
   *
   * `false` by default: silently widening a search would hand the user a partner they
   * explicitly asked not to meet.
   */
  relaxAllowed: boolean;
}

export const DEFAULT_SEARCH_PREFERENCES: SearchPreferences = {
  genders: [],
  ageMin: null,
  ageMax: null,
  cities: [],
  regions: [],
  languages: [],
  relaxAllowed: false,
};

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

export const genderSchema = z.enum(GENDERS);
export const languageSchema = z.enum(LANGUAGES);

/**
 * Narrowing guards for data that comes *out* of storage rather than off the wire.
 *
 * Everything written through the API is validated first, so these exist for the paths
 * that do not pass through a schema: rows read back from the database. Reading must
 * never assume the write path was the only author.
 */
const GENDER_SET: ReadonlySet<string> = new Set(GENDERS);
const LANGUAGE_SET: ReadonlySet<string> = new Set(LANGUAGES);

export function isGender(value: string): value is Gender {
  return GENDER_SET.has(value);
}

export function isLanguage(value: string): value is Language {
  return LANGUAGE_SET.has(value);
}

const placeSchema = z.string().trim().min(1).max(PROFILE_LIMITS.PLACE_MAX_LENGTH);

/**
 * A list of place names, as stored in one filter column.
 *
 * A stored list goes through `normalizePlaces`, which drops unusable entries and
 * duplicates: a row written before a bound changed, or edited by hand, must not make the
 * matchmaker compare against a value no request could have produced.
 */
const placeFilterSchema = z
  .array(placeSchema)
  .max(PROFILE_LIMITS.PLACE_FILTER_MAX)
  .transform((values) => normalizePlaces(values));

/**
 * Year of birth. The upper bound is "this year" rather than a constant, so the schema
 * does not have to be edited every January.
 */
const birthYearSchema = z
  .number()
  .int()
  .min(PROFILE_LIMITS.BIRTH_YEAR_MIN)
  .max(new Date().getFullYear());

/**
 * A partial profile update.
 *
 * `null` clears a field; omitting it leaves it as it was. The distinction matters:
 * "I no longer want to say my city" is a real action, and it must not be expressible
 * only by setting an empty string.
 */
export const profileUpdateSchema = z
  .object({
    gender: genderSchema.nullable().optional(),
    birthYear: birthYearSchema.nullable().optional(),
    city: placeSchema.nullable().optional(),
    region: placeSchema.nullable().optional(),
    languages: z.array(languageSchema).max(LANGUAGES.length).optional(),
  })
  .strict();

export const searchPreferencesSchema = z
  .object({
    genders: z.array(genderSchema).max(GENDERS.length),
    ageMin: z.number().int().min(PROFILE_LIMITS.AGE_MIN).max(PROFILE_LIMITS.AGE_MAX).nullable(),
    ageMax: z.number().int().min(PROFILE_LIMITS.AGE_MIN).max(PROFILE_LIMITS.AGE_MAX).nullable(),
    cities: placeFilterSchema,
    regions: placeFilterSchema,
    languages: z.array(languageSchema).max(LANGUAGES.length),
    relaxAllowed: z.boolean(),
  })
  .strict()
  /**
   * The one cross-field rule, and the reason this schema is a `ZodEffects`.
   *
   * Each bound is individually valid, but `ageMin: 40` with `ageMax: 30` describes nobody
   * at all: the search would wait forever without ever saying why. It cannot live on the
   * *update* schema, because a request that moves one bound is only valid or invalid in
   * combination with the stored value of the other — which is exactly why the settings
   * endpoint merges first and then parses the result through this schema.
   */
  .refine(
    (prefs) => prefs.ageMin === null || prefs.ageMax === null || prefs.ageMin <= prefs.ageMax,
    { message: 'AGE_RANGE_INVERTED', path: ['ageMax'] },
  );

/**
 * A partial filter update.
 *
 * Cross-field rules (`ageMin <= ageMax`) are deliberately *not* refinements here: a
 * request that changes only one bound is valid or invalid depending on the stored value
 * of the other. The service merges first and validates the result with
 * `searchPreferencesSchema`, so the pair is always checked as a pair.
 */
export const searchPreferencesUpdateSchema = z
  .object({
    genders: z.array(genderSchema).max(GENDERS.length).optional(),
    ageMin: z
      .number()
      .int()
      .min(PROFILE_LIMITS.AGE_MIN)
      .max(PROFILE_LIMITS.AGE_MAX)
      .nullable()
      .optional(),
    ageMax: z
      .number()
      .int()
      .min(PROFILE_LIMITS.AGE_MIN)
      .max(PROFILE_LIMITS.AGE_MAX)
      .nullable()
      .optional(),
    cities: placeFilterSchema.optional(),
    regions: placeFilterSchema.optional(),
    languages: z.array(languageSchema).max(LANGUAGES.length).optional(),
    relaxAllowed: z.boolean().optional(),
  })
  .strict();

/**
 * The `PATCH /me/settings` body: privacy, declared profile and filters together.
 *
 * Blocking is deliberately absent. Whether the action exists at all is a platform
 * policy the owner sets in `/admin` (docs/DECISIONS.md D31), not a per-user setting:
 * an anonymous user granting themselves a moderation capability was the wrong shape.
 */
export const settingsUpdateSchema = z
  .object({
    incomingRequests: z.enum(['everyone', 'nobody']).optional(),
    profile: profileUpdateSchema.optional(),
    search: searchPreferencesUpdateSchema.optional(),
  })
  .strict();

export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;
export type SearchPreferencesUpdate = z.infer<typeof searchPreferencesUpdateSchema>;

// -----------------------------------------------------------------------------
// Matching rules
// -----------------------------------------------------------------------------

/**
 * Fold a user-declared place name for comparison.
 *
 * Case, surrounding space, repeated space and `ё`/`е` are ignored: two people typing
 * "Королёв" and "королев " mean the same town, and reporting them as different would
 * make the filter useless. Nothing else is normalised — in particular this is *not*
 * geocoding, so "Спб" and "Санкт-Петербург" stay different, as they must.
 */
export function normalizePlace(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/gu, ' ').replace(/ё/gu, 'е');
  return normalized.length > 0 ? normalized : null;
}

/**
 * A place filter, made comparable.
 *
 * Deduplicates by `normalizePlace` — "Москва" and "москва " are one city — keeps the
 * first spelling as typed (the interface shows the user's own words back), and drops
 * values that normalize to nothing. An empty result is legitimate: it means "anywhere".
 */
export function normalizePlaces(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = normalizePlace(value);
    if (normalized === null || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(value.trim());
  }

  return result;
}

/** The names in a filter list, folded for comparison. */
function placeSet(values: readonly string[]): Set<string> {
  const set = new Set<string>();

  for (const value of values) {
    const normalized = normalizePlace(value);
    if (normalized !== null) set.add(normalized);
  }

  return set;
}

/**
 * Age implied by a declared year of birth.
 *
 * Year granularity, not days: the input is a year the user typed, so anything more
 * precise would be invented.
 */
export function ageFromBirthYear(birthYear: number, now: Date = new Date()): number {
  return now.getUTCFullYear() - birthYear;
}

/**
 * Year of birth for an age the user typed.
 *
 * The interface asks for an *age* because that is what a person knows about themselves
 * without arithmetic, but a stored age silently goes stale: someone who entered "25" in
 * 2026 would still read as 25 in 2030, and every age filter would quietly be wrong. The
 * conversion happens once, at the edge, so the stored value stays correct forever and
 * the matchmaker, the filters and the relaxation ladder are untouched.
 *
 * See docs/DECISIONS.md D22 for why the field is labelled "Возраст" while the database
 * column stays `declaredBirthYear`.
 */
export function birthYearFromAge(age: number, now: Date = new Date()): number {
  return now.getUTCFullYear() - Math.round(age);
}

/**
 * Whether `candidate` satisfies `prefs`.
 *
 * The searcher's own declaration plays no part: every filter names what it wants (a
 * gender, an age, a list of places), which is also why this function no longer takes a
 * second profile. Every unmet or *unverifiable* condition returns `false`; see the
 * module comment.
 */
export function preferencesFit(
  prefs: SearchPreferences,
  candidate: DeclaredProfile,
  now: Date = new Date(),
): boolean {
  if (prefs.genders.length > 0) {
    if (candidate.gender === null || !prefs.genders.includes(candidate.gender)) return false;
  }

  if (prefs.ageMin !== null || prefs.ageMax !== null) {
    if (candidate.birthYear === null) return false;

    const age = ageFromBirthYear(candidate.birthYear, now);
    if (prefs.ageMin !== null && age < prefs.ageMin) return false;
    if (prefs.ageMax !== null && age > prefs.ageMax) return false;
  }

  if (prefs.cities.length > 0 || prefs.regions.length > 0) {
    // "One of the places I named", not "all of them": the two lists — and the names
    // inside each — form one union, so naming Moscow and Tatarstan accepts a candidate
    // who matches either. Declaring nothing cannot satisfy a place filter: guessing
    // would match strangers.
    const cities = placeSet(prefs.cities);
    const regions = placeSet(prefs.regions);
    const candidateCity = normalizePlace(candidate.city);
    const candidateRegion = normalizePlace(candidate.region);

    const matchesCity = candidateCity !== null && cities.has(candidateCity);
    const matchesRegion = candidateRegion !== null && regions.has(candidateRegion);

    if (!matchesCity && !matchesRegion) return false;
  }

  if (prefs.languages.length > 0) {
    const shares = candidate.languages.some((language) => prefs.languages.includes(language));
    if (!shares) return false;
  }

  return true;
}

export interface MatchSide {
  profile: DeclaredProfile;
  preferences: SearchPreferences;
}

/**
 * The rule the matchmaker applies: *both* sides' filters must be satisfied.
 *
 * Symmetric by construction, because a chat that one participant's filters forbid is
 * not a smaller version of a good match — it is the exact outcome they opted out of.
 * A filter is a refusal, and consent has to hold in both directions.
 */
export function mutuallyCompatible(a: MatchSide, b: MatchSide, now: Date = new Date()): boolean {
  return (
    preferencesFit(a.preferences, b.profile, now) && preferencesFit(b.preferences, a.profile, now)
  );
}

/**
 * How many filters the user has set.
 *
 * A count, not a boolean, because it is the natural upper bound on how many relaxation
 * steps can possibly change anything.
 */
export function activeFilterCount(prefs: SearchPreferences): number {
  return activeRelaxationOrder(prefs).length;
}

/** Whether anything is actually being filtered. */
export function hasActiveFilters(prefs: SearchPreferences): boolean {
  return activeFilterCount(prefs) > 0;
}

// -----------------------------------------------------------------------------
// Relaxation
// -----------------------------------------------------------------------------

/**
 * The order in which filters are dropped when a search drags on, and the reason for it.
 *
 * Least meaningful first, so the user keeps the criteria they cared about for as long
 * as possible:
 *  1. `languages` — pleasant, rarely decisive, and the easiest to work around;
 *  2. `location` — a declared, unverifiable place name;
 *  3. `age` — a coarse, self-typed year;
 *  4. `genders` — the most deliberate choice in the panel, dropped last.
 *
 * This order is the product decision. It is documented in docs/PRODUCT_SPEC.md, and the
 * user is always told which of these the server actually dropped.
 */
export const RELAXABLE_CRITERIA = ['languages', 'location', 'age', 'genders'] as const;
export type RelaxableCriterion = (typeof RELAXABLE_CRITERIA)[number];

/** Whether this criterion currently restricts anything. */
function criterionIsSet(prefs: SearchPreferences, criterion: RelaxableCriterion): boolean {
  switch (criterion) {
    case 'genders':
      return prefs.genders.length > 0;
    case 'age':
      return prefs.ageMin !== null || prefs.ageMax !== null;
    case 'location':
      return prefs.cities.length > 0 || prefs.regions.length > 0;
    case 'languages':
      return prefs.languages.length > 0;
  }
}

/** Removes one criterion, returning a copy. */
function dropCriterion(prefs: SearchPreferences, criterion: RelaxableCriterion): SearchPreferences {
  switch (criterion) {
    case 'genders':
      return { ...prefs, genders: [] };
    case 'age':
      return { ...prefs, ageMin: null, ageMax: null };
    case 'location':
      return { ...prefs, cities: [], regions: [] };
    case 'languages':
      return { ...prefs, languages: [] };
  }
}

/**
 * The filters the user actually set, in the order relaxation removes them.
 *
 * Only *set* criteria appear. Dropping a filter that was never applied would burn a
 * relaxation step, tell the user nothing, and make them wait just as long for the step
 * that matters — which is why the ladder is defined over this list rather than over
 * every possible criterion.
 */
export function activeRelaxationOrder(prefs: SearchPreferences): RelaxableCriterion[] {
  return RELAXABLE_CRITERIA.filter((criterion) => criterionIsSet(prefs, criterion));
}

/**
 * Applies `steps` relaxation steps: the first `steps` filters from
 * {@link activeRelaxationOrder}, and nothing else.
 *
 * Returns the criteria now in force *and* the filters that were removed, because the
 * caller has to be able to say exactly what changed. Asking for more steps than there
 * are filters is harmless and idempotent — the extra steps simply have nothing to do.
 */
export function relaxBySteps(
  prefs: SearchPreferences,
  steps: number,
): { criteria: SearchPreferences; dropped: RelaxableCriterion[] } {
  const active = activeRelaxationOrder(prefs);
  const count = Math.max(0, Math.min(steps, active.length));
  const dropped = active.slice(0, count);

  return {
    criteria: dropped.reduce(dropCriterion, { ...prefs }),
    dropped,
  };
}

/**
 * How many relaxation steps the server may have taken after waiting `waitedMs`.
 *
 * `0` inside the initial window, then one step per `stepMs`, uncapped here because the
 * caller clamps to the number of filters actually set. Time-based rather than
 * idle-based, so the behaviour is observable in the interface and reproducible in a test.
 */
export function relaxationStage(
  waitedMs: number,
  options: { relaxAfterMs: number; stepMs: number },
): number {
  if (waitedMs < options.relaxAfterMs) return 0;

  return Math.floor((waitedMs - options.relaxAfterMs) / Math.max(1, options.stepMs)) + 1;
}
