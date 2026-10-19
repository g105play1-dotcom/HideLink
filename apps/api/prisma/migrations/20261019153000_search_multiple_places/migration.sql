-- "Где искать" becomes a multi-select, and "anywhere" becomes the *empty* set instead of a
-- stored 'any' value (docs/DECISIONS.md D25). The two are the same shape the gender filter
-- already has, so a "relax this criterion" step now always means "empty this list".
--
-- Additive in effect, destructive in SQL: the existing choice is carried across before the
-- old column is dropped, so nobody's filter is lost. The mapping is one-to-one — 'any' and
-- NULL both become the empty set, which means exactly what they meant.
ALTER TABLE "Identity" ADD COLUMN "prefLocations" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "Identity"
   SET "prefLocations" = ARRAY["prefLocation"::text]
 WHERE "prefLocation" IN ('city', 'region');

ALTER TABLE "Identity" DROP COLUMN "prefLocation";

-- Rollback plan (docs/DECISIONS.md D25): re-create the single-value column and put the
-- first element of the set back into it. This is lossy in exactly one case — a user who
-- selected both 'city' and 'region' keeps only one, which is *narrower* than what they
-- chose. Restore the pair by hand for those rows first:
--   SELECT id, "prefLocations" FROM "Identity" WHERE array_length("prefLocations", 1) > 1;
--   ALTER TABLE "Identity" ADD COLUMN "prefLocation" TEXT NOT NULL DEFAULT 'any';
--   UPDATE "Identity" SET "prefLocation" = COALESCE("prefLocations"[1], 'any');
--   ALTER TABLE "Identity" DROP COLUMN "prefLocations";
