-- Blocking becomes a platform policy instead of a per-user setting (docs/DECISIONS.md D31).
--
-- The owner corrected the earlier shape: an anonymous user deciding whether the block
-- action exists is not a moderation capability, and he asked for the switch to live in
-- `/admin` with the feature **off** until he turns it on. One row holds the answer for the
-- whole installation; no row means the shipped default, so nothing has to be seeded.
--
-- Additive only. The old `Identity.blockingEnabled` column stays in place (unused) because
-- dropping it would rewrite user rows for no benefit; see the schema comment.
CREATE TABLE "PlatformPolicy" (
    "id" TEXT NOT NULL,
    "blockingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PlatformPolicy_pkey" PRIMARY KEY ("id")
);

-- Rollback plan: start reading `Identity.blockingEnabled` again (the column is untouched),
-- or delete the single row to fall back to the shipped default:
--   DROP TABLE "PlatformPolicy";
