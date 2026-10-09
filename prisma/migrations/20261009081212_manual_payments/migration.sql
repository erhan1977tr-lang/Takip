-- Paket 10 (kararlar 206–209): yöneticinin elle kaydettiği müşteri ödemesi (ManualPayment), avansın dayanağı
-- (FgoDocument.basis, BillingBatch.basis) ve "Önemli kararlar" tekilleştirme anahtarı (AdminAlert.dedupeKey).
-- Yalnızca ekleme: mevcut belge, ödeme ve kayıtlara dokunulmaz; geçmişe dönük eşleştirme / belge yok.

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('BANK_TRANSFER', 'CASH', 'CARD', 'OTHER');

-- AlterTable
ALTER TABLE "AdminAlert" ADD COLUMN "dedupeKey" TEXT;

-- AlterTable
ALTER TABLE "BillingBatch" ADD COLUMN "basis" TEXT;

-- AlterTable
ALTER TABLE "FgoDocument" ADD COLUMN "basis" TEXT;

-- CreateTable
CREATE TABLE "ManualPayment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "batchId" TEXT,
    "proformaRef" TEXT NOT NULL,
    "paidOn" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "ron" DECIMAL(14,2) NOT NULL,
    "rate" DECIMAL(10,4),
    "advanceDocId" TEXT,
    "advanceBatchId" TEXT,
    "requestKey" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,

    CONSTRAINT "ManualPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ManualPayment_requestKey_key" ON "ManualPayment"("requestKey");

-- CreateIndex
CREATE INDEX "ManualPayment_orderId_idx" ON "ManualPayment"("orderId");

-- CreateIndex
CREATE INDEX "ManualPayment_customerId_paidOn_idx" ON "ManualPayment"("customerId", "paidOn");

-- CreateIndex
CREATE INDEX "ManualPayment_batchId_idx" ON "ManualPayment"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "AdminAlert_dedupeKey_key" ON "AdminAlert"("dedupeKey");

-- AddForeignKey
ALTER TABLE "ManualPayment" ADD CONSTRAINT "ManualPayment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualPayment" ADD CONSTRAINT "ManualPayment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualPayment" ADD CONSTRAINT "ManualPayment_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "BillingBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualPayment" ADD CONSTRAINT "ManualPayment_advanceDocId_fkey" FOREIGN KEY ("advanceDocId") REFERENCES "FgoDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualPayment" ADD CONSTRAINT "ManualPayment_advanceBatchId_fkey" FOREIGN KEY ("advanceBatchId") REFERENCES "BillingBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualPayment" ADD CONSTRAINT "ManualPayment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualPayment" ADD CONSTRAINT "ManualPayment_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Elle ödeme kaydı değişmez (karar 206): silinemez; para / zincir / kimlik alanları değişemez. İzin verilenler yalnızca
-- (1) bir kez geçersiz kılma (voidedAt / voidedById / voidReason boştan doluya) ve (2) avans bağlantısı (advanceDocId /
-- advanceBatchId — avans kesilince dolar, belge FGO'da silinince ON DELETE SET NULL ile boşalır).
-- Bakım (veritabanı sıfırlama / yedekten dönüş) takip.audit_maintenance = 'on' ile.
CREATE OR REPLACE FUNCTION takip_manual_payment_guard() RETURNS trigger AS $$
BEGIN
  IF current_setting('takip.audit_maintenance', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ManualPayment is immutable: DELETE is not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
     OR NEW."customerId" IS DISTINCT FROM OLD."customerId"
     OR NEW."batchId" IS DISTINCT FROM OLD."batchId"
     OR NEW."proformaRef" IS DISTINCT FROM OLD."proformaRef"
     OR NEW."paidOn" IS DISTINCT FROM OLD."paidOn"
     OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."method" IS DISTINCT FROM OLD."method"
     OR NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."note" IS DISTINCT FROM OLD."note"
     OR NEW."ron" IS DISTINCT FROM OLD."ron"
     OR NEW."rate" IS DISTINCT FROM OLD."rate"
     OR NEW."requestKey" IS DISTINCT FROM OLD."requestKey"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (OLD."voidedAt" IS NOT NULL AND (NEW."voidedAt" IS DISTINCT FROM OLD."voidedAt"
         OR NEW."voidedById" IS DISTINCT FROM OLD."voidedById" OR NEW."voidReason" IS DISTINCT FROM OLD."voidReason"))
  THEN
    RAISE EXCEPTION 'ManualPayment is immutable: only voiding and the advance link may change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "ManualPayment_guard" ON "ManualPayment";
CREATE TRIGGER "ManualPayment_guard"
  BEFORE UPDATE OR DELETE ON "ManualPayment"
  FOR EACH ROW EXECUTE FUNCTION takip_manual_payment_guard();
