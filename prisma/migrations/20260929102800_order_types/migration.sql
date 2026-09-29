-- Aşama 2 (elle yazıldı): sipariş tipleri tablosu ve ilk kayıtları.
-- Order.orderTypeCode sütunu ve yabancı anahtarı, bundan SONRA gelen (CI'nin ürettiği) migration'da eklenir;
-- satırlar önceden var olduğu için mevcut siparişler "GLASS_ORDER" varsayılanıyla sorunsuz bağlanır.

-- CreateTable
CREATE TABLE "OrderType" (
    "code" TEXT NOT NULL,
    "nameRo" TEXT NOT NULL,
    "nameTr" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "numberFormat" TEXT NOT NULL DEFAULT '{CODE}{SEQ}',
    "usesSales" BOOLEAN NOT NULL DEFAULT true,
    "usesDrawing" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderType_pkey" PRIMARY KEY ("code")
);

INSERT INTO "OrderType" ("code", "nameRo", "nameTr", "active", "sortOrder", "numberFormat", "usesSales", "usesDrawing", "updatedAt")
VALUES
  ('GLASS_ORDER', 'Comandă sticlă', 'Cam siparişi', true, 1, '{CODE}{SEQ}', true, true, CURRENT_TIMESTAMP),
  ('PROFILE_ORDER', 'Comandă profile', 'Profil siparişi', false, 2, '{CODE}P{SEQ}', false, false, CURRENT_TIMESTAMP);
