import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_RETENTION_MAX_DAYS,
  DEFAULT_ARCHIVE_POLICY,
  archiveCriteriaMatch,
  archivePolicySchema,
  shouldArchiveChat,
  type ArchiveCriteria,
  type ArchivePolicy,
} from './archive.js';
import { PUBLIC_ID_EXAMPLE, type DeclaredProfile } from './index.js';

const NOW = new Date('2026-10-19T00:00:00.000Z');
const OTHER_ID = 'AL000000000001';

function profile(overrides: Partial<DeclaredProfile> = {}): DeclaredProfile {
  return { gender: null, birthYear: null, city: null, region: null, languages: [], ...overrides };
}

function subject(publicId: string, overrides: Partial<DeclaredProfile> = {}) {
  return { publicId, profile: profile(overrides) };
}

function criteria(overrides: Partial<ArchiveCriteria> = {}): ArchiveCriteria {
  return {
    genders: [],
    ageMin: null,
    ageMax: null,
    cities: [],
    regions: [],
    languages: [],
    ...overrides,
  };
}

function policy(overrides: Partial<ArchivePolicy> = {}): ArchivePolicy {
  return { ...DEFAULT_ARCHIVE_POLICY, enabled: true, ...overrides };
}

describe('shouldArchiveChat', () => {
  it('stores nothing while the switch is off, whatever the scope says', () => {
    expect(shouldArchiveChat(DEFAULT_ARCHIVE_POLICY, [subject(PUBLIC_ID_EXAMPLE)], NOW)).toBe(
      false,
    );
    expect(
      shouldArchiveChat(
        policy({ enabled: false, audience: 'selected', selectedPublicIds: [PUBLIC_ID_EXAMPLE] }),
        [subject(PUBLIC_ID_EXAMPLE)],
        NOW,
      ),
    ).toBe(false);
  });

  it('covers everyone when the audience is everyone', () => {
    expect(shouldArchiveChat(policy({ audience: 'everyone' }), [subject(OTHER_ID)], NOW)).toBe(
      true,
    );
  });

  it('covers only the listed User IDs when the audience is selected', () => {
    const chosen = policy({ audience: 'selected', selectedPublicIds: [PUBLIC_ID_EXAMPLE] });

    expect(shouldArchiveChat(chosen, [subject(PUBLIC_ID_EXAMPLE), subject(OTHER_ID)], NOW)).toBe(
      true,
    );
    expect(shouldArchiveChat(chosen, [subject(OTHER_ID)], NOW)).toBe(false);
  });

  it('archives a chat when either participant is in scope', () => {
    // The owner selects people, not conversations: one of the two being in scope is
    // enough, so a selected person's chat is never half-recorded.
    const chosen = policy({ audience: 'selected', selectedPublicIds: [PUBLIC_ID_EXAMPLE] });
    expect(shouldArchiveChat(chosen, [subject(OTHER_ID), subject(PUBLIC_ID_EXAMPLE)], NOW)).toBe(
      true,
    );
  });
});

describe('archiveCriteriaMatch', () => {
  it('applies every declared constraint together', () => {
    const rule = criteria({ genders: ['female'], ageMin: 20, ageMax: 30, cities: ['Москва'] });

    expect(
      archiveCriteriaMatch(
        rule,
        subject(PUBLIC_ID_EXAMPLE, { gender: 'female', birthYear: 2000, city: 'москва' }),
        NOW,
      ),
    ).toBe(true);

    // One unmet condition is enough to exclude: 26 years old but not in the city.
    expect(
      archiveCriteriaMatch(
        rule,
        subject(PUBLIC_ID_EXAMPLE, { gender: 'female', birthYear: 2000, city: 'Казань' }),
        NOW,
      ),
    ).toBe(false);
  });

  it('never treats an undeclared attribute as a match', () => {
    // The same "strict" rule the search filters use: silence is not consent.
    expect(
      archiveCriteriaMatch(criteria({ genders: ['female'] }), subject(PUBLIC_ID_EXAMPLE), NOW),
    ).toBe(false);
    expect(archiveCriteriaMatch(criteria({ ageMin: 18 }), subject(PUBLIC_ID_EXAMPLE), NOW)).toBe(
      false,
    );
    expect(
      archiveCriteriaMatch(criteria({ cities: ['Москва'] }), subject(PUBLIC_ID_EXAMPLE), NOW),
    ).toBe(false);
  });

  it('matches a shared language and ignores cities outside the list', () => {
    const inMoscow = subject(PUBLIC_ID_EXAMPLE, { languages: ['ru', 'en'] });
    expect(archiveCriteriaMatch(criteria({ languages: ['en'] }), inMoscow, NOW)).toBe(true);
    expect(archiveCriteriaMatch(criteria({ languages: ['de'] }), inMoscow, NOW)).toBe(false);
  });
});

describe('archivePolicySchema', () => {
  it('accepts a complete policy', () => {
    const result = archivePolicySchema.safeParse({
      enabled: true,
      audience: 'criteria',
      criteria: criteria({ genders: ['male'], ageMin: 18, ageMax: 99 }),
      selectedPublicIds: [],
      storeText: true,
      storeMedia: ['image'],
      retentionDays: 30,
    });

    expect(result.success).toBe(true);
  });

  it('accepts the default policy', () => {
    expect(archivePolicySchema.safeParse(DEFAULT_ARCHIVE_POLICY).success).toBe(true);
  });

  it('refuses a switch that would store nothing', () => {
    const result = archivePolicySchema.safeParse({
      ...DEFAULT_ARCHIVE_POLICY,
      enabled: true,
      storeText: false,
      storeMedia: [],
    });

    expect(result.success).toBe(false);
  });

  it('refuses a criteria audience with no criteria, and a selected audience with no IDs', () => {
    expect(
      archivePolicySchema.safeParse({ ...DEFAULT_ARCHIVE_POLICY, audience: 'criteria' }).success,
    ).toBe(false);
    expect(
      archivePolicySchema.safeParse({ ...DEFAULT_ARCHIVE_POLICY, audience: 'selected' }).success,
    ).toBe(false);
  });

  it('refuses an inverted age range and a retention beyond the ceiling', () => {
    expect(
      archivePolicySchema.safeParse({
        ...DEFAULT_ARCHIVE_POLICY,
        audience: 'criteria',
        criteria: criteria({ ageMin: 40, ageMax: 30 }),
      }).success,
    ).toBe(false);

    expect(
      archivePolicySchema.safeParse({
        ...DEFAULT_ARCHIVE_POLICY,
        retentionDays: ARCHIVE_RETENTION_MAX_DAYS + 1,
      }).success,
    ).toBe(false);
  });

  it('refuses unknown fields and malformed User IDs', () => {
    expect(archivePolicySchema.safeParse({ ...DEFAULT_ARCHIVE_POLICY, nope: true }).success).toBe(
      false,
    );
    expect(
      archivePolicySchema.safeParse({
        ...DEFAULT_ARCHIVE_POLICY,
        audience: 'selected',
        selectedPublicIds: ['not-a-user-id'],
      }).success,
    ).toBe(false);
  });
});
