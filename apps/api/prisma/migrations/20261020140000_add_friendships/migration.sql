-- A mutual, persistent friendship (docs/DECISIONS.md D34).
--
-- Purely additive: a new table with two foreign keys. Existing identities keep working
-- without a row. Rows are created only by an explicit, mutual in-chat agreement and are
-- deleted when either side removes the friend, blocks or reports the other person, or
-- rotates to a new User ID.
CREATE TABLE "Friendship" (
    "id" UUID NOT NULL,
    "userIdA" UUID NOT NULL,
    "userIdB" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Friendship_pkey" PRIMARY KEY ("id")
);

-- The pair is stored in canonical order, so one unique index is enough to make a
-- friendship unique no matter which person asked first. The check is the database-level
-- backstop for the ordering rule in FriendsService.
ALTER TABLE "Friendship"
    ADD CONSTRAINT "Friendship_order_check" CHECK ("userIdA" < "userIdB");

CREATE UNIQUE INDEX "Friendship_userIdA_userIdB_key" ON "Friendship"("userIdA", "userIdB");
CREATE INDEX "Friendship_userIdB_idx" ON "Friendship"("userIdB");

ALTER TABLE "Friendship"
    ADD CONSTRAINT "Friendship_userIdA_fkey"
    FOREIGN KEY ("userIdA") REFERENCES "Identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Friendship"
    ADD CONSTRAINT "Friendship_userIdB_fkey"
    FOREIGN KEY ("userIdB") REFERENCES "Identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Rollback plan: the table is new and nothing else references it. Dropping it removes
-- every friendship and leaves identities, chats and moderation rows untouched:
--   DROP TABLE "Friendship";
