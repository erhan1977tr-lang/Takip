-- CreateEnum
CREATE TYPE "BillingBatchStatus" AS ENUM ('PENDING', 'ISSUED', 'FAILED', 'VOID');

-- AlterTable
ALTER TABLE "FgoDocument" ADD COLUMN     "batchId" TEXT,
ALTER COLUMN "orderId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "BillingBatch" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "BillingBatchStatus" NOT NULL DEFAULT 'PENDING',
    "currency" TEXT NOT NULL,
    "loadingDays" DATE[],
    "selectionKey" TEXT NOT NULL,
    "sourceTotal" DECIMAL(14,2) NOT NULL,
    "ronNet" DECIMAL(14,2) NOT NULL,
    "fxRate" DECIMAL(10,4) NOT NULL,
    "fxDate" DATE NOT NULL,
    "fxSource" TEXT NOT NULL,
    "fxPolicy" TEXT NOT NULL,
    "fxCurrency" TEXT NOT NULL,
    "fxBaseRate" DECIMAL(12,6) NOT NULL,
    "fxMarkupPercent" DECIMAL(6,3),
    "fxSourceDate" DATE NOT NULL,
    "fxResolvedAt" TIMESTAMP(3) NOT NULL,
    "fxManual" BOOLEAN NOT NULL,
    "confirmationId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,

    CONSTRAINT "BillingBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingBatchOrder" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "loadingDay" DATE NOT NULL,
    "sourceAmount" DECIMAL(14,2) NOT NULL,
    "activeKey" TEXT,

    CONSTRAINT "BillingBatchOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingBatchLine" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "BillingBatchLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillingBatch_customerId_idx" ON "BillingBatch"("customerId");

-- CreateIndex
CREATE INDEX "BillingBatch_status_idx" ON "BillingBatch"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BillingBatchOrder_activeKey_key" ON "BillingBatchOrder"("activeKey");

-- CreateIndex
CREATE INDEX "BillingBatchOrder_orderId_idx" ON "BillingBatchOrder"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingBatchOrder_batchId_orderId_key" ON "BillingBatchOrder"("batchId", "orderId");

-- CreateIndex
CREATE INDEX "BillingBatchLine_batchId_idx" ON "BillingBatchLine"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "FgoDocument_batchId_key" ON "FgoDocument"("batchId");

-- AddForeignKey
ALTER TABLE "FgoDocument" ADD CONSTRAINT "FgoDocument_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "BillingBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingBatch" ADD CONSTRAINT "BillingBatch_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingBatch" ADD CONSTRAINT "BillingBatch_confirmationId_fkey" FOREIGN KEY ("confirmationId") REFERENCES "LoadingConfirmation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingBatch" ADD CONSTRAINT "BillingBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingBatchOrder" ADD CONSTRAINT "BillingBatchOrder_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "BillingBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingBatchOrder" ADD CONSTRAINT "BillingBatchOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingBatchLine" ADD CONSTRAINT "BillingBatchLine_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "BillingBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

