-- TAKİP — Müşteri üretim onayı canlıya geçişi: SİPARİŞ BİLDİRİMİ E-POSTA SAĞLIĞI. YALNIZCA SELECT.
-- Amaç: Aşama 2'den (özelliğin açılması) önce canlıdaki sipariş bildirim e-postalarının gerçekten gittiğini görmek.
-- Onay süresi talep müşteriye İLETİLİNCE başlar (posta sunucusu kabul edince); e-posta kapalı / SMTP ayarsızsa talepler
-- iletilmez, süre başlamaz. Bu rapor bunu önceden gösterir.
-- Canlıdaki 4.2.0 şemasıyla da çalışır (yeni sütun kullanmaz). DDL / DML YOK; tamamı READ ONLY işlemde, ROLLBACK ile biter.
-- Çıktıda e-posta adresi, müşteri adı, hata metni, tutar YOKTUR (yalnızca sayılar, olay türleri ve zamanlar).
-- Çalıştırma: docs/canliya-gecis-p7.md'deki ro() kalıbı (PGOPTIONS='-c default_transaction_read_only=on').

BEGIN TRANSACTION READ ONLY;

\echo '=== 1. Son 14 gün: sipariş bildirimi kuyruğu (tür × durum). SENT = posta sunucusu kabul etti'
SELECT n.type AS olay, n.status::text AS durum, count(*) AS adet, max(n."sentAt") AS son_gonderim
FROM "NotificationOutbox" n
WHERE n.type LIKE 'ORDER\_%' AND n."createdAt" >= now() - interval '14 days'
GROUP BY n.type, n.status ORDER BY n.type, n.status;

\echo '=== 2. Özet: son başarılı sipariş bildirimi e-postası ve son 24 saat / 7 gün sayıları'
SELECT max(n."sentAt") AS son_basarili_gonderim,
       count(*) FILTER (WHERE n.status::text = 'SENT' AND n."sentAt" >= now() - interval '24 hours') AS gonderilen_24s,
       count(*) FILTER (WHERE n.status::text = 'SENT' AND n."sentAt" >= now() - interval '7 days') AS gonderilen_7g,
       count(*) FILTER (WHERE n.status::text = 'FAILED' AND n."createdAt" >= now() - interval '7 days') AS basarisiz_7g,
       count(*) FILTER (WHERE n.status::text = 'SKIPPED' AND n."createdAt" >= now() - interval '7 days') AS atlanan_7g
FROM "NotificationOutbox" n
WHERE n.type LIKE 'ORDER\_%';

\echo '=== 3. Birikme: 1 saattir bekleyen sipariş bildirimleri (0 olmalı; çoksa e-posta kapalı ya da işçi çalışmıyor)'
SELECT n.type AS olay, count(*) AS bekleyen, min(n."createdAt") AS en_eski, max(n.attempts) AS en_cok_deneme
FROM "NotificationOutbox" n
WHERE n.type LIKE 'ORDER\_%' AND n.status::text = 'PENDING' AND n."createdAt" < now() - interval '1 hour'
GROUP BY n.type ORDER BY n.type;

\echo '=== 4. Uygulama içi bildirim: 1 saattir dağıtılmamış olaylar (0 olmalı; işçi sağlığı)'
SELECT count(*) AS dagitilmamis, min(n."createdAt") AS en_eski
FROM "NotificationOutbox" n
WHERE n."inAppAt" IS NULL AND n."createdAt" < now() - interval '1 hour' AND n."createdAt" >= now() - interval '7 days';

\echo '=== 5. E-posta alabilecek müşteri firmaları: etkin, e-posta bildirimi açık en az bir kullanıcısı olan firma sayısı'
SELECT count(DISTINCT c.id) AS musteri_firma,
       count(DISTINCT c.id) FILTER (WHERE u.id IS NOT NULL) AS bildirim_alan_firma,
       count(DISTINCT c.id) FILTER (WHERE u.id IS NULL) AS e_postasiz_firma
FROM "Customer" c
LEFT JOIN "User" u ON u."customerId" = c.id AND u.type::text = 'CUSTOMER' AND u."isActive" AND u."emailNotifications" AND u."deletedAt" IS NULL
WHERE EXISTS (SELECT 1 FROM "Order" o WHERE o."customerId" = c.id AND o."orderTypeCode" = 'GLASS_ORDER' AND o."removedAt" IS NULL
              AND o.status::text NOT IN ('IPTAL', 'ARSIVLENDI'));

\echo '=== 6. E-posta bildirimlerinin başlangıç kaydı (notify.since) — yoksa işçi henüz hiç e-posta göndermemiş'
SELECT count(*) AS kayit FROM "IntegrationSetting" s WHERE s.key = 'notify.since';

ROLLBACK;
