-- Aşama 7F-1 (karar 104–106). Bu dosya elle yazılmıştır: tablo / sütun değişiklikleri Prisma'nın üreteceği SQL ile aynıdır
-- (CI ayrıca migration üretmez); yanında Prisma şema farkının göremediği parçalar vardır — avans tutarının doldurulması,
-- aktarım adedi denetimi, kalemlerin kapsam anahtarı denetimi ve düzeltme kaydının "yalnızca eklenir" tetikleyicisi (tablo ile aynı dosyada olmalı).
-- "LoadingConfirmation" / "LoadingConfirmationItem" satırları DEĞİŞMEZ: yeni sütunlar sabit varsayılanla eklenir
-- (satır güncellemesi yoktur, tetikleyici çalışmaz); var olan kalemler revision = 0 (onay anı) olarak okunur.

-- DropIndex
DROP INDEX "FgoDocument_orderId_kind_key";

-- DropIndex
DROP INDEX "LoadingConfirmationItem_confirmationId_offerLineId_status_key";

-- DropIndex
DROP INDEX "LoadingConfirmationItem_replanId_status_key";

-- AlterTable
ALTER TABLE "FgoDocument" ADD COLUMN     "advanced" DECIMAL(14,2),
ADD COLUMN     "seq" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "BillingBatchOrder" ADD COLUMN     "loadingRevision" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "LoadingConfirmationItem" ADD COLUMN     "correctionId" TEXT,
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "scopeKey" TEXT;

-- AlterTable
ALTER TABLE "LoadingReplan" ADD COLUMN     "closedReason" TEXT,
ADD COLUMN     "correctionId" TEXT;

-- CreateTable
CREATE TABLE "LoadingCorrection" (
    "id" TEXT NOT NULL,
    "confirmationId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoadingCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LoadingCorrection_confirmationId_revision_key" ON "LoadingCorrection"("confirmationId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "FgoDocument_orderId_kind_seq_key" ON "FgoDocument"("orderId", "kind", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "LoadingConfirmationItem_scope_key" ON "LoadingConfirmationItem"("confirmationId", "scopeKey", "status", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "LoadingConfirmationItem_replan_key" ON "LoadingConfirmationItem"("replanId", "status", "revision");

-- AddForeignKey
ALTER TABLE "LoadingCorrection" ADD CONSTRAINT "LoadingCorrection_confirmationId_fkey" FOREIGN KEY ("confirmationId") REFERENCES "LoadingConfirmation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoadingCorrection" ADD CONSTRAINT "LoadingCorrection_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoadingConfirmationItem" ADD CONSTRAINT "LoadingConfirmationItem_correctionId_fkey" FOREIGN KEY ("correctionId") REFERENCES "LoadingCorrection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoadingReplan" ADD CONSTRAINT "LoadingReplan_correctionId_fkey" FOREIGN KEY ("correctionId") REFERENCES "LoadingCorrection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------- Prisma'nın görmediği parçalar ----------

-- Sipariş başına avans faturası: karşıladığı tahsilat (istenen tutar). Eski kayıtlarda işçinin o gün kullandığı tutar:
-- yöneticinin elle girdiği ödeme, yoksa FGO'nun proformada gösterdiği tahsilat, o da yoksa avans faturasının toplamı.
UPDATE "FgoDocument" d SET "advanced" = COALESCE(
  (SELECT g."paidAmount" FROM "GlassBilling" g WHERE g."orderId" = d."orderId"),
  (SELECT p."paid" FROM "FgoDocument" p WHERE p."orderId" = d."orderId" AND p."kind" = 'PROFORMA' AND p."paid" > 0 LIMIT 1),
  d."total")
WHERE d."kind" = 'ADVANCE' AND d."orderId" IS NOT NULL AND d."advanced" IS NULL;

-- Aktarılan adet her zaman pozitiftir (kısmi aktarım: 0 < adet ≤ kalan; üst sınır kilit altında sunucuda denetlenir)
ALTER TABLE "LoadingReplan" ADD CONSTRAINT "LoadingReplan_quantity_positive" CHECK ("quantity" > 0);

-- Kapsam anahtarı: bundan sonra eklenen her onay kalemi kapsamını taşımak zorundadır ("l:<teklif satırı>" ya da
-- "r:<aktarım>") — böylece "bir onayda bir kapsam için sıra ve durum başına tek kalem" benzersizliği her yeni satırda
-- geçerlidir. NOT VALID: var olan (değişmez) satırlar denetlenmez ve güncellenmez; yalnızca yeni satırlar denetlenir.
ALTER TABLE "LoadingConfirmationItem" ADD CONSTRAINT "LoadingConfirmationItem_scopeKey_required"
  CHECK ("scopeKey" IS NOT NULL AND "scopeKey" = CASE WHEN "replanId" IS NOT NULL THEN 'r:' || "replanId" ELSE 'l:' || COALESCE("offerLineId", 'null') END) NOT VALID;

-- Yükleme düzeltmesi yalnızca eklenir (onay ve kalemleriyle aynı işlev: UPDATE / DELETE / TRUNCATE reddedilir)
DROP TRIGGER IF EXISTS "LoadingCorrection_append_only_row" ON "LoadingCorrection";
CREATE TRIGGER "LoadingCorrection_append_only_row"
  BEFORE UPDATE OR DELETE ON "LoadingCorrection"
  FOR EACH ROW EXECUTE FUNCTION takip_loading_confirmation_append_only();

DROP TRIGGER IF EXISTS "LoadingCorrection_append_only_truncate" ON "LoadingCorrection";
CREATE TRIGGER "LoadingCorrection_append_only_truncate"
  BEFORE TRUNCATE ON "LoadingCorrection"
  FOR EACH STATEMENT EXECUTE FUNCTION takip_loading_confirmation_append_only();
