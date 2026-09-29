# 0010 — Yüklenen dosyalar için antivirüs

**Durum:** Kabul (uygulama Aşama 2, ayar ekranı Aşama 2/8) · 29.09.2026

## Bağlam
Müşteriler ve iç ekip teknik dosya yükler (PDF, DWG, DXF, STEP, ZIP, Office, görsel; dosya başına 100 MB'a kadar).
Bu dosyalar diğer kullanıcıların bilgisayarlarında açılır. Ürün sahibi yönetici Entegrasyonlar sayfasından
yönetilen antivirüs taraması istedi (karar 10).

## Karar
- Tarayıcı: **ClamAV** (`clamd`), Docker Compose'ta ayrı bir servis. Uygulama clamd'ye TCP üzerinden `INSTREAM`
  protokolüyle bağlanır — ek npm paketi gerekmez (`node:net`).
- Tarama soyutlaması `server/files/scanner.js`: `scan(stream) → { status: 'clean' | 'infected' | 'error', signature? }`.
  İleride başka sağlayıcı (ör. bulut API) aynı arayüzle eklenebilir.
- Akış: dosya önce karantina alanına yazılır → taranır → temizse kalıcı depolamaya taşınır ve kayda
  `scanStatus=CLEAN` yazılır. Virüslüyse dosya silinir, yükleme reddedilir, kullanıcıya iki dilde mesaj gösterilir,
  denetim kaydı ve yöneticiye bildirim oluşur.
- Taranmamış (`PENDING`) ya da `INFECTED` dosya hiç kimseye indirilmez; dosya indirme yetkisine bu kontrol eklenir.
- **Yönetici → Entegrasyonlar → Antivirüs** ayarları:
  - Durum: kapalı / açık
  - Tarayıcı erişilemezse: yüklemeyi reddet (önerilen) / kabul et, "taranmadı" diye işaretle ve sonra tara
  - Adres ve port (varsayılan `clamav:3310`), zaman aşımı
  - "Bağlantıyı test et" (EICAR test dizisiyle) ve imza veritabanı sürümü / son güncelleme
- Ayar değişiklikleri denetim kaydına yazılır. Adres/port sır değildir; ileride sağlayıcı anahtarı gerekirse
  yalnızca sunucudaki `.env` dosyasında durur, ekranda gösterilmez.
- Dosya içeriği uzantıya göre değil imza baytlarına (magic number) göre de kontrol edilir (tanım §21).

## Sonuçlar
- Sunucuda ClamAV yaklaşık 1–1,5 GB bellek kullanır; Contabo sunucusunun belleği buna göre seçilmeli.
- Mevcut yüklenmiş dosyalar kurulumdan sonra bir kez toplu taranır.
