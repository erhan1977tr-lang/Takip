-- TAKİP — Fabrika Ekipleri (4.3.19, karar 304) ÖNCESİ canlı eşleşme raporu. YALNIZCA SELECT; READ ONLY işlem, ROLLBACK ile
-- biter. Hiçbir şey yazmaz. Şifre, şifre özeti, oturum / davet kodu, token, e-posta, müşteri adı ya da tutar İÇERMEZ:
-- kişiler ad + kimliğin ilk 8 karakteriyle, siparişler / ödemeler / sandıklar yalnızca SAYI olarak gösterilir.
-- Satışçı–çizimci alanları (4.3.0, karar 300) gerektirir: bölüm 0'da "eksik" satır varsa canlı şema daha eskidir — o zaman
-- yalnızca bölüm 0'ın sonucunu iletin, devamını çalıştırmayın.
-- Kullanım (sunucuda, salt okunur):  psql "$DATABASE_URL" -f ekip-eslesmeleri.sql

BEGIN TRANSACTION READ ONLY;

\echo '=== 0. Şema: gerekli alanlar var mı (hepsi "var" olmalı); FactoryTeam tablosu (4.3.19 öncesi: yok)'
SELECT x.tablo, x.alan, CASE WHEN c.column_name IS NULL THEN 'eksik' ELSE 'var' END AS durum
FROM (VALUES ('User', 'defaultDrawerId'), ('User', 'priceTableId'), ('Order', 'salesUserId'), ('Order', 'assignedDrawerId'),
             ('FactoryPayment', 'salesUserId'), ('Crate', 'salesUserId')) AS x(tablo, alan)
LEFT JOIN information_schema.columns c ON c.table_schema = 'public' AND c.table_name = x.tablo AND c.column_name = x.alan
ORDER BY 1, 2;
SELECT count(*) AS factory_team_tablosu FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'FactoryTeam';

\echo '=== 1. Satışçılar: varsayılan çizimci ve fiyat tablosu (kişi = ad + kimlik başı)'
SELECT coalesce(nullif(s.name, ''), '(adsız)') AS satisci, left(s.id, 8) AS satisci_kimlik,
       CASE WHEN s."deletedAt" IS NOT NULL THEN 'silinmiş' WHEN s."isActive" THEN 'etkin' ELSE 'pasif' END AS satisci_durum,
       coalesce(nullif(d.name, ''), CASE WHEN d.id IS NULL THEN '—' ELSE '(adsız)' END) AS varsayilan_cizimci,
       left(d.id, 8) AS cizimci_kimlik,
       CASE WHEN d.id IS NULL THEN '—' WHEN d."deletedAt" IS NOT NULL THEN 'silinmiş' WHEN d."isActive" THEN 'etkin' ELSE 'pasif' END AS cizimci_durum,
       coalesce(t.name, '—') AS fiyat_tablosu, CASE WHEN t.id IS NULL THEN '—' WHEN t."isActive" THEN 'etkin' ELSE 'pasif' END AS tablo_durum
FROM "User" s
LEFT JOIN "User" d ON d.id = s."defaultDrawerId"
LEFT JOIN "PriceTable" t ON t.id = s."priceTableId"
WHERE s."appRole"::text = 'SATIS' AND s.type::text = 'INTERNAL'
ORDER BY satisci_durum, satisci;

\echo '=== 2. Çizimciler: kaç etkin satışçının varsayılanı (> 1 ise aynı çizimci iki ekipte — ekip kurulurken biri seçilmeli)'
SELECT coalesce(nullif(d.name, ''), '(adsız)') AS cizimci, left(d.id, 8) AS cizimci_kimlik,
       CASE WHEN d."deletedAt" IS NOT NULL THEN 'silinmiş' WHEN d."isActive" THEN 'etkin' ELSE 'pasif' END AS durum,
       count(s.id) FILTER (WHERE s."isActive" AND s."deletedAt" IS NULL) AS etkin_satisci_sayisi
FROM "User" d
LEFT JOIN "User" s ON s."defaultDrawerId" = d.id AND s."appRole"::text = 'SATIS'
WHERE d."appRole"::text = 'CIZIM' AND d.type::text = 'INTERNAL'
GROUP BY d.id, d.name, d."isActive", d."deletedAt" ORDER BY etkin_satisci_sayisi DESC, cizimci;

\echo '=== 3. Fiyat tabloları (satış / alış): kaç etkin satışçıya atanmış (> 1 ise aynı tablo iki ekipte — var olan bağlantı DEĞİŞMEZ; yeni atamada engellenir)'
SELECT t.name AS fiyat_tablosu, t.currency AS para_birimi, CASE WHEN t."isActive" THEN 'etkin' ELSE 'pasif' END AS durum,
       CASE WHEN t."isDefault" THEN 'evet' ELSE 'hayır' END AS varsayilan,
       count(s.id) FILTER (WHERE s."isActive" AND s."deletedAt" IS NULL AND s."appRole"::text = 'SATIS') AS etkin_satisci_sayisi
FROM "PriceTable" t LEFT JOIN "User" s ON s."priceTableId" = t.id
WHERE t.kind::text = 'SALES'
GROUP BY t.id, t.name, t.currency, t."isActive", t."isDefault" ORDER BY etkin_satisci_sayisi DESC, fiyat_tablosu;

