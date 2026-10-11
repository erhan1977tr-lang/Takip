-- 3.77.0 — beş düzeltme (karar 259–263). Elle yazılmış, veriyi koruyan geçiş: hiçbir satır silinmez, hiçbir sipariş /
-- müşteri / mali kayıt değişmez (yalnızca tip genişletme, yeni boş sütunlar ve indeksler; silinmiş siparişlerde yeni
-- numberActive sütunu NULL yapılır).

-- 1) Müşteri sipariş numarası metin (karar 259): mevcut tam sayılar aynen metne çevrilir ("68" → '68')
ALTER TABLE "Order" ALTER COLUMN "customerOrderNo" SET DATA TYPE TEXT USING "customerOrderNo"::text;
ALTER TABLE "OrderDraft" ALTER COLUMN "customerOrderNo" SET DATA TYPE TEXT USING "customerOrderNo"::text;

-- 2) Numara tekilliği yalnızca etkin siparişlerde (karar 260): silinmiş siparişte numberActive NULL
ALTER TABLE "Order" ADD COLUMN "numberActive" BOOLEAN DEFAULT true;
UPDATE "Order" SET "numberActive" = NULL WHERE "removedAt" IS NOT NULL;

DROP INDEX "Order_orderNo_key";
DROP INDEX "Order_customerId_orderTypeCode_customerOrderNo_compSeq_key";
CREATE UNIQUE INDEX "Order_customer_number_active_key" ON "Order"("customerId", "orderTypeCode", "customerOrderNo", "compSeq", "numberActive");
CREATE UNIQUE INDEX "Order_orderNo_active_key" ON "Order"("orderNo", "numberActive");

-- 3) Metraj 3 ondalık (karar 261): bir camın m²'si (boş = eski satır, eski kural) ve onay / aktarım m²'si 3 ondalık
ALTER TABLE "OfferLine" ADD COLUMN "pieceM2" DECIMAL(18,9);
ALTER TABLE "LoadingConfirmationItem" ADD COLUMN "pieceM2" DECIMAL(18,9);
ALTER TABLE "LoadingConfirmationItem" ALTER COLUMN "m2" SET DATA TYPE DECIMAL(12,3);
ALTER TABLE "LoadingReplan" ALTER COLUMN "m2" SET DATA TYPE DECIMAL(12,3);

-- 4) Şekilli cam (karar 262): satır niteliği
ALTER TABLE "OfferLine" ADD COLUMN "shaped" BOOLEAN NOT NULL DEFAULT false;

-- 5) Aynı PDF yeniden aktarılabilir (karar 263): dosya özeti tek başına tekil değildir
DROP INDEX "OfferImport_orderId_checksum_key";
CREATE INDEX "OfferImport_orderId_checksum_idx" ON "OfferImport"("orderId", "checksum");
