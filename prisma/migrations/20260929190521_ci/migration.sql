-- CreateEnum
CREATE TYPE "PriceTableKind" AS ENUM ('SALES', 'CUSTOMER');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "priceTableId" TEXT;

-- AlterTable
ALTER TABLE "Offer" ADD COLUMN     "offerAmount" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "OfferLine" ADD COLUMN     "offerPrice" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "PriceTable" ADD COLUMN     "kind" "PriceTableKind" NOT NULL DEFAULT 'SALES';

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_priceTableId_fkey" FOREIGN KEY ("priceTableId") REFERENCES "PriceTable"("id") ON DELETE SET NULL ON UPDATE CASCADE;

