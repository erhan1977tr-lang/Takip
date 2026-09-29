-- AlterEnum
ALTER TYPE "AppRole" ADD VALUE 'DENETIMCI';

-- AlterEnum
BEGIN;
CREATE TYPE "PermissionKey_new" AS ENUM ('ORDER_VIEW', 'ORDER_CREATE', 'ORDER_REVIEW', 'ORDER_CANCEL', 'DRAWING_WORK', 'DRAWING_APPROVE', 'OFFER_VIEW', 'OFFER_DRAFT_VIEW', 'OFFER_PREPARE', 'OFFER_SEND', 'PRICE_FINAL_VIEW', 'SHIPMENT_VIEW', 'FILE_UPLOAD', 'FILE_INTERNAL_VIEW', 'NOTE_ADD', 'NOTE_INTERNAL_VIEW', 'CUSTOMER_NAME_VIEW', 'USER_MANAGE', 'CUSTOMER_MANAGE', 'CATALOG_MANAGE', 'SETTINGS_MANAGE', 'AUDIT_VIEW');
ALTER TABLE "RolePermission" ALTER COLUMN "key" TYPE "PermissionKey_new" USING ("key"::text::"PermissionKey_new");
ALTER TYPE "PermissionKey" RENAME TO "PermissionKey_old";
ALTER TYPE "PermissionKey_new" RENAME TO "PermissionKey";
DROP TYPE "public"."PermissionKey_old";
COMMIT;

-- CreateTable
CREATE TABLE "AuthFailure" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthFailure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuthFailure_email_createdAt_idx" ON "AuthFailure"("email", "createdAt");

-- CreateIndex
CREATE INDEX "AuthFailure_ip_createdAt_idx" ON "AuthFailure"("ip", "createdAt");

