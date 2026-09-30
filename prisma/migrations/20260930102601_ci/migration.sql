-- CreateEnum
CREATE TYPE "ProfileStage" AS ENUM ('FIYAT_BEKLIYOR', 'TEKLIF_GONDERILDI', 'ONAYLANDI', 'PROFORMA', 'DEPODA', 'TESLIM_EDILDI', 'FATURALANDI');

-- CreateEnum
CREATE TYPE "StockMoveKind" AS ENUM ('GIRIS', 'CIKIS', 'SAYIM', 'IADE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PermissionKey" ADD VALUE 'OFFER_APPROVE';
ALTER TYPE "PermissionKey" ADD VALUE 'STOCK_MANAGE';

-- DropForeignKey
ALTER TABLE "OrderFile" DROP CONSTRAINT "OrderFile_uploadedById_fkey";

-- DropIndex
DROP INDEX "Order_customerId_customerOrderNo_key";

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "profilePriceTableId" TEXT;

-- AlterTable
ALTER TABLE "OfferLine" ADD COLUMN     "profileProductId" TEXT,
ADD COLUMN     "unitCode" TEXT;

-- AlterTable
ALTER TABLE "OrderFile" ADD COLUMN     "source" TEXT,
ALTER COLUMN "uploadedById" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ProfileCategory" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameRo" TEXT NOT NULL,
    "nameTr" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfileProduct" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "nameRo" TEXT NOT NULL,
    "nameTr" TEXT NOT NULL,
    "unitCode" TEXT NOT NULL,
    "imageId" TEXT,
    "listPrice" DECIMAL(12,2),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfileImage" (
    "id" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "name" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfilePriceTable" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfilePriceTable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfilePriceItem" (
    "id" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfilePriceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfileOrder" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "stage" "ProfileStage" NOT NULL DEFAULT 'FIYAT_BEKLIYOR',
    "stageSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedOfferId" TEXT,
    "pickupDate" DATE,
    "contactPhone" TEXT,
    "vehiclePlate" TEXT,
    "proformaNo" TEXT,
    "proformaAt" TIMESTAMP(3),
    "paidAt" DATE,
    "warehouseSentAt" TIMESTAMP(3),
    "stockDeducted" BOOLEAN NOT NULL DEFAULT false,
    "depotTokenHash" TEXT,
    "depotTokenExpiresAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "deliveredVia" TEXT,
    "invoiceNo" TEXT,
    "invoicedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfileOrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT,
    "code" TEXT NOT NULL,
    "nameRo" TEXT NOT NULL,
    "nameTr" TEXT NOT NULL,
    "unitCode" TEXT NOT NULL,
    "categoryCode" TEXT NOT NULL,
    "imageId" TEXT,
    "qty" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProfileOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "kind" "StockMoveKind" NOT NULL,
    "orderId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProfileCategory_code_key" ON "ProfileCategory"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ProfileProduct_code_key" ON "ProfileProduct"("code");

-- CreateIndex
CREATE INDEX "ProfileProduct_categoryId_sortOrder_idx" ON "ProfileProduct"("categoryId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "ProfilePriceTable_name_key" ON "ProfilePriceTable"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ProfilePriceItem_tableId_productId_key" ON "ProfilePriceItem"("tableId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProfileOrder_orderId_key" ON "ProfileOrder"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "ProfileOrder_depotTokenHash_key" ON "ProfileOrder"("depotTokenHash");

-- CreateIndex
CREATE INDEX "ProfileOrder_stage_idx" ON "ProfileOrder"("stage");

-- CreateIndex
CREATE INDEX "ProfileOrderItem_orderId_idx" ON "ProfileOrderItem"("orderId");

-- CreateIndex
CREATE INDEX "StockMovement_productId_idx" ON "StockMovement"("productId");

-- CreateIndex
CREATE INDEX "StockMovement_orderId_idx" ON "StockMovement"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_customerId_orderTypeCode_customerOrderNo_key" ON "Order"("customerId", "orderTypeCode", "customerOrderNo");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_profilePriceTableId_fkey" FOREIGN KEY ("profilePriceTableId") REFERENCES "ProfilePriceTable"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderFile" ADD CONSTRAINT "OrderFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileProduct" ADD CONSTRAINT "ProfileProduct_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProfileCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileProduct" ADD CONSTRAINT "ProfileProduct_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "ProfileImage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfilePriceItem" ADD CONSTRAINT "ProfilePriceItem_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "ProfilePriceTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfilePriceItem" ADD CONSTRAINT "ProfilePriceItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ProfileProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileOrder" ADD CONSTRAINT "ProfileOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileOrderItem" ADD CONSTRAINT "ProfileOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ProfileProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

