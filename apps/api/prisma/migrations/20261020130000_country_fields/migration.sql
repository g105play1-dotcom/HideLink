-- Countries join the voluntary profile and the location filter (docs/DECISIONS.md D30,
-- D33). Purely additive: both columns are optional / default to an empty list, so every
-- existing identity keeps its current behaviour — no declared country and no country
-- constraint.
--
-- The value is an ISO 3166-1 alpha-2 code, not a country name: the vocabulary is closed,
-- and «Германия», "Germany" and «Deutschland» must compare equal. The server validates
-- every write against the same generated list the interface uses.
ALTER TABLE "Identity" ADD COLUMN "declaredCountry" VARCHAR(2);
ALTER TABLE "Identity" ADD COLUMN "prefCountries" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Rollback plan (docs/DECISIONS.md D30): both columns are new and nothing derives from
-- them, so the reversal is a plain drop. No existing column is rewritten.
--   ALTER TABLE "Identity" DROP COLUMN "prefCountries";
--   ALTER TABLE "Identity" DROP COLUMN "declaredCountry";
