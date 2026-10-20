import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SEARCH_PREFERENCES,
  activeFilterCount,
  activeRelaxationOrder,
  ageFromBirthYear,
  birthYearFromAge,
  hasActiveFilters,
  mutuallyCompatible,
  normalizePlace,
  normalizePlaces,
  preferencesFit,
  profileUpdateSchema,
  relaxBySteps,
  relaxationStage,
  searchPreferencesSchema,
  searchPreferencesUpdateSchema,
  settingsUpdateSchema,
  type DeclaredProfile,
  type SearchPreferences,
} from './preferences.js';

const NOW = new Date('2026-06-01T00:00:00.000Z');

function profile(overrides: Partial<DeclaredProfile> = {}): DeclaredProfile {
  return { gender: null, birthYear: null, city: null, region: null, languages: [], ...overrides };
}

function prefs(overrides: Partial<SearchPreferences> = {}): SearchPreferences {
  return { ...DEFAULT_SEARCH_PREFERENCES, ...overrides };
}

describe('normalizePlace', () => {
  it('folds case, spacing and ё/е, because those are not different places', () => {
    expect(normalizePlace('  Королёв ')).toBe(normalizePlace('королев'));
    expect(normalizePlace('Нижний   Новгород')).toBe('нижний новгород');
  });

  it('treats blank input as "not declared" rather than as an empty place', () => {
    expect(normalizePlace('')).toBeNull();
    expect(normalizePlace('   ')).toBeNull();
    expect(normalizePlace(null)).toBeNull();
    expect(normalizePlace(undefined)).toBeNull();
  });

  it('does not geocode: two spellings of one city stay different', () => {
    expect(normalizePlace('Спб')).not.toBe(normalizePlace('Санкт-Петербург'));
  });
});

describe('normalizePlaces', () => {
  it('deduplicates a filter by the folded spelling and keeps the first as typed', () => {
    // The user sees their own words back; comparison happens on the folded form.
    expect(normalizePlaces(['Москва', 'москва ', 'Казань'])).toEqual(['Москва', 'Казань']);
  });

  it('drops blanks instead of storing a name that matches nothing', () => {
    expect(normalizePlaces(['   ', ''])).toEqual([]);
  });
});

describe('ageFromBirthYear', () => {
  it('is year-granular, matching what the user actually typed', () => {
    expect(ageFromBirthYear(1990, NOW)).toBe(36);
    expect(ageFromBirthYear(2000, NOW)).toBe(26);
  });
});

describe('birthYearFromAge', () => {
  it('round-trips through the age, so the interface can ask for an age', () => {
    // The settings screen shows "Возраст", the column keeps a year. This is the one
    // conversion between them, and it has to be exact for the two to agree.
    for (const age of [18, 25, 40, 99]) {
      expect(ageFromBirthYear(birthYearFromAge(age, NOW), NOW)).toBe(age);
    }
  });

  it('does not go stale: the same stored year reads one older next year', () => {
    const stored = birthYearFromAge(25, NOW);
    expect(ageFromBirthYear(stored, new Date('2027-06-01T00:00:00.000Z'))).toBe(26);
  });
});

