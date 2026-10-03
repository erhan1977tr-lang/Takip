-- CreateEnum
CREATE TYPE "FxPolicy" AS ENUM ('BT_UNIT_SELL', 'BNR', 'BNR_PLUS_PERCENT');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "fxMarkupPercent" DECIMAL(6,3),
ADD COLUMN     "fxPolicy" "FxPolicy";

-- AlterTable
ALTER TABLE "GlassBilling" ADD COLUMN     "fxBaseRate" DECIMAL(12,6),
ADD COLUMN     "fxCurrency" TEXT,
ADD COLUMN     "fxManual" BOOLEAN,
ADD COLUMN     "fxMarkupPercent" DECIMAL(6,3),
ADD COLUMN     "fxPolicy" TEXT,
ADD COLUMN     "fxResolvedAt" TIMESTAMP(3),
ADD COLUMN     "fxSourceDate" DATE;

