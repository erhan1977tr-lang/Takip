# 0007 — Arayüz dilleri: Romence ve Türkçe

**Durum:** Kabul · 28.09.2026 (3.1.0)

## Karar
- Diller: `ro` (varsayılan) ve `tr`. İngilizce arayüz yok (karar 9).
- Metinler `server/i18n/{ro,tr}/<alan>.js` dosyalarında; iki dilin anahtarları birebir aynı olmak zorunda (birim test).
- Giriş sayfasının dili: çerez → IP ülkesi (TR → tr, RO/MD → ro; RIPE NCC aralıkları `server/geo/ranges.js`) →
  tarayıcı dili → `ro`. Dil düğmeleri her zaman ekranda; seçim kullanıcı kaydına yazılır ve panelde devam eder.
- İş kuralları metin değil kod döndürür; çeviri yalnızca gösterim katmanında yapılır.
- Kullanıcı notları çevrilmez; otomatik not çevirisi Aşama 8'de sağlayıcı soyutlamasıyla eklenir.
