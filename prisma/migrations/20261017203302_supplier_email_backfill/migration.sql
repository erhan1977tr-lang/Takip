-- DÜZELTME 10 M9 (3.97.0, karar 293): tedarikçinin mevcut tek e-posta adresi (Supplier.email) yeni adres listesine
-- (SupplierEmail) BİRİNCİL ve ETKİN adres olarak taşınır. Eklemelidir: hiçbir satır silinmez / değişmez; Supplier.email
-- yerinde kalır (eski sürüm uyumu). Tekrar çalıştırılırsa ikinci kayıt yazmaz (adres listesi olan tedarikçi atlanır,
-- tekil indeks çakışması yok sayılır).
INSERT INTO "SupplierEmail" ("id", "supplierId", "email", "emailKey", "isPrimary", "isActive", "sortOrder", "createdAt", "updatedAt")
SELECT 'sem_' || md5(s."id" || ':' || lower(btrim(s."email"))), s."id", btrim(s."email"), lower(btrim(s."email")), true, true, 0, now(), now()
FROM "Supplier" s
WHERE s."email" IS NOT NULL
  AND btrim(s."email") <> ''
  AND NOT EXISTS (SELECT 1 FROM "SupplierEmail" e WHERE e."supplierId" = s."id")
ON CONFLICT ("supplierId", "emailKey") DO NOTHING;
