-- CreateEnum
CREATE TYPE "ProfileMeasure" AS ENUM ('M', 'BUC');

-- CreateEnum
CREATE TYPE "ProfileColor" AS ENUM ('RAL7016', 'ELOXAT');

-- AlterTable
ALTER TABLE "ProfileProduct" ADD COLUMN     "criticalStock" INTEGER,
ADD COLUMN     "packContent" DECIMAL(12,3),
ADD COLUMN     "packMeasure" "ProfileMeasure";

-- CreateTable
CREATE TABLE "ProfileGlassThickness" (
    "id" TEXT NOT NULL,
    "mm" DECIMAL(6,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileGlassThickness_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfileSystem" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameRo" TEXT NOT NULL,
    "nameTr" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileSystem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfileCalcItem" (
    "id" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "productId" TEXT,
    "color" "ProfileColor",
    "thicknessId" TEXT,
    "perMeter" DECIMAL(12,4),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileCalcItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProfileGlassThickness_mm_key" ON "ProfileGlassThickness"("mm");

-- CreateIndex
CREATE UNIQUE INDEX "ProfileSystem_code_key" ON "ProfileSystem"("code");

-- CreateIndex
CREATE INDEX "ProfileCalcItem_systemId_sortOrder_idx" ON "ProfileCalcItem"("systemId", "sortOrder");

-- CreateIndex
CREATE INDEX "ProfileCalcItem_productId_idx" ON "ProfileCalcItem"("productId");

-- CreateIndex
CREATE INDEX "ProfileCalcItem_thicknessId_idx" ON "ProfileCalcItem"("thicknessId");

-- AddForeignKey
ALTER TABLE "ProfileCalcItem" ADD CONSTRAINT "ProfileCalcItem_systemId_fkey" FOREIGN KEY ("systemId") REFERENCES "ProfileSystem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileCalcItem" ADD CONSTRAINT "ProfileCalcItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ProfileProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileCalcItem" ADD CONSTRAINT "ProfileCalcItem_thicknessId_fkey" FOREIGN KEY ("thicknessId") REFERENCES "ProfileGlassThickness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

