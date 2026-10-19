import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SEARCH_PREFERENCES,
  activeFilterCount,
  activeRelaxationOrder,
  ageFromBirthYear,
  hasActiveFilters,
  mutuallyCompatible,
  normalizePlace,
  preferencesFit,
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

describe('ageFromBirthYear', () => {
  it('is year-granular, matching what the user actually typed', () => {
    expect(ageFromBirthYear(1990, NOW)).toBe(36);
    expect(ageFromBirthYear(2000, NOW)).toBe(26);
  });
});

describe('preferencesFit', () => {
  const searcher = profile({ city: 'Казань', region: 'Татарстан', languages: ['ru'] });

  it('accepts anyone when nothing is filtered', () => {
    expect(preferencesFit(prefs(), profile(), searcher, NOW)).toBe(true);
  });

  it('requires a declaration when a gender filter is set', () => {
    expect(
      preferencesFit(prefs({ genders: ['female'] }), profile({ gender: 'female' }), searcher, NOW),
    ).toBe(true);
    expect(
      preferencesFit(prefs({ genders: ['female'] }), profile({ gender: 'male' }), searcher, NOW),
    ).toBe(false);
    // Undeclared is not "probably fine".
    expect(preferencesFit(prefs({ genders: ['female'] }), profile(), searcher, NOW)).toBe(false);
  });

  it('requires a declared year of birth when an age range is set', () => {
    const range = prefs({ ageMin: 25, ageMax: 35 });

    expect(preferencesFit(range, profile({ birthYear: 1995 }), searcher, NOW)).toBe(true);
    expect(preferencesFit(range, profile({ birthYear: 1970 }), searcher, NOW)).toBe(false);
    expect(preferencesFit(range, profile({ birthYear: 2010 }), searcher, NOW)).toBe(false);
    expect(preferencesFit(range, profile(), searcher, NOW)).toBe(false);
  });

  it('applies a single-sided age bound', () => {
    expect(preferencesFit(prefs({ ageMin: 30 }), profile({ birthYear: 1990 }), searcher, NOW)).toBe(
      true,
    );
    expect(preferencesFit(prefs({ ageMin: 30 }), profile({ birthYear: 2005 }), searcher, NOW)).toBe(
      false,
    );
    expect(preferencesFit(prefs({ ageMax: 30 }), profile({ birthYear: 2005 }), searcher, NOW)).toBe(
      true,
    );
  });

  it("compares the candidate against the searcher's own declared place", () => {
    const sameCity = prefs({ location: 'city' });

    expect(preferencesFit(sameCity, profile({ city: 'казань' }), searcher, NOW)).toBe(true);
    expect(preferencesFit(sameCity, profile({ city: 'Москва' }), searcher, NOW)).toBe(false);
    expect(preferencesFit(sameCity, profile(), searcher, NOW)).toBe(false);

    // The searcher never declared a city, so "same city as me" can hold for nobody.
    expect(preferencesFit(sameCity, profile({ city: 'Казань' }), profile(), NOW)).toBe(false);
  });

  it('uses the region for the region mode', () => {
    const sameRegion = prefs({ location: 'region' });

    expect(
      preferencesFit(
        sameRegion,
        profile({ city: 'Набережные Челны', region: 'Татарстан' }),
        searcher,
        NOW,
      ),
    ).toBe(true);
    expect(preferencesFit(sameRegion, profile({ region: 'Башкортостан' }), searcher, NOW)).toBe(
      false,
    );
  });

  it('needs at least one shared language', () => {
    const wants = prefs({ languages: ['en', 'de'] });

    expect(preferencesFit(wants, profile({ languages: ['de'] }), searcher, NOW)).toBe(true);
    expect(preferencesFit(wants, profile({ languages: ['ru'] }), searcher, NOW)).toBe(false);
    expect(preferencesFit(wants, profile(), searcher, NOW)).toBe(false);
  });

  it('combines every filter as an AND', () => {
    const strict = prefs({
      genders: ['female'],
      ageMin: 25,
      ageMax: 35,
      location: 'city',
      languages: ['ru'],
    });
    const ideal = profile({
      gender: 'female',
      birthYear: 1995,
      city: 'Казань',
      languages: ['ru', 'en'],
    });

    expect(preferencesFit(strict, ideal, searcher, NOW)).toBe(true);
    expect(preferencesFit(strict, { ...ideal, city: 'Москва' }, searcher, NOW)).toBe(false);
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
    location: 'city',
    languages: ['ru'],
  });

  it('drops one filter per step, least meaningful first', () => {
    expect(activeRelaxationOrder(strict)).toEqual(['languages', 'location', 'age', 'genders']);

    const one = relaxBySteps(strict, 1);
    expect(one.dropped).toEqual(['languages']);
    expect(one.criteria.languages).toEqual([]);
    expect(one.criteria.location).toBe('city');
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
      genders: ['female', 'other'],
      ageMin: 18,
      ageMax: 99,
      location: 'region',
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
