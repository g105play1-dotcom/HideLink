-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('female', 'male', 'other');

-- AlterTable
ALTER TABLE "Identity" ADD COLUMN     "declaredBirthYear" INTEGER,
ADD COLUMN     "declaredCity" VARCHAR(64),
ADD COLUMN     "declaredGender" "Gender",
ADD COLUMN     "declaredLanguages" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "declaredRegion" VARCHAR(64),
ADD COLUMN     "prefAgeMax" INTEGER,
ADD COLUMN     "prefAgeMin" INTEGER,
ADD COLUMN     "prefGenders" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "prefLanguages" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "prefLocation" VARCHAR(16) NOT NULL DEFAULT 'any',
ADD COLUMN     "prefRelax" BOOLEAN NOT NULL DEFAULT false;
