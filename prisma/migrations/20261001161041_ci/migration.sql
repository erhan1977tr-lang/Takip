-- AlterEnum
ALTER TYPE "PermissionKey" ADD VALUE 'OFFER_EXPORT';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "customerExcel" BOOLEAN NOT NULL DEFAULT false;

