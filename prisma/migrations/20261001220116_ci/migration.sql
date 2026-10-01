-- AlterEnum
ALTER TYPE "PermissionKey" ADD VALUE 'ACCOUNT_SETTINGS';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailNotifications" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "fixedLanguage" TEXT;

