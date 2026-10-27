-- AlterTable
ALTER TABLE "Offer" ADD COLUMN     "approvalDueAt" TIMESTAMP(3),
ADD COLUMN     "approvalOverdueAt" TIMESTAMP(3),
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "changeNote" TEXT,
ADD COLUMN     "changeRequestedAt" TIMESTAMP(3),
ADD COLUMN     "changeRequestedById" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "productionApprovalRequired" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_changeRequestedById_fkey" FOREIGN KEY ("changeRequestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

