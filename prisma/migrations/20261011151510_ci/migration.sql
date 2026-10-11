-- AlterTable
ALTER TABLE "OfferLine" ADD COLUMN     "importId" TEXT,
ADD COLUMN     "sourceRow" INTEGER;

-- CreateTable
CREATE TABLE "OfferImport" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREVIEW',
    "name" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mime" TEXT,
    "checksum" TEXT NOT NULL,
    "scanStatus" "FileScanStatus" NOT NULL DEFAULT 'PENDING',
    "scanSignature" TEXT,
    "scannedAt" TIMESTAMP(3),
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "parseError" TEXT,
    "parsed" JSONB,
    "factoryOrderNo" TEXT,
    "offerId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "appliedById" TEXT,
    "fingerprint" TEXT,

    CONSTRAINT "OfferImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OfferImport_storageKey_key" ON "OfferImport"("storageKey");

-- CreateIndex
CREATE INDEX "OfferImport_factoryOrderNo_idx" ON "OfferImport"("factoryOrderNo");

-- CreateIndex
CREATE INDEX "OfferImport_scanStatus_idx" ON "OfferImport"("scanStatus");

-- CreateIndex
CREATE UNIQUE INDEX "OfferImport_orderId_checksum_key" ON "OfferImport"("orderId", "checksum");

-- CreateIndex
CREATE INDEX "OfferLine_importId_idx" ON "OfferLine"("importId");

-- AddForeignKey
ALTER TABLE "OfferLine" ADD CONSTRAINT "OfferLine_importId_fkey" FOREIGN KEY ("importId") REFERENCES "OfferImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferImport" ADD CONSTRAINT "OfferImport_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferImport" ADD CONSTRAINT "OfferImport_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferImport" ADD CONSTRAINT "OfferImport_appliedById_fkey" FOREIGN KEY ("appliedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

