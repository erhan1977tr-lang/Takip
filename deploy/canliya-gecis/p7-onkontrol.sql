-- TAKİP P7 (3.73.x) — canlıya geçiş ÖN KONTROLÜ (3.66.1 → 3.73.x). YALNIZCA SELECT.
-- DDL / DML / geçici nesne YOK. Tamamı READ ONLY bir işlemde çalışır ve ROLLBACK ile biter; oturum ayrıca
-- PGOPTIONS ile salt okunur açılır (yazma denemesi hata verir). Çıktıda tutar, kişi adı, e-posta, gizli ayar YOKTUR.
-- Çalıştırma ve beklenen sonuçlar: docs/canliya-gecis-p7.md (K1).

BEGIN TRANSACTION READ ONLY;

\echo '=== 0. Saat, veritabanı, salt okunur (on beklenir)'
SELECT now() AS simdi, current_database() AS veritabani, current_setting('transaction_read_only') AS salt_okunur;

\echo '=== 1. Migration: son 5; yarım / geri alınmış 0; P1 migration kaydı deploy ÖNCESİ 0'
SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 5;
SELECT count(*) AS yarim_ya_da_geri_alinmis FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;
SELECT count(*) AS p1_migration_kaydi FROM _prisma_migrations WHERE migration_name = '20261010124850_ci';
SELECT count(*) AS onceki_son_migration FROM _prisma_migrations WHERE migration_name = '20261010045151_ci' AND finished_at IS NOT NULL;

\echo '=== 2. NO-GO: kuyrukta ESKİ sipariş düzeyi kapanış faturası işi (yeni sürüm FGO''ya göndermeden kalıcı hata ile kapatır) — 0 satır'
SELECT n.id AS is_no, o."orderNo", n.status::text AS durum, n.attempts AS deneme, n."availableAt" AS siradaki,
       CASE WHEN n."lastError" LIKE '[BELIRSIZ]%' THEN 'BELİRSİZ — FGO''ya ulaşmış olabilir'
            WHEN n.attempts > 0 THEN 'daha önce denenmiş — FGO''da {orderNo}-F var mı bakılmalı' ELSE '' END AS not_
FROM "NotificationOutbox" n LEFT JOIN "Order" o ON o.id = n."orderId"
WHERE n.type = 'FGO_GLASS' AND n.payload->>'kind' = 'INVOICE' AND n.status::text = 'PENDING'
ORDER BY n."createdAt";

\echo '=== 3. NO-GO: BELİRSİZ FGO işi (yönetici #belirsiz ekranında karar vermeli) — 0 satır'
SELECT n.id AS is_no, n.type, o."orderNo", n.attempts AS deneme, n."createdAt"::date AS tarih
FROM "NotificationOutbox" n LEFT JOIN "Order" o ON o.id = n."orderId"
WHERE n.status::text = 'PENDING' AND n."lastError" LIKE '[BELIRSIZ]%'
ORDER BY n."createdAt";

\echo '=== 4. Bekle: kuyruktaki FGO / belge e-postası işleri (deploy anında 0 olması beklenir; işçi bitirsin)'
SELECT n.type, count(*) AS bekleyen FROM "NotificationOutbox" n
WHERE n.status::text = 'PENDING' AND n.type IN ('FGO_GLASS', 'FGO_BATCH', 'FGO_PROFORMA', 'FGO_INVOICE', 'FGO_PROFILE_ADVANCE', 'FGO_DOC_EMAIL')
GROUP BY 1 ORDER BY 1;

\echo '=== 5. RİSK (P1): kendi proforması var, kapanış faturası yok, HİÇ yükleme onayı yok ama durumu Yüklendi / Arşiv — 0 satır beklenir'
SELECT o."orderNo", o.status::text AS durum, o."estimatedShipDate"::date AS planlanan, o."actualShipDate"::date AS fiili
FROM "Order" o
WHERE o."orderTypeCode" = 'GLASS_ORDER' AND o."removedAt" IS NULL AND o.status::text IN ('YUKLENDI', 'ARSIVLENDI')
  AND EXISTS (SELECT 1 FROM "FgoDocument" d WHERE d."orderId" = o.id AND d.kind = 'PROFORMA')
  AND NOT EXISTS (SELECT 1 FROM "FgoDocument" d WHERE d."orderId" = o.id AND d.kind = 'INVOICE')
  AND NOT EXISTS (SELECT 1 FROM "LoadingConfirmationItem" i WHERE i."orderId" = o.id)
ORDER BY 3 NULLS LAST, 1;

