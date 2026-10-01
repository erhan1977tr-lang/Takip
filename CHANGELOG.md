# Sürüm notları

Sürüm numarası logonun altında görünür ve her güncellemede artar:
**yeni özellik → ikinci hane** (3.1.0), **düzeltme → üçüncü hane** (3.0.1).
Önceki sistem v2.25 olduğu için yeni sistem 3.0.0 ile başladı.

## 3.12.0 — 01.10.2026 · Ekran düzeni (eski GKH TAKIP düzenine yakın)

- **Hareketler sol menüde:** sipariş sayfasında hareket listesi sol menünün altında, kendi içinde kayar; sağdaki kart kalktı.
  Sipariş dışındaki sayfalarda görünmez.
- **Sipariş bilgileri teklifin üstünde:** yatay, sıkışık bilgi bloğu (cam ve profil siparişinde ortak). Sağ sütun kalktı,
  içerik tüm genişliği kullanır. Kim neyi görür değişmedi (firma adı maskesi aynı).
- **Katlanabilir sol menü:** "‹" menüyü tamamen gizler, içerik genişler; soldaki küçük "›" sekmesi geri açar. Tercih
  tarayıcıda saklanır, sayfa değişince korunur. Dar ekranda menü içeriğin üstüne açılan çekmece olur.

## 3.11.4 — 30.09.2026

- Kod düzeni (lint) ve profil testlerinde düzeltmeler; onaylı düğmelerde (ör. "Müşteriye gönder") hangi düğmeye basıldığı artık her zaman iletilir.

## 3.11.0 — 30.09.2026 · Aşama 6a (profil siparişi)

- **Yeni sipariş:** müşteri önce **Cam siparişi / Profil siparişi** seçer. Profil formunda ürün görseli, ad/kod, birim ve
  adet; yalnızca adedi 0'dan büyük satırlar siparişe girer. Taslak kaydedilebilir. Numara `GLAP12` (camdan ayrı sıra).
- **Profil Kataloğu** (Yönetim): kategoriler ve ürünler (Romence/Türkçe ad, birim, görsel, liste fiyatı EUR, sıra,
  aktif/pasif), Excel ile içe/dışa aktarma. Başlangıç verisi Comanda Depozit formundan (27 ürün, görselleriyle).
- **Profil Fiyatları** (Yönetim): müşteriye özel profil fiyat tabloları; firmaya bağlanır. Bağlı değilse liste fiyatı gelir.
- **Akış:** fiyat bekliyor → yönetici fiyatlar ve müşteriye gönderir → müşteri **Onayla** (alış tarihi, telefon, plaka) →
  Proforma kesildi → Ödeme alındı → Depoda → Teslim edildi → Faturalandı. Satış ve çizim hiç devreye girmez; iptal
  yalnızca yönetici. Yönetici kuyrukları: fiyat bekleyen, onaylanmamış teklifler, ödeme bekleyen, depoda, fatura bekleyen.
- **Alış tarihi:** hafta sonu seçilemez; en erken ödemeden sonraki ilk iş günü (ödeme geç gelirse tarih kendiliğinden
  kayar). Müşteri teslim bilgilerini depo e-postası gidene kadar değiştirebilir.
