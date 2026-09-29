-- AlterTable
ALTER TABLE "Offer" ADD COLUMN     "priceTableId" TEXT;

-- AlterTable
ALTER TABLE "OfferLine" ADD COLUMN     "descriptionRo" TEXT,
ADD COLUMN     "glassProductId" TEXT,
ADD COLUMN     "listPrice" DECIMAL(12,2),
ADD COLUMN     "weightKgM2" DECIMAL(6,2);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "priceTableId" TEXT;

-- CreateTable
CREATE TABLE "PriceTable" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "holePrice" DECIMAL(12,2),
    "cncPrice" DECIMAL(12,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceTable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceTableItem" (
    "id" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "glassProductId" TEXT NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceTableItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAlert" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "orderId" TEXT,
    "offerId" TEXT,
    "details" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "AdminAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PriceTable_name_key" ON "PriceTable"("name");

-- CreateIndex
CREATE UNIQUE INDEX "PriceTableItem_tableId_glassProductId_key" ON "PriceTableItem"("tableId", "glassProductId");

-- CreateIndex
CREATE INDEX "AdminAlert_resolvedAt_createdAt_idx" ON "AdminAlert"("resolvedAt", "createdAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_priceTableId_fkey" FOREIGN KEY ("priceTableId") REFERENCES "PriceTable"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_priceTableId_fkey" FOREIGN KEY ("priceTableId") REFERENCES "PriceTable"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceTableItem" ADD CONSTRAINT "PriceTableItem_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "PriceTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceTableItem" ADD CONSTRAINT "PriceTableItem_glassProductId_fkey" FOREIGN KEY ("glassProductId") REFERENCES "GlassProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAlert" ADD CONSTRAINT "AdminAlert_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAlert" ADD CONSTRAINT "AdminAlert_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAlert" ADD CONSTRAINT "AdminAlert_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAlert" ADD CONSTRAINT "AdminAlert_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

