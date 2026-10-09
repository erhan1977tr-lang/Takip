-- Profil hesaplayıcısı (karar 203): sistemin türü (korkuluk profili / küpeşte — müşteri ikisini ayrı seçer) ve cam
-- kalınlığının müşteriye görünen adı ("6+6"). Elle yazıldı (Prisma biçiminde); mevcut kayıtlara dokunulmaz (ikisi de boş başlar).

-- CreateEnum
CREATE TYPE "ProfileSystemKind" AS ENUM ('PROFILE', 'HANDRAIL');

-- AlterTable
ALTER TABLE "ProfileGlassThickness" ADD COLUMN "label" TEXT;

-- AlterTable
ALTER TABLE "ProfileSystem" ADD COLUMN "kind" "ProfileSystemKind";
