-- CreateEnum
CREATE TYPE "ProfileReturnStatus" AS ENUM ('ACIK', 'TESLIM_ALINDI', 'IPTAL');

-- AlterEnum
ALTER TYPE "PermissionKey" ADD VALUE 'PROFILE_RETURN_MANAGE';

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "profileReturnId" TEXT;

-- CreateTable
CREATE TABLE "ProfileReturn" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "status" "ProfileReturnStatus" NOT NULL DEFAULT 'ACIK',
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "currency" TEXT NOT NULL,
    "fxRate" DECIMAL(10,4),
    "amount" DECIMAL(14,2) NOT NULL,
    "invoiced" BOOLEAN NOT NULL DEFAULT false,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "financeAction" TEXT,
    "refundDoneAt" DATE,
    "refundReference" TEXT,
    "refundById" TEXT,
    "photoFileIds" JSONB,
    "depotTokenHash" TEXT,
    "depotTokenExpiresAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "receivedVia" TEXT,
    "receivedById" TEXT,
    "receivedNote" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "requestKey" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfileReturnLine" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "offerLineId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameRo" TEXT NOT NULL,
    "nameTr" TEXT NOT NULL,
    "unitCode" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "lineTotal" DECIMAL(14,2) NOT NULL,
    "goodQty" INTEGER,
    "damagedQty" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProfileReturnLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockedStockMovement" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "profileReturnId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockedStockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProfileReturn_depotTokenHash_key" ON "ProfileReturn"("depotTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "ProfileReturn_requestKey_key" ON "ProfileReturn"("requestKey");

-- CreateIndex
CREATE INDEX "ProfileReturn_status_idx" ON "ProfileReturn"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ProfileReturn_orderId_seq_key" ON "ProfileReturn"("orderId", "seq");

-- CreateIndex
CREATE INDEX "ProfileReturnLine_returnId_sortOrder_idx" ON "ProfileReturnLine"("returnId", "sortOrder");

-- CreateIndex
CREATE INDEX "ProfileReturnLine_offerLineId_idx" ON "ProfileReturnLine"("offerLineId");

-- CreateIndex
CREATE INDEX "BlockedStockMovement_productId_idx" ON "BlockedStockMovement"("productId");

-- CreateIndex
CREATE INDEX "BlockedStockMovement_profileReturnId_idx" ON "BlockedStockMovement"("profileReturnId");

-- CreateIndex
CREATE INDEX "StockMovement_profileReturnId_idx" ON "StockMovement"("profileReturnId");

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_profileReturnId_fkey" FOREIGN KEY ("profileReturnId") REFERENCES "ProfileReturn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileReturn" ADD CONSTRAINT "ProfileReturn_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileReturnLine" ADD CONSTRAINT "ProfileReturnLine_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "ProfileReturn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileReturnLine" ADD CONSTRAINT "ProfileReturnLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ProfileProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockedStockMovement" ADD CONSTRAINT "BlockedStockMovement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ProfileProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockedStockMovement" ADD CONSTRAINT "BlockedStockMovement_profileReturnId_fkey" FOREIGN KEY ("profileReturnId") REFERENCES "ProfileReturn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

