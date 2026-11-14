-- 4.2.20 (karar 320): mal kabulünde palet ve kutu sayısı (INTRAREA MARFĂ formundaki PALETI / CUTII). Yalnızca yeni, boş
-- olabilen sütunlar eklenir; mevcut kabul satırları değişmez (sütun eklemek satır tetikleyicisini çalıştırmaz).
ALTER TABLE "SupplierReceipt" ADD COLUMN "pallets" INTEGER,
ADD COLUMN "boxes" INTEGER;

ALTER TABLE "SupplierReceipt" ADD CONSTRAINT "SupplierReceipt_pallets_check" CHECK ("pallets" IS NULL OR ("pallets" >= 0 AND "pallets" <= 99999));
ALTER TABLE "SupplierReceipt" ADD CONSTRAINT "SupplierReceipt_boxes_check" CHECK ("boxes" IS NULL OR ("boxes" >= 0 AND "boxes" <= 99999));
