-- Kur politikası zorunlu (karar 98): politikası seçilmemiş müşteriler BT_UNIT_SELL olur (önceki varsayılan davranış:
-- günün BT kuru, elle). NULL satırlar önce doldurulduğu için bu dosya elle yazılmıştır (Prisma'nın ürettiği SET NOT NULL
-- dolu olmayan tabloda hata verirdi). Profil siparişine cam ile aynı kur kaydı alanları eklenir.

UPDATE "Customer" SET "fxPolicy" = 'BT_UNIT_SELL' WHERE "fxPolicy" IS NULL;

-- AlterTable
ALTER TABLE "Customer" ALTER COLUMN "fxPolicy" SET NOT NULL,
ALTER COLUMN "fxPolicy" SET DEFAULT 'BT_UNIT_SELL';

-- AlterTable
ALTER TABLE "ProfileOrder" ADD COLUMN     "fxBaseRate" DECIMAL(12,6),
ADD COLUMN     "fxCurrency" TEXT,
ADD COLUMN     "fxManual" BOOLEAN,
ADD COLUMN     "fxMarkupPercent" DECIMAL(6,3),
ADD COLUMN     "fxPolicy" TEXT,
ADD COLUMN     "fxResolvedAt" TIMESTAMP(3),
ADD COLUMN     "fxSourceDate" DATE;
