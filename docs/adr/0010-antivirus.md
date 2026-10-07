# 0010 — Yüklenen dosyalar için antivirüs

**Durum:** Uygulandı (3.5.0) · 29.09.2026 · **Güncellendi (3.50.21, karar 150):** tarayıcının adresi / portu artık
yönetici ayarı değildir — yalnızca sunucu ayarından gelir; tarayıcının yanıtına güvenilmez (aşağıda "Güncelleme").

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
  - ~~Adres ve port (varsayılan `clamav:3310`), zaman aşımı~~ — **3.50.21'de kaldırıldı (karar 150):** adres ve port
    ekranda yalnızca salt-okunur gösterilir; kaynağı sunucu ayarıdır (`CLAMAV_HOST` / `CLAMAV_PORT`)
  - "Bağlantıyı test et" (EICAR test dizisiyle) ve imza veritabanı sürümü / son güncelleme
- Ayar değişiklikleri denetim kaydına yazılır. İleride sağlayıcı anahtarı gerekirse yalnızca sunucudaki `.env`
  dosyasında durur, ekranda gösterilmez.
- Dosya içeriği uzantıya göre değil imza baytlarına (magic number) göre de kontrol edilir (tanım §21).

## Sonuçlar
- Sunucuda ClamAV yaklaşık 1–1,5 GB bellek kullanır; Contabo sunucusunun belleği buna göre seçilmeli.
- Mevcut yüklenmiş dosyalar kurulumdan sonra bir kez toplu taranır.

## Uygulama notları (3.5.0)
- İstemci: `server/files/clamav.js` (INSTREAM/PING/VERSION, ek paket yok). Saklama akışı: `server/files/store.js`
  (içerik türü kontrolü `server/files/signature.js`, SHA-256, tarama, kalıcı yere taşıma).
- Ayarlar: `IntegrationSetting` tablosu, anahtar `antivirus` (açık/kapalı, ulaşılamazsa kabul/reddet — 3.50.21'e
  kadar adres ve port da buradaydı); kayıt olmadığında `CLAMAV_HOST` tanımlıysa açık. Her değişiklik denetim kaydına
  önce/sonra değerleriyle yazılır.
- Sunucu: `deploy/clamav` (resmî imaj + 150 MB akış/dosya sınırı), `worker` servisi, `takip antivirus` komutu.
- CI: uçtan uca testler gerçek ClamAV ile çalışır (ZIP içinde EICAR reddedilir, yönetici testi başarılı).

## Güncelleme (3.50.21, karar 150 — güvenlik denetimi 3.50.9 AUD-12)

**Sorun.** Tarayıcının adresi ve portu yönetici ekranından (ve doğrudan istekle) herhangi bir değere çevrilebiliyordu;
uygulama da karşı tarafın yanıtına güveniyordu. Sonuçları: (1) yüklenen her dosyanın tam kopyası yöneticinin seçtiği
adrese gönderilebiliyor, o adres "temiz" dediğinde virüslü dosya `CLEAN` olarak saklanıyordu; (2) uygulama iç ağdaki
herhangi bir adres / porta bağlanıp aldığı yanıtı ekranda gösteriyordu (iç ağ keşfi); (3) yanıt sınırsız belleğe
alınıyordu (64 MB yanıt → 64 MB bellek); (4) düzenli tek bayt gönderen bir karşı taraf taramayı süresiz açık
tutabiliyordu; (5) "imza adı" ve hata metni olarak gelen serbest metin veritabanına, denetim kaydına, bildirime ve
ekrana yazılıyordu.

**Karar.**
- **Hedef sunucu denetimindedir.** Adres yalnızca `CLAMAV_HOST`, port yalnızca `CLAMAV_PORT` sunucu ayarından gelir
  (`avTarget` — `server/files/antivirus.js`; sunucuda Compose `clamav` verir, tanımlı değilse varsayılan
  `clamav:3310`). Veritabanında kalmış eski adres / port değerleri **okunmaz**; taşıma / geri doldurma yapılmadı.
  `saveAvSettings` yalnızca açık / kapalı ve "ulaşılamazsa" politikasını saklar; istekle gönderilen adres / port yok
  sayılır. Ekranda adres / port salt-okunur gösterilir. Yükleme, arka plan taraması, durum denetimi, "bağlantıyı test
  et", "şimdi tara" ve `takip antivirus` — hepsi aynı tek kaynaktan (`getAvSettings`) okur.
- **Tarayıcının yanıtına güvenilmez** (`server/files/clamav.js`):
  - Yanıt en çok **4096 bayt** okunur (clamd'nin yanıtı tek kısa satırdır); aşılırsa bağlantı hemen kesilir.
  - İki bağımsız süre sınırı: **hareketsizlik** (çağıranın verdiği süre; yükleme ve arka plan taramasında 120 sn) ve
    **mutlak süre: 5 dakika** (bağlantının tamamı; hiçbir çağıran aşamaz, veri akışıyla uzamaz). PING / VERSION
    için ikisi de 5 saniyedir.
  - Yanıtın biçimi doğrulanır: **temiz** yalnızca tam olarak `stream: OK` yanıtıdır; `stream: … FOUND` her zaman
    **virüs** kararıdır; clamd'nin `… ERROR` yanıtı ve tanınmayan / bozuk her yanıt **hatadır** — hiçbir zaman
    "temiz" sayılmaz. Sürüm bilgisi dar bir kalıba uymak zorundadır.
  - **İmza adı** yalnızca güvenli karakterlerdir (`A–Z a–z 0–9 . _ : + / ( ) { } [ ] -` ve boşluk; ötekiler `?`),
    en çok **200 karakter**.
  - **Hata her zaman sabit koddur:** `unreachable`, `timeout`, `response-too-large`, `invalid-response`,
    `scanner-error`, `file-not-found`, `file-error`. Tarayıcının ham yanıtı, ağ hatası metni (`ECONNREFUSED …`) ve
    dosya yolu bu dosyanın dışına çıkmaz; ekran kodu iki dilde sabit metne çevirir, adresteki `detail` yalnızca bu
    kodlardan biri olabilir.
- **Değişmeyenler:** açık / kapalı, "ulaşılamazsa kabul et, sonra tara / reddet" politikası, karantina, arka plan
  taraması, yükleme sınırları, müşteri / ekip / depo yükleme akışları, ClamAV'ın kendi ayarları. Tarayıcıya
  ulaşılamadığında varsayılan davranış hâlâ "kabul et" (SEC-14 ertelenmiş durumda).

**Sonuçlar.**
- Tarayıcıyı başka bir adrese taşımak artık bir **sunucu işidir** (Compose / `.env`), yönetici ekranından yapılamaz.
- Bir tarama en çok 5 dakika sürer; süre dolarsa sonuç hatadır (politikaya göre "taranmadı" ya da ret) — büyük
  dosyada ClamAV 5 dakikadan uzun sürerse dosya temiz sayılmaz, arka plan taraması yeniden dener.
- Geçmiş kayıtlardaki (3.50.21 öncesi yazılmış) imza adları değiştirilmedi; ekranda gösterilirken aynı kuraldan geçer.
