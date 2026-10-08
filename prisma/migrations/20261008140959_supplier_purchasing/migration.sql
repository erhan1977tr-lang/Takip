-- Paket 6 (kararlar 179–184): tedarikçiler, ürünlerin alış bilgisi, tedarikçi siparişleri (revizyon, satır, teknik ek),
-- tedarikçi ödemeleri ve yeni yetki. Elle yazıldı (tabloları ve kesinleşmiş revizyonun değişmezliğini aynı adımda kurmak
-- için); tablolar Prisma'nın üreteceği biçimdedir, tetikleyiciler Prisma şema farkına girmez.

-- AlterEnum
ALTER TYPE "PermissionKey" ADD VALUE 'SUPPLIER_MANAGE';

-- CreateEnum
CREATE TYPE "SupplierOrderStatus" AS ENUM ('TASLAK', 'GONDERIM_BEKLIYOR', 'GONDERILDI', 'GONDERIM_HATASI', 'TESLIM_ALINDI', 'IPTAL');

-- AlterTable
ALTER TABLE "ProfileProduct" ADD COLUMN     "purchaseCurrency" TEXT,
ADD COLUMN     "purchasePrice" DECIMAL(12,4),
ADD COLUMN     "purchaseUnit" TEXT,
ADD COLUMN     "supplierId" TEXT;

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "currency" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierOrder" (
    "id" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "SupplierOrderStatus" NOT NULL DEFAULT 'TASLAK',
    "etaDate" DATE,
    "sentAt" TIMESTAMP(3),
    "sendError" TEXT,
    "receivedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierOrderRevision" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "orderDate" DATE NOT NULL,
    "note" TEXT,
    "total" DECIMAL(14,2),
    "missingPrice" BOOLEAN NOT NULL DEFAULT false,
    "finalizedAt" TIMESTAMP(3),
    "finalizedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierOrderRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierOrderLine" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "color" TEXT,
    "qty" INTEGER NOT NULL,
    "unitCode" TEXT NOT NULL,
    "unitPrice" DECIMAL(12,4),
    "priceSource" TEXT,
    "lineTotal" DECIMAL(14,2),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SupplierOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierOrderFile" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mime" TEXT,
    "checksum" TEXT,
    "scanStatus" "FileScanStatus" NOT NULL DEFAULT 'PENDING',
    "scanSignature" TEXT,
    "scannedAt" TIMESTAMP(3),
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierOrderFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierPayment" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "paidOn" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "note" TEXT,
    "requestKey" TEXT NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Supplier_isActive_name_idx" ON "Supplier"("isActive", "name");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierOrder_orderNo_key" ON "SupplierOrder"("orderNo");

-- CreateIndex
CREATE INDEX "SupplierOrder_supplierId_status_idx" ON "SupplierOrder"("supplierId", "status");

-- CreateIndex
CREATE INDEX "SupplierOrder_status_etaDate_idx" ON "SupplierOrder"("status", "etaDate");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierOrderRevision_orderId_revision_key" ON "SupplierOrderRevision"("orderId", "revision");

-- CreateIndex
CREATE INDEX "SupplierOrderLine_revisionId_sortOrder_idx" ON "SupplierOrderLine"("revisionId", "sortOrder");

-- CreateIndex
CREATE INDEX "SupplierOrderLine_productId_idx" ON "SupplierOrderLine"("productId");

-- CreateIndex
CREATE INDEX "SupplierOrderFile_revisionId_idx" ON "SupplierOrderFile"("revisionId");

-- CreateIndex
CREATE INDEX "SupplierOrderFile_scanStatus_idx" ON "SupplierOrderFile"("scanStatus");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPayment_requestKey_key" ON "SupplierPayment"("requestKey");

-- CreateIndex
CREATE INDEX "SupplierPayment_supplierId_paidOn_idx" ON "SupplierPayment"("supplierId", "paidOn");

