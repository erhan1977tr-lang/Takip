-- AlterEnum
ALTER TYPE "PermissionKey" ADD VALUE 'CRATE_EDIT';

-- DropForeignKey
ALTER TABLE "Crate" DROP CONSTRAINT "Crate_orderId_fkey";

-- AlterTable
ALTER TABLE "Crate" ADD COLUMN     "customerId" TEXT,
ADD COLUMN     "heightMm" INTEGER,
ADD COLUMN     "lengthMm" INTEGER,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "shipDay" DATE,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updatedById" TEXT,
ADD COLUMN     "widthMm" INTEGER,
ALTER COLUMN "orderId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "CrateOrder" (
    "crateId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,

    CONSTRAINT "CrateOrder_pkey" PRIMARY KEY ("crateId","orderId")
);

-- CreateIndex
CREATE INDEX "CrateOrder_orderId_idx" ON "CrateOrder"("orderId");

-- CreateIndex
CREATE INDEX "Crate_shipDay_customerId_idx" ON "Crate"("shipDay", "customerId");

-- AddForeignKey
ALTER TABLE "Crate" ADD CONSTRAINT "Crate_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Crate" ADD CONSTRAINT "Crate_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Crate" ADD CONSTRAINT "Crate_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrateOrder" ADD CONSTRAINT "CrateOrder_crateId_fkey" FOREIGN KEY ("crateId") REFERENCES "Crate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrateOrder" ADD CONSTRAINT "CrateOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

