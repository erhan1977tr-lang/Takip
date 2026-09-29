# 0004 — Veritabanı, migration ve seed stratejisi

**Durum:** Kabul · 29.09.2026

## Migration
- Kaynak `prisma/schema.prisma`. Çalışma dallarında CI, şemadan farkı bulup migration'ı üretir ve depoya geri yazar;
  `main` dalında migration üretilmez, yalnızca uygulanır.
- Prisma'nın ifade edemediği SQL (tetikleyici, kontrol kısıtı, kısmi indeks) elle yazılmış, tarihli ayrı bir migration
  klasörüne konur (ör. `..._audit_append_only`). Bu nesneler şema farkında görünmez.
- Sunucuda yalnızca `prisma migrate deploy` çalışır; `db push` üretimde kullanılmaz.
- Migration geri alınmaz; hata yeni bir migration ile düzeltilir. Her kurulumdan önce yedek alınır (Aşama 10).

## Seed
İki katman:
1. **Temel veri** (`prisma/seed/base.mjs`, `npm run db:seed`): her ortamda gerekli, tekrar çalıştırılabilir (idempotent)
   veriler. Adımlar `prisma/seed/steps/` altında; her adım yalnızca mevcut şemanın desteklediği tabloları doldurur.
   Veri dosyaları `prisma/seed/data/` altında (rol-yetki matrisi, sipariş tipleri, profil kataloğu, birimler).
   Tablosu henüz olmayan veri (ör. profil kataloğu) dosyada hazır bekler; ilgili aşama kendi adımını ekler.
2. **Demo verisi** (`scripts/demo/seed.mjs`): yalnızca `DEMO_MODE=1` iken, temel verinin üstüne örnek firmalar,
   hesaplar ve siparişler.

Kural: iş verisi (profil ürünleri, birimler...) ön yüz koduna gömülmez; seed ile gelir ve yönetici ekranından değişir.
