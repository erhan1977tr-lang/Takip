# 0011 — Ortam değişkenleri ve doğrulama

**Durum:** Kabul · 29.09.2026

## Karar
- Tüm ortam değişkenleri tek dosyada tanımlanır: `server/env.js` (ad, tür, zorunluluk, varsayılan, açıklama).
  Uygulama kodu (`app`, `lib`, `server`, `components`) `process.env`'i doğrudan okumaz (NODE_ENV gibi çatı değişkenleri hariç);
  `getEnv()` kullanır. Birim test bunu denetler.
- Sunucu açılırken (`instrumentation.ts`) ortam doğrulanır; zorunlu değer eksik ya da geçersizse sunucu açılmaz ve
  eksikleri tek seferde listeler. Uyarılar (ör. SMTP tanımsız) günlüğe yazılır ama açılışı durdurmaz.
- `npm run env:check` aynı doğrulamayı komut satırında yapar; CI ve kurulum betiği bunu çalıştırır.
- `.env.example` tüm değişkenleri açıklamalarıyla içerir; birim test, tanımdaki her değişkenin örnek dosyada
  olduğunu kontrol eder.
- Sırlar (AUTH_SECRET, POSTGRES_PASSWORD, SMTP_PASS) yalnızca sunucudaki `.env` dosyasında durur; git'e, koda ya da
  sohbete yazılmaz. Doğrulama çıktısı sır değerlerini asla yazdırmaz.
