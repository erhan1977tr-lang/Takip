-- TAKİP — Müşteri teklif revizyonu (4.2.10, karar 306) canlıya geçiş KONTROLÜ. YALNIZCA SELECT.
-- 4.2.9 şemasıyla da çalışır (4.2.10'un yeni çeviri sütunlarını kullanmaz): geçişten ÖNCE ve SONRA aynı çıktı karşılaştırılır.
-- Açık müşteri revizyonu (uygulamadaki kural — server/orders/offer-revision.js → customerRevision): kapsamdaki (bayraklı) cam
-- siparişi, müşteriye gönderilmiş SON sürümde değişiklik istenmiş ve o sürümden sonra yeni sürüm gönderilmemiş. Aşama:
--   TASLAK_YOK  en yeni sürüm talepli gönderilmiş sürümün kendisi (4.2.10 öncesinde üretimde alınmış talep — ör. ALE81):
--               4.2.10'da satış / yönetici "Revizyon taslağını aç" ile tek seferlik taslak açar
--   SATISTA     en yeni sürüm taslak (HAZIRLANIYOR) · YONETICIDE en yeni sürüm yönetici onayında (YONETIMDE)
-- DDL / DML YOK; tamamı READ ONLY işlemde, ROLLBACK ile biter. Çıktıda müşteri adı, e-posta, tutar, not metni YOKTUR.
-- Çalıştırma: docs/canliya-gecis-p7.md'deki ro() kalıbı (PGOPTIONS='-c default_transaction_read_only=on').

BEGIN TRANSACTION READ ONLY;

\echo '=== 1. Ayar (Müşteri üretim onayı): satır yoksa KAPALI'
SELECT count(*) AS ayar_satiri, bool_or(s.value->>'enabled' = 'true') AS acik, max(s.value->>'cutoff') AS kesim_gunu
FROM "IntegrationSetting" s WHERE s.key = 'production-approval';

\echo '=== 2. Açık müşteri revizyonları — aşama × sipariş durumu'
WITH v AS (
  SELECT f."orderId", f.id, f.status::text AS st, f."changeRequestedAt",
         row_number() OVER (PARTITION BY f."orderId" ORDER BY f."createdAt" DESC) AS rn,
         count(*) OVER (PARTITION BY f."orderId") AS surum_sayisi
  FROM "Offer" f
), son_gonderilen AS (
  SELECT DISTINCT ON (v."orderId") v."orderId", v.id, v.rn, v."changeRequestedAt", v.surum_sayisi
  FROM v WHERE v.st = 'GONDERILDI' ORDER BY v."orderId", v.rn
), acik AS (
  SELECT o.id, o."orderNo", o.status::text AS durum, o."onHold", g.rn, g."changeRequestedAt", g.surum_sayisi - g.rn + 1 AS surum,
         (SELECT v.st FROM v WHERE v."orderId" = o.id AND v.rn = 1) AS en_yeni
  FROM "Order" o JOIN son_gonderilen g ON g."orderId" = o.id
  WHERE o."orderTypeCode" = 'GLASS_ORDER' AND o."productionApprovalRequired" AND o."removedAt" IS NULL
    AND g."changeRequestedAt" IS NOT NULL
)
SELECT CASE WHEN rn = 1 THEN 'TASLAK_YOK' WHEN en_yeni = 'HAZIRLANIYOR' THEN 'SATISTA' WHEN en_yeni = 'YONETIMDE' THEN 'YONETICIDE' ELSE 'KURAL_DISI' END AS asama,
       durum, count(*) AS siparis
FROM acik GROUP BY 1, 2 ORDER BY 1, 2;

\echo '=== 3. Ayrıntı: açık revizyonlar (sipariş no, durum, beklemede mi, talepli sürüm, talep zamanı, aşama)'
WITH v AS (
  SELECT f."orderId", f.id, f.status::text AS st, f."changeRequestedAt",
         row_number() OVER (PARTITION BY f."orderId" ORDER BY f."createdAt" DESC) AS rn,
         count(*) OVER (PARTITION BY f."orderId") AS surum_sayisi
  FROM "Offer" f
), son_gonderilen AS (
  SELECT DISTINCT ON (v."orderId") v."orderId", v.rn, v."changeRequestedAt", v.surum_sayisi
  FROM v WHERE v.st = 'GONDERILDI' ORDER BY v."orderId", v.rn
)
SELECT o."orderNo" AS siparis, o.status::text AS durum, o."onHold" AS beklemede, g.surum_sayisi - g.rn + 1 AS talepli_surum,
       g."changeRequestedAt" AS talep_zamani,
       CASE WHEN g.rn = 1 THEN 'TASLAK_YOK'
            WHEN (SELECT v.st FROM v WHERE v."orderId" = o.id AND v.rn = 1) = 'HAZIRLANIYOR' THEN 'SATISTA'
            WHEN (SELECT v.st FROM v WHERE v."orderId" = o.id AND v.rn = 1) = 'YONETIMDE' THEN 'YONETICIDE'
            ELSE 'KURAL_DISI' END AS asama
FROM "Order" o JOIN son_gonderilen g ON g."orderId" = o.id
WHERE o."orderTypeCode" = 'GLASS_ORDER' AND o."productionApprovalRequired" AND o."removedAt" IS NULL
  AND g."changeRequestedAt" IS NOT NULL
ORDER BY asama, o."orderNo";

\echo '=== 4. Taslağı açılmamış talepler (ALE81 gibi): "Revizyon taslağını aç"ı engelleyecek mali kilit var mı (FGO belgesi, etkin parti, bekleyen belge işi, onaylı yükleme)'
WITH v AS (
  SELECT f."orderId", f.status::text AS st, f."changeRequestedAt",
         row_number() OVER (PARTITION BY f."orderId" ORDER BY f."createdAt" DESC) AS rn
  FROM "Offer" f
)
SELECT o."orderNo" AS siparis, o.status::text AS durum,
       (SELECT count(*) FROM "FgoDocument" d WHERE d."orderId" = o.id) AS fgo_belgesi,
       (SELECT count(*) FROM "BillingBatchOrder" b WHERE b."orderId" = o.id AND b."activeKey" IS NOT NULL) AS etkin_parti,
       (SELECT count(*) FROM "NotificationOutbox" n WHERE n."orderId" = o.id AND n.status::text = 'PENDING' AND n.type IN ('FGO_GLASS', 'FGO_PROFORMA', 'FGO_INVOICE')) AS bekleyen_belge_isi,
       (SELECT count(*) FROM "LoadingConfirmationItem" i WHERE i."orderId" = o.id) AS onayli_yukleme_kalemi
FROM "Order" o JOIN v ON v."orderId" = o.id AND v.rn = 1
WHERE o."orderTypeCode" = 'GLASS_ORDER' AND o."productionApprovalRequired" AND o."removedAt" IS NULL
  AND v.st = 'GONDERILDI' AND v."changeRequestedAt" IS NOT NULL
ORDER BY o."orderNo";

\echo '=== 5. Değişiklik talebi bildirimleri (son 7 gün): uygulama içi / e-posta kuyruğu'
SELECT n.type AS olay, n.status::text AS durum, count(*) AS adet, count(*) FILTER (WHERE n."inAppAt" IS NOT NULL) AS zil_dagitildi, max(n."sentAt") AS son_eposta
FROM "NotificationOutbox" n
WHERE n.type IN ('ORDER_OFFER_CHANGE_REQUESTED', 'ORDER_OFFER_REVISION_OPENED') AND n."createdAt" >= now() - interval '7 days'
GROUP BY n.type, n.status ORDER BY n.type, n.status;

ROLLBACK;
