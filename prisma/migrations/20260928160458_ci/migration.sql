-- CreateEnum
CREATE TYPE "OrderFileKind" AS ENUM ('CUSTOMER', 'INTERNAL');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('HAZIRLANIYOR', 'YONETIMDE', 'GONDERILDI');

-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'TEKLIF_HAZIRLANIYOR';

-- DropForeignKey
ALTER TABLE "DrawingRevision" DROP CONSTRAINT "DrawingRevision_drawingId_fkey";

-- AlterTable
ALTER TABLE "Drawing" ADD COLUMN     "fileName" TEXT,
ADD COLUMN     "fileSize" INTEGER;

-- AlterTable
ALTER TABLE "Offer" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'EUR',
ADD COLUMN     "status" "OfferStatus" NOT NULL DEFAULT 'HAZIRLANIYOR',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "amount" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "camEtiket" TEXT,
ADD COLUMN     "customerOrderNo" INTEGER NOT NULL,
ADD COLUMN     "onHold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sandikEtiket" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "glassName" TEXT,
ALTER COLUMN "metraj" SET DEFAULT 0,
ALTER COLUMN "netAgirlik" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "OrderStatusHistory" ADD COLUMN     "changedById" TEXT;

-- CreateTable
CREATE TABLE "OrderFile" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" "OrderFileKind" NOT NULL DEFAULT 'CUSTOMER',
    "name" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mime" TEXT,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderNote" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlassProduct" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlassProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferLine" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL,
    "poz" TEXT,
    "enMm" INTEGER,
    "boyMm" INTEGER,
    "adet" INTEGER NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL DEFAULT 'm2',
    "unitPrice" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "OfferLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderFile_storageKey_key" ON "OrderFile"("storageKey");

-- CreateIndex
CREATE INDEX "OrderFile_orderId_idx" ON "OrderFile"("orderId");

-- CreateIndex
CREATE INDEX "OrderNote_orderId_idx" ON "OrderNote"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "GlassProduct_name_key" ON "GlassProduct"("name");

-- CreateIndex
CREATE INDEX "Offer_orderId_idx" ON "Offer"("orderId");

-- CreateIndex
CREATE INDEX "Order_estimatedShipDate_idx" ON "Order"("estimatedShipDate");

-- CreateIndex
CREATE UNIQUE INDEX "Order_customerId_customerOrderNo_key" ON "Order"("customerId", "customerOrderNo");

-- CreateIndex
CREATE INDEX "OrderStatusHistory_orderId_idx" ON "OrderStatusHistory"("orderId");

-- AddForeignKey
ALTER TABLE "OrderStatusHistory" ADD CONSTRAINT "OrderStatusHistory_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderFile" ADD CONSTRAINT "OrderFile_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderFile" ADD CONSTRAINT "OrderFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderNote" ADD CONSTRAINT "OrderNote_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderNote" ADD CONSTRAINT "OrderNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferLine" ADD CONSTRAINT "OfferLine_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DrawingRevision" ADD CONSTRAINT "DrawingRevision_drawingId_fkey" FOREIGN KEY ("drawingId") REFERENCES "Drawing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

