# Takip — Sipariş ve Üretim Portalı

Cam sipariş akışı için web uygulaması:
sipariş → satış kararı (çizim / teklif / beklemeye al) → çizim ve müşteri onayı → teklif → yönetici fiyat onayı → üretim → yükleme.

- **Uygulama:** Next.js 15 (App Router) + Prisma 6 + PostgreSQL
- **Prototip:** `prototype/index.html` — tarayıcıda açılan, verisi yerelde tutulan tanıtım sürümü (tüm ekranların taslağı)

## Durum

| Bölüm | Durum |
|---|---|
| Giriş, ilk giriş (e-posta kodu + şifre belirleme), oturum | ✅ |
| Yönetici: Müşteriler (firmalar), Kullanıcılar, davet / şifre sıfırlama / pasifleştirme | ✅ |
| Davet e-postası (SMTP, TR / RO / EN) | ✅ |
| Siparişler, teklif, çizim, yükleme takvimi | ⏳ prototipten taşınacak |
| Sunucuya otomatik kurulum | ⏳ sunucu hazır olunca |

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

Her `git push`'ta GitHub Actions şema doğrulama, migration, birim testleri, tip kontrolü, derleme, uçtan uca testler ve Docker imajı derlemesini çalıştırır.

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