describe('preferencesFit', () => {
  it('accepts anyone when nothing is filtered', () => {
    expect(preferencesFit(prefs(), profile(), NOW)).toBe(true);
  });

  it('requires a declaration when a gender filter is set', () => {
    expect(preferencesFit(prefs({ genders: ['female'] }), profile({ gender: 'female' }), NOW)).toBe(
      true,
    );
    expect(preferencesFit(prefs({ genders: ['female'] }), profile({ gender: 'male' }), NOW)).toBe(
      false,
    );
    // Undeclared is not "probably fine".
    expect(preferencesFit(prefs({ genders: ['female'] }), profile(), NOW)).toBe(false);
  });

  it('requires a declared year of birth when an age range is set', () => {
    const range = prefs({ ageMin: 25, ageMax: 35 });

    expect(preferencesFit(range, profile({ birthYear: 1995 }), NOW)).toBe(true);
    expect(preferencesFit(range, profile({ birthYear: 1970 }), NOW)).toBe(false);
    expect(preferencesFit(range, profile({ birthYear: 2010 }), NOW)).toBe(false);
    expect(preferencesFit(range, profile(), NOW)).toBe(false);
  });

  it('applies a single-sided age bound', () => {
    expect(preferencesFit(prefs({ ageMin: 30 }), profile({ birthYear: 1990 }), NOW)).toBe(true);
    expect(preferencesFit(prefs({ ageMin: 30 }), profile({ birthYear: 2005 }), NOW)).toBe(false);
    expect(preferencesFit(prefs({ ageMax: 30 }), profile({ birthYear: 2005 }), NOW)).toBe(true);
  });

  it('matches the city names the filter lists, however they are typed', () => {
    const kazan = prefs({ cities: ['Казань'] });

    // Case and spacing are folded the same way as on the declared side.
    expect(preferencesFit(kazan, profile({ city: 'казань' }), NOW)).toBe(true);
    expect(preferencesFit(kazan, profile({ city: '  Казань ' }), NOW)).toBe(true);
    expect(preferencesFit(kazan, profile({ city: 'Москва' }), NOW)).toBe(false);

    // Declaring nothing never satisfies a place filter: guessing would match strangers.
    expect(preferencesFit(kazan, profile(), NOW)).toBe(false);
  });

  it('matches regions independently of cities', () => {
    const tatarstan = prefs({ regions: ['Татарстан'] });

    expect(
      preferencesFit(tatarstan, profile({ city: 'Набережные Челны', region: 'Татарстан' }), NOW),
    ).toBe(true);
    expect(preferencesFit(tatarstan, profile({ region: 'Башкортостан' }), NOW)).toBe(false);
    // A city is not a region: the two lists are compared against different declarations.
    expect(preferencesFit(tatarstan, profile({ city: 'Татарстан' }), NOW)).toBe(false);
  });

  it('accepts a candidate matching *either* list, because several places are one wider search', () => {
    const both = prefs({ cities: ['Казань'], regions: ['Татарстан'] });

    // A peer who declared a city but no region matches the city list and not the region
    // one; selecting both is strictly more permissive than selecting either.
    expect(preferencesFit(both, profile({ city: 'Казань' }), NOW)).toBe(true);
    expect(preferencesFit(both, profile({ region: 'Татарстан' }), NOW)).toBe(true);
    expect(preferencesFit(both, profile({ city: 'Москва', region: 'Москва' }), NOW)).toBe(false);

    // Several names inside one list are a union too, not an intersection.
    expect(
      preferencesFit(prefs({ cities: ['Казань', 'Москва'] }), profile({ city: 'Москва' }), NOW),
    ).toBe(true);
  });

  it('treats empty place lists as "anywhere"', () => {
    // The neutral state is the absence of the names, not a stored "any" value: the
    // filter has no vocabulary member for it (docs/DECISIONS.md D25/D27).
    expect(preferencesFit(prefs(), profile({ city: 'Москва' }), NOW)).toBe(true);
    expect(preferencesFit(prefs({ cities: [], regions: [] }), profile(), NOW)).toBe(true);
  });

  it('needs at least one shared language', () => {
    const wants = prefs({ languages: ['en', 'de'] });

    expect(preferencesFit(wants, profile({ languages: ['de'] }), NOW)).toBe(true);
    expect(preferencesFit(wants, profile({ languages: ['ru'] }), NOW)).toBe(false);
    expect(preferencesFit(wants, profile(), NOW)).toBe(false);
  });

  it('combines every filter as an AND', () => {
    const strict = prefs({
      genders: ['female'],
      ageMin: 25,
      ageMax: 35,
      cities: ['Казань'],
      languages: ['ru'],
    });
    const ideal = profile({
      gender: 'female',
      birthYear: 1995,
      city: 'Казань',
      languages: ['ru', 'en'],
    });

    expect(preferencesFit(strict, ideal, NOW)).toBe(true);
    expect(preferencesFit(strict, { ...ideal, city: 'Москва' }, NOW)).toBe(false);
  });
});

describe('mutuallyCompatible', () => {
  it('requires both sides to accept each other', () => {
    const woman = profile({ gender: 'female', birthYear: 1995 });
    const man = profile({ gender: 'male', birthYear: 1990 });

    // He accepts her, she does not accept him.
    const oneSided = mutuallyCompatible(
      { profile: man, preferences: prefs({ genders: ['female'] }) },
      { profile: woman, preferences: prefs({ genders: ['male'] }) },
      NOW,
    );
    expect(oneSided).toBe(true);

    const refused = mutuallyCompatible(
      { profile: man, preferences: prefs({ genders: ['female'] }) },
      { profile: woman, preferences: prefs({ genders: ['female'] }) },
      NOW,
    );
    expect(refused).toBe(false);
  });

  it('matches two strangers who filter nothing', () => {
    expect(
      mutuallyCompatible(
        { profile: profile(), preferences: prefs() },
        { profile: profile(), preferences: prefs() },
        NOW,
      ),
    ).toBe(true);
  });
});

