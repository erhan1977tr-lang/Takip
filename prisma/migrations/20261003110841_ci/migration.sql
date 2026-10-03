-- CreateEnum
CREATE TYPE "ReplanStatus" AS ENUM ('ACTIVE', 'CONFIRMED', 'CANCELLED');

-- AlterTable
ALTER TABLE "LoadingConfirmationItem" ADD COLUMN     "notLoadedNote" TEXT,
ADD COLUMN     "replanId" TEXT;

-- CreateTable
CREATE TABLE "LoadingReplan" (
    "id" TEXT NOT NULL,
    "sourceItemId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "m2" DECIMAL(10,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "fromDay" DATE NOT NULL,
    "shipDay" DATE NOT NULL,
    "status" "ReplanStatus" NOT NULL DEFAULT 'ACTIVE',
    "activeKey" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "LoadingReplan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LoadingReplan_activeKey_key" ON "LoadingReplan"("activeKey");

-- CreateIndex
CREATE INDEX "LoadingReplan_shipDay_status_idx" ON "LoadingReplan"("shipDay", "status");

-- CreateIndex
CREATE INDEX "LoadingReplan_orderId_idx" ON "LoadingReplan"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "LoadingConfirmationItem_replanId_status_key" ON "LoadingConfirmationItem"("replanId", "status");

-- AddForeignKey
ALTER TABLE "LoadingConfirmationItem" ADD CONSTRAINT "LoadingConfirmationItem_replanId_fkey" FOREIGN KEY ("replanId") REFERENCES "LoadingReplan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoadingReplan" ADD CONSTRAINT "LoadingReplan_sourceItemId_fkey" FOREIGN KEY ("sourceItemId") REFERENCES "LoadingConfirmationItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoadingReplan" ADD CONSTRAINT "LoadingReplan_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoadingReplan" ADD CONSTRAINT "LoadingReplan_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoadingReplan" ADD CONSTRAINT "LoadingReplan_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

