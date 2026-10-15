-- CreateEnum
CREATE TYPE "CommercialOfferStatus" AS ENUM ('TASLAK', 'HAZIR', 'KABUL', 'RED', 'IPTAL');

-- AlterEnum
ALTER TYPE "PermissionKey" ADD VALUE 'COMMERCIAL_OFFER_MANAGE';

-- CreateTable
CREATE TABLE "CommercialOffer" (
    "id" TEXT NOT NULL,
    "no" INTEGER NOT NULL,
    "status" "CommercialOfferStatus" NOT NULL DEFAULT 'TASLAK',
    "customerId" TEXT,
    "firmName" TEXT NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "editVersion" INTEGER NOT NULL DEFAULT 0,
    "statusNote" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommercialOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommercialOfferVersion" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "cost" DECIMAL(14,2) NOT NULL,
    "issuedAt" TIMESTAMP(3),
    "issuedById" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommercialOfferVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommercialOffer_no_key" ON "CommercialOffer"("no");

-- CreateIndex
CREATE INDEX "CommercialOffer_status_updatedAt_idx" ON "CommercialOffer"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommercialOfferVersion_offerId_version_key" ON "CommercialOfferVersion"("offerId", "version");

-- AddForeignKey
ALTER TABLE "CommercialOffer" ADD CONSTRAINT "CommercialOffer_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommercialOffer" ADD CONSTRAINT "CommercialOffer_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommercialOfferVersion" ADD CONSTRAINT "CommercialOfferVersion_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "CommercialOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommercialOfferVersion" ADD CONSTRAINT "CommercialOfferVersion_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommercialOfferVersion" ADD CONSTRAINT "CommercialOfferVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

