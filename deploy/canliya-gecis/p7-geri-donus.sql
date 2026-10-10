-- TAKİP P7 — deploy SONRASI / geri dönüş kararı ÖNCESİ kontrol. YALNIZCA SELECT; READ ONLY işlem, ROLLBACK ile biter.
-- Geri dönüş (3.66.1) yalnızca bütün sayılar 0 iken finansal olarak risksizdir. > 0 ise eski sürüm bu siparişlere sipariş
-- sayfasından İKİNCİ kapanış faturası kestirebilir ve alacakları yanlış gruplar → GERİ DÖNÜLMEZ, ileriye düzeltme yapılır.

BEGIN TRANSACTION READ ONLY;

\echo '=== 1. Yeni kuralla oluşmuş sipariş zinciri fatura partileri (durum dağılımı) — geri dönüş için 0'
SELECT b.status::text AS durum, count(*) AS adet FROM "BillingBatch" b
WHERE b."chainOrderId" IS NOT NULL AND b.kind::text = 'INVOICE' GROUP BY 1 ORDER BY 1;

\echo '=== 2. Ayrıntı (sipariş no, belge no, durum)'
SELECT o."orderNo", b.status::text AS durum, d.series || d.number AS belge, b."createdAt"::date AS tarih
FROM "BillingBatch" b JOIN "Order" o ON o.id = b."chainOrderId" LEFT JOIN "FgoDocument" d ON d."batchId" = b.id
WHERE b."chainOrderId" IS NOT NULL AND b.kind::text = 'INVOICE' ORDER BY b."createdAt";

\echo '=== 3. Avans düşümü kaydı (refDocId) olan satır — geri dönüş için 0'
SELECT count(*) AS avans_dusum_satiri FROM "BillingBatchLine" WHERE "refDocId" IS NOT NULL;

\echo '=== 4. Deploy sonrası kesilmiş TÜM FGO belgeleri (bilgi; zaman damgasını deploy saatiyle karşılaştırın)'
SELECT d.kind, d.series || d.number AS belge, d."issuedAt" FROM "FgoDocument" d ORDER BY d."issuedAt" DESC LIMIT 15;

ROLLBACK;
