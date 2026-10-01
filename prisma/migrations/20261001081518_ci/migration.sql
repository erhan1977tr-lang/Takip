-- AlterEnum
ALTER TYPE "PermissionKey" ADD VALUE 'ACCOUNTING_MANAGE';

-- CreateTable
CREATE TABLE "FgoDocument" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "series" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "link" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'RON',
    "total" DECIMAL(14,2),
    "paid" DECIMAL(14,2),
    "checkedAt" TIMESTAMP(3),
    "checkError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FgoDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoadingCost" (
    "id" TEXT NOT NULL,
    "shipDay" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoadingCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactoryPayment" (
    "id" TEXT NOT NULL,
    "paidOn" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FactoryPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FgoDocument_orderId_idx" ON "FgoDocument"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "FgoDocument_series_number_key" ON "FgoDocument"("series", "number");

-- CreateIndex
CREATE INDEX "LoadingCost_shipDay_idx" ON "LoadingCost"("shipDay");

-- CreateIndex
CREATE INDEX "FactoryPayment_paidOn_idx" ON "FactoryPayment"("paidOn");

-- AddForeignKey
ALTER TABLE "FgoDocument" ADD CONSTRAINT "FgoDocument_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

