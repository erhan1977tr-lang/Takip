-- 3.87.0 (karar 282): tedarikçi siparişi mal kabulü. Elle yazıldı (tabloları ve değişmezlik tetikleyicisini aynı adımda
-- kurmak için); tablolar Prisma'nın üreteceği biçimdedir, tetikleyiciler Prisma şema farkına girmez. Yalnızca EKLEME yapar:
-- StockMovement'a boş (nullable) bir sütun eklenir; mevcut stok hareketlerine ve siparişlere dokunulmaz.

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "supplierReceiptId" TEXT;

-- CreateTable
CREATE TABLE "SupplierReceipt" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "receivedOn" DATE NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "requestKey" TEXT NOT NULL,
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierReceiptLine" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameRo" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "color" TEXT,
    "categoryCode" TEXT,
    "lengthM" DECIMAL(12,3),
    "qty" INTEGER NOT NULL,
    "unitCode" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SupplierReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierReceipt_requestKey_key" ON "SupplierReceipt"("requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierReceipt_orderId_seq_key" ON "SupplierReceipt"("orderId", "seq");

-- CreateIndex
CREATE INDEX "SupplierReceiptLine_receiptId_sortOrder_idx" ON "SupplierReceiptLine"("receiptId", "sortOrder");

-- CreateIndex
CREATE INDEX "SupplierReceiptLine_orderLineId_idx" ON "SupplierReceiptLine"("orderLineId");

-- CreateIndex
CREATE INDEX "SupplierReceiptLine_productId_idx" ON "SupplierReceiptLine"("productId");

-- CreateIndex
CREATE INDEX "StockMovement_supplierReceiptId_idx" ON "StockMovement"("supplierReceiptId");

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_supplierReceiptId_fkey" FOREIGN KEY ("supplierReceiptId") REFERENCES "SupplierReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierReceipt" ADD CONSTRAINT "SupplierReceipt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "SupplierOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierReceipt" ADD CONSTRAINT "SupplierReceipt_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "SupplierOrderRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierReceiptLine" ADD CONSTRAINT "SupplierReceiptLine_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "SupplierReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierReceiptLine" ADD CONSTRAINT "SupplierReceiptLine_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "SupplierOrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierReceiptLine" ADD CONSTRAINT "SupplierReceiptLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ProfileProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------------
-- Mal kabulü değişmez: kabul ve satırları güncellenemez / silinemez (yanlış kabulün düzeltmesi ayrı bir iş akışıdır — bu
-- sürümde yok; stok gerekirse Profil Stoğu'ndaki sayım düzeltmesiyle düzeltilir). Tek istisna denetim kaydıyla aynı bakım
-- anahtarıdır (SET LOCAL takip.audit_maintenance = 'on' — yalnızca test veritabanı temizliği; uygulama kodu kullanmaz).

CREATE OR REPLACE FUNCTION takip_supplier_receipt_guard() RETURNS trigger AS $$
BEGIN
  IF current_setting('takip.audit_maintenance', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is immutable: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "SupplierReceipt_guard" ON "SupplierReceipt";
CREATE TRIGGER "SupplierReceipt_guard"
  BEFORE UPDATE OR DELETE ON "SupplierReceipt"
  FOR EACH ROW EXECUTE FUNCTION takip_supplier_receipt_guard();

DROP TRIGGER IF EXISTS "SupplierReceiptLine_guard" ON "SupplierReceiptLine";
CREATE TRIGGER "SupplierReceiptLine_guard"
  BEFORE UPDATE OR DELETE ON "SupplierReceiptLine"
  FOR EACH ROW EXECUTE FUNCTION takip_supplier_receipt_guard();
