-- AlterTable
ALTER TABLE "ProfileOrder" ADD COLUMN     "direct" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requestKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ProfileOrder_requestKey_key" ON "ProfileOrder"("requestKey");

