-- Whether the "block a peer" action is offered at all (docs/DECISIONS.md D24).
--
-- Additive and defaulted, so existing rows keep today's behaviour (blocking on) and no
-- backfill or rollback plan is needed. Existing `Block` rows are deliberately untouched:
-- switching the feature off stops new blocks, it does not undo old ones.
ALTER TABLE "Identity" ADD COLUMN     "blockingEnabled" BOOLEAN NOT NULL DEFAULT true;
