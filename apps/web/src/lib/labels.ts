import {
  ageFromBirthYear,
  type DeclaredProfile,
  type Gender,
  type Language,
  type LocationMode,
  type RelaxableCriterion,
  type SearchPreferences,
} from '@anonlink/shared';

/**
 * Russian names for the shared vocabularies.
 *
 * The wire protocol and the database use stable identifiers (`female`, `ru`, `city`), and
 * those identifiers must never reach the screen: `Record<Gender, string>` makes the
 * mapping exhaustive at compile time, so adding a language to the shared list is a type
 * error here until it has a name a user can read.
 */

export const GENDER_LABELS: Record<Gender, string> = {
  female: 'Женский',
  male: 'Мужской',
};

export const LANGUAGE_LABELS: Record<Language, string> = {
  ru: 'Русский',
  en: 'Английский',
  uk: 'Украинский',
  kk: 'Казахский',
  de: 'Немецкий',
  fr: 'Французский',
  es: 'Испанский',
  tr: 'Турецкий',
  zh: 'Китайский',
  ar: 'Арабский',
};

export const LOCATION_LABELS: Record<LocationMode, string> = {
  any: 'Любой город',
  city: 'Только мой город',
  region: 'Только мой регион',
};

/** How a dropped filter is named in the "searching wider" notice. */
export const CRITERION_LABELS: Record<RelaxableCriterion, string> = {
  languages: 'язык общения',
  location: 'город или регион',
  age: 'возраст',
  genders: 'пол',
};

function joinRussian(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} и ${items[items.length - 1]}`;
}

/** "снят фильтр «возраст»" / "сняты фильтры «возраст» и «пол»". */
export function describeDroppedCriteria(dropped: RelaxableCriterion[]): string {
  if (dropped.length === 0) return '';

  const names = dropped.map((criterion) => `«${CRITERION_LABELS[criterion]}»`);
  return dropped.length === 1 ? `снят фильтр ${names[0]}` : `сняты фильтры ${joinRussian(names)}`;
}

/**
 * The filters in force, one short phrase per line, ready to render as chips.
 *
 * Reads a `SearchPreferences`, which means it can describe *either* what the settings
 * form currently holds or what the server reported for a running search — the search
 * screen uses the second, and the two must not drift in wording.
 *
 * An empty result means "no filter at all", which is a different statement from "filters
 * we could not describe"; the caller renders the two differently.
 */
export function describeCriteria(criteria: SearchPreferences): string[] {
  const lines: string[] = [];

  if (criteria.genders.length > 0) {
    lines.push(`Пол: ${criteria.genders.map((gender) => GENDER_LABELS[gender]).join(', ')}`);
  }

  if (criteria.ageMin !== null && criteria.ageMax !== null) {
    lines.push(`Возраст: ${criteria.ageMin}–${criteria.ageMax}`);
  } else if (criteria.ageMin !== null) {
    lines.push(`Возраст: от ${criteria.ageMin}`);
  } else if (criteria.ageMax !== null) {
    lines.push(`Возраст: до ${criteria.ageMax}`);
  }

  if (criteria.location !== 'any') {
    lines.push(LOCATION_LABELS[criteria.location]);
  }

  if (criteria.languages.length > 0) {
    lines.push(
      `Языки: ${criteria.languages.map((language) => LANGUAGE_LABELS[language]).join(', ')}`,
    );
  }

  return lines;
}

/**
 * What the user has declared about themselves, as chips.
 *
 * Shown in the settings screen next to the fields, so it is obvious which parts are
 * simply empty rather than filled in with something the user did not type.
 */
export function describeProfile(profile: DeclaredProfile): string[] {
  const lines: string[] = [];

  if (profile.gender !== null) lines.push(`Пол: ${GENDER_LABELS[profile.gender]}`);

  if (profile.birthYear !== null) {
    lines.push(`Возраст: ${ageFromBirthYear(profile.birthYear)}`);
  }

  const place = [profile.city, profile.region].filter((value): value is string => Boolean(value));
  if (place.length > 0) lines.push(`Место: ${place.join(', ')}`);

  if (profile.languages.length > 0) {
    lines.push(
      `Языки: ${profile.languages.map((language) => LANGUAGE_LABELS[language]).join(', ')}`,
    );
  }

  return lines;
}
