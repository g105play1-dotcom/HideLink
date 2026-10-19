-- CreateEnum
CREATE TYPE "ArchiveAudience" AS ENUM ('everyone', 'criteria', 'selected');

-- CreateTable
CREATE TABLE "ArchivePolicy" (
    "id" VARCHAR(16) NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "audience" "ArchiveAudience" NOT NULL DEFAULT 'everyone',
    "genders" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ageMin" INTEGER,
    "ageMax" INTEGER,
    "cities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "regions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "storeText" BOOLEAN NOT NULL DEFAULT true,
    "storeMedia" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "retentionDays" INTEGER NOT NULL DEFAULT 90,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ArchivePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArchiveSubject" (
    "id" UUID NOT NULL,
    "policyId" VARCHAR(16) NOT NULL DEFAULT 'default',
    "identityId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArchiveSubject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatArchive" (
    "id" UUID NOT NULL,
    "chatId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3),
    "messageCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ChatArchive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArchivedMessage" (
    "id" UUID NOT NULL,
    "archiveId" UUID NOT NULL,
    "senderId" UUID NOT NULL,
    "text" VARCHAR(4000),
    "mediaKind" VARCHAR(24),
    "mediaRef" VARCHAR(512),
    "sentAt" TIMESTAMPTZ(3) NOT NULL,
    "seq" INTEGER NOT NULL,

    CONSTRAINT "ArchivedMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ArchiveSubject_identityId_idx" ON "ArchiveSubject"("identityId");

-- CreateIndex
CREATE UNIQUE INDEX "ArchiveSubject_policyId_identityId_key" ON "ArchiveSubject"("policyId", "identityId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatArchive_chatId_key" ON "ChatArchive"("chatId");

-- CreateIndex
CREATE INDEX "ChatArchive_expiresAt_idx" ON "ChatArchive"("expiresAt");

-- CreateIndex
CREATE INDEX "ChatArchive_createdAt_idx" ON "ChatArchive"("createdAt");

-- CreateIndex
CREATE INDEX "ArchivedMessage_archiveId_seq_idx" ON "ArchivedMessage"("archiveId", "seq");

-- AddForeignKey
ALTER TABLE "ArchiveSubject" ADD CONSTRAINT "ArchiveSubject_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "ArchivePolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArchiveSubject" ADD CONSTRAINT "ArchiveSubject_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatArchive" ADD CONSTRAINT "ChatArchive_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArchivedMessage" ADD CONSTRAINT "ArchivedMessage_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "ChatArchive"("id") ON DELETE CASCADE ON UPDATE CASCADE;
