-- CreateEnum
CREATE TYPE "CreditOffsetStatus" AS ENUM ('ACTIVE', 'REVERSED', 'FGO_RECORDED');

-- CreateTable
CREATE TABLE "CreditOffset" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "sourceChain" TEXT NOT NULL,
    "sourceOrderId" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "targetChain" TEXT NOT NULL,
    "targetOrderId" TEXT NOT NULL,
    "targetRef" TEXT NOT NULL,
    "amountRon" DECIMAL(14,2) NOT NULL,
    "note" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "status" "CreditOffsetStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closeReason" TEXT,

    CONSTRAINT "CreditOffset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditOffset_requestKey_key" ON "CreditOffset"("requestKey");

-- CreateIndex
CREATE INDEX "CreditOffset_customerId_createdAt_idx" ON "CreditOffset"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditOffset_sourceChain_idx" ON "CreditOffset"("sourceChain");

-- CreateIndex
CREATE INDEX "CreditOffset_targetChain_idx" ON "CreditOffset"("targetChain");

-- AddForeignKey
ALTER TABLE "CreditOffset" ADD CONSTRAINT "CreditOffset_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditOffset" ADD CONSTRAINT "CreditOffset_sourceOrderId_fkey" FOREIGN KEY ("sourceOrderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditOffset" ADD CONSTRAINT "CreditOffset_targetOrderId_fkey" FOREIGN KEY ("targetOrderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditOffset" ADD CONSTRAINT "CreditOffset_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditOffset" ADD CONSTRAINT "CreditOffset_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

