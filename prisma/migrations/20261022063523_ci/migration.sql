-- AlterEnum
ALTER TYPE "PermissionKey" ADD VALUE 'ORDER_ASSIGN';

-- AlterTable
ALTER TABLE "Crate" ADD COLUMN     "salesUserId" TEXT;

-- AlterTable
ALTER TABLE "FactoryPayment" ADD COLUMN     "salesUserId" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "routingRuleId" TEXT,
ADD COLUMN     "salesAssignedAt" TIMESTAMP(3),
ADD COLUMN     "salesAssignedById" TEXT,
ADD COLUMN     "salesAssignedVia" TEXT,
ADD COLUMN     "salesUserId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "defaultDrawerId" TEXT;

-- CreateTable
CREATE TABLE "GlassRoutingRule" (
    "id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "targetUserId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlassRoutingRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GlassRoutingRule_startsAt_idx" ON "GlassRoutingRule"("startsAt");

-- CreateIndex
CREATE INDEX "FactoryPayment_salesUserId_idx" ON "FactoryPayment"("salesUserId");

-- CreateIndex
CREATE INDEX "Order_salesUserId_idx" ON "Order"("salesUserId");

-- CreateIndex
CREATE INDEX "Order_assignedDrawerId_idx" ON "Order"("assignedDrawerId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_defaultDrawerId_fkey" FOREIGN KEY ("defaultDrawerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_salesUserId_fkey" FOREIGN KEY ("salesUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_salesAssignedById_fkey" FOREIGN KEY ("salesAssignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_routingRuleId_fkey" FOREIGN KEY ("routingRuleId") REFERENCES "GlassRoutingRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Crate" ADD CONSTRAINT "Crate_salesUserId_fkey" FOREIGN KEY ("salesUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactoryPayment" ADD CONSTRAINT "FactoryPayment_salesUserId_fkey" FOREIGN KEY ("salesUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlassRoutingRule" ADD CONSTRAINT "GlassRoutingRule_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlassRoutingRule" ADD CONSTRAINT "GlassRoutingRule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

