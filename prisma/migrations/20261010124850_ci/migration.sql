-- AlterTable
ALTER TABLE "BillingBatch" ADD COLUMN     "chainOrderId" TEXT;

-- AlterTable
ALTER TABLE "BillingBatchLine" ADD COLUMN     "refDocId" TEXT;

-- CreateIndex
CREATE INDEX "BillingBatch_chainOrderId_idx" ON "BillingBatch"("chainOrderId");

