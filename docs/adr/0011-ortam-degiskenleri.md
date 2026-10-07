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

## Güncelleme (3.50.22, karar 151 — güvenlik denetimi 3.50.9 AUD-13)

**Sorun.** Dört test / geliştirme ayarı (`DEMO_MODE`, `MAIL_OUTBOX_DIR`, `TRANSLATE_FAKE`, `COOKIE_SECURE=false`) üretimde
hata değil yalnızca açılış günlüğünde bir uyarıydı; `DEMO_MODE=1` öteki uyarıları susturuyor, kendisi hiç uyarı
üretmiyordu; işçi ortamı hiç doğrulamıyor ve e-posta klasörünü ham `process.env`'den okuyordu. Sunucudaki `.env`'de
kalmış / yanlışlıkla kopyalanmış tek satır üretimi sessizce zayıflatabiliyordu: e-postalar gönderilmeyip diske yazılır
(kayıtlar "gönderildi" olur), çerez `Secure` olmaz, notlara sahte çeviri yazılır, giriş sayfasında demo kutusu ve
yöneticiye demo posta kutusu (davet / şifre kodları) açılır. Bu ayarlar hata yapılamıyordu çünkü tek ölçüt
`NODE_ENV=production` idi ve CI'daki uçtan uca testler ile demo ortamı da üretim derlemesini bu ayarlarla çalıştırıyor.

**Karar.**
- **Gerçek sunucu işareti:** `TAKIP_DEPLOYMENT`. Yalnızca `deploy/docker-compose.yml` verir — `app`, `worker`, `tools`
  servislerinin `environment:` bloğunda SABİT değer (`server`). Compose'da `environment`, `env_file`'dan önce gelir:
  sunucudaki `.env` bu değeri ezemez, boşaltamaz. Boş olmayan HER değer "gerçek sunucu"dur (tanınmayan değer ayrıca
  hatadır) — işareti "kapatan" bir değer yoktur. İmaj, kurulumun ürettiği `.env`, sunucu aracı, CI'nın genel ortamı ve
  demo kurulumu işareti vermez. İşaret yalnızca komut satırı seçeneğiyle bilerek kaldırılabilir
  (`docker compose run -e TAKIP_DEPLOYMENT= …` — kurulum testinin kullandığı yol; `.env` ile yapılamaz).
- **Etkisizleştirme (uygulama kapanmaz):** işaret varken dört ayar — ne yazılmış olursa olsun, geçersiz değer dahil —
  okunmadan önce kaynaktan çıkarılır ve güvenli değerler zorlanır: demo kapalı, e-posta klasörü yok (gerçek SMTP), sahte
  çeviri kapalı (gerçek sağlayıcı), çerezler `Secure`. `NODE_ENV` ölçüt değildir. Zorunlu / bozuk değerler eskisi gibi
  hatadır.
- **Tek kural, iki süreç:** uygulama (`instrumentation.ts`) ve işçi (`scripts/worker.mjs`) aynı açılış denetimini
  kullanır (`startupEnv`). İşçi hatalı ortamda BAŞLAMAZ (veritabanına bağlanmadan çıkar) ve bu ayarları yalnızca
  doğrulanmış değerlerden (`getEnv`) okur.
- **Görünürlük:** açılış günlüğünde (uygulama ve işçi) "GÜVENLİK UYARISI — … YOK SAYILDI" başlığı altında ayarların
  ADLARI; Yönetici → Entegrasyonlar'da "Ortam uyarıları" kartı (uyarı yoksa çizilmez). Hiçbir yerde değer, yol ya da sır
  yazılmaz. İşaretsiz üretim derlemesinde (CI / demo) açık olan ayarlar günlüğe yazılır; `DEMO_MODE` artık hiçbir
  uyarıyı susturmaz ve kendisi de yazılır.
- **Demo verisi betiği** (`scripts/demo/seed.mjs`) tek ayara güvenmez (`server/demo/guard.js`): gerçek sunucu işareti
  varsa `DEMO_MODE=1` olsa da çalışmaz; ilk yükleme yalnızca BOŞ veritabanına yapılır (demo dışı kullanıcı ya da sipariş
  varsa reddedilir). İki koşul da yazmadan önce denetlenir.

**Sonuçlar.**
- CI'daki uçtan uca testler, demo adımı ve Codespaces demosu (işaret yok) bu ayarları eskisi gibi kullanır.
- Sunucudaki `.env`'e bu ayarlardan biri yazılırsa site çalışmaya devam eder, ayar etkisizdir ve yönetici ekranında
  görünür; satır `.env`'den kaldırılınca kart kaybolur.
- Kurulum testi (`deploy/test/worker-nonroot.sh`) e-posta turunu, işaretin komut satırından kaldırıldığı tek seferlik
  bir işçi kapsayıcısında atar; `deploy/test/env-marker.sh` işaretin `.env`'den ezilemediğini gerçek Compose ile dener.
