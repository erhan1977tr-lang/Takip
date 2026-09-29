-- Aşama 1 (elle yazıldı; Prisma'nın şema farkında görünmez).
--
-- 1) Rol yetkileri yeni yetki listesine geçiyor: eski satırlar silinir, `npm run db:seed` yenilerini yazar.
--    (Ardından gelen otomatik migration PermissionKey enum'unu değiştirir; tablo boş olmalı.)
DELETE FROM "RolePermission";

-- 2) Firma kodu tam 3 büyük harf (karar: tüm sistem 3 harfli). Eski kodlar dönüştürülür:
--    harf olmayanlar atılır, ilk 3 harf alınır (eksikse X ile tamamlanır). Çakışırsa üçüncü, sonra ikinci harf
--    A–Z denenir. Firmanın siparişlerinin numarası da yeni koda göre güncellenir (MIRELA12 → MIR12).
DO $$
DECLARE
  f RECORD;
  base TEXT;
  cand TEXT;
  i INT;
  j INT;
  found BOOLEAN;
  letters CONSTANT TEXT := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
BEGIN
  FOR f IN
    SELECT id, prefix FROM "Customer"
    WHERE prefix IS NOT NULL AND prefix !~ '^[A-Z]{3}$'
    ORDER BY "createdAt"
  LOOP
    base := rpad(left(upper(regexp_replace(translate(f.prefix, 'çğıöşüÇĞİÖŞÜăâîșțĂÂÎȘȚ', 'cgiosuCGIOSUaaistAAIST'), '[^A-Za-z]', '', 'g')), 3), 3, 'X');
    cand := base;
    found := NOT EXISTS (SELECT 1 FROM "Customer" WHERE prefix = cand AND id <> f.id);
    i := 1;
    WHILE NOT found AND i <= 26 LOOP
      cand := left(base, 2) || substr(letters, i, 1);
      found := NOT EXISTS (SELECT 1 FROM "Customer" WHERE prefix = cand AND id <> f.id);
      i := i + 1;
    END LOOP;
    j := 1;
    WHILE NOT found AND j <= 26 LOOP
      i := 1;
      WHILE NOT found AND i <= 26 LOOP
        cand := left(base, 1) || substr(letters, j, 1) || substr(letters, i, 1);
        found := NOT EXISTS (SELECT 1 FROM "Customer" WHERE prefix = cand AND id <> f.id);
        i := i + 1;
      END LOOP;
      j := j + 1;
    END LOOP;
    IF NOT found THEN
      RAISE EXCEPTION 'Firma % için boş 3 harfli kod bulunamadı', f.id;
    END IF;

    UPDATE "Order" SET "orderNo" = cand || "customerOrderNo"
      WHERE "customerId" = f.id AND "orderNo" = f.prefix || "customerOrderNo";
    UPDATE "Customer" SET prefix = cand WHERE id = f.id;
    RAISE NOTICE 'Firma kodu % → %', f.prefix, cand;
  END LOOP;
END $$;

ALTER TABLE "Customer" DROP CONSTRAINT IF EXISTS "Customer_prefix_3_letters";
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_prefix_3_letters" CHECK (prefix IS NULL OR prefix ~ '^[A-Z]{3}$');
