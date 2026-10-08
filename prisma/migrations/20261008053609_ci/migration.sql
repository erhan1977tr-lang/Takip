-- AlterTable
ALTER TABLE "DrawingRevision" ADD COLUMN     "translation" TEXT,
ADD COLUMN     "translationAt" TIMESTAMP(3),
ADD COLUMN     "translationError" TEXT,
ADD COLUMN     "translationLang" TEXT,
ADD COLUMN     "translationStatus" "NoteTranslationStatus";

