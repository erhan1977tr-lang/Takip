-- AlterTable
ALTER TABLE "BillingBatch" ADD COLUMN     "parentId" TEXT,
ADD COLUMN     "uniqueKey" TEXT;

-- AlterTable
ALTER TABLE "BillingBatchLine" ADD COLUMN     "pieces" INTEGER,
ADD COLUMN     "refBatchId" TEXT,
ADD COLUMN     "ronGross" DECIMAL(14,2),
ADD COLUMN     "ronNet" DECIMAL(14,2),
ADD COLUMN     "ronUnit" DECIMAL(14,2),
ALTER COLUMN "orderId" DROP NOT NULL,
ALTER COLUMN "unitPrice" DROP NOT NULL,
ALTER COLUMN "amount" DROP NOT NULL;

-- AlterTable
ALTER TABLE "BillingBatchOrder" ALTER COLUMN "offerId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "BillingBatch_uniqueKey_key" ON "BillingBatch"("uniqueKey");

-- AddForeignKey
ALTER TABLE "BillingBatch" ADD CONSTRAINT "BillingBatch_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "BillingBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

