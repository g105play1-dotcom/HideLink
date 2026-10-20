import {
  LANGUAGE_NAMES,
  LANGUAGES,
  ageFromBirthYear,
  countryLabel,
  type CountryCode,
  type DeclaredProfile,
  type Gender,
  type Language,
  type OwnerMessageTopic,
  type RelaxableCriterion,
  type SearchPreferences,
} from '@anonlink/shared';

import { DEFAULT_LOCALE, LOCALE_TAGS, type Locale } from '@/i18n/config';
import { translate, type MessageKey } from '@/i18n/messages';

/**
 * Display names for the shared vocabularies.
 *
 * The wire protocol and the database use stable identifiers (`female`, `ru`, `city`), and
 * those identifiers must never reach the screen: `Record<Gender, MessageKey>` makes the
 * gender mapping exhaustive at compile time, so adding a gender to the shared list is a
 * type error here until it has a name a user can read.
 */
export const GENDER_LABELS: Record<Gender, MessageKey> = {
  female: 'Женский',
  male: 'Мужской',
};

/**
 * Display names for the shared vocabularies.
 *
 * Genders are interface words and are translated with the interface. Languages are
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
 * A list of names rather than a mode: «Где искать» names the countries, cities and
 * regions a candidate has declared, and "anywhere" is the empty lists, rendered as an
 * explicit «Любой» chip next to the pickers (docs/DECISIONS.md D27/D33). Countries are
 * codes and are shown by their native name (D30); the other two are the user's words.
 */
export function describePlaces(
  cities: readonly string[],
  regions: readonly string[],
  countries: readonly CountryCode[],
  locale: Locale = DEFAULT_LOCALE,
): string[] {
  const lines: string[] = [];

  if (countries.length > 0) {
    lines.push(
      translate(locale, 'Страны: {value}', {
        value: countries.map((country) => countryLabel(country)).join(', '),
      }),
    );
  }
  if (cities.length > 0) {
    lines.push(translate(locale, 'Города: {value}', { value: cities.join(', ') }));
  }
  if (regions.length > 0) {
    lines.push(translate(locale, 'Регионы: {value}', { value: regions.join(', ') }));
  }

  return lines;
}

/** How a dropped filter is named in the "searching wider" notice. */
export const CRITERION_LABELS: Record<RelaxableCriterion, MessageKey> = {
  languages: 'язык общения',
  location: 'город, регион или страна',
  age: 'возраст',
  genders: 'пол',
};

/**
 * The subsections of the "contact the owner" form, as the user reads them.
 *
 * Exhaustive on purpose: the shared list is the single source of the vocabulary, so a new
 * topic is a compile error here until it has a name for the screen — and the owner's inbox
 * renders messages with the same labels.
 *
 * `abuse` is "Жалоба на пользователя" rather than the bare "Жалоба": the latter is also
 * the chat button that opens the report dialog, and one Russian key with two meanings
 * cannot have one translation in a dictionary keyed by the Russian text.
 */
export const OWNER_TOPIC_LABELS: Record<OwnerMessageTopic, MessageKey> = {
  abuse: 'Жалоба на пользователя',
  suggestion: 'Предложение',
  bug: 'Ошибка в работе',
  advertising: 'Реклама',
  partnership: 'Сотрудничество',
  other: 'Другое',
};

function joinList(items: string[], locale: Locale): string {
  if (items.length <= 1) return items[0] ?? '';

  try {
    return new Intl.ListFormat(LOCALE_TAGS[locale], { type: 'conjunction' }).format(items);
  } catch {
    // Very old browsers may lack Intl.ListFormat; a comma is a safe fallback and does
    // not change the meaning of the notice.
    return items.join(', ');
  }
}

/** "снят фильтр «возраст»" / "сняты фильтры «возраст» и «пол»". */
export function describeDroppedCriteria(
  dropped: RelaxableCriterion[],
  locale: Locale = DEFAULT_LOCALE,
): string {
  if (dropped.length === 0) return '';

  const names = dropped.map((criterion) => `«${translate(locale, CRITERION_LABELS[criterion])}»`);

  return dropped.length === 1
    ? translate(locale, 'снят фильтр {name}', { name: names[0] ?? '' })
    : translate(locale, 'сняты фильтры {list}', { list: joinList(names, locale) });
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
export function describeCriteria(
  criteria: SearchPreferences,
  locale: Locale = DEFAULT_LOCALE,
): string[] {
  const lines: string[] = [];

  if (criteria.genders.length > 0) {
    lines.push(
      translate(locale, 'Пол: {value}', {
        value: criteria.genders
          .map((gender) => translate(locale, GENDER_LABELS[gender]))
          .join(', '),
      }),
    );
  }

  if (criteria.ageMin !== null && criteria.ageMax !== null) {
    lines.push(
      translate(locale, 'Возраст: {min}–{max}', {
        min: criteria.ageMin,
        max: criteria.ageMax,
      }),
    );
  } else if (criteria.ageMin !== null) {
    lines.push(translate(locale, 'Возраст: от {min}', { min: criteria.ageMin }));
  } else if (criteria.ageMax !== null) {
    lines.push(translate(locale, 'Возраст: до {max}', { max: criteria.ageMax }));
  }

  lines.push(...describePlaces(criteria.cities, criteria.regions, criteria.countries, locale));

  if (criteria.languages.length > 0) {
    lines.push(
      translate(locale, 'Языки: {value}', {
        value: criteria.languages.map((language) => LANGUAGE_LABELS[language]).join(', '),
      }),
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
export function describeProfile(
  profile: DeclaredProfile,
  locale: Locale = DEFAULT_LOCALE,
): string[] {
  const lines: string[] = [];

  if (profile.gender !== null) {
    lines.push(
      translate(locale, 'Пол: {value}', {
        value: translate(locale, GENDER_LABELS[profile.gender]),
      }),
    );
  }

  if (profile.birthYear !== null) {
    lines.push(
      translate(locale, 'Возраст: {value}', { value: ageFromBirthYear(profile.birthYear) }),
    );
  }

  const place = [
    profile.country === null ? null : countryLabel(profile.country),
    profile.city,
    profile.region,
  ].filter((value): value is string => Boolean(value));
  if (place.length > 0)
    lines.push(translate(locale, 'Место: {value}', { value: place.join(', ') }));

  if (profile.languages.length > 0) {
    lines.push(
      translate(locale, 'Языки: {value}', {
        value: profile.languages.map((language) => LANGUAGE_LABELS[language]).join(', '),
      }),
    );
  }

  return lines;
}
