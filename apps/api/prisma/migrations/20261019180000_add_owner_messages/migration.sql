-- "Contact the owner": a message a user deliberately writes to the operator, filed under
-- a topic (docs/DECISIONS.md D26).
--
-- Purely additive: one new enum and one new table. No existing column, index or row is
-- touched, so there is no backfill. The rollback is equally simple and lossless for the
-- rest of the schema:
--   DROP TABLE "OwnerMessage";
--   DROP TYPE "OwnerMessageTopic";
CREATE TYPE "OwnerMessageTopic" AS ENUM ('abuse', 'suggestion', 'bug', 'advertising', 'partnership', 'other');

CREATE TABLE "OwnerMessage" (
    "id" UUID NOT NULL,
    "identityId" UUID,
    "topic" "OwnerMessageTopic" NOT NULL,
    "text" VARCHAR(2000) NOT NULL,
    "contact" VARCHAR(200),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OwnerMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OwnerMessage_createdAt_idx" ON "OwnerMessage"("createdAt");
CREATE INDEX "OwnerMessage_expiresAt_idx" ON "OwnerMessage"("expiresAt");
CREATE INDEX "OwnerMessage_topic_createdAt_idx" ON "OwnerMessage"("topic", "createdAt");

-- `SET NULL` rather than `CASCADE`: the message is the user's own words and outlives a
-- deleted identity. (Identities are never deleted by the service today; this only guards
-- a manual cleanup.)
ALTER TABLE "OwnerMessage" ADD CONSTRAINT "OwnerMessage_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