describe('relaxation', () => {
  const strict = prefs({
    genders: ['female'],
    ageMin: 25,
    ageMax: 35,
    cities: ['Казань'],
    languages: ['ru'],
  });

  it('drops one filter per step, least meaningful first', () => {
    expect(activeRelaxationOrder(strict)).toEqual(['languages', 'location', 'age', 'genders']);

    const one = relaxBySteps(strict, 1);
    expect(one.dropped).toEqual(['languages']);
    expect(one.criteria.languages).toEqual([]);
    expect(one.criteria.cities).toEqual(['Казань']);
    expect(one.criteria.ageMin).toBe(25);
    expect(one.criteria.genders).toEqual(['female']);

    const four = relaxBySteps(strict, 4);
    expect(four.dropped).toEqual(['languages', 'location', 'age', 'genders']);
    expect(four.criteria).toEqual({ ...DEFAULT_SEARCH_PREFERENCES, relaxAllowed: false });
  });

  it('counts only filters the user actually set', () => {
    // Which filters exist decides both the order and how many steps can do anything.
    const onlyGenders = prefs({ genders: ['male'] });
    expect(activeRelaxationOrder(onlyGenders)).toEqual(['genders']);
    expect(activeFilterCount(onlyGenders)).toBe(1);

    // One step is enough to remove the only filter the user set: an unset filter is
    // never allowed to consume a step and make them wait longer for the one that counts.
    expect(relaxBySteps(onlyGenders, 1).dropped).toEqual(['genders']);
    expect(relaxBySteps(onlyGenders, 1).criteria).toEqual(DEFAULT_SEARCH_PREFERENCES);

    // A search with no filters has nothing to widen, ever.
    expect(relaxBySteps(DEFAULT_SEARCH_PREFERENCES, 3)).toEqual({
      criteria: DEFAULT_SEARCH_PREFERENCES,
      dropped: [],
    });
  });

  it('never touches the decision to allow relaxation in the first place', () => {
    expect(relaxBySteps({ ...strict, relaxAllowed: true }, 9).criteria.relaxAllowed).toBe(true);
  });

  it('reports exactly what it removed, and is idempotent beyond the last filter', () => {
    expect(relaxBySteps(strict, 0).dropped).toEqual([]);
    expect(relaxBySteps(strict, 2).dropped).toEqual(['languages', 'location']);
    expect(relaxBySteps(strict, 99)).toEqual(relaxBySteps(strict, 4));
    expect(relaxBySteps(strict, -1).dropped).toEqual([]);
  });

  it('starts only after the initial window, then one step per interval', () => {
    const options = { relaxAfterMs: 10_000, stepMs: 5_000 };

    expect(relaxationStage(0, options)).toBe(0);
    expect(relaxationStage(9_999, options)).toBe(0);
    expect(relaxationStage(10_000, options)).toBe(1);
    expect(relaxationStage(14_999, options)).toBe(1);
    expect(relaxationStage(15_000, options)).toBe(2);
    expect(relaxationStage(25_000, options)).toBe(4);
    // Uncapped on purpose: the caller clamps to the number of filters set, and a cap
    // here would silently make a long wait mean something different.
    expect(relaxationStage(600_000, options)).toBe(119);
  });

  it('knows when there is nothing to relax', () => {
    expect(activeFilterCount(DEFAULT_SEARCH_PREFERENCES)).toBe(0);
    expect(hasActiveFilters(DEFAULT_SEARCH_PREFERENCES)).toBe(false);
    expect(hasActiveFilters(strict)).toBe(true);
  });
});

