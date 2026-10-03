-- DropIndex
DROP INDEX "Order_customerId_orderTypeCode_customerOrderNo_key";

-- AlterTable
ALTER TABLE "OfferLine" ADD COLUMN     "compensationId" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "compOfId" TEXT,
ADD COLUMN     "compSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "removedAt" TIMESTAMP(3),
ADD COLUMN     "removedById" TEXT,
ADD COLUMN     "removedStatus" "OrderStatus";

-- CreateTable
CREATE TABLE "Compensation" (
    "id" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'APPLIED',
    "sourceOrderId" TEXT NOT NULL,
    "sourceOfferId" TEXT NOT NULL,
    "sourceLineId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "descriptionRo" TEXT,
    "enMm" INTEGER,
    "boyMm" INTEGER,
    "quantity" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "priceMode" TEXT NOT NULL,
    "priceTier" TEXT NOT NULL,
    "normalCost" DECIMAL(12,2) NOT NULL,
    "normalPrice" DECIMAL(12,2),
    "unitCost" DECIMAL(12,2) NOT NULL,
    "offerPrice" DECIMAL(12,2),
    "free" BOOLEAN NOT NULL DEFAULT false,
    "destType" TEXT NOT NULL,
    "destOrderId" TEXT,
    "loadingDay" DATE,
    "sourceItemId" TEXT,
    "notLoadedScope" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,

    CONSTRAINT "Compensation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Compensation_requestKey_key" ON "Compensation"("requestKey");

-- CreateIndex
CREATE INDEX "Compensation_sourceOrderId_idx" ON "Compensation"("sourceOrderId");

-- CreateIndex
CREATE INDEX "Compensation_destOrderId_idx" ON "Compensation"("destOrderId");

-- CreateIndex
CREATE INDEX "Compensation_notLoadedScope_idx" ON "Compensation"("notLoadedScope");

-- CreateIndex
CREATE INDEX "OfferLine_compensationId_idx" ON "OfferLine"("compensationId");

-- CreateIndex
CREATE INDEX "Order_removedAt_idx" ON "Order"("removedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_customerId_orderTypeCode_customerOrderNo_compSeq_key" ON "Order"("customerId", "orderTypeCode", "customerOrderNo", "compSeq");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_compOfId_fkey" FOREIGN KEY ("compOfId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_removedById_fkey" FOREIGN KEY ("removedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferLine" ADD CONSTRAINT "OfferLine_compensationId_fkey" FOREIGN KEY ("compensationId") REFERENCES "Compensation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Compensation" ADD CONSTRAINT "Compensation_sourceOrderId_fkey" FOREIGN KEY ("sourceOrderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Compensation" ADD CONSTRAINT "Compensation_sourceLineId_fkey" FOREIGN KEY ("sourceLineId") REFERENCES "OfferLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Compensation" ADD CONSTRAINT "Compensation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Compensation" ADD CONSTRAINT "Compensation_destOrderId_fkey" FOREIGN KEY ("destOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Compensation" ADD CONSTRAINT "Compensation_sourceItemId_fkey" FOREIGN KEY ("sourceItemId") REFERENCES "LoadingConfirmationItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Compensation" ADD CONSTRAINT "Compensation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Compensation" ADD CONSTRAINT "Compensation_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

