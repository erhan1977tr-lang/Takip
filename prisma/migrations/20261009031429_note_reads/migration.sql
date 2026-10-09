-- Paket 9 (karar 199): siparişteki mesajların okunma durumu (kullanıcı başına) ve not formunun tek kullanımlık anahtarı.
-- Elle yazıldı (tabloyu ve ilk okunma kayıtlarını aynı adımda kurmak için); biçim Prisma'nın üreteceğinin aynısıdır.

-- AlterTable
ALTER TABLE "OrderNote" ADD COLUMN "requestKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "OrderNote_requestKey_key" ON "OrderNote"("requestKey");

-- DropIndex / CreateIndex: okunmamış sayımı (sipariş + tarih)
DROP INDEX "OrderNote_orderId_idx";
CREATE INDEX "OrderNote_orderId_createdAt_idx" ON "OrderNote"("orderId", "createdAt");

-- CreateTable
CREATE TABLE "OrderNoteRead" (
    "userId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderNoteRead_pkey" PRIMARY KEY ("userId","orderId")
);

-- CreateIndex
CREATE INDEX "OrderNoteRead_orderId_idx" ON "OrderNoteRead"("orderId");

-- AddForeignKey
ALTER TABLE "OrderNoteRead" ADD CONSTRAINT "OrderNoteRead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderNoteRead" ADD CONSTRAINT "OrderNoteRead_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Mevcut notlar "okunmuş" sayılır: sayaç yalnızca bu sürümden sonra yazılan mesajları gösterir (eski mesajlar birden
-- kırmızı sayaç olarak çıkmaz). Notu olan her sipariş için o siparişi görebilecek etkin kullanıcılara (iç ekip; müşteride
-- yalnızca siparişin firmasının kullanıcıları) bugünün tarihiyle tek kayıt. Notlara ve siparişlere dokunulmaz.
INSERT INTO "OrderNoteRead" ("userId", "orderId", "lastReadAt")
SELECT u."id", o."id", CURRENT_TIMESTAMP
FROM "Order" o
JOIN "User" u ON (u."appRole" <> 'MUSTERI' OR u."customerId" = o."customerId")
WHERE EXISTS (SELECT 1 FROM "OrderNote" n WHERE n."orderId" = o."id")
ON CONFLICT DO NOTHING;
