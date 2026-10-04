-- CreateEnum
CREATE TYPE "NoteTranslationStatus" AS ENUM ('PENDING', 'DONE', 'SAME', 'FAILED');

-- AlterTable
ALTER TABLE "OrderNote" ADD COLUMN     "translation" TEXT,
ADD COLUMN     "translationAt" TIMESTAMP(3),
ADD COLUMN     "translationError" TEXT,
ADD COLUMN     "translationLang" TEXT,
ADD COLUMN     "translationStatus" "NoteTranslationStatus";