\echo '=== 4. Cam siparişleri: sorumlu satışçıya göre (açık / kapalı); satışçısız olanlar ayrı satırda'
SELECT coalesce(nullif(s.name, ''), CASE WHEN o."salesUserId" IS NULL THEN '(sorumlusu yok)' ELSE '(adsız)' END) AS satisci,
       left(o."salesUserId", 8) AS satisci_kimlik,
       count(*) FILTER (WHERE o.status::text NOT IN ('ARSIVLENDI', 'IPTAL') AND o."removedAt" IS NULL) AS acik,
       count(*) FILTER (WHERE o.status::text IN ('ARSIVLENDI', 'IPTAL') OR o."removedAt" IS NOT NULL) AS kapali_silinmis
FROM "Order" o LEFT JOIN "User" s ON s.id = o."salesUserId"
WHERE o."orderTypeCode" = 'GLASS_ORDER'
GROUP BY o."salesUserId", s.name ORDER BY acik DESC;

\echo '=== 5. Sipariş çizimcisi ≠ sorumlu satışçının varsayılan çizimcisi (açık cam siparişleri; çizim geçmişi olanlar ayrı sayılır)'
SELECT coalesce(nullif(s.name, ''), '(adsız)') AS satisci, coalesce(nullif(od.name, ''), '(adsız)') AS siparis_cizimcisi,
       coalesce(nullif(sd.name, ''), '—') AS satiscinin_varsayilani,
       count(*) AS siparis,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "Drawing" g WHERE g."orderId" = o.id)) AS cizim_gecmisi_olan
FROM "Order" o
JOIN "User" s ON s.id = o."salesUserId"
JOIN "User" od ON od.id = o."assignedDrawerId"
LEFT JOIN "User" sd ON sd.id = s."defaultDrawerId"
WHERE o."orderTypeCode" = 'GLASS_ORDER' AND o."removedAt" IS NULL AND o.status::text NOT IN ('ARSIVLENDI', 'IPTAL')
  AND o."assignedDrawerId" IS DISTINCT FROM s."defaultDrawerId"
GROUP BY s.name, od.name, sd.name ORDER BY siparis DESC;

\echo '=== 6. Sorumlusu olmayan açık cam siparişlerinde çizim geçmişi (ilk atamada farklı çizimciye geçiş engellenir — DRAWER_HISTORY)'
SELECT count(*) AS sahipsiz_acik,
       count(*) FILTER (WHERE o."assignedDrawerId" IS NOT NULL) AS cizimcisi_olan,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "Drawing" g WHERE g."orderId" = o.id) OR o."drawingTrack"::text NOT IN ('YOK', 'GEREKLI')) AS cizim_gecmisi_olan
FROM "Order" o
WHERE o."orderTypeCode" = 'GLASS_ORDER' AND o."salesUserId" IS NULL AND o."removedAt" IS NULL AND o.status::text NOT IN ('ARSIVLENDI', 'IPTAL');

\echo '=== 7. Fabrika ödemeleri: hesaba göre KAYIT SAYISI (tutar gösterilmez)'
SELECT coalesce(nullif(s.name, ''), CASE WHEN p."salesUserId" IS NULL THEN '(hesap boş)' ELSE '(adsız)' END) AS hesap,
       left(p."salesUserId", 8) AS hesap_kimlik, p.currency AS para_birimi, count(*) AS kayit
FROM "FactoryPayment" p LEFT JOIN "User" s ON s.id = p."salesUserId"
GROUP BY p."salesUserId", s.name, p.currency ORDER BY hesap, para_birimi;

\echo '=== 8. Sandıklar: satışçı bölümüne göre sayı; farklı satışçıların siparişlerini taşıyan sandık (0 olmalı)'
SELECT coalesce(nullif(s.name, ''), CASE WHEN c."salesUserId" IS NULL THEN '(bölümü boş)' ELSE '(adsız)' END) AS bolum,
       left(c."salesUserId", 8) AS bolum_kimlik, count(*) AS sandik
FROM "Crate" c LEFT JOIN "User" s ON s.id = c."salesUserId"
GROUP BY c."salesUserId", s.name ORDER BY sandik DESC;
SELECT count(*) AS karisik_sandik FROM (
  SELECT co."crateId" FROM "CrateOrder" co JOIN "Order" o ON o.id = co."orderId" JOIN "Crate" c ON c.id = co."crateId"
  WHERE o."customerId" = c."customerId"
  GROUP BY co."crateId" HAVING count(DISTINCT o."salesUserId") > 1
) k;

\echo '=== 9. Yönlendirme: geçmiş veri bağlandı mı; son 5 kural (kip, hedef, başlangıç)'
SELECT count(*) AS baglama_isareti FROM "IntegrationSetting" WHERE key = 'sales-routing' AND value ? 'linkedAt';
SELECT r.mode AS kip, coalesce(nullif(u.name, ''), CASE WHEN r."targetUserId" IS NULL THEN '—' ELSE '(adsız)' END) AS hedef,
       left(r."targetUserId", 8) AS hedef_kimlik, r."startsAt" AS baslangic
FROM "GlassRoutingRule" r LEFT JOIN "User" u ON u.id = r."targetUserId"
ORDER BY r."startsAt" DESC, r."createdAt" DESC LIMIT 5;

ROLLBACK;
