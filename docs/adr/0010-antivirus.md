# 0010 — Yüklenen dosyalar için antivirüs

**Durum:** Uygulandı (3.5.0) · 29.09.2026

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
- `INFECTED` dosya hiç kimseye indirilmez (karantina: `UPLOAD_DIR/.karantina`). Ürün sahibinin kararıyla tarayıcıya
  ulaşılamadığında dosya kabul edilir ve `PENDING` ("taranmadı") işaretlenir; bu dosya uyarı rozetiyle indirilebilir,
  arka plan işçisi (`scripts/worker.mjs`, sunucuda `worker` servisi) dakikada bir tarar.
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

## Uygulama notları (3.5.0)
- İstemci: `server/files/clamav.js` (INSTREAM/PING/VERSION, ek paket yok). Saklama akışı: `server/files/store.js`
  (içerik türü kontrolü `server/files/signature.js`, SHA-256, tarama, kalıcı yere taşıma).
- Ayarlar: `IntegrationSetting` tablosu, anahtar `antivirus` (açık/kapalı, adres, port, ulaşılamazsa kabul/reddet);
  kayıt olmadığında `CLAMAV_HOST` tanımlıysa açık. Her değişiklik denetim kaydına önce/sonra değerleriyle yazılır.
- Sunucu: `deploy/clamav` (resmî imaj + 150 MB akış/dosya sınırı), `worker` servisi, `takip antivirus` komutu.
- CI: uçtan uca testler gerçek ClamAV ile çalışır (ZIP içinde EICAR reddedilir, yönetici testi başarılı).
