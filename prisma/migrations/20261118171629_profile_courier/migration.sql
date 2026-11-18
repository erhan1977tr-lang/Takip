-- 4.2.24 (karar 324): profil siparişinde "Kurye ile gönderim". Yalnızca yeni sütun; mevcut siparişler false (değişmez).
ALTER TABLE "ProfileOrder" ADD COLUMN "courier" BOOLEAN NOT NULL DEFAULT false;
