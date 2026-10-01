-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "city" TEXT,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "county" TEXT,
ADD COLUMN     "regCom" TEXT;

-- AlterTable
ALTER TABLE "ProfileOrder" ADD COLUMN     "fxDate" DATE,
ADD COLUMN     "fxRate" DECIMAL(10,4),
ADD COLUMN     "fxSource" TEXT,
ADD COLUMN     "invoiceLink" TEXT,
ADD COLUMN     "proformaAmount" DECIMAL(12,2),
ADD COLUMN     "proformaLink" TEXT;

