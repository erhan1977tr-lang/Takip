# 0001 — Mevcut kod tabanı üzerinde aşamalı yeniden yapılanma

**Durum:** Kabul · 29.09.2026

## Bağlam
Tanım (`docs/spec`) kaybolan GKH Digital portalının yeniden kurulmasını ister. Bu depoda cam siparişi
akışının büyük bölümü (3.1.x) zaten çalışıyor, testli ve sunucuya kurulabilir durumda.

## Karar
- Yığın korunur: Next.js 15 (App Router, server actions), Prisma 6, PostgreSQL 17, Node ≥ 20.9, Docker + Caddy.
- Sıfırdan yazılmaz. Her aşama mevcut kodu tanıma ve `docs/decisions.md` kararlarına göre sağlamlaştırır,
  eksikleri ekler. Çalışan davranış ancak bir karar gerektiriyorsa değişir.
- Saf iş kuralları `server/**/*.js` içinde düz ESM olarak durur (Next'e bağımlı değil, `node --test` ile test edilir).
  Next'e bağlı kod `lib/` ve `app/` altında.
- Adresler ortak kalır (karar 6); rol, sayfanın ne gösterdiğini belirler.

## Sonuçlar
- Kullanıcılar arayüzü tanımaya devam eder; veri kaybı olmadan geçiş yapılır.
- Tanımdaki tablo adları (`companies`, `quotes`...) birebir kopyalanmaz; mevcut modeller (`Customer`, `Offer`...)
  genişletilir. Ad eşleşmesi ilgili aşamada ADR'ye yazılır.
