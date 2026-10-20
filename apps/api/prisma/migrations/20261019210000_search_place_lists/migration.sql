-- "Где искать" stops being two modes ("the same city as mine") and becomes two lists of
-- place names the candidate has to match (docs/DECISIONS.md D27). The owner asked for the
-- row to be the same kind of list as every other filter: many concrete cities and regions,
-- with "Любой" as the empty set.
--
-- Additive in effect, destructive in SQL: before the old column is dropped, every stored
-- mode is translated into the place it referred to, so nobody's filter is lost. 'city'
-- becomes the city the person had declared; 'region' becomes the declared region. A mode
-- chosen without a declared place translated into "nobody can match" before and translates
-- into "anywhere" now — the one case where the mapping widens instead of preserving, and
-- the only honest option, because there is no place name to carry across.
ALTER TABLE "Identity" ADD COLUMN "prefCities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Identity" ADD COLUMN "prefRegions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "Identity"
   SET "prefCities" = ARRAY["declaredCity"::text]
 WHERE 'city' = ANY("prefLocations")
   AND "declaredCity" IS NOT NULL
   AND btrim("declaredCity") <> '';

UPDATE "Identity"
   SET "prefRegions" = ARRAY["declaredRegion"::text]
 WHERE 'region' = ANY("prefLocations")
   AND "declaredRegion" IS NOT NULL
   AND btrim("declaredRegion") <> '';

ALTER TABLE "Identity" DROP COLUMN "prefLocations";

-- Rollback plan (docs/DECISIONS.md D27): put the single-mode column back and derive it
-- from the lists. This is lossy in exactly one direction — several named places collapse
-- to one mode — and it cannot reconstruct "my city" without comparing against the current
-- declaration, so the mode is applied only when a list still names the declared place:
--   ALTER TABLE "Identity" ADD COLUMN "prefLocations" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
--   UPDATE "Identity"
--      SET "prefLocations" = ARRAY['city']
--    WHERE "declaredCity" = ANY("prefCities");
--   UPDATE "Identity"
--      SET "prefLocations" = "prefLocations" || ARRAY['region']
--    WHERE "declaredRegion" = ANY("prefRegions");
--   ALTER TABLE "Identity" DROP COLUMN "prefCities";
--   ALTER TABLE "Identity" DROP COLUMN "prefRegions";