- **Depo e-postası:** ödeme alınınca (ya da yönetici "Siparişi depoya gönder" deyince) doldurulmuş **Comanda Depozit PDF'i**
  depoya gider (alıcılar Entegrasyonlar'dan değiştirilebilir). E-postadaki bağlantıdan depo **imzalı teslim belgesini**
  yükleyip teslimi onaylar; belge siparişin altında saklanır.
- **Stok:** ürün başına stok, giriş/sayım hareketleri ve Excel; depoya giden sipariş stoktan kendiliğinden düşer. Stok
  yetmezse yöneticiye uyarı gösterilir, işlem engellenmez.
- **Kur notu:** EUR tekliflerde (cam ve profil) Banca Transilvania satış kuru notu; fiyatlar TVA hariç.

## 3.10.1 — 29.09.2026 · Aşama 5 (teklif: iki kademeli fiyat)

- **Satış fiyatı ↔ müşteri fiyatı:** satış kendi fiyatını girer; yönetici fiyat onayında her satıra **müşteri fiyatı**
  girer. Yönetici ekranında satış fiyatı (salt okunur) ve müşteri fiyatı yan yana; altında satış tutarı, müşteri tutarı ve
  fark. Yönetici satış fiyatını değiştiremez.
- **Satırlar ortak:** yönetici ölçü, adet değiştirir ya da satır ekler/silerse satışın teklifi de aynı şekilde güncellenir.
  Satışa geri gönderilip yeniden gelen teklifte yöneticinin müşteri fiyatları korunur.
- **Müşteri Fiyatları** (Yönetim): müşteriye özel fiyat tabloları (cam m² fiyatı, delik / CNC fiyatı, Excel ile yükleme);
  müşteri firması bir tabloya bağlanır. Satış teklifi yöneticiye gönderince müşteri fiyatları kendiliğinden dolar; tablosu
  olmayan müşteride boş gelir.
- Tüm satırlara müşteri fiyatı girilmeden teklif müşteriye gönderilemez.
- **Kim neyi görür:** müşteri ve denetimci yalnızca müşteri fiyatını, satış yalnızca kendi fiyatını görür (sunucuda
  ayrılır; satışa giden hiçbir sayfada müşteri fiyatı yok). Teklifler ve Yüklemeler sayfasında yönetici satış tutarı ile
  müşteri tutarını yan yana görür.
- Müşteriye giden teklif değişmez; yöneticinin güncellemesi yeni sürüm açar. Fiyatlar KDV hariç.
- Önceden gönderilmiş teklifler güncellemede kendiliğinden yeni düzene taşınır.

## 3.9.0 — 29.09.2026 · Aşama 4 (çizim akışı)

- **İki adımlı gönderim:** çizimci dosyaları önce **taslağa** yükler (müşteri görmez), sonra "Müşteriye gönder"e basar;
  "Emin misiniz?" sorusu onaylanınca çizim müşterinin onayına gider.
- **Sürüm başına birden çok dosya** (PDF + DWG + DXF…). Taslaktan dosya çıkarılabilir; gönderilen sürümün dosyaları
  değişmez, eski sürümler silinmez.
- **Virüs taraması zorunlu:** çizimcinin her dosyası yüklenirken taranır; taranmamış (antivirüse o an ulaşılamamış ya da
  antivirüs kapalıyken yüklenmiş) dosya bulunan çizim müşteriye gönderilemez.
- **Geri çekme:** müşteri karar vermeden, çizimci gönderdiği sürümü gerekçe yazarak geri çekebilir; sürüm geçmişte
  "geri çekildi" olarak kalır, müşteri gerekçeyi görür.
- **Sürüm notu:** müşteriye görünen not ve yalnızca ekibin gördüğü iç not. Her sürümde kim gönderdi, müşteri ne zaman
  karar verdi görünür.
- **Otomatik atama:** tek etkin çizimci varsa "Çizim Ekibine Gönder"le iş kendiliğinden ona atanır ("üstlen" gerekmez).
- Çizim paneli: **Çizilecekler**, **Müşteri onayında**, **Benim çizimlerim**; müşteri DWG/DXF gönderdiyse rozet.
  Kuyruklarda süresi geçenler en üstte (kırmızı SLA rozeti).
- Eski düzende yüklenmiş çizimler güncellemede kendiliğinden yeni düzene taşınır.

## 3.8.1 — 29.09.2026

- Siparişin yükleme tarihi değişince (ya da "yüklendi" başka bir günde işaretlenince) sandıkları da yeni güne taşınır;
  takvimde müşteri, sipariş ve sandıklar birlikte yer değiştirir. Yeni günde aynı sandık numarası doluysa ilk boş
  numaraya kayar. Başka siparişlerin camlarını da taşıyan sandık eski günde kalır, taşınan siparişle bağı kaldırılır.
  Taşıma denetim kaydına yazılır.

## 3.8.0 — 29.09.2026 · Sandıklar yükleme sekmesinde

- Sandık ölçü ve ağırlıkları artık **Yüklemeler** sekmesinde, yükleme günü ve müşteri bazında girilir (satış ya da
  yönetici): müşteri satırının altındaki "Sandıklar" açılır; sandık no, uzunluk / genişlik / yükseklik (mm), net ve brüt
  ağırlık, not ve (birden çok siparişte) sandıktaki siparişler. "+ Sandık ekle", "Bu gün dolu" (o gün diğer
  müşterilerde kullanılan numaralar), anlık net/brüt toplamı, "güncellendi · tarih · kişi".
- Sandık numarası o gün içinde tektir (müşteriler arasında da). Girilen sandıklar o müşterinin o günkü tahmininin
  önüne geçer; brüt boşsa net + 50 kg dara sayılır.
- Sipariş sayfasında sandık girişi kaldırıldı; yalnızca siparişin hangi sandıklarda olduğu ve yükleme gününe bağlantı
  görünür. Eski düzende girilmiş sandıklar güncellemede kendiliğinden yükleme gününe taşınır.
- Her kayıt denetim kaydına (önce/sonra) ve ilgili siparişlerin geçmişine yazılır.

## 3.7.1 — 29.09.2026 · Aşama 3b (fiyat tabloları)

- **Fiyat Tabloları** (Yönetim → Fiyat Tabloları): her tablonun adı, para birimi, cam başına m² fiyatı ve delik / CNC
  için adet başına sabit fiyatı. Aktif / pasif, "Varsayılan yap", kullanılmamış tabloyu silme.
- Fiyatlar ekranda (arama, "yalnız fiyatsızlar", "N camın fiyatı girilmemiş") ya da **Excel** ile: "Excel indir"
  ürün sahibinin fiyat listesi düzeninde iner; "Excel'den yükle" önce önizleme gösterir, onaylanınca kaydeder. Boş
  bırakılan fiyat değişmez. Her değişiklik denetim kaydına önce/sonra değeriyle yazılır.
- **Satışçı atamaları:** her satışçının tek tablosu olur; ataması olmayan satışçı varsayılan tabloyu kullanır.
- Satışçının teklifine müşterinin seçtiği camlar **liste fiyatıyla dolu** gelir; eklenen delik ve CNC satırlarına
  tablonun sabit fiyatı yazılır. Satışçı ölçüleri, delikleri ve CNC'yi ekler; fiyatı değiştirebilir.
- Satışçı liste fiyatından farklı fiyatla gönderirse yöneticinin yeni **Önemli kararlar** listesine düşer ve
  yönetici girişte uyarı görür; "Gördüm" ile kapatır (kim, ne zaman kayıtlı). Tablo sonradan değişse de açık
  tekliflerin satırları değişmez.
- Teklif satırı camın Romence adını ve ağırlığını da saklar: Romence ekranda cam Romence görünür; yükleme ağırlığı
  katalogdaki kg/m² ile hesaplanır (tekliflerde ağırlık görünmez).

## 3.6.1 — 29.09.2026

- Cam kataloğu sayfasındaki satır düğmeleri tarayıcıda form kimliğiyle çakışmayacak şekilde düzeltildi.

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
