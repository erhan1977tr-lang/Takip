-- Yükleme onayı yalnızca eklenir (karar 92): onaylanmış yükleme bir muhasebe / lojistik olayıdır.
-- "LoadingConfirmation" ve "LoadingConfirmationItem" satırlarında UPDATE, DELETE ve TRUNCATE engellenir; INSERT serbesttir
-- (ileride kırık cam / düzeltme iş akışları kayıt EKLEYEREK çalışır, var olanı değiştirerek değil).
-- Tek istisna, denetim kaydıyla aynı bakım anahtarı: aynı işlemde  SET LOCAL takip.audit_maintenance = 'on'
-- (yalnızca test veritabanı temizliği için; uygulama kodu kullanmaz).
-- Prisma şema farkı tetikleyicileri görmez; bu dosya elle yazılmıştır ve tabloları oluşturan 20261003043620_ci'den sonra çalışır.

CREATE OR REPLACE FUNCTION takip_loading_confirmation_append_only() RETURNS trigger AS $$
BEGIN
  IF current_setting('takip.audit_maintenance', true) = 'on' THEN
    IF TG_LEVEL = 'STATEMENT' THEN RETURN NULL; END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only (confirmed loading): % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "LoadingConfirmation_append_only_row" ON "LoadingConfirmation";
CREATE TRIGGER "LoadingConfirmation_append_only_row"
  BEFORE UPDATE OR DELETE ON "LoadingConfirmation"
  FOR EACH ROW EXECUTE FUNCTION takip_loading_confirmation_append_only();

DROP TRIGGER IF EXISTS "LoadingConfirmation_append_only_truncate" ON "LoadingConfirmation";
CREATE TRIGGER "LoadingConfirmation_append_only_truncate"
  BEFORE TRUNCATE ON "LoadingConfirmation"
  FOR EACH STATEMENT EXECUTE FUNCTION takip_loading_confirmation_append_only();

DROP TRIGGER IF EXISTS "LoadingConfirmationItem_append_only_row" ON "LoadingConfirmationItem";
CREATE TRIGGER "LoadingConfirmationItem_append_only_row"
  BEFORE UPDATE OR DELETE ON "LoadingConfirmationItem"
  FOR EACH ROW EXECUTE FUNCTION takip_loading_confirmation_append_only();

DROP TRIGGER IF EXISTS "LoadingConfirmationItem_append_only_truncate" ON "LoadingConfirmationItem";
CREATE TRIGGER "LoadingConfirmationItem_append_only_truncate"
  BEFORE TRUNCATE ON "LoadingConfirmationItem"
  FOR EACH STATEMENT EXECUTE FUNCTION takip_loading_confirmation_append_only();
