-- The owner's people directory: favorites, reservations and hidden personas (D39).
--
-- `isOwnerPersona` marks synthetic identities created only to join one user's random
-- search as an ordinary peer. They have no session and no socket; the flag keeps them out
-- of the owner's directory and out of normal matching. A fresh persona is made per owner
-- chat, so a public ID disclosed by a block cannot be reused to link conversations.
--
-- `OwnerFavorite` is one operator's bookmark. `OwnerReservation` says "put the owner in
-- front of this person on their next random search"; it survives until consumed or
-- cancelled, which is what makes joining an offline user possible.
--
-- Additive only.
ALTER TABLE "Identity"
    ADD COLUMN "isOwnerPersona" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "OwnerFavorite" (
    "identityId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerFavorite_pkey" PRIMARY KEY ("identityId")
);

CREATE TABLE "OwnerReservation" (
    "targetId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerReservation_pkey" PRIMARY KEY ("targetId")
);

CREATE INDEX "OwnerFavorite_createdAt_idx" ON "OwnerFavorite"("createdAt");
CREATE INDEX "OwnerReservation_createdAt_idx" ON "OwnerReservation"("createdAt");

ALTER TABLE "OwnerFavorite"
    ADD CONSTRAINT "OwnerFavorite_identityId_fkey"
    FOREIGN KEY ("identityId") REFERENCES "Identity"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OwnerReservation"
    ADD CONSTRAINT "OwnerReservation_targetId_fkey"
    FOREIGN KEY ("targetId") REFERENCES "Identity"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Rollback plan:
--   DROP TABLE "OwnerReservation";
--   DROP TABLE "OwnerFavorite";
--   ALTER TABLE "Identity" DROP COLUMN "isOwnerPersona";
-- This loses only the owner's bookmarks, pending reservations and the marker on synthetic
-- identities. Users, chats, reports, bans and archives are untouched. Synthetic identities
-- left behind would become indistinguishable from ordinary users, so a rollback should be
-- done only after deleting those rows if that matters.
