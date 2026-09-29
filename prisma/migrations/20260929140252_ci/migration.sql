-- DropIndex
DROP INDEX "GlassProduct_name_key";

-- AlterTable
ALTER TABLE "GlassProduct" ADD COLUMN     "colorEn" TEXT,
ADD COLUMN     "colorRo" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "colorTr" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "nameEn" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "weightKgM2" DECIMAL(6,2);

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "glassNameRo" TEXT,
ADD COLUMN     "glassProductId" TEXT,
ADD COLUMN     "glassWeightKgM2" DECIMAL(6,2);

-- CreateTable
CREATE TABLE "OrderDraft" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderTypeCode" TEXT NOT NULL DEFAULT 'GLASS_ORDER',
    "createdById" TEXT NOT NULL,
    "title" TEXT,
    "customerOrderNo" INTEGER,
    "note" TEXT,
    "items" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderDraftFile" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
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

    CONSTRAINT "OrderDraftFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderDraft_customerId_idx" ON "OrderDraft"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderDraftFile_storageKey_key" ON "OrderDraftFile"("storageKey");

-- CreateIndex
CREATE INDEX "OrderDraftFile_draftId_idx" ON "OrderDraftFile"("draftId");

-- CreateIndex
CREATE UNIQUE INDEX "GlassProduct_nameTr_colorTr_key" ON "GlassProduct"("nameTr", "colorTr");

-- AddForeignKey
ALTER TABLE "OrderDraft" ADD CONSTRAINT "OrderDraft_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderDraft" ADD CONSTRAINT "OrderDraft_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderDraftFile" ADD CONSTRAINT "OrderDraftFile_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "OrderDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderDraftFile" ADD CONSTRAINT "OrderDraftFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_glassProductId_fkey" FOREIGN KEY ("glassProductId") REFERENCES "GlassProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

