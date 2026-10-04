-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "guestHostId" TEXT;

-- CreateIndex
CREATE INDEX "Order_guestHostId_idx" ON "Order"("guestHostId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_guestHostId_fkey" FOREIGN KEY ("guestHostId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

