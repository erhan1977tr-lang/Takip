-- AlterTable
ALTER TABLE "ProfileProduct" ADD COLUMN     "supplierCode" TEXT;

-- AlterTable
ALTER TABLE "SupplierOrderLine" ADD COLUMN     "supplierCode" TEXT;

-- CreateTable
CREATE TABLE "SupplierEmail" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailKey" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierOpeningBalance" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "asOf" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "note" TEXT,
    "correctsId" TEXT,
    "requestKey" TEXT NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierOpeningBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportCost" (
    "id" TEXT NOT NULL,
    "carrierName" TEXT NOT NULL,
    "invoiceNo" TEXT,
    "invoiceDate" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "fxRate" DECIMAL(12,6),
    "fxDate" DATE,
    "amountEur" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "requestKey" TEXT NOT NULL,
    "paidOn" DATE,
    "paidById" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransportCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportCostReceipt" (
    "transportId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,

    CONSTRAINT "TransportCostReceipt_pkey" PRIMARY KEY ("transportId","receiptId")
);

-- CreateTable
CREATE TABLE "TransportAllocation" (
    "id" TEXT NOT NULL,
    "transportId" TEXT NOT NULL,
    "receiptLineId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "amountEur" DECIMAL(14,4) NOT NULL,

    CONSTRAINT "TransportAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierEmail_supplierId_sortOrder_idx" ON "SupplierEmail"("supplierId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierEmail_supplierId_emailKey_key" ON "SupplierEmail"("supplierId", "emailKey");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierOpeningBalance_requestKey_key" ON "SupplierOpeningBalance"("requestKey");

-- CreateIndex
CREATE INDEX "SupplierOpeningBalance_supplierId_asOf_idx" ON "SupplierOpeningBalance"("supplierId", "asOf");

-- CreateIndex
CREATE UNIQUE INDEX "TransportCost_requestKey_key" ON "TransportCost"("requestKey");

-- CreateIndex
CREATE INDEX "TransportCost_invoiceDate_idx" ON "TransportCost"("invoiceDate");

-- CreateIndex
CREATE INDEX "TransportCost_carrierName_idx" ON "TransportCost"("carrierName");

-- CreateIndex
CREATE INDEX "TransportCostReceipt_receiptId_idx" ON "TransportCostReceipt"("receiptId");

-- CreateIndex
CREATE INDEX "TransportAllocation_productId_idx" ON "TransportAllocation"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "TransportAllocation_transportId_receiptLineId_key" ON "TransportAllocation"("transportId", "receiptLineId");

-- AddForeignKey
ALTER TABLE "SupplierEmail" ADD CONSTRAINT "SupplierEmail_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierOpeningBalance" ADD CONSTRAINT "SupplierOpeningBalance_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportCostReceipt" ADD CONSTRAINT "TransportCostReceipt_transportId_fkey" FOREIGN KEY ("transportId") REFERENCES "TransportCost"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportCostReceipt" ADD CONSTRAINT "TransportCostReceipt_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "SupplierReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportAllocation" ADD CONSTRAINT "TransportAllocation_transportId_fkey" FOREIGN KEY ("transportId") REFERENCES "TransportCost"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportAllocation" ADD CONSTRAINT "TransportAllocation_receiptLineId_fkey" FOREIGN KEY ("receiptLineId") REFERENCES "SupplierReceiptLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportAllocation" ADD CONSTRAINT "TransportAllocation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ProfileProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

