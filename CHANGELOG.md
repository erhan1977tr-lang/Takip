# Sürüm notları

Sürüm numarası logonun altında görünür ve her güncellemede artar:
**yeni özellik → ikinci hane** (3.1.0), **düzeltme → üçüncü hane** (3.0.1).
Önceki sistem v2.25 olduğu için yeni sistem 3.0.0 ile başladı.

## 3.6.0 — 29.09.2026 · Aşama 3a (cam kataloğu, taslak, kuyruklar)

- **Cam kataloğu iki dilli:** her camın Türkçe ve Romence adı ve rengi, ağırlığı (kg/m²). Herkes camı kendi seçtiği
  dilde görür. Ağırlık yüklemeler için; tekliflerde görünmez.
- **Excel ile katalog:** yönetici kataloğu Excel olarak indirir, düzenleyip yükler. Yüklemeden önce önizleme
  (eklenecek, değişecek, hatalı satırlar); onaylanınca kaydedilir ve denetim kaydına yazılır. Dosyada olmayan camlara
  dokunulmaz. Katalog sayfasında arama, "yalnız pasifler" ve düzenleme.
- Pasif cam hiçbir listede görünmez; sipariş satırı camın o günkü adlarını ve ağırlığını saklar (katalog değişse de
  eski sipariş değişmez).
- **Taslak sipariş:** müşteri "Taslak kaydet" ile formu yarım bırakır, "Siparişlerim → Taslaklarım"dan devam eder ya
  da siler. Taslak fabrikaya gitmez; numara ve SLA gönderince başlar.
- Yeni siparişe isteğe bağlı **Ek bilgi** notu (satışın gördüğü sipariş notu olur). Cam adedi 1–9999.
- Satışın "Sıra bende" ekranına **Müşteri onayında** ve **Üretimdeki siparişler** bölümleri. Kuyruklara yalnızca cam
  siparişleri girer (profil siparişleri satış/çizim kuyruğuna düşmez).

## 3.5.0 — 29.09.2026 · Aşama 2 (sipariş çekirdeği)

- **Antivirüs:** müşterinin ve ekibin yüklediği her dosya kaydedilmeden önce ClamAV ile taranır; virüslü dosya kabul
  edilmez. Tarayıcıya o an ulaşılamazsa dosya "taranmadı" işaretlenip kabul edilir ve arka planda taranır; sonradan
  virüslü çıkan dosya karantinaya alınır, indirilemez. Yönetici → **Entegrasyonlar** sayfası: durum, ayarlar,
  bağlantı testi, karantina ve engellenen yüklemeler.
- Dosyanın türü içeriğinden kontrol edilir: adı .pdf olup içi PDF olmayan (ör. kılık değiştirmiş program) reddedilir.
  Her dosyanın SHA-256 özeti saklanır. Çizim ekibi de müşteriyle aynı dosya türlerini yükleyebilir.
- Dosya indirmeleri denetim kaydına yazılır; denetim kaydında işlemi yapanın rolü ve IP adresi de tutulur.
- Tüm sipariş işlemleri tek iş akışı servisinden geçiyor: her işlem aynı anda geçmiş (önceki → sonraki durum),
  denetim kaydı ve bildirim kuyruğu satırı yazar. İki kişi aynı anda işlem yaparsa ikincisine "sipariş bu arada
  değişti" denir; müşteri, bu arada yeni çizim sürümü yüklendiyse eski sürümü onaylayamaz.
- Sipariş numarası: formdaki önerilen numara değiştirilmemişken aynı firmadan aynı anda başka sipariş gelirse
  hata yerine bir sonraki numara otomatik verilir.
