# 0008 — Test stratejisi

**Durum:** Kabul · 29.09.2026

| Katman | Araç | Komut | Ne test edilir |
|--------|------|-------|----------------|
| Birim | `node --test` | `npm test` | Saf kurallar (`server/**`): durumlar, maskeleme, hesaplar, i18n anahtarları, akış tanımı |
| Veritabanı | `node --test` + gerçek PostgreSQL | `npm run test:db` | Kısıtlar, tetikleyiciler (denetim), seed tekrarlanabilirliği, eşzamanlı numara üretimi |
| Uçtan uca | Playwright | `npm run e2e` | Rollerin gerçek tarayıcıda akışı, ekran görüntüleri, sızıntı testi |
| Statik | ESLint + TypeScript | `npm run lint`, `npm run typecheck` | Kod kalitesi ve tip hataları |

- Veritabanı testleri ayrı bir veritabanında çalışır (`TEST_DATABASE_URL`); tanımlı değilse atlanır ve bunu yazar.
  Her test dosyası tabloları temizleyerek başlar.
- CI sırası: sürüm kontrolü → kurulum → ortam kontrolü → migration → lint → tip → birim → veritabanı → derleme →
  uçtan uca → demo → Docker. Herhangi biri kırmızıysa sürüm yayımlanmaz.
- Tanım §30'daki kabul testlerinin her biri, ilgili aşamada bir teste bağlanır.
