# Takip — Sipariş ve Üretim Portalı

Cam sipariş akışı için web uygulaması:

1. Müşteri siparişi ve dosyasını gönderir.
2. Satış dosyayı kontrol eder: **Çizim Ekibine Gönder**, **Teklife Gönder** ya da **Beklemeye Al**.
3. İki hat bağımsız yürür:
   - **Çizim:** çizimci çizer → müşteri onaylar ya da revizyon ister (müşterinin tek onayı budur)
   - **Teklif:** satış yazar → sistem yöneticisi fiyatı onaylar → teklif müşterinin panelinde görünür (müşteri onaylamaz)
4. Çizim onaylı (ya da gereksiz) ve teklif müşterideyse sipariş **otomatik olarak üretime geçer** (beklemedeki sipariş geçmez) → yükleme → arşiv.
5. Satış, teklif hâlâ kendisindeyken kararını geri alabilir: **Çizime Göndermeyi Geri Al** (çizim müşteriye gitmeden önce) ve **Teklife Göndermeyi Geri Al**. Sipariş yeniden karar bekler, teklif taslağı korunur.
6. Teklif yöneticiye gönderildikten sonra satış değişiklik yapamaz. Müşterideki teklifi yalnızca sistem yöneticisi **günceller** (hazırlıkta ya da üretimde); yeni sürüm hemen müşteriye görünür, eski sürüm kayıtta kalır. Teklif gönderildikten sonra revize çizim gelirse yöneticinin listesinde **Teklif kontrolü** altında çıkar: teklifi günceller ya da “değişiklik yok” der.
7. Siparişi yalnızca sistem yöneticisi iptal edebilir.

- **Uygulama:** Next.js 15 (App Router) + Prisma 6 + PostgreSQL
- **Prototip:** `prototype/index.html` — tarayıcıda açılan, verisi yerelde tutulan tanıtım sürümü (tüm ekranların taslağı)
- **Canlı demo:** GitHub Codespaces'te örnek verilerle çalışan gerçek uygulama — [aç](https://codespaces.new/erhan1977tr-lang/Takip/tree/backend?quickstart=1) · [DEMO.md](DEMO.md)

## Durum

| Bölüm | Durum |
|---|---|
| Giriş, ilk giriş (e-posta kodu + şifre belirleme), oturum | ✅ |
| Yönetici: Müşteriler (firmalar), Kullanıcılar, davet / şifre sıfırlama / pasifleştirme | ✅ |
| Davet e-postası (SMTP, TR / RO / EN) | ✅ |
| Siparişler: müşteri siparişi (dosya + cam kataloğu), satış kararı, paralel çizim ve teklif hatları, satış kararını geri alma, çizim revizyonu, yönetici fiyat onayı ve teklif güncelleme, üretim, yükleme, arşiv | ✅ |
| Teklifler sayfası (müşteri: Tekliflerim, iç ekip: durumlara göre) | ✅ |
| Notlar (iç not), hareket geçmişi, SLA, müşteri adı maskeleme, yetkili dosya indirme | ✅ |
| Cam Kataloğu (yönetici) | ✅ |
| Yükleme takvimi (satış/yönetici ve müşteri), sandık ölçü/ağırlık kaydı, yük tahmini | ✅ |
| Romence / Türkçe arayüz, IP'ye göre giriş dili, dil seçimi | ✅ |
| Excel/PDF çıktıları (döküm, nakliye listesi, sandık etiketi, teklif), bildirimler | ⏳ |
| Sunucuya otomatik kurulum | ⏳ sunucu hazır olunca |

## Diller

Arayüz Romence ve Türkçedir. Metinler `server/i18n/ro/` ve `server/i18n/tr/` altındaki sözlüklerdedir (iki dilin anahtarları
birebir aynı olmalı; `npm test` kontrol eder). Kod içinde `const { t } = await getT()` ve `t('status.order.YENI')` kullanılır.

Dil seçimi: çerez (kullanıcının seçimi / giriş dili) → Cloudflare ülke başlığı → IP adresinin ülkesi (Türkiye → tr, Romanya ve
Moldova → ro; `server/geo/ranges.js`, RIPE NCC verisi, CI tarafından aylık yenilenir) → tarayıcı dili → Romence.

## Klasörler

```
app/                 sayfalar ve sunucu işlemleri (Next.js)
  login/  setup/     giriş ve ilk giriş
  (panel)/           giriş sonrası ekranlar (yan menü)
lib/                 veritabanı, oturum, şifre, davet, roller
server/              e-posta ve davet kodu (Next'ten bağımsız, birim testli)
prisma/              veritabanı şeması ve migration'lar
scripts/             create-admin, test-mail, CI yardımcıları
e2e/                 Playwright uçtan uca testleri
deploy/              sunucu düzeni (docker compose + Caddy)
prototype/           tanıtım prototipi
.devcontainer/       Codespaces demo ortamı (scripts/demo/)
```

## Kendi bilgisayarında çalıştırma (Node.js 22, PostgreSQL)

```bash
npm install
cp .env.example .env          # DATABASE_URL, AUTH_SECRET ve (isterseniz) SMTP değerlerini girin
                              # SMTP yoksa: MAIL_OUTBOX_DIR=./.outbox ve COOKIE_SECURE=false
npx prisma migrate deploy
npm run create-admin -- siz@firma.com "Ad Soyad" --factory "GKH Trading"
npm run dev                   # http://localhost:3000
```

`create-admin` ekrana tek kullanımlık bir kod yazar. Girişte e-postanızı yazıp şifreyi boş bırakın, kodu girin ve şifrenizi belirleyin.

## Testler

```bash
npm test          # birim testleri (e-posta şablonu, davet kodu)
npm run e2e       # uçtan uca testler (çalışan uygulama ve MAIL_OUTBOX_DIR gerekir)
```

Her `git push`'ta GitHub Actions şema doğrulama, migration, birim testleri, tip kontrolü, derleme, uçtan uca testler ve Docker imajı derlemesini çalıştırır. Ana ekranların masaüstü ve mobil ekran görüntüleri `ci-screenshots` dalına yazılır.

Sipariş durumları ve kim ne yapabilir: `server/orders/rules.js` (birim testleri `test/orders.test.js`).

## E-posta (SMTP)

Yönetici bir kullanıcı oluşturduğunda sunucu 6 haneli bir kod üretir, yalnızca özetini veritabanına kaydeder ve kodu e-postayla yollar. Kod varsayılan olarak 24 saat geçerlidir, 5 yanlış denemede kilitlenir ve tek kullanımlıktır.

SMTP ayarlarını denemek için:

```bash
npm run mail:test -- adresiniz@ornek.com tr
```

- **Google Workspace / Gmail:** `smtp.gmail.com`, port 587. Normal şifre çalışmaz; 2 adımlı doğrulamayı açıp bir *uygulama şifresi* oluşturun.
- **Microsoft 365:** `smtp.office365.com`, port 587. Posta kutusunda *Authenticated SMTP* açık olmalı.
- **Hosting firmasının maili (cPanel vb.):** genelde `mail.alanadiniz.ro`, port 465 veya 587.

Mailler spam'e düşüyorsa alan adının **SPF** ve **DKIM** kayıtlarını kontrol edin.

`.env` git'e yüklenmez. Şifreleri hiçbir zaman koda, README'ye ya da sohbete yazmayın.
