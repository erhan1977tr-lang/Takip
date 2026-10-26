-- TAKİP — Müşteri üretim onayı (karar 305): mevcut siparişlerin KAPSAM RAPORU. YALNIZCA SELECT.
-- Planlanan yükleme günü ≥ 06.11.2026 (Europe/Bucharest) olan cam siparişleri ve geçiş işleminin onlara ne yapacağı.
-- Canlıdaki 4.2.0 şemasıyla çalışır (yeni sütun kullanmaz). DDL / DML YOK; tamamı READ ONLY işlemde, ROLLBACK ile biter.
-- Çıktıda müşteri adı, tutar, fiyat, e-posta YOKTUR (sipariş no firma kodunu içerir).
-- Kategoriler (server/orders/production-approval-enroll.js ile aynı kural):
--   REQUEST        onay talebi açılır (HAZIRLANIYOR / URETIMDE, güncel sürüm müşteride)
--   FLAG_ONLY      yalnızca kapsama alınır (teklif henüz müşteride değil; onay teklif gönderilince istenir)
--   LOADED         yüklendi / yükleme onayı kalemi var (kısmi dahil) — dokunulmaz
--   FINAL_INVOICED nihai fatura kesilmiş — dokunulmaz
--   COMPENSATION   telafi (-T) siparişi — dokunulmaz
--   NO_OFFER / DRAFT_OPEN  güncel teklif müşteride değil — dokunulmaz, incelenmeli
-- Çalıştırma (sunucuda): psql "$DATABASE_URL" -f deploy/canliya-gecis/uretim-onayi-kapsam.sql  (PGOPTIONS='-c default_transaction_read_only=on')

BEGIN TRANSACTION READ ONLY;

