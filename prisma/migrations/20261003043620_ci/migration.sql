-- CreateEnum
CREATE TYPE "LoadedStatus" AS ENUM ('LOADED', 'NOT_LOADED');

-- AlterEnum
ALTER TYPE "PermissionKey" ADD VALUE 'LOADING_CONFIRM';

-- CreateTable
CREATE TABLE "LoadingConfirmation" (
    "id" TEXT NOT NULL,
    "shipDay" DATE NOT NULL,
    "confirmedById" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoadingConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoadingConfirmationItem" (
    "id" TEXT NOT NULL,
    "confirmationId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "offerLineId" TEXT,
    "sortOrder" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "descriptionRo" TEXT,
    "glassProductId" TEXT,
    "enMm" INTEGER,
    "boyMm" INTEGER,
    "weightKgM2" DECIMAL(6,2),
    "free" BOOLEAN NOT NULL DEFAULT false,
    "quantity" INTEGER NOT NULL,
    "m2" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "unitSale" DECIMAL(12,2),
    "costAmount" DECIMAL(14,4) NOT NULL,
    "saleAmount" DECIMAL(14,4) NOT NULL,
    "status" "LoadedStatus" NOT NULL DEFAULT 'LOADED',
    "notLoadedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoadingConfirmationItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LoadingConfirmation_shipDay_key" ON "LoadingConfirmation"("shipDay");

-- CreateIndex
CREATE INDEX "LoadingConfirmationItem_orderId_idx" ON "LoadingConfirmationItem"("orderId");

-- CreateIndex
CREATE INDEX "LoadingConfirmationItem_customerId_idx" ON "LoadingConfirmationItem"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "LoadingConfirmationItem_confirmationId_offerLineId_status_key" ON "LoadingConfirmationItem"("confirmationId", "offerLineId", "status");

-- AddForeignKey
ALTER TABLE "LoadingConfirmation" ADD CONSTRAINT "LoadingConfirmation_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoadingConfirmationItem" ADD CONSTRAINT "LoadingConfirmationItem_confirmationId_fkey" FOREIGN KEY ("confirmationId") REFERENCES "LoadingConfirmation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoadingConfirmationItem" ADD CONSTRAINT "LoadingConfirmationItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoadingConfirmationItem" ADD CONSTRAINT "LoadingConfirmationItem_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoadingConfirmationItem" ADD CONSTRAINT "LoadingConfirmationItem_offerLineId_fkey" FOREIGN KEY ("offerLineId") REFERENCES "OfferLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

