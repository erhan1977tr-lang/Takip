-- Paket 8 (kararlar 192–197): Romanya deposu / Türkiye fabrikası çalışma takvimi istisnaları, profil teslimat fotoğrafları ve
-- teslimat raporları. Elle yazıldı (tabloları ve değişmezlik tetikleyicilerini aynı adımda kurmak için); tablolar Prisma'nın
-- üreteceği biçimdedir, tetikleyiciler Prisma şema farkına girmez. Mevcut verilere dokunulmaz.

-- CreateEnum
CREATE TYPE "WorkCalendar" AS ENUM ('RO_DEPOT', 'TR_FACTORY');

-- CreateTable
CREATE TABLE "DeliveryPhoto" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "via" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryReport" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "stage" "ProfileStage" NOT NULL,
    "deliveryDay" DATE,
    "deliveredAt" TIMESTAMP(3),
    "note" TEXT,
    "data" JSONB NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "requestKey" TEXT,
    "via" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkCalendarOverride" (
    "id" TEXT NOT NULL,
    "calendar" "WorkCalendar" NOT NULL,
    "day" DATE NOT NULL,
    "open" BOOLEAN NOT NULL,
    "note" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkCalendarOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryPhoto_fileId_key" ON "DeliveryPhoto"("fileId");

-- CreateIndex
CREATE INDEX "DeliveryPhoto_orderId_createdAt_idx" ON "DeliveryPhoto"("orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryPhoto_orderId_checksum_key" ON "DeliveryPhoto"("orderId", "checksum");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryReport_requestKey_key" ON "DeliveryReport"("requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryReport_orderId_revision_key" ON "DeliveryReport"("orderId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "WorkCalendarOverride_calendar_day_key" ON "WorkCalendarOverride"("calendar", "day");

-- AddForeignKey
ALTER TABLE "DeliveryPhoto" ADD CONSTRAINT "DeliveryPhoto_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryPhoto" ADD CONSTRAINT "DeliveryPhoto_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "OrderFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryReport" ADD CONSTRAINT "DeliveryReport_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryReport" ADD CONSTRAINT "DeliveryReport_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------------
-- Teslimat fotoğrafı ve teslimat raporu DEĞİŞMEZ (karar 195, 196): fotoğraf bağı ve rapor kopyası yazıldıktan sonra
-- değiştirilemez / silinemez — rapor oluşturulduğu andaki kopya olarak kalır, fotoğraf geçmişten kaybolmaz. Düzeltme yeni bir
-- rapor sürümüyle yapılır. Tek istisna denetim kaydıyla aynı bakım anahtarıdır (SET LOCAL takip.audit_maintenance = 'on' —
-- yalnızca test veritabanı temizliği; uygulama kodu kullanmaz).

CREATE OR REPLACE FUNCTION takip_delivery_record_guard() RETURNS trigger AS $$
BEGIN
  IF current_setting('takip.audit_maintenance', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is immutable: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "DeliveryPhoto_guard" ON "DeliveryPhoto";
CREATE TRIGGER "DeliveryPhoto_guard"
  BEFORE UPDATE OR DELETE ON "DeliveryPhoto"
  FOR EACH ROW EXECUTE FUNCTION takip_delivery_record_guard();

DROP TRIGGER IF EXISTS "DeliveryReport_guard" ON "DeliveryReport";
CREATE TRIGGER "DeliveryReport_guard"
  BEFORE UPDATE OR DELETE ON "DeliveryReport"
  FOR EACH ROW EXECUTE FUNCTION takip_delivery_record_guard();
