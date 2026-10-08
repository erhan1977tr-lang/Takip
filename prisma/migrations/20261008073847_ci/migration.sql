-- CreateEnum
CREATE TYPE "DrawingRevisionKind" AS ENUM ('TALEP', 'HATALI');

-- AlterEnum
ALTER TYPE "DrawingTrack" ADD VALUE 'DUZELTME_BEKLIYOR';

-- AlterTable
ALTER TABLE "Drawing" ADD COLUMN     "sourceFiles" JSONB,
ADD COLUMN     "translation" TEXT,
ADD COLUMN     "translationAt" TIMESTAMP(3),
ADD COLUMN     "translationError" TEXT,
ADD COLUMN     "translationLang" TEXT,
ADD COLUMN     "translationStatus" "NoteTranslationStatus";

-- AlterTable
ALTER TABLE "DrawingRevision" ADD COLUMN     "kind" "DrawingRevisionKind" NOT NULL DEFAULT 'TALEP';

