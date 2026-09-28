# Takip — Sipariş ve Üretim Portalı (prototip)

Cam sipariş akışı için web tabanlı, mobil uyumlu prototip:
sipariş → satış kararı (çizim / teklif / beklemeye al) → çizim ve müşteri onayı → teklif → yönetici fiyat onayı → üretim → yükleme.

## Dosyalar
- `index.html` — tek dosyalık çalışan prototip. Tarayıcıda açın. Veriler tarayıcıda (localStorage) tutulur.
- `prisma/schema.prisma` — veritabanı şeması.

## Demo hesaplar (şifre: `demo123`)
- musteri@demo.com — Müşteri
- satis@demo.com — Satış
- admin@demo.com — Sistem Yöneticisi
- cizim@demo.com — Çizim Ekibi

## Prototip sınırları
- Gerçek sunucu ve veritabanı yok; e-posta gönderilmez, doğrulama kodu ekranda gösterilir.
- Şifreler tarayıcıda düz metin tutulur — yalnızca demo içindir.

## E-posta (SMTP) — davet kodu gönderimi

Yönetici bir kullanıcı oluşturduğunda sunucu 6 haneli bir kod üretir, özetini veritabanına kaydeder ve kodu kullanıcıya e-postayla yollar (TR / RO / EN).

```
server/mail/config.js           .env'den SMTP ayarlarını okur
server/mail/transport.js        nodemailer bağlantısı
server/mail/templates/invite.js davet e-postası şablonu
server/mail/sendInvite.js       gönderim
server/auth/inviteCode.js       kod üretme / doğrulama (kod açık saklanmaz, 5 deneme sınırı)
scripts/test-mail.mjs           test maili
```

### Kurulum ve test maili (Node.js 20.6+)

```bash
npm install
cp .env.example .env        # sonra .env içindeki değerleri doldurun
npm test                    # şablon ve kod testleri (SMTP gerekmez)
npm run mail:test -- adresiniz@ornek.com tr
```

`.env` git'e yüklenmez. SMTP şifresini hiçbir zaman koda, README'ye ya da sohbete yazmayın.

### Sağlayıcıya göre notlar
- **Google Workspace / Gmail:** `smtp.gmail.com`, port 587. Normal şifre çalışmaz; hesapta 2 adımlı doğrulamayı açıp bir *uygulama şifresi* oluşturun.
- **Microsoft 365:** `smtp.office365.com`, port 587. Yönetim panelinden bu posta kutusu için *Authenticated SMTP* açık olmalı.
- **Hosting firmasının maili (cPanel vb.):** genelde `mail.alanadiniz.ro`, port 465 (TLS) veya 587.

Mailler spam'e düşüyorsa alan adının DNS'inde **SPF** ve **DKIM** kayıtlarının gönderen sunucuyu kapsadığından emin olun.