- Sipariş tipleri altyapısı (cam; profil siparişi Aşama 6'da açılacak). Birden çok tip açık olduğunda "Yeni sipariş"
  önce tip seçtirir.
- Sunucuya antivirüs ve arka plan işçisi servisleri eklendi; `takip antivirus` komutu.

## 3.4.1 — 29.09.2026

- Arama motorları siteyi taramaz: `robots.txt` her şeyi kapatır, sunucu her yanıta `X-Robots-Tag: noindex` ekler.
- (Sunucudaki otomatik güncellemenin ilk gerçek denemesi.)

## 3.4.0 — 29.09.2026 · Sunucu

- Sunucu kurulumu tek komutla: Docker, HTTPS (Let's Encrypt), güvenlik duvarı, fail2ban, otomatik güvenlik yamaları,
  veritabanı, ilk yönetici hesabı. Gizli anahtarlar sunucunun kendisinde üretilir. Depo özel olduğu için sunucu
  GitHub'a yalnızca okuma izinli bir erişim anahtarıyla bağlanır (anahtar yalnızca sunucuda durur).
- Otomatik güncelleme: GitHub'daki testlerden geçen her sürüm birkaç dakika içinde sunucuda yayınlanır; öncesinde
  veritabanı yedeklenir, yeni sürüm açılmazsa önceki sürüme dönülür.
- Sunucu aracı `takip`: durum, e-posta (SMTP) ayarı, yönetici hesabı, yedek, günlük.
- Her gece veritabanı ve dosya yedeği.
- `/surum` adresi yayındaki sürümü gösterir; logonun üzerine gelince derlenen commit de görünür.

## 3.3.2 — 29.09.2026 · Aşama 1 (giriş, roller, yetkiler, firmalar)

- **Denetimci** rolü: yönetici kullanıcı eklerken seçebilir. Tüm siparişleri tam firma adıyla, iç notları ve iç dosyaları görür;
  teklif olarak yalnızca müşteriye gönderilmiş olanı görür. Hiçbir işlem yapamaz. Menüsü: Siparişler, Teklifler, Yüklemeler.
- Yetkiler tek bir tablodan yönetiliyor; her sayfa ve işlem sunucuda bu tabloya göre kontrol ediliyor.
- Satış ve çizim ekibine firmanın adı daha veritabanından gelirken maskeleniyor; iletişim bilgileri (kişi, telefon, adres,
  vergi no) hiç gitmiyor. Çizim ekibi teklif tutarlarını görmüyor; satış yönetici fiyatını görmüyor.
- Girişte hatalı deneme sınırı: 15 dakikada 5 hatalı denemeden sonra giriş geçici olarak kilitlenir (kod ekranında da).
  Giriş, çıkış ve kilit olayları denetim kaydına yazılır.
- Şifre en az 6 karakter (en az bir harf ve bir rakam).
- **Firma kodu tam 3 harf** (A–Z). Eski kodlar 3 harfe çevrildi ve siparişlerin numaraları yeni koda göre güncellendi.
  Siparişi olan firmanın kodu artık değiştirilemez. Kod boş bırakılırsa addan, boşta olan bir kod önerilir.
- Demo ortamına Denetimci hesabı eklendi (denetim@ornek.test).

## 3.2.1 — 29.09.2026

- Kod denetiminin ilk bulguları düzeltildi (yönetici formlarındaki bağlantılar sayfayı yeniden yüklemeden açılır).

## 3.2.0 — 29.09.2026 · Aşama 0 (temel)

Ekranlarda ve iş akışında değişiklik yok; yeniden yapılanmanın temeli atıldı.

- Proje kuralları (`CLAUDE.md`), ana tanım (`docs/spec`), ürün kararları (`docs/decisions.md`) ve 11 mimari karar kaydı (`docs/adr`).
- Ortam değişkenleri tek yerde tanımlı ve doğrulanıyor; eksik/hatalı değer varsa sunucu açılmaz ve hepsini tek seferde listeler
  (`npm run env:check`). `.env.example` tamamlandı.
- Denetim kaydı veritabanında korunuyor: kayıtlar güncellenemez ve silinemez.
- Temel veri çerçevesi (`npm run db:seed`): beş rol (Denetimci dahil) ve yetkileri; sipariş tipleri, birimler ve profil kataloğu verisi
  sonraki aşamalar için hazır. Sunucu kurulumunda migration ile birlikte çalışır.
- İş akışı servisi iskeleti (tek geçiş noktası, denetim, bildirim kuyruğu) ve testleri.
- Kod denetimi (ESLint), ayrı veritabanında çalışan veritabanı testleri, satış/çizim ekranlarında müşteri adı sızıntı testi.

## 3.1.1 — 29.09.2026

- Teklif tablosunda uzun (Romence) sütun başlıkları iki satıra iner; açıklama sütunu daralmaz.

## 3.1.0 — 29.09.2026

- Uygulama Romence ve Türkçe: giriş ekranı, tüm paneller, durumlar, hareket geçmişi, hata mesajları.
- Giriş ekranının dili bağlantının geldiği ülkeye göre otomatik: Türkiye IP'si → Türkçe, Romanya (ve Moldova) → Romence;
  ülke bilinmiyorsa tarayıcı dili, o da değilse Romence. IP aralıkları RIPE NCC'nin herkese açık verisinden (aylık yenilenir).
- Giriş ekranında RO | TR düğmeleri, panellerin sağ üstünde dil seçimi; seçim hatırlanır.
- Hangi dilde giriş yapıldıysa panel o dille açılır; kullanıcının dili kaydedilir (e-postalar o dilde gider).
- Yönetici yeni kullanıcı eklerken davet e-postasının dilini Romence ya da Türkçe seçer.

## 3.0.0 — 28.09.2026

İlk sürüm.

- GKH Digital logosu giriş ekranında ve panellerin sol üstünde; altında sürüm numarası. Tarayıcı sekmesi simgesi.
- Giriş: e-posta + şifre; ilk girişte e-posta koduyla şifre belirleme. Roller: sistem yöneticisi, satış, çizimci, müşteri.
- Yönetici: müşteri firmaları, kullanıcılar, davetler, cam kataloğu.
- Sipariş akışı: müşteri siparişi → satış kararı (çizime / teklife gönder, beklemeye al; kararı geri alma)
  → çizim ve teklif hatları paralel → çizim onayı + teklif müşterideyken otomatik üretim → yükleme → arşiv.
- Teklif: cam satırları, CNC ve delik alt satırları, bedelsiz satır; fiyatsız satırla gönderilemez;
  yönetici fiyat onayı ve müşterideki teklifi güncelleme; revize çizim sonrası teklif kontrolü.
- Yükleme takvimi (satış / yönetici ve müşteri), sandık ölçü ve ağırlıkları, yük tahmini.
- Notlar, hareket geçmişi, SLA, müşteri adı maskeleme, yetkili dosya indirme.
- Codespaces demo ortamı (örnek veriler, demo posta kutusu).
