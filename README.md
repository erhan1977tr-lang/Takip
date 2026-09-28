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
