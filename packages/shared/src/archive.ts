/**
 * The owner's chat-archive policy.
 *
 * AnonLink normally keeps a conversation only in the process that serves it. The owner
 * decided (2026-10-19, see `docs/DECISIONS.md` D21) that transcripts *may* be kept,
 * read only by the owner, and that the owner chooses — by hand — which conversations are
 * kept, what is kept and for how long. This module is that choice, expressed as data.
 *
 * ## Why it lives in `@anonlink/shared`
 *
 * The policy is evaluated on the server (which conversations are stored) *and* edited in
 * the owner's browser (which shows what the policy means before it is saved). Written
 * once, the two cannot drift: a form that says "everyone, text only" and a server that
 * reads "criteria, media" would be a silent privacy bug.
 *
 * ## Fail closed
 *
 * Nothing here is stored unless the policy is switched on *and* a participant is in
 * scope. An absent policy, an unknown audience or an unparseable value matches nobody —
 * a bug must never turn into "record everyone".
 */
import { z } from 'zod';

import { PUBLIC_ID_PATTERN } from './ids.js';
import { LANGUAGES } from './languages.js';
import {
  GENDERS,
  PROFILE_LIMITS,
  ageFromBirthYear,
  genderSchema,
  languageSchema,
  normalizePlace,
  type DeclaredProfile,
  type Gender,
} from './preferences.js';

// -----------------------------------------------------------------------------
// Vocabularies
// -----------------------------------------------------------------------------

/** Who the archive covers. */
export const ARCHIVE_AUDIENCES = ['everyone', 'criteria', 'selected'] as const;
export type ArchiveAudience = (typeof ARCHIVE_AUDIENCES)[number];

/**
 * Kinds of attachment the policy may ask to keep.
 *
 * Nothing in AnonLink produces an attachment yet (media is only architecturally
 * prepared — see `docs/PRODUCT_SPEC.md` §21), so a non-empty `storeMedia` currently
 * changes nothing: there is nothing to store. It is modelled now because the owner
 * asked to choose it by hand, and because the archive table already has the columns for
 * it; leaving it out would mean a schema migration the day the first image is sent.
 */
