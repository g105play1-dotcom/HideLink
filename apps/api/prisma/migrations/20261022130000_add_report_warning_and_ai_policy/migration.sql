-- Report warnings and the two AI permissions (docs/DECISIONS.md D38).
--
-- `reportWarningAt` is the target's copy of "somebody reported you"; it is cleared when
-- the warning is acknowledged and overwritten by the next report. The report table remains
-- the durable evidence, so no extra notice table is needed.
--
-- Both AI switches ship **off**. `aiAutonomyEnabled` will let an AI moderator act without
-- a human click; `aiCompanionEnabled` will let an AI stand in when random matching finds
-- nobody. Neither has a provider yet: storing the permission now is deliberate, so the
-- owner decides the policy before the adapter exists.
--
-- Additive only.
ALTER TABLE "Identity"
    ADD COLUMN "reportWarningAt" TIMESTAMPTZ(3);

ALTER TABLE "PlatformPolicy"
    ADD COLUMN "aiAutonomyEnabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "aiCompanionEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Rollback plan:
--   ALTER TABLE "PlatformPolicy"
--       DROP COLUMN "aiAutonomyEnabled",
--       DROP COLUMN "aiCompanionEnabled";
--   ALTER TABLE "Identity" DROP COLUMN "reportWarningAt";
-- Doing so only loses the stored permissions and any warning not yet acknowledged; reports,
-- bans and chats are untouched.
