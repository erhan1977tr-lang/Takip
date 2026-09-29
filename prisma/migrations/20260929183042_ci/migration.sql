-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DrawingStatus" ADD VALUE 'TASLAK';
ALTER TYPE "DrawingStatus" ADD VALUE 'GERI_CEKILDI';

-- AlterTable
ALTER TABLE "Drawing" ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "decidedById" TEXT,
ADD COLUMN     "noteCustomer" TEXT,
ADD COLUMN     "noteInternal" TEXT,
ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "sentById" TEXT,
ADD COLUMN     "withdrawReason" TEXT,
ADD COLUMN     "withdrawnAt" TIMESTAMP(3),
ALTER COLUMN "fileUrl" DROP NOT NULL;

-- CreateTable
CREATE TABLE "DrawingFile" (
    "id" TEXT NOT NULL,
    "drawingId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mime" TEXT,
    "checksum" TEXT,
    "scanStatus" "FileScanStatus" NOT NULL DEFAULT 'PENDING',
    "scanSignature" TEXT,
    "scannedAt" TIMESTAMP(3),
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DrawingFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DrawingFile_drawingId_idx" ON "DrawingFile"("drawingId");

-- CreateIndex
CREATE INDEX "DrawingFile_scanStatus_idx" ON "DrawingFile"("scanStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Drawing_orderId_version_key" ON "Drawing"("orderId", "version");

-- AddForeignKey
ALTER TABLE "Drawing" ADD CONSTRAINT "Drawing_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Drawing" ADD CONSTRAINT "Drawing_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DrawingFile" ADD CONSTRAINT "DrawingFile_drawingId_fkey" FOREIGN KEY ("drawingId") REFERENCES "Drawing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DrawingFile" ADD CONSTRAINT "DrawingFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

