-- TAKİP içi mahsup kaydı değişmez (DÜZELTME 10 Aşama 2C, karar 295): silinemez; tutar / kaynak / hedef / kimlik alanları
-- değişemez. İzin verilen tek değişiklik: bir kez kapatma — status ACTIVE → REVERSED | FGO_RECORDED ile closedAt /
-- closedById / closeReason boştan doluya; FGO_RECORDED'da fgoRef (muhasebecinin beyan ettiği FGO referansı) zorunlu,
-- REVERSED'da boş. Kapalı kayıt yeniden açılamaz ve ikinci kez kapatılamaz.
-- Bakım (veritabanı sıfırlama / yedekten dönüş) takip.audit_maintenance = 'on' ile (ManualPayment ile aynı).
CREATE OR REPLACE FUNCTION takip_credit_offset_guard() RETURNS trigger AS $$
BEGIN
  IF current_setting('takip.audit_maintenance', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CreditOffset is immutable: DELETE is not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."customerId" IS DISTINCT FROM OLD."customerId"
     OR NEW."sourceChain" IS DISTINCT FROM OLD."sourceChain"
     OR NEW."sourceOrderId" IS DISTINCT FROM OLD."sourceOrderId"
     OR NEW."sourceRef" IS DISTINCT FROM OLD."sourceRef"
     OR NEW."targetChain" IS DISTINCT FROM OLD."targetChain"
     OR NEW."targetOrderId" IS DISTINCT FROM OLD."targetOrderId"
     OR NEW."targetRef" IS DISTINCT FROM OLD."targetRef"
     OR NEW."amountRon" IS DISTINCT FROM OLD."amountRon"
     OR NEW."note" IS DISTINCT FROM OLD."note"
     OR NEW."requestKey" IS DISTINCT FROM OLD."requestKey"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'CreditOffset is immutable: only a one-time close may change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status"
     OR NEW."closedAt" IS DISTINCT FROM OLD."closedAt"
     OR NEW."closedById" IS DISTINCT FROM OLD."closedById"
     OR NEW."closeReason" IS DISTINCT FROM OLD."closeReason"
     OR NEW."fgoRef" IS DISTINCT FROM OLD."fgoRef"
  THEN
    IF OLD."status" <> 'ACTIVE' OR NEW."status" NOT IN ('REVERSED', 'FGO_RECORDED')
       OR NEW."closedAt" IS NULL OR NEW."closedById" IS NULL OR NEW."closeReason" IS NULL
       OR (NEW."status" = 'FGO_RECORDED' AND NEW."fgoRef" IS NULL)
       OR (NEW."status" = 'REVERSED' AND NEW."fgoRef" IS NOT NULL)
    THEN
      RAISE EXCEPTION 'CreditOffset is immutable: only ACTIVE may be closed once' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "CreditOffset_guard" ON "CreditOffset";
CREATE TRIGGER "CreditOffset_guard"
  BEFORE UPDATE OR DELETE ON "CreditOffset"
  FOR EACH ROW EXECUTE FUNCTION takip_credit_offset_guard();