-- AddForeignKey
ALTER TABLE "ProfileProduct" ADD CONSTRAINT "ProfileProduct_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierOrder" ADD CONSTRAINT "SupplierOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierOrderRevision" ADD CONSTRAINT "SupplierOrderRevision_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "SupplierOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierOrderLine" ADD CONSTRAINT "SupplierOrderLine_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "SupplierOrderRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierOrderLine" ADD CONSTRAINT "SupplierOrderLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ProfileProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierOrderFile" ADD CONSTRAINT "SupplierOrderFile_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "SupplierOrderRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------------
-- Kesinleşmiş revizyon değişmez (karar 181): "Siparişi onayla / gönder" revizyonu kesinleştirir (finalizedAt). Ondan sonra
-- revizyonun kendisi, satırları ve ekleri değiştirilemez / silinemez; değişiklik ancak YENİ revizyonla (açıkça onaylanıp
-- yeniden gönderilir) yapılır. Bir siparişte aynı anda tek taslak revizyon olur. Tek istisna denetim kaydıyla aynı bakım
-- anahtarıdır (SET LOCAL takip.audit_maintenance = 'on' — yalnızca test veritabanı temizliği; uygulama kodu kullanmaz).
-- Ekte yalnızca arka plan antivirüs taramasının sonucu (scanStatus, scanSignature, scannedAt) yazılabilir.

CREATE OR REPLACE FUNCTION takip_supplier_revision_guard() RETURNS trigger AS $$
BEGIN
  IF current_setting('takip.audit_maintenance', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."finalizedAt" IS NULL AND EXISTS (
      SELECT 1 FROM "SupplierOrderRevision" r WHERE r."orderId" = NEW."orderId" AND r."finalizedAt" IS NULL
    ) THEN
      RAISE EXCEPTION 'SupplierOrderRevision: an order can have only one draft revision' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."finalizedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'SupplierOrderRevision is final: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "SupplierOrderRevision_guard" ON "SupplierOrderRevision";
CREATE TRIGGER "SupplierOrderRevision_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "SupplierOrderRevision"
  FOR EACH ROW EXECUTE FUNCTION takip_supplier_revision_guard();

-- Satır ve ekin sahibi revizyon kesinse: satır eklenemez, değiştirilemez, silinemez
CREATE OR REPLACE FUNCTION takip_supplier_line_guard() RETURNS trigger AS $$
BEGIN
  IF current_setting('takip.audit_maintenance', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM "SupplierOrderRevision" r WHERE r."id" = OLD."revisionId" AND r."finalizedAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'SupplierOrderLine belongs to a final revision: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "SupplierOrderRevision" r WHERE r."id" = NEW."revisionId" AND r."finalizedAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'SupplierOrderLine belongs to a final revision: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "SupplierOrderLine_guard" ON "SupplierOrderLine";
CREATE TRIGGER "SupplierOrderLine_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "SupplierOrderLine"
  FOR EACH ROW EXECUTE FUNCTION takip_supplier_line_guard();

-- Ekte yalnızca tarama sonucu (scanStatus, scanSignature, scannedAt) değişebilir: arka plan taraması kesin revizyonun ekini
-- de işaretleyebilir; ad, dosya, boyut, tür, özet, yükleyen ve revizyon değişmez
CREATE OR REPLACE FUNCTION takip_supplier_file_guard() RETURNS trigger AS $$
BEGIN
  IF current_setting('takip.audit_maintenance', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."revisionId" = OLD."revisionId" AND NEW."name" = OLD."name" AND NEW."storageKey" = OLD."storageKey"
      AND NEW."size" = OLD."size" AND NEW."mime" IS NOT DISTINCT FROM OLD."mime" AND NEW."checksum" IS NOT DISTINCT FROM OLD."checksum"
      AND NEW."uploadedById" IS NOT DISTINCT FROM OLD."uploadedById" AND NEW."createdAt" = OLD."createdAt" THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM "SupplierOrderRevision" r WHERE r."id" = OLD."revisionId" AND r."finalizedAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'SupplierOrderFile belongs to a final revision: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "SupplierOrderRevision" r WHERE r."id" = NEW."revisionId" AND r."finalizedAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'SupplierOrderFile belongs to a final revision: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "SupplierOrderFile_guard" ON "SupplierOrderFile";
CREATE TRIGGER "SupplierOrderFile_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "SupplierOrderFile"
  FOR EACH ROW EXECUTE FUNCTION takip_supplier_file_guard();