describe('schemas', () => {
  it('accepts a full set of preferences', () => {
    const result = searchPreferencesSchema.safeParse({
      genders: ['female', 'male'],
      ageMin: 18,
      ageMax: 99,
      cities: ['Казань'],
      regions: [],
      languages: ['ru', 'en'],
      relaxAllowed: true,
    });

    expect(result.success).toBe(true);
  });

  it('accepts any age range, and refuses only values that are not an age', () => {
    // The owner decided the service imposes no age restriction, so where a filter starts
    // and ends is the user's choice. Only values that cannot be an age are refused.
    expect(
      searchPreferencesSchema.safeParse({
        ...DEFAULT_SEARCH_PREFERENCES,
        ageMin: 12,
        ageMax: 15,
      }).success,
    ).toBe(true);

    expect(
      searchPreferencesSchema.safeParse({ ...DEFAULT_SEARCH_PREFERENCES, ageMin: -1 }).success,
    ).toBe(false);
    expect(
      searchPreferencesSchema.safeParse({ ...DEFAULT_SEARCH_PREFERENCES, ageMax: 1000 }).success,
    ).toBe(false);
  });

  it('refuses unknown languages, unknown genders and unknown fields', () => {
    expect(searchPreferencesUpdateSchema.safeParse({ languages: ['klingon'] }).success).toBe(false);
    expect(searchPreferencesUpdateSchema.safeParse({ genders: ['elf'] }).success).toBe(false);
    expect(searchPreferencesUpdateSchema.safeParse({ nested: {} }).success).toBe(false);
  });

  it('refuses the retired place modes, because a place filter names places', () => {
    // The filter used to store `city`/`region` modes; a client that still sends them is
    // refused rather than half-honoured (`strict()`), and "anywhere" is the empty list
    // (docs/DECISIONS.md D27).
    expect(searchPreferencesUpdateSchema.safeParse({ locations: ['any'] }).success).toBe(false);
    expect(searchPreferencesUpdateSchema.safeParse({ locations: ['city'] }).success).toBe(false);
    expect(searchPreferencesUpdateSchema.safeParse({ cities: [] }).success).toBe(true);
  });

  it('bounds each place list and drops duplicates by the folded spelling', () => {
    const many = Array.from({ length: 11 }, (_, index) => `Город ${index}`);

    expect(searchPreferencesUpdateSchema.safeParse({ cities: many.slice(0, 10) }).success).toBe(
      true,
    );
    expect(searchPreferencesUpdateSchema.safeParse({ cities: many }).success).toBe(false);
    expect(searchPreferencesUpdateSchema.safeParse({ cities: ['   '] }).success).toBe(false);

    const deduped = searchPreferencesUpdateSchema.safeParse({
      cities: ['Москва', 'москва ', 'Казань'],
    });
    expect(deduped.success && deduped.data.cities).toEqual(['Москва', 'Казань']);
  });

  it('no longer accepts "other" as a gender', () => {
    // Removed from the vocabulary on the owner's instruction (docs/DECISIONS.md D22).
    // The refusal is what keeps a hand-written request from re-introducing a value the
    // interface can no longer clear.
    expect(profileUpdateSchema.safeParse({ gender: 'other' }).success).toBe(false);
    expect(searchPreferencesUpdateSchema.safeParse({ genders: ['other'] }).success).toBe(false);
  });

  it('accepts clearing a field with null but not with a blank string', () => {
    const update = settingsUpdateSchema.safeParse({ profile: { city: null } });
    expect(update.success).toBe(true);

    const blank = settingsUpdateSchema.safeParse({ profile: { city: '   ' } });
    expect(blank.success).toBe(false);
  });

  it('refuses a year of birth in the future or before the floor', () => {
    const future = new Date().getFullYear() + 1;
    expect(settingsUpdateSchema.safeParse({ profile: { birthYear: future } }).success).toBe(false);
    expect(settingsUpdateSchema.safeParse({ profile: { birthYear: 1700 } }).success).toBe(false);
  });

  it('accepts an empty update, which is how a no-op request looks', () => {
    expect(settingsUpdateSchema.safeParse({}).success).toBe(true);
  });

  it('refuses an inverted age range, which would match nobody', () => {
    const inverted = searchPreferencesSchema.safeParse({
      ...DEFAULT_SEARCH_PREFERENCES,
      ageMin: 40,
      ageMax: 30,
    });
    expect(inverted.success).toBe(false);

    // One-sided bounds are fine: "35+" is a complete instruction.
    expect(
      searchPreferencesSchema.safeParse({ ...DEFAULT_SEARCH_PREFERENCES, ageMin: 35, ageMax: null })
        .success,
    ).toBe(true);
    expect(
      searchPreferencesSchema.safeParse({ ...DEFAULT_SEARCH_PREFERENCES, ageMin: 25, ageMax: 25 })
        .success,
    ).toBe(true);

    // The *update* schema cannot carry this rule, because one bound on its own is always
    // valid — which is why the endpoint merges with the stored filters before parsing
    // through the schema above.
    expect(searchPreferencesUpdateSchema.safeParse({ ageMin: 40 }).success).toBe(true);
  });
});
