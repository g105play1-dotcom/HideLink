import {
  LANGUAGE_NAMES,
  LANGUAGES,
  ageFromBirthYear,
  type DeclaredProfile,
  type Gender,
  type Language,
  type OwnerMessageTopic,
  type RelaxableCriterion,
  type SearchPreferences,
} from '@anonlink/shared';

/**
 * Display names for the shared vocabularies.
 *
 * The wire protocol and the database use stable identifiers (`female`, `ru`, `city`), and
 * those identifiers must never reach the screen: `Record<Gender, string>` makes the gender
 * mapping exhaustive at compile time, so adding a gender to the shared list is a type error
 * here until it has a name a user can read.
 */

export const GENDER_LABELS: Record<Gender, string> = {
  female: 'Женский',
  male: 'Мужской',
};

/**
 * Display names for the shared vocabularies.
 *
 * Genders are interface words and will be translated with the interface. Languages are
 * **not** translated: each is shown in its own language — «Русский», "English", «中文» —
 * as the owner asked. That is also the one spelling that does not depend on the interface
 * language, and it is what a person looking for their own language recognises fastest.
 */
export const LANGUAGE_LABELS: Record<Language, string> = Object.fromEntries(
  LANGUAGES.map((language) => [language, LANGUAGE_NAMES[language].native]),
) as Record<Language, string>;

/**
 * The place filters, as the user reads them.
 *
 * A list of names rather than a mode: «Где искать» names the cities and regions a
 * candidate has declared, and "anywhere" is the empty list, rendered as an explicit
 * «Любой» chip next to the pickers (docs/DECISIONS.md D27).
 */
export function describePlaces(cities: readonly string[], regions: readonly string[]): string[] {
  const lines: string[] = [];

  if (cities.length > 0) lines.push(`Города: ${cities.join(', ')}`);
  if (regions.length > 0) lines.push(`Регионы: ${regions.join(', ')}`);

  return lines;
}

/** How a dropped filter is named in the "searching wider" notice. */
export const CRITERION_LABELS: Record<RelaxableCriterion, string> = {
  languages: 'язык общения',
  location: 'город или регион',
  age: 'возраст',
  genders: 'пол',
};

/**
 * The subsections of the "contact the owner" form, as the user reads them.
 *
 * Exhaustive on purpose: the shared list is the single source of the vocabulary, so a new
 * topic is a compile error here until it has a name for the screen — and the owner's inbox
 * renders messages with the same labels.
 */
export const OWNER_TOPIC_LABELS: Record<OwnerMessageTopic, string> = {
  abuse: 'Жалоба',
  suggestion: 'Предложение',
  bug: 'Ошибка в работе',
  advertising: 'Реклама',
  partnership: 'Сотрудничество',
  other: 'Другое',
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

  lines.push(...describePlaces(criteria.cities, criteria.regions));

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