\echo '=== 6. BELİRSİZ (P1): aynı zincir, onay yok, planlanan + 2 gün geçmiş — fiilen yüklendiyse önce "Yükleme yapıldı" kaydı'
SELECT o."orderNo", o.status::text AS durum, o."onHold" AS beklemede, o."estimatedShipDate"::date AS planlanan
FROM "Order" o
WHERE o."orderTypeCode" = 'GLASS_ORDER' AND o."removedAt" IS NULL AND o.status::text NOT IN ('YUKLENDI', 'ARSIVLENDI', 'IPTAL')
  AND o."estimatedShipDate" IS NOT NULL AND o."estimatedShipDate"::date + 2 <= current_date
  AND EXISTS (SELECT 1 FROM "FgoDocument" d WHERE d."orderId" = o.id AND d.kind = 'PROFORMA')
  AND NOT EXISTS (SELECT 1 FROM "FgoDocument" d WHERE d."orderId" = o.id AND d.kind = 'INVOICE')
  AND NOT EXISTS (SELECT 1 FROM "LoadingConfirmationItem" i WHERE i."orderId" = o.id)
ORDER BY 4, 1;

\echo '=== 7. ENGEL (P1): kendi proforması olan EUR siparişte kur kaydı yok → fatura CHAIN_RATE_MISSING ile durur'
SELECT o."orderNo", o.status::text AS durum
FROM "Order" o LEFT JOIN "GlassBilling" g ON g."orderId" = o.id
WHERE o."orderTypeCode" = 'GLASS_ORDER' AND o."removedAt" IS NULL AND o.status::text <> 'IPTAL'
  AND EXISTS (SELECT 1 FROM "FgoDocument" d WHERE d."orderId" = o.id AND d.kind = 'PROFORMA')
  AND NOT EXISTS (SELECT 1 FROM "FgoDocument" d WHERE d."orderId" = o.id AND d.kind = 'INVOICE')
  AND g."fxRate" IS NULL
  AND EXISTS (SELECT 1 FROM "Offer" f WHERE f."orderId" = o.id AND f.status::text = 'GONDERILDI' AND f.currency = 'EUR')
ORDER BY 1;

\echo '=== 8. ENGEL (P7, CHAIN_ROOT_MISSING): avans faturası var, proforması yok (FGO''da silinmiş) → muhasebe kararı'
SELECT o."orderNo", o.status::text AS durum,
       (SELECT string_agg(d.series || d.number, ', ') FROM "FgoDocument" d WHERE d."orderId" = o.id AND d.kind = 'ADVANCE') AS avanslar
FROM "Order" o
WHERE o."orderTypeCode" = 'GLASS_ORDER' AND o."removedAt" IS NULL
  AND EXISTS (SELECT 1 FROM "FgoDocument" d WHERE d."orderId" = o.id AND d.kind = 'ADVANCE')
  AND NOT EXISTS (SELECT 1 FROM "FgoDocument" d WHERE d."orderId" = o.id AND d.kind IN ('PROFORMA', 'INVOICE'))
ORDER BY 1;

\echo '=== 9. Bilgi: kesilemeyen (FAILED) belge partileri — yönetici yeniden dener ya da vazgeçer; "yinelenen belge" hatasında önce FGO''ya bakılır, VAZGEÇİLMEZ'
SELECT b.kind::text AS tur, b.status::text AS durum, count(*) AS adet FROM "BillingBatch" b
WHERE b.status::text IN ('PENDING', 'FAILED') GROUP BY 1, 2 ORDER BY 1, 2;

\echo '=== 10. Bilgi: açık "Önemli kararlar" uyarıları (türe göre)'
SELECT a.type, count(*) AS acik FROM "AdminAlert" a WHERE a."resolvedAt" IS NULL GROUP BY 1 ORDER BY 2 DESC, 1;

\echo '=== 11. Yönetici erişimi: etkin, şifresi belirlenmiş iç ekip yöneticisi sayısı (en az 1; tercihen 2)'
SELECT count(*) AS etkin_yonetici FROM "User" u
WHERE u."appRole"::text = 'ADMIN' AND u.type::text = 'INTERNAL' AND u."isActive" AND u."deletedAt" IS NULL AND u."passwordHash" IS NOT NULL;

\echo '=== 12. Yeni sütunlar (P1) — deploy ÖNCESİ 0 satır, SONRASI 2 satır'
SELECT table_name, column_name FROM information_schema.columns
WHERE table_schema = current_schema()
  AND ((table_name = 'BillingBatch' AND column_name = 'chainOrderId') OR (table_name = 'BillingBatchLine' AND column_name = 'refDocId'))
ORDER BY 1;

\echo '=== 13. Tablo büyüklükleri (migration süresi tahmini: boş sütun anlık; indeks satır sayısına bağlı)'
SELECT (SELECT count(*) FROM "BillingBatch") AS billing_batch, (SELECT count(*) FROM "BillingBatchLine") AS billing_batch_line,
       (SELECT count(*) FROM "Order") AS siparis, (SELECT count(*) FROM "FgoDocument") AS fgo_belge;

ROLLBACK;