export const MEDIA_KINDS = ['image', 'video', 'audio', 'file'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Upper bound for the retention setting. Zero means "until the owner deletes it". */
export const ARCHIVE_RETENTION_MAX_DAYS = 3650;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Which declared attributes put a person in scope.
 *
 * An empty list is "no constraint on this attribute"; a set constraint behaves exactly
 * like a search filter — an attribute the person never declared does **not** satisfy it
 * (see the module comment in `preferences.ts`). That strictness is deliberate: "archive
 * everyone aged 20–30 who did not say their age" is not a thing anyone means.
 */
export interface ArchiveCriteria {
  genders: Gender[];
  ageMin: number | null;
  ageMax: number | null;
  cities: string[];
  regions: string[];
  languages: string[];
}

export interface ArchivePolicy {
  /** The master switch. Off means nothing is written anywhere. */
  enabled: boolean;
  audience: ArchiveAudience;
  criteria: ArchiveCriteria;
  /** Users chosen one by one, used when `audience` is `selected`. */
  selectedPublicIds: string[];
  /** Whether message text is kept. */
  storeText: boolean;
  /** Which attachments would be kept. Inert until the product can send any. */
  storeMedia: MediaKind[];
  /** Days an archive is kept before the sweep deletes it. `0` = keep until deleted. */
  retentionDays: number;
}

/** One participant, reduced to what the policy can match on. */
export interface ArchiveSubject {
  publicId: string;
  profile: DeclaredProfile;
}

export const EMPTY_ARCHIVE_CRITERIA: ArchiveCriteria = {
  genders: [],
  ageMin: null,
  ageMax: null,
  cities: [],
  regions: [],
  languages: [],
};

/**
 * The state of a fresh installation: nothing is stored.
 *
 * Archiving is opt-in, so this is what the server runs with until the owner turns it on.
 */
export const DEFAULT_ARCHIVE_POLICY: ArchivePolicy = {
  enabled: false,
  audience: 'everyone',
  criteria: EMPTY_ARCHIVE_CRITERIA,
  selectedPublicIds: [],
  storeText: true,
  storeMedia: [],
  retentionDays: 90,
};

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

export const archiveAudienceSchema = z.enum(ARCHIVE_AUDIENCES);
export const mediaKindSchema = z.enum(MEDIA_KINDS);

const publicIdSchema = z.string().regex(PUBLIC_ID_PATTERN, 'PUBLIC_ID');
const placeSchema = z.string().trim().min(1).max(PROFILE_LIMITS.PLACE_MAX_LENGTH);

export const archiveCriteriaSchema = z
  .object({
    genders: z.array(genderSchema).max(GENDERS.length),
    ageMin: z.number().int().min(PROFILE_LIMITS.AGE_MIN).max(PROFILE_LIMITS.AGE_MAX).nullable(),
    ageMax: z.number().int().min(PROFILE_LIMITS.AGE_MIN).max(PROFILE_LIMITS.AGE_MAX).nullable(),
    cities: z.array(placeSchema).max(200),
    regions: z.array(placeSchema).max(200),
    languages: z.array(languageSchema).max(LANGUAGES.length),
  })
  .strict();

/**
 * The whole policy, validated as one object.
 *
 * The cross-field rules are refinements rather than defaults, because a policy that
 * cannot do what it says is worse than a rejected one:
 *  - `enabled` with nothing selected to store would be a switch that does nothing;
 *  - `criteria` with an empty criteria set silently means "everyone", which is exactly
 *    the surprise this feature must never cause — so it is refused, not guessed;
 *  - `selected` with no IDs likewise.
 */
export const archivePolicySchema = z
  .object({
    enabled: z.boolean(),
    audience: archiveAudienceSchema,
    criteria: archiveCriteriaSchema,
    selectedPublicIds: z.array(publicIdSchema).max(1000),
    storeText: z.boolean(),
    storeMedia: z.array(mediaKindSchema).max(MEDIA_KINDS.length),
    retentionDays: z.number().int().min(0).max(ARCHIVE_RETENTION_MAX_DAYS),
  })
  .strict()
  .refine((policy) => !policy.enabled || policy.storeText || policy.storeMedia.length > 0, {
    message: 'NOTHING_TO_STORE',
    path: ['storeText'],
  })
  .refine((policy) => policy.audience !== 'criteria' || !archiveCriteriaIsEmpty(policy.criteria), {
    message: 'CRITERIA_REQUIRED',
    path: ['audience'],
  })
  .refine((policy) => policy.audience !== 'selected' || policy.selectedPublicIds.length > 0, {
    message: 'SELECTED_REQUIRED',
    path: ['selectedPublicIds'],
  })
  .refine(
    (policy) =>
      policy.criteria.ageMin === null ||
      policy.criteria.ageMax === null ||
      policy.criteria.ageMin <= policy.criteria.ageMax,
    { message: 'AGE_RANGE_INVERTED', path: ['criteria', 'ageMax'] },
  );

// -----------------------------------------------------------------------------
// Evaluation
// -----------------------------------------------------------------------------

/** True when the criteria constrain nothing at all. */
export function archiveCriteriaIsEmpty(criteria: ArchiveCriteria): boolean {
  return (
    criteria.genders.length === 0 &&
    criteria.ageMin === null &&
    criteria.ageMax === null &&
    criteria.cities.length === 0 &&
    criteria.regions.length === 0 &&
    criteria.languages.length === 0
  );
}

/** Whether one declared attribute set satisfies the criteria. Never throws. */
export function archiveCriteriaMatch(
  criteria: ArchiveCriteria,
  subject: ArchiveSubject,
  now: Date = new Date(),
): boolean {
  const { profile } = subject;

  if (criteria.genders.length > 0) {
    if (profile.gender === null || !criteria.genders.includes(profile.gender)) return false;
  }

  if (criteria.ageMin !== null || criteria.ageMax !== null) {
    if (profile.birthYear === null) return false;
    const age = ageFromBirthYear(profile.birthYear, now);
    if (criteria.ageMin !== null && age < criteria.ageMin) return false;
    if (criteria.ageMax !== null && age > criteria.ageMax) return false;
  }

  if (criteria.cities.length > 0) {
    const city = normalizePlace(profile.city);
    if (city === null || !criteria.cities.some((value) => normalizePlace(value) === city)) {
      return false;
    }
  }

  if (criteria.regions.length > 0) {
    const region = normalizePlace(profile.region);
    if (region === null || !criteria.regions.some((value) => normalizePlace(value) === region)) {
      return false;
    }
  }

  if (criteria.languages.length > 0) {
    if (!profile.languages.some((language) => criteria.languages.includes(language))) return false;
  }

  return true;
}

/** Whether one person is in the archive's scope. */
export function archiveSubjectMatches(
  policy: ArchivePolicy,
  subject: ArchiveSubject,
  now: Date = new Date(),
): boolean {
  if (!policy.enabled) return false;

  switch (policy.audience) {
    case 'everyone':
      return true;
    case 'selected':
      return policy.selectedPublicIds.includes(subject.publicId);
    case 'criteria':
      return archiveCriteriaMatch(policy.criteria, subject, now);
    default:
      // An audience the code does not know about must match nobody, never everybody.
      return false;
  }
}

/**
 * Whether a chat between `subjects` should be archived.
 *
 * **Either** participant being in scope is enough: the owner selects *people*, and a
 * conversation with a selected person cannot be half-recorded. The consequence — the
 * other participant's messages are kept too, although they matched nothing — is stated
 * plainly in `docs/SECURITY.md` rather than left implicit.
 */
export function shouldArchiveChat(
  policy: ArchivePolicy,
  subjects: readonly ArchiveSubject[],
  now: Date = new Date(),
): boolean {
  if (!policy.enabled) return false;
  return subjects.some((subject) => archiveSubjectMatches(policy, subject, now));
}
