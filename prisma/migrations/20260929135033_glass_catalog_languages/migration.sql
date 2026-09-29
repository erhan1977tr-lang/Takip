-- Cam kataloğu: Türkçe / Romence ad (karar 20). Mevcut "name" Türkçe ad olur; Romence ad başlangıçta aynı yazılır
-- (yönetici Excel'le ya da sayfadan düzeltir). Diğer sütunlar CI'nin ürettiği migration'da eklenir.
ALTER TABLE "GlassProduct" RENAME COLUMN "name" TO "nameTr";
ALTER TABLE "GlassProduct" ADD COLUMN "nameRo" TEXT;
UPDATE "GlassProduct" SET "nameRo" = "nameTr";
ALTER TABLE "GlassProduct" ALTER COLUMN "nameRo" SET NOT NULL;
