-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "billingEmail" TEXT;

-- AlterTable
ALTER TABLE "LoadingConfirmationItem" ADD COLUMN     "pieceBase" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "OfferLine" ADD COLUMN     "pieceBase" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "splitGroup" TEXT;

