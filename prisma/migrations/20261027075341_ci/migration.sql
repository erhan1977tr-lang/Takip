-- AlterEnum
ALTER TYPE "PermissionKey" ADD VALUE 'LOADING_APPROVAL_OVERRIDE';

-- AlterTable
ALTER TABLE "Offer" ADD COLUMN     "approvalDeliveredAt" TIMESTAMP(3),
ADD COLUMN     "approvalDeliveryChannel" TEXT,
ADD COLUMN     "approvalDeliveryError" TEXT,
ADD COLUMN     "approvalDeliveryFailedAt" TIMESTAMP(3),
ADD COLUMN     "approvalReminderAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "loadingOverrideAt" TIMESTAMP(3),
ADD COLUMN     "loadingOverrideById" TEXT,
ADD COLUMN     "loadingOverrideReason" TEXT;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_loadingOverrideById_fkey" FOREIGN KEY ("loadingOverrideById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