\echo '=== 1. Özet: kategori × durum'
WITH o AS (
  SELECT ord.id, ord."orderNo", ord.status::text AS status, ord."onHold", ord."compOfId",
         ((COALESCE(ord."actualShipDate", ord."estimatedShipDate") AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Bucharest')::date AS yukleme
  FROM "Order" ord
  WHERE ord."orderTypeCode" = 'GLASS_ORDER' AND ord."removedAt" IS NULL AND ord.status::text NOT IN ('IPTAL', 'ARSIVLENDI')
), lat AS (
  SELECT DISTINCT ON (f."orderId") f."orderId", f.status::text AS son_teklif, f."sentAt" FROM "Offer" f ORDER BY f."orderId", f."createdAt" DESC
), sent AS (
  SELECT f."orderId", count(*) AS n FROM "Offer" f WHERE f.status::text = 'GONDERILDI' GROUP BY f."orderId"
), li AS (
  SELECT i."orderId", count(*) AS n FROM "LoadingConfirmationItem" i GROUP BY i."orderId"
), inv AS (
  SELECT d."orderId" FROM "FgoDocument" d WHERE d.kind = 'INVOICE' AND d."orderId" IS NOT NULL
  UNION SELECT bo."orderId" FROM "BillingBatchOrder" bo JOIN "BillingBatch" b ON b.id = bo."batchId" WHERE b.kind::text = 'INVOICE' AND b.status::text = 'ISSUED'
), pf AS (
  SELECT d."orderId" FROM "FgoDocument" d WHERE d.kind = 'PROFORMA' AND d."orderId" IS NOT NULL
  UNION SELECT bo."orderId" FROM "BillingBatchOrder" bo JOIN "BillingBatch" b ON b.id = bo."batchId" WHERE b.kind::text = 'PROFORMA' AND bo."activeKey" IS NOT NULL
), k AS (
  SELECT o.*, lat.son_teklif, lat."sentAt", COALESCE(li.n, 0) AS yukleme_onay_kalemi, (inv."orderId" IS NOT NULL) AS nihai_fatura,
         (pf."orderId" IS NOT NULL) AS proforma,
         CASE
           WHEN o.status = 'YUKLENDI' OR COALESCE(li.n, 0) > 0 THEN 'LOADED'
           WHEN inv."orderId" IS NOT NULL THEN 'FINAL_INVOICED'
           WHEN o."compOfId" IS NOT NULL THEN 'COMPENSATION'
           WHEN lat.son_teklif = 'GONDERILDI' AND o.status IN ('HAZIRLANIYOR', 'URETIMDE') THEN 'REQUEST'
           WHEN o.status = 'URETIMDE' THEN 'NO_OFFER'
           WHEN COALESCE(sent.n, 0) > 0 THEN 'DRAFT_OPEN'
           WHEN o.status IN ('YENI', 'HAZIRLANIYOR') THEN 'FLAG_ONLY'
           ELSE 'NO_OFFER'
         END AS kategori
  FROM o LEFT JOIN lat ON lat."orderId" = o.id LEFT JOIN sent ON sent."orderId" = o.id LEFT JOIN li ON li."orderId" = o.id
       LEFT JOIN (SELECT DISTINCT "orderId" FROM inv) inv ON inv."orderId" = o.id LEFT JOIN (SELECT DISTINCT "orderId" FROM pf) pf ON pf."orderId" = o.id
  WHERE o.yukleme >= DATE '2026-11-06'
)
SELECT kategori, status AS durum, count(*) AS siparis, count(*) FILTER (WHERE proforma) AS proformali, count(*) FILTER (WHERE "onHold") AS beklemede
FROM k GROUP BY kategori, status ORDER BY kategori, status;

\echo '=== 2. Ayrıntı: her sipariş (sipariş no, durum, planlanan yükleme, son teklif, kategori)'
WITH o AS (
  SELECT ord.id, ord."orderNo", ord.status::text AS status, ord."onHold", ord."compOfId",
         ((COALESCE(ord."actualShipDate", ord."estimatedShipDate") AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Bucharest')::date AS yukleme
  FROM "Order" ord
  WHERE ord."orderTypeCode" = 'GLASS_ORDER' AND ord."removedAt" IS NULL AND ord.status::text NOT IN ('IPTAL', 'ARSIVLENDI')
), lat AS (
  SELECT DISTINCT ON (f."orderId") f."orderId", f.status::text AS son_teklif, f."sentAt" FROM "Offer" f ORDER BY f."orderId", f."createdAt" DESC
), sent AS (
  SELECT f."orderId", count(*) AS n FROM "Offer" f WHERE f.status::text = 'GONDERILDI' GROUP BY f."orderId"
), li AS (
  SELECT i."orderId", count(*) AS n FROM "LoadingConfirmationItem" i GROUP BY i."orderId"
), inv AS (
  SELECT d."orderId" FROM "FgoDocument" d WHERE d.kind = 'INVOICE' AND d."orderId" IS NOT NULL
  UNION SELECT bo."orderId" FROM "BillingBatchOrder" bo JOIN "BillingBatch" b ON b.id = bo."batchId" WHERE b.kind::text = 'INVOICE' AND b.status::text = 'ISSUED'
), pf AS (
  SELECT d."orderId" FROM "FgoDocument" d WHERE d.kind = 'PROFORMA' AND d."orderId" IS NOT NULL
  UNION SELECT bo."orderId" FROM "BillingBatchOrder" bo JOIN "BillingBatch" b ON b.id = bo."batchId" WHERE b.kind::text = 'PROFORMA' AND bo."activeKey" IS NOT NULL
), k AS (
  SELECT o.*, lat.son_teklif, lat."sentAt", COALESCE(li.n, 0) AS yukleme_onay_kalemi, (inv."orderId" IS NOT NULL) AS nihai_fatura,
         (pf."orderId" IS NOT NULL) AS proforma,
         CASE
           WHEN o.status = 'YUKLENDI' OR COALESCE(li.n, 0) > 0 THEN 'LOADED'
           WHEN inv."orderId" IS NOT NULL THEN 'FINAL_INVOICED'
           WHEN o."compOfId" IS NOT NULL THEN 'COMPENSATION'
           WHEN lat.son_teklif = 'GONDERILDI' AND o.status IN ('HAZIRLANIYOR', 'URETIMDE') THEN 'REQUEST'
           WHEN o.status = 'URETIMDE' THEN 'NO_OFFER'
           WHEN COALESCE(sent.n, 0) > 0 THEN 'DRAFT_OPEN'
           WHEN o.status IN ('YENI', 'HAZIRLANIYOR') THEN 'FLAG_ONLY'
           ELSE 'NO_OFFER'
         END AS kategori
  FROM o LEFT JOIN lat ON lat."orderId" = o.id LEFT JOIN sent ON sent."orderId" = o.id LEFT JOIN li ON li."orderId" = o.id
       LEFT JOIN (SELECT DISTINCT "orderId" FROM inv) inv ON inv."orderId" = o.id LEFT JOIN (SELECT DISTINCT "orderId" FROM pf) pf ON pf."orderId" = o.id
  WHERE o.yukleme >= DATE '2026-11-06'
)
SELECT "orderNo" AS siparis, status AS durum, yukleme, son_teklif, "sentAt"::date AS teklif_gonderim, proforma, "onHold" AS beklemede, kategori
FROM k ORDER BY kategori, yukleme, "orderNo";

\echo '=== 3. Yüklenmiş / kısmi yüklenmiş (dokunulmaz) — yükleme onayı kalemi sayısıyla'
WITH o AS (
  SELECT ord.id, ord."orderNo", ord.status::text AS status, ord."onHold", ord."compOfId",
         ((COALESCE(ord."actualShipDate", ord."estimatedShipDate") AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Bucharest')::date AS yukleme
  FROM "Order" ord
  WHERE ord."orderTypeCode" = 'GLASS_ORDER' AND ord."removedAt" IS NULL AND ord.status::text NOT IN ('IPTAL', 'ARSIVLENDI')
), lat AS (
  SELECT DISTINCT ON (f."orderId") f."orderId", f.status::text AS son_teklif, f."sentAt" FROM "Offer" f ORDER BY f."orderId", f."createdAt" DESC
), sent AS (
  SELECT f."orderId", count(*) AS n FROM "Offer" f WHERE f.status::text = 'GONDERILDI' GROUP BY f."orderId"
), li AS (
  SELECT i."orderId", count(*) AS n FROM "LoadingConfirmationItem" i GROUP BY i."orderId"
), inv AS (
  SELECT d."orderId" FROM "FgoDocument" d WHERE d.kind = 'INVOICE' AND d."orderId" IS NOT NULL
  UNION SELECT bo."orderId" FROM "BillingBatchOrder" bo JOIN "BillingBatch" b ON b.id = bo."batchId" WHERE b.kind::text = 'INVOICE' AND b.status::text = 'ISSUED'
), pf AS (
  SELECT d."orderId" FROM "FgoDocument" d WHERE d.kind = 'PROFORMA' AND d."orderId" IS NOT NULL
  UNION SELECT bo."orderId" FROM "BillingBatchOrder" bo JOIN "BillingBatch" b ON b.id = bo."batchId" WHERE b.kind::text = 'PROFORMA' AND bo."activeKey" IS NOT NULL
), k AS (
  SELECT o.*, lat.son_teklif, lat."sentAt", COALESCE(li.n, 0) AS yukleme_onay_kalemi, (inv."orderId" IS NOT NULL) AS nihai_fatura,
         (pf."orderId" IS NOT NULL) AS proforma,
         CASE
           WHEN o.status = 'YUKLENDI' OR COALESCE(li.n, 0) > 0 THEN 'LOADED'
           WHEN inv."orderId" IS NOT NULL THEN 'FINAL_INVOICED'
           WHEN o."compOfId" IS NOT NULL THEN 'COMPENSATION'
           WHEN lat.son_teklif = 'GONDERILDI' AND o.status IN ('HAZIRLANIYOR', 'URETIMDE') THEN 'REQUEST'
           WHEN o.status = 'URETIMDE' THEN 'NO_OFFER'
           WHEN COALESCE(sent.n, 0) > 0 THEN 'DRAFT_OPEN'
           WHEN o.status IN ('YENI', 'HAZIRLANIYOR') THEN 'FLAG_ONLY'
           ELSE 'NO_OFFER'
         END AS kategori
  FROM o LEFT JOIN lat ON lat."orderId" = o.id LEFT JOIN sent ON sent."orderId" = o.id LEFT JOIN li ON li."orderId" = o.id
       LEFT JOIN (SELECT DISTINCT "orderId" FROM inv) inv ON inv."orderId" = o.id LEFT JOIN (SELECT DISTINCT "orderId" FROM pf) pf ON pf."orderId" = o.id
  WHERE o.yukleme >= DATE '2026-11-06'
)
SELECT "orderNo" AS siparis, status AS durum, yukleme, yukleme_onay_kalemi, nihai_fatura FROM k WHERE kategori IN ('LOADED', 'FINAL_INVOICED') ORDER BY yukleme, "orderNo";

\echo '=== 4. Güncel teklifi müşteride olmayanlar (FLAG_ONLY / NO_OFFER / DRAFT_OPEN) — sessizce değiştirilmez, incelenmeli'
WITH o AS (
  SELECT ord.id, ord."orderNo", ord.status::text AS status, ord."onHold", ord."compOfId",
         ((COALESCE(ord."actualShipDate", ord."estimatedShipDate") AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Bucharest')::date AS yukleme
  FROM "Order" ord
  WHERE ord."orderTypeCode" = 'GLASS_ORDER' AND ord."removedAt" IS NULL AND ord.status::text NOT IN ('IPTAL', 'ARSIVLENDI')
), lat AS (
  SELECT DISTINCT ON (f."orderId") f."orderId", f.status::text AS son_teklif, f."sentAt" FROM "Offer" f ORDER BY f."orderId", f."createdAt" DESC
), sent AS (
  SELECT f."orderId", count(*) AS n FROM "Offer" f WHERE f.status::text = 'GONDERILDI' GROUP BY f."orderId"
), li AS (
  SELECT i."orderId", count(*) AS n FROM "LoadingConfirmationItem" i GROUP BY i."orderId"
), inv AS (
  SELECT d."orderId" FROM "FgoDocument" d WHERE d.kind = 'INVOICE' AND d."orderId" IS NOT NULL
  UNION SELECT bo."orderId" FROM "BillingBatchOrder" bo JOIN "BillingBatch" b ON b.id = bo."batchId" WHERE b.kind::text = 'INVOICE' AND b.status::text = 'ISSUED'
), pf AS (
  SELECT d."orderId" FROM "FgoDocument" d WHERE d.kind = 'PROFORMA' AND d."orderId" IS NOT NULL
  UNION SELECT bo."orderId" FROM "BillingBatchOrder" bo JOIN "BillingBatch" b ON b.id = bo."batchId" WHERE b.kind::text = 'PROFORMA' AND bo."activeKey" IS NOT NULL
), k AS (
  SELECT o.*, lat.son_teklif, lat."sentAt", COALESCE(li.n, 0) AS yukleme_onay_kalemi, (inv."orderId" IS NOT NULL) AS nihai_fatura,
         (pf."orderId" IS NOT NULL) AS proforma,
         CASE
           WHEN o.status = 'YUKLENDI' OR COALESCE(li.n, 0) > 0 THEN 'LOADED'
           WHEN inv."orderId" IS NOT NULL THEN 'FINAL_INVOICED'
           WHEN o."compOfId" IS NOT NULL THEN 'COMPENSATION'
           WHEN lat.son_teklif = 'GONDERILDI' AND o.status IN ('HAZIRLANIYOR', 'URETIMDE') THEN 'REQUEST'
           WHEN o.status = 'URETIMDE' THEN 'NO_OFFER'
           WHEN COALESCE(sent.n, 0) > 0 THEN 'DRAFT_OPEN'
           WHEN o.status IN ('YENI', 'HAZIRLANIYOR') THEN 'FLAG_ONLY'
           ELSE 'NO_OFFER'
         END AS kategori
  FROM o LEFT JOIN lat ON lat."orderId" = o.id LEFT JOIN sent ON sent."orderId" = o.id LEFT JOIN li ON li."orderId" = o.id
       LEFT JOIN (SELECT DISTINCT "orderId" FROM inv) inv ON inv."orderId" = o.id LEFT JOIN (SELECT DISTINCT "orderId" FROM pf) pf ON pf."orderId" = o.id
  WHERE o.yukleme >= DATE '2026-11-06'
)
SELECT "orderNo" AS siparis, status AS durum, yukleme, son_teklif, kategori FROM k WHERE kategori IN ('FLAG_ONLY', 'NO_OFFER', 'DRAFT_OPEN') ORDER BY kategori, yukleme, "orderNo";

ROLLBACK;
