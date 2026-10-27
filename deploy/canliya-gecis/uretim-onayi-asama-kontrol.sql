-- TAKİP — Müşteri üretim onayı canlıya geçişi: AŞAMA KONTROLÜ (Aşama 1 sonrası ve Aşama 2 boyunca). YALNIZCA SELECT.
-- 4.2.8 şemasını (üretim onayı sütunları) ister: Aşama 1'den (yeni sürüm + migration) ÖNCE çalışmaz.
-- Aşama 1 beklenen: ayar kapalı (satır yok ya da enabled=false), kapsam bayrağı 0, onay talebi / hatırlatma / istisna 0.
-- Aşama 2: bayraklar, talep / iletim / onay sayıları ve pilot seçimi için sipariş ayrıntısı.
-- DDL / DML YOK; tamamı READ ONLY işlemde, ROLLBACK ile biter. Çıktıda müşteri adı, e-posta, tutar, gerekçe / not metni YOKTUR.
-- Çalıştırma: docs/canliya-gecis-p7.md'deki ro() kalıbı (PGOPTIONS='-c default_transaction_read_only=on').

BEGIN TRANSACTION READ ONLY;

\echo '=== 1. Ayar (Ayarlar → Entegrasyonlar → Müşteri üretim onayı): satır yoksa KAPALI'
SELECT count(*) AS ayar_satiri,
       bool_or(s.value->>'enabled' = 'true') AS acik,
       max(s.value->>'cutoff') AS kesim_gunu,
       max(s."updatedAt") AS son_degisiklik
FROM "IntegrationSetting" s WHERE s.key = 'production-approval';

\echo '=== 2. Kapsam bayrağı (productionApprovalRequired) — durum dağılımı (Aşama 1: 0 satır)'
SELECT o.status::text AS durum, count(*) AS siparis, count(*) FILTER (WHERE o."loadingOverrideAt" IS NOT NULL) AS yukleme_istisnali
FROM "Order" o
WHERE o."productionApprovalRequired" AND o."removedAt" IS NULL
GROUP BY o.status ORDER BY o.status;

\echo '=== 3. Kapsamdaki siparişlerin müşteriye gönderilmiş son teklif sürümü — onay durumu sayıları'
WITH s AS (
  SELECT DISTINCT ON (f."orderId") f."orderId", f."approvalRequestedAt", f."approvalDeliveredAt", f."approvalDeliveryChannel",
         f."approvalDeliveryError", f."approvalDueAt", f."approvalReminderAt", f."approvalOverdueAt", f."approvedAt", f."changeRequestedAt"
  FROM "Offer" f JOIN "Order" o ON o.id = f."orderId"
  WHERE o."productionApprovalRequired" AND o."removedAt" IS NULL AND f.status::text = 'GONDERILDI'
  ORDER BY f."orderId", f."createdAt" DESC
)
SELECT count(*) AS gonderilmis_surum,
       count(*) FILTER (WHERE "approvalRequestedAt" IS NOT NULL) AS talep_acik,
       count(*) FILTER (WHERE "approvalDeliveredAt" IS NOT NULL) AS iletildi,
       count(*) FILTER (WHERE "approvalDeliveryChannel" = 'EMAIL') AS iletim_eposta,
       count(*) FILTER (WHERE "approvalDeliveryChannel" = 'IN_APP') AS iletim_uygulama_ici,
       count(*) FILTER (WHERE "approvalDeliveryError" = 'EMAIL_FAILED') AS hata_eposta,
       count(*) FILTER (WHERE "approvalDeliveryError" = 'NO_RECIPIENT') AS hata_alici_yok,
       count(*) FILTER (WHERE "approvalReminderAt" IS NOT NULL) AS hatirlatma_gitti,
       count(*) FILTER (WHERE "approvalOverdueAt" IS NOT NULL) AS gecikme_bildirildi,
       count(*) FILTER (WHERE "approvedAt" IS NOT NULL) AS onaylandi,
       count(*) FILTER (WHERE "changeRequestedAt" IS NOT NULL) AS degisiklik_istendi
FROM s;

\echo '=== 4. Onay kuyruğu (son 7 gün): talep / hatırlatma / teklif e-postaları (tür × durum). Aşama 1: talep / hatırlatma satırı yok'
SELECT n.type AS olay, n.status::text AS durum, count(*) AS adet, max(n."sentAt") AS son_gonderim
FROM "NotificationOutbox" n
WHERE n.type IN ('ORDER_PRODUCTION_APPROVAL_REQUESTED', 'ORDER_PRODUCTION_APPROVAL_REMINDER', 'ORDER_OFFER_SENT', 'ORDER_OFFER_UPDATED')
  AND n."createdAt" >= now() - interval '7 days'
GROUP BY n.type, n.status ORDER BY n.type, n.status;

\echo '=== 5. Kapsam dışı ama planlanan yüklemesi kesim günü ve sonrası olan açık cam siparişleri (kapsama alma betiğinin adayları)'
SELECT o.status::text AS durum, count(*) AS siparis
FROM "Order" o
WHERE o."orderTypeCode" = 'GLASS_ORDER' AND o."removedAt" IS NULL AND NOT o."productionApprovalRequired"
  AND o.status::text NOT IN ('IPTAL', 'ARSIVLENDI', 'YUKLENDI')
  AND ((COALESCE(o."actualShipDate", o."estimatedShipDate") AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Bucharest')::date >= DATE '2026-11-06'
GROUP BY o.status ORDER BY o.status;

\echo '=== 6. Ayrıntı: kapsamdaki her sipariş (pilot seçimi için) — sipariş no, durum, planlanan yükleme, son gönderilmiş sürümün onay durumu'
WITH s AS (
  SELECT DISTINCT ON (f."orderId") f."orderId", f."approvalRequestedAt", f."approvalDeliveredAt", f."approvalDeliveryError",
         f."approvalDueAt", f."approvedAt", f."changeRequestedAt"
  FROM "Offer" f WHERE f.status::text = 'GONDERILDI'
  ORDER BY f."orderId", f."createdAt" DESC
)
SELECT o."orderNo" AS siparis, o.status::text AS durum,
       ((COALESCE(o."actualShipDate", o."estimatedShipDate") AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Bucharest')::date AS yukleme,
       CASE
         WHEN s."orderId" IS NULL THEN 'TEKLIF_GONDERILMEDI'
         WHEN s."approvedAt" IS NOT NULL THEN 'ONAYLANDI'
         WHEN s."changeRequestedAt" IS NOT NULL THEN 'DEGISIKLIK_ISTENDI'
         WHEN s."approvalDeliveredAt" IS NOT NULL THEN 'ILETILDI_BEKLIYOR'
         WHEN s."approvalDeliveryError" IS NOT NULL THEN 'ILETILEMEDI_' || s."approvalDeliveryError"
         WHEN s."approvalRequestedAt" IS NOT NULL THEN 'TALEP_KUYRUKTA'
         ELSE 'TALEP_YOK'
       END AS onay,
       s."approvalDueAt" AS son_tarih, (o."loadingOverrideAt" IS NOT NULL) AS yukleme_istisnasi
FROM "Order" o LEFT JOIN s ON s."orderId" = o.id
WHERE o."productionApprovalRequired" AND o."removedAt" IS NULL
ORDER BY yukleme, o."orderNo";

ROLLBACK;
