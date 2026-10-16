-- 3.91.0 (karar 286): hatalı mal kabulünün düzeltmesi. Elle yazıldı (tabloları ve değişmezlik tetikleyicisini aynı adımda
-- kurmak için); tablolar Prisma'nın üreteceği biçimdedir, tetikleyiciler Prisma şema farkına girmez. Yalnızca EKLEME yapar:
-- stok hareketi türüne bir değer, StockMovement'a boş (nullable) bir sütun ve iki yeni tablo. Mevcut kabullere, stok
-- hareketlerine ve siparişlere dokunulmaz.

-- AlterEnum
ALTER TYPE "StockMoveKind" ADD VALUE 'KABUL_DUZELTME';

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "supplierCorrectionId" TEXT;

-- CreateTable
CREATE TABLE "SupplierReceiptCorrection" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "reopened" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierReceiptCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierReceiptCorrectionLine" (
    "id" TEXT NOT NULL,
    "correctionId" TEXT NOT NULL,
    "receiptLineId" TEXT NOT NULL,
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
    "stockBefore" INTEGER NOT NULL,
    "stockAfter" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SupplierReceiptCorrectionLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierReceiptCorrection_requestKey_key" ON "SupplierReceiptCorrection"("requestKey");

-- CreateIndex
CREATE INDEX "SupplierReceiptCorrection_receiptId_idx" ON "SupplierReceiptCorrection"("receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierReceiptCorrection_orderId_seq_key" ON "SupplierReceiptCorrection"("orderId", "seq");

-- CreateIndex
CREATE INDEX "SupplierReceiptCorrectionLine_correctionId_sortOrder_idx" ON "SupplierReceiptCorrectionLine"("correctionId", "sortOrder");

-- CreateIndex
CREATE INDEX "SupplierReceiptCorrectionLine_receiptLineId_idx" ON "SupplierReceiptCorrectionLine"("receiptLineId");

-- CreateIndex
CREATE INDEX "SupplierReceiptCorrectionLine_orderLineId_idx" ON "SupplierReceiptCorrectionLine"("orderLineId");

-- CreateIndex
CREATE INDEX "SupplierReceiptCorrectionLine_productId_idx" ON "SupplierReceiptCorrectionLine"("productId");

-- CreateIndex
CREATE INDEX "StockMovement_supplierCorrectionId_idx" ON "StockMovement"("supplierCorrectionId");

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_supplierCorrectionId_fkey" FOREIGN KEY ("supplierCorrectionId") REFERENCES "SupplierReceiptCorrection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierReceiptCorrection" ADD CONSTRAINT "SupplierReceiptCorrection_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "SupplierOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierReceiptCorrection" ADD CONSTRAINT "SupplierReceiptCorrection_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "SupplierReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierReceiptCorrectionLine" ADD CONSTRAINT "SupplierReceiptCorrectionLine_correctionId_fkey" FOREIGN KEY ("correctionId") REFERENCES "SupplierReceiptCorrection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierReceiptCorrectionLine" ADD CONSTRAINT "SupplierReceiptCorrectionLine_receiptLineId_fkey" FOREIGN KEY ("receiptLineId") REFERENCES "SupplierReceiptLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierReceiptCorrectionLine" ADD CONSTRAINT "SupplierReceiptCorrectionLine_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "SupplierOrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierReceiptCorrectionLine" ADD CONSTRAINT "SupplierReceiptCorrectionLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ProfileProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------------
-- Düzeltme kaydı da değişmez: düzeltme ve satırları güncellenemez / silinemez (yanlış düzeltme yeniden düzeltilemez — stok
-- gerekirse Profil Stoğu'ndaki sayım ya da giriş ile düzeltilir). Mal kabulüyle aynı koruma işlevi (bakım anahtarı yalnızca
-- test veritabanı temizliği içindir).

DROP TRIGGER IF EXISTS "SupplierReceiptCorrection_guard" ON "SupplierReceiptCorrection";
CREATE TRIGGER "SupplierReceiptCorrection_guard"
  BEFORE UPDATE OR DELETE ON "SupplierReceiptCorrection"
  FOR EACH ROW EXECUTE FUNCTION takip_supplier_receipt_guard();

DROP TRIGGER IF EXISTS "SupplierReceiptCorrectionLine_guard" ON "SupplierReceiptCorrectionLine";
CREATE TRIGGER "SupplierReceiptCorrectionLine_guard"
  BEFORE UPDATE OR DELETE ON "SupplierReceiptCorrectionLine"
  FOR EACH ROW EXECUTE FUNCTION takip_supplier_receipt_guard();
