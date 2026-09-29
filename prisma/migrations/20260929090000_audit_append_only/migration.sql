-- Denetim kaydı yalnızca eklenir (ADR 0005).
-- UPDATE, DELETE ve TRUNCATE engellenir. Tek istisna: aynı oturumda
--   SET takip.audit_maintenance = 'on'
-- (yalnızca test veritabanı temizliği ve yasal zorunlu silme için; uygulama kodu kullanmaz).
-- Prisma şema farkı tetikleyicileri görmez; bu dosya elle yazılmıştır.

CREATE OR REPLACE FUNCTION takip_audit_log_append_only() RETURNS trigger AS $$
BEGIN
  IF current_setting('takip.audit_maintenance', true) = 'on' THEN
    IF TG_LEVEL = 'STATEMENT' THEN RETURN NULL; END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'AuditLog is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "AuditLog_append_only_row" ON "AuditLog";
CREATE TRIGGER "AuditLog_append_only_row"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION takip_audit_log_append_only();

DROP TRIGGER IF EXISTS "AuditLog_append_only_truncate" ON "AuditLog";
CREATE TRIGGER "AuditLog_append_only_truncate"
  BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION takip_audit_log_append_only();
