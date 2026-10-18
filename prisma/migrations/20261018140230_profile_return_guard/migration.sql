-- Profil iadesi kayıtları değişmez (DÜZELTME 10 Aşama 2D, karar 296). Bakım (veritabanı sıfırlama / yedekten dönüş)
-- takip.audit_maintenance = 'on' ile (ManualPayment / CreditOffset ile aynı).
--  * BlockedStockMovement: yalnızca eklenir (UPDATE / DELETE yok).
--  * ProfileReturnLine: silinmez; satırın kendisi değişmez; depo teslimi sağlam / hasarlı miktarı boştan doluya BİR KEZ yazar.
--  * ProfileReturn: silinmez; açılış verisi (sipariş, sıra, gerekçe, tutar, fiyat / kur kopyası, mali niyet, fotoğraflar,
--    form anahtarı, açan) değişmez; durum yalnızca ACIK → TESLIM_ALINDI | IPTAL; kapandıktan sonra teslim / iptal alanları
--    değişmez; gerçek para iadesi (tarih + referans + işaretleyen) boştan doluya bir kez; depo bağlantısı özeti yalnızca açıkken
--    değişir ya da kapanışta silinir.
CREATE OR REPLACE FUNCTION takip_profile_return_guard() RETURNS trigger AS $$
BEGIN
  IF current_setting('takip.audit_maintenance', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is immutable: DELETE is not allowed', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_TABLE_NAME = 'BlockedStockMovement' THEN
    RAISE EXCEPTION 'BlockedStockMovement is append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_TABLE_NAME = 'ProfileReturnLine' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."returnId" IS DISTINCT FROM OLD."returnId"
       OR NEW."offerLineId" IS DISTINCT FROM OLD."offerLineId" OR NEW."productId" IS DISTINCT FROM OLD."productId"
       OR NEW."code" IS DISTINCT FROM OLD."code" OR NEW."nameRo" IS DISTINCT FROM OLD."nameRo" OR NEW."nameTr" IS DISTINCT FROM OLD."nameTr"
       OR NEW."unitCode" IS DISTINCT FROM OLD."unitCode" OR NEW."qty" IS DISTINCT FROM OLD."qty"
       OR NEW."unitPrice" IS DISTINCT FROM OLD."unitPrice" OR NEW."lineTotal" IS DISTINCT FROM OLD."lineTotal"
       OR NEW."sortOrder" IS DISTINCT FROM OLD."sortOrder"
    THEN
      RAISE EXCEPTION 'ProfileReturnLine is immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF (NEW."goodQty" IS DISTINCT FROM OLD."goodQty" OR NEW."damagedQty" IS DISTINCT FROM OLD."damagedQty")
       AND (OLD."goodQty" IS NOT NULL OR OLD."damagedQty" IS NOT NULL OR NEW."goodQty" IS NULL OR NEW."damagedQty" IS NULL)
    THEN
      RAISE EXCEPTION 'ProfileReturnLine: receipt quantities are written once' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  -- ProfileReturn
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."orderId" IS DISTINCT FROM OLD."orderId" OR NEW."seq" IS DISTINCT FROM OLD."seq"
     OR NEW."reason" IS DISTINCT FROM OLD."reason" OR NEW."note" IS DISTINCT FROM OLD."note"
     OR NEW."currency" IS DISTINCT FROM OLD."currency" OR NEW."fxRate" IS DISTINCT FROM OLD."fxRate"
     OR NEW."amount" IS DISTINCT FROM OLD."amount" OR NEW."invoiced" IS DISTINCT FROM OLD."invoiced" OR NEW."paid" IS DISTINCT FROM OLD."paid"
     OR NEW."financeAction" IS DISTINCT FROM OLD."financeAction" OR NEW."photoFileIds"::text IS DISTINCT FROM OLD."photoFileIds"::text
     OR NEW."requestKey" IS DISTINCT FROM OLD."requestKey" OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'ProfileReturn is immutable: opening data may not change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF OLD."status" <> 'ACIK' OR NEW."status" NOT IN ('TESLIM_ALINDI', 'IPTAL') THEN
      RAISE EXCEPTION 'ProfileReturn: only ACIK may be closed, once' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW."status" = 'TESLIM_ALINDI' AND (NEW."receivedAt" IS NULL OR NEW."receivedVia" IS NULL) THEN
      RAISE EXCEPTION 'ProfileReturn: receipt needs time and channel' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW."status" = 'IPTAL' AND (NEW."cancelledAt" IS NULL OR NEW."cancelReason" IS NULL) THEN
      RAISE EXCEPTION 'ProfileReturn: cancel needs time and reason' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt" OR NEW."receivedVia" IS DISTINCT FROM OLD."receivedVia"
     OR NEW."receivedById" IS DISTINCT FROM OLD."receivedById" OR NEW."receivedNote" IS DISTINCT FROM OLD."receivedNote"
     OR NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt" OR NEW."cancelReason" IS DISTINCT FROM OLD."cancelReason"
  THEN
    RAISE EXCEPTION 'ProfileReturn: receipt / cancel data may only be written when closing' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW."refundDoneAt" IS DISTINCT FROM OLD."refundDoneAt" OR NEW."refundReference" IS DISTINCT FROM OLD."refundReference"
      OR NEW."refundById" IS DISTINCT FROM OLD."refundById")
     AND (OLD."refundDoneAt" IS NOT NULL OR NEW."refundDoneAt" IS NULL OR NEW."refundReference" IS NULL)
  THEN
    RAISE EXCEPTION 'ProfileReturn: the refund mark is written once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW."depotTokenHash" IS DISTINCT FROM OLD."depotTokenHash" OR NEW."depotTokenExpiresAt" IS DISTINCT FROM OLD."depotTokenExpiresAt")
     AND OLD."status" <> 'ACIK'
  THEN
    RAISE EXCEPTION 'ProfileReturn: the depot link changes only while open' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."status" <> 'ACIK' AND (NEW."depotTokenHash" IS NOT NULL OR NEW."depotTokenExpiresAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'ProfileReturn: a closed return has no depot link' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "ProfileReturn_guard" ON "ProfileReturn";
CREATE TRIGGER "ProfileReturn_guard" BEFORE UPDATE OR DELETE ON "ProfileReturn" FOR EACH ROW EXECUTE FUNCTION takip_profile_return_guard();
DROP TRIGGER IF EXISTS "ProfileReturnLine_guard" ON "ProfileReturnLine";
CREATE TRIGGER "ProfileReturnLine_guard" BEFORE UPDATE OR DELETE ON "ProfileReturnLine" FOR EACH ROW EXECUTE FUNCTION takip_profile_return_guard();
DROP TRIGGER IF EXISTS "BlockedStockMovement_guard" ON "BlockedStockMovement";
CREATE TRIGGER "BlockedStockMovement_guard" BEFORE UPDATE OR DELETE ON "BlockedStockMovement" FOR EACH ROW EXECUTE FUNCTION takip_profile_return_guard();
