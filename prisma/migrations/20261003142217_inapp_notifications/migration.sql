-- Aşama 8 (karar 107): uygulama içi bildirimler. Elle yazılmıştır: sütun / dizin değişiklikleri Prisma'nın üreteceği
-- SQL ile aynıdır (CI ayrıca migration üretmez); yanında var olan kayıtların sessizce "eski" sayılması vardır —
-- bu sürümden ÖNCEKİ olaylar bildirime dönüşmez, eski bildirim satırları okunmamış görünmez.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "notificationSound" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "dedupeKey" TEXT,
ADD COLUMN     "orderId" TEXT,
ADD COLUMN     "params" JSONB,
ADD COLUMN     "readAt" TIMESTAMP(3),
ADD COLUMN     "type" TEXT;

-- AlterTable
ALTER TABLE "NotificationOutbox" ADD COLUMN     "inAppAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Notification_userId_isRead_createdAt_idx" ON "Notification"("userId", "isRead", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");

-- CreateIndex
CREATE INDEX "NotificationOutbox_inAppAt_idx" ON "NotificationOutbox"("inAppAt");

-- ---------- Prisma'nın görmediği parçalar ----------

-- Geçmiş olaylar dağıtılmış sayılır: yalnızca bu sürümden sonraki olaylar zile düşer
UPDATE "NotificationOutbox" SET "inAppAt" = "createdAt" WHERE "inAppAt" IS NULL;

-- Daha önce kullanılmayan tabloda kalmış satır varsa okunmuş sayılır (ilk açılışta eski kayıt "okunmamış" görünmesin)
UPDATE "Notification" SET "isRead" = true, "readAt" = CURRENT_TIMESTAMP WHERE "isRead" = false;
