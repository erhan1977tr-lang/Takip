# Sürüm notları

Sürüm numarası logonun altında görünür ve her güncellemede artar:
**yeni özellik → ikinci hane** (3.1.0), **düzeltme → üçüncü hane** (3.0.1).
Önceki sistem v2.25 olduğu için yeni sistem 3.0.0 ile başladı.

## 3.71.0 — 10.10.2026

P5 — müşteri ekranları (karar 243–244). Şema değişmedi; rol yetkileri ve firma izolasyonu değişmedi.

- **Revizyon ekranı:** ayrı "İşaretler / Marcaje" paneli yok. Her işaretin açıklaması "Revizyon notu / Nota de revizie"
  bölümünde, işaretin numarasıyla ("#3") yazılır. İşaretlerin KALICI kimliği ve numarası vardır: başka bir işaret silinse,
  sıra değişse ya da taslak yeniden açılsa numara değişmez, silinen numara yeniden verilmez; açıklama işaretin kendi
  kaydındadır, yanlış işarete bağlanamaz. Sunucu kimlik / numarayı doğrular, nottaki "#n:" maddesi kalıcı numarayla yazılır.
  Başka sürümün işareti alınmaz; dosya erişimi (AUD-8) değişmedi.
- **Müşteri sipariş listesi:** "Yüklenen ve arşiv / Încărcate și arhivă" bölümünde yalnızca kapanmış (arşivlenmiş / iptal)
  ve onaylı yüklemeyle EKSİKSİZ yüklenmiş siparişler. Tarihi geçmiş yüklenmemiş sipariş, kısmen yüklenmiş (kalanı olan)
  sipariş ve onaylı yüklemesi olmayan "Yüklendi" siparişi Active'de kalır. Active tahmini yükleme gününe göre artan
  (profilde teslim günü; tarihsiz sonda).
- Testler: işaret kimliği / numarası ve not bağı (birim), liste ayrımı ve sırası (birim + veritabanı), revizyon ekranı ve
  müşteri listesi (uçtan uca).

## 3.70.2 — 10.10.2026

- P4 veritabanı testi: yeniden hesaplama karşılaştırması Decimal alanları düz değere çevirerek yapılır (yalnızca test).

## 3.70.1 — 10.10.2026

- P4 düzeltmesi (lint): proforma FGO satırına iç alanların gitmemesi açık alan listesiyle sağlanır; davranış aynı.

## 3.70.0 — 10.10.2026

P4 — proformada aynı camların birleştirilmesi (karar 242). Şema değişmedi; nihai fatura, avans, tahsilat, alacak, kur ve KDV
kuralları değişmedi; mevcut belgeler geriye dönük değişmez.

- **Sipariş proforması ve müşteri proforması (sipariş içinde):** aynı teknik cam adına sahip satırlar — farklı ölçü ve farklı
  birim fiyatlı olanlar da — tek satırda; miktar m² toplamı. Anahtar camın Romence teknik adı (boşluk / büyük-küçük harf farkı
  yok sayılır); nihai faturadaki kısaltılmış "Sticla …" adı anahtar değildir. Siparişler arasında birleştirme yok.
- **Tutar korunur:** birleşik satırın tutarı parça parça hesaplanır ve FGO'ya TVA dahil toplamla (PretTotal) gider — belge
  toplamı (TVA hariç ve dahil) birleştirmeden önceki proformayla kuruşu kuruşuna aynı. Farklı fiyatlarda gösterilen birim
  fiyat m² ağırlıklı ortalamadır (yalnızca gösterim; önizlemede "ort." / "medie" işareti).
- **Ayrı kalır:** CNC, delik, sandık bedeli ve m² dışındaki diğer kalemler; bedelsiz satırlar proformaya hiç girmez.
- Testler: saf kural (gruplama, ortalama, ayrı kalemler, 400 turluk kuruş özellik testi, nihai fatura değişmez), veritabanı +
  sahte FGO (sipariş proforması ve müşteri partisi), uçtan uca önizleme (TR / RO).

## 3.69.3 — 10.10.2026

- P3 uçtan uca testi: denetimcinin firma tutarı gerçek gönderimdeki gibi müşteri tutarı kaydından (Price) okunur; test verisi
  bu kaydı da yazar. Uygulama davranışı değişmedi.

## 3.69.2 — 10.10.2026

- P3 düzeltmesi: "Döküm" sayfasının para birimi toplamları müşteri sırasından bağımsız, para birimi adına göre sıralı
  (EUR, RON, …).

## 3.69.1 — 10.10.2026

- P3 düzeltmesi: firma "Özet" sayfasının "Sipariş toplamı" metni (`loading.firmSummary.orderTotal`) yanlışlıkla silinmişti;
  geri eklendi (tr / ro).

## 3.69.0 — 10.10.2026

P3 — iki sayfalı Yükleme Özeti Excel'i (karar 241). Şema değişmedi; hesaplar ve finansal kayıtlar değişmedi.

- **"Firmalar"** sayfası: bilgi satırları (onaylı / PLANLANAN), firma bazlı özet (sandık, ağırlık, rolün görebildiği tutarlar)
  ve misafir yük tablosu.
- **"Döküm"** sayfası: düz tablo — SİPARİŞ NO | MÜŞTERİ | PROJE | AÇIKLAMA | ADET | BİRİM | METRAJ | BİRİM FİYAT | TUTAR |
  Para birimi; her kalem bir satır, sipariş blokları yok, süzgeç / sıralama açık, para birimi başına toplam tablonun altında.
- **Yönetici / yönetici yardımcısı:** ek **"Döküm (Fabrika)"** sayfası (aynı satırlar fabrika fiyatıyla); "Döküm" müşteri
  fiyatıyla. **Satış:** fabrika fiyatı, maskeli adlar; müşteri fiyatı dosyada yok. **Denetimci:** müşteri fiyatı; fabrika fiyatı
  dosyada yok. Müşteri ve çizimci erişemez (403).
- Testler: sayfa adları, sütun sırası, çok sipariş / çok para birimi toplamları, kısmi yükleme, rol bazlı fiyat / ad
  (XLSX paketinin tüm parçaları taranır), formül enjeksiyonu, belge özelliği ve tanımlı ad denetimi.

## 3.68.1 — 10.10.2026

- P2 düzeltmesi (tip kontrolü): telafi formunun hedef listesindeki "yönetici onayı bekler" işareti de aynı akış kuralından
  (`compensationFlow`) gelir.

## 3.68.0 — 10.10.2026

P2 — telafi "aynı fiyat" denetimi ve teklif toplam metrajı (karar 240). Şema değişmedi; finansal kurallar değişmedi.

- **Telafi formu, kaynak müşteri fiyatı boşken "Aynı fiyat":** ekran artık sunucuyla aynı yolu gösterir — teklif doğrudan
  müşteriye gitmez (yeni telafi siparişinde yöneticinin fiyat onayı; müşterideki teklifte satış için yönetici onayı;
  yöneticide "fiyat gerekli" uyarısı ve gönderim kapalı). Önceden form "doğrudan müşteriye gider" diyordu. Satışa tutar
  gitmez; yalnızca "kaynakta müşteri fiyatı var mı" bilgisi.
- **Aynı fiyat / işlem adedi:** veritabanı testleriyle doğrulandı — aynı fiyatla taşınan telafi camı bedelsiz değil, kaynağın
  müşteri ve fabrika fiyatıyla taşınır; CNC / delik adetleri aynen taşınır (1'e inmez). Taşınan işlem satırlarının müşteri
  fiyatı karar 157 gereği 0'dır ve "Bedelsiz" görünür (değişmedi).
- **Toplam metraj:** sipariş sayfasındaki salt okunur teklif tablosunun altında "Toplam metraj" (teklifin kendi hesabı; üç
  ondalık gösterim).

## 3.67.3 — 10.10.2026

- P1 e2e: Finans / FGO kartının bekleme metni beklentisi yeni kurala göre güncellendi (nihai fatura Faturalama kartından).

## 3.67.2 — 10.10.2026

- Müşteri faturası oluşturulurken işlem içinde kur yeniden çözülmez: aynı günün diğer fatura gruplarının kuru ilk
  hesaptan alınır (önceden işlem içinde BNR'ye ağ isteği gidebiliyordu). Hedef grubun kuru, tutarlar ve kurallar değişmedi.
- P1 testleri: sahte FGO belge toplamını gerçekçi döndürür; bir testte değişken çakışması giderildi.

## 3.67.1 — 10.10.2026

- P1 düzeltmesi: tip kontrolü için `billingState` parametre tanımına `invoiced` eklendi. Davranış değişmedi.

## 3.67.0 — 10.10.2026

P1 — nihai fatura güvenliği (karar 239). Şema: iki boş bırakılabilir sütun eklendi (`BillingBatch.chainOrderId`,
`BillingBatchLine.refDocId`); var olan veri değiştirilmedi.

- **Nihai fatura yalnızca onaylı yüklemeden:** kendi proforması olan cam siparişinin nihai faturası artık sipariş
  sayfasındaki "Fatura Gönder" ile ve "tahmini tarih + 2 gün" kuralıyla kesilmez; yükleme gününün **Faturalama** kartında,
  yalnızca o yüklemede onaylanan (LOADED) ve henüz faturalanmamış miktar için, siparişin kendi zincirinde kesilir.
  Kısmi yüklemede kalan, yüklendiği onaydan faturalanır. Tahsilat şart değildir.
- **Avans düşümü:** siparişin avans faturaları faturalara "Stornare avans conform factură …" satırıyla, her faturanın
  değeriyle sınırlı ve toplamda bir kez düşülür; avansı kesilmemiş tahsilat varken fatura kesilmez.
- **Kur:** faturada proformanın kayıtlı kuru kullanılır; kur kaydı yoksa fatura kesilmez (yeniden çözülmez).
- **Fatura sonrası tahsilat:** nihai fatura kesildikten sonra proformaya gelen yeni tahsilat otomatik avans / mahsup
  yapılmaz; o siparişin yeni faturası ve avansı durur, yöneticiye "muhasebe incelemesi gerekli" uyarısı gösterilir.
  Diğer siparişlerin faturalanması etkilenmez.
- Sipariş sayfasında "Nihai fatura" bölümü: onaylı yüklemeler ve fatura durumları, Faturalama kartına bağlantı.
- Onaylı yüklemesi olan siparişe sipariş düzeyinde proforma kesilmez; kuyrukta kalmış eski sipariş düzeyi fatura işi
  FGO'ya gitmeden kapatılır.

## 3.66.1 — 10.10.2026

Paket D — çizim erişimi ve dosya güvenliği doğrulaması (karar 238). Erişim kuralı (AUD-8, karar 146) değişmedi; şema değişmedi.

- **Güvenlik testleri:** çizim dosyalarına erişim gerçek sunucuda rol × dosya matrisiyle sınanır — başka firmanın
  dosyası (dosya kimliği, eski sürüm kimliği, `?ac=1`), taslak ve geri çekilen sürüm, eski tek-dosya düzeni, müşterinin
  DWG kaydı, kaldırılmış sipariş, çizim / satış kapsamı, klasör dışını gösteren saklama anahtarı, path traversal, dosya
  listesi ve sayfa yanıtında sızıntı. Reddedilen istekte dosya içeriği, adı, saklama anahtarı dönmez; indirme kaydı yazılmaz.
- **"güncel" etiketi:** geri çekilmiş çizim sürümü artık "güncel" diye işaretlenmez (yenisi henüz gönderilmediyse müşteri
  hiçbir sürümü güncel görmez).

## 3.66.0 — 10.10.2026

Paket C — sipariş, yükleme ve FGO düzeltmeleri (kararlar 230–237). Veritabanı şeması değişmedi; veri dönüştürülmedi.

- **Tahmini yükleme tarihi:** Sipariş Bilgileri'nde tarihin yanında "Değiştir" ile düzenlenir; kaydetmeden önce eski → yeni
  gün onay penceresi. Yönetici, Yönetici Yardımcısı ve Satış değiştirir; müşteri, çizim ve denetimci değiştiremez. Yükleme
  tamamlanınca (Yüklendi / Arşiv ya da onaylı yükleme kaydı — kısmi yükleme dahil) sunucuda kilitli. Denetim kaydında eski
  ve yeni gün. İşlemler kartındaki ayrı tarih formu kaldırıldı.
- **Telafi etiketi:** telafi camı teklif tablosunda, teklif PDF'inde ve Excel'inde cam türünün üstünde gerçek telafi
  numarasıyla etiketlenir (yeni telafi siparişi: "Telafi ALE46-T2"; var olan siparişe eklenen telafi: "ALE46 telafisi").
  Bedelsiz telafide teklifin altında fiziksel ve faturalanacak cam ayrı yazılır; bedelsiz cam faturalanmaz.
- **m² üç ondalık:** ekran, PDF ve Excel'de m² 3 ondalıkla gösterilir; hesap değişmedi.
- **Yükleme Özeti Excel'i:** tek sayfa — bilgi, firma özeti, misafir yük, ardından müşteri → sipariş blokları (sipariş
  toplamı, müşteri toplamı, para birimi başına genel toplam). Aynı ad yalnızca aynı siparişte birleşir; birim fiyat camın
  ağırlıklı ortalaması, tutara CNC / delik / sandık dahil. Onaylı günde firma özeti, sipariş blokları ve bütün toplamlar
  yalnızca fiilen yüklenen kalemlerden (10 planlanan / 8 yüklenen → her bölüm 8); onaysız günde hepsi planlanan miktardan.
  Başlıklar "PLANLANAN" / "YÜKLENEN" etiketli; ikisi aynı dosyada karışmaz. Bedelsiz telafi ayrı satır, tutarı 0. Satışta firma adları maskeli.
- **Sandık:** sandık formundaki sipariş seçim kutuları kaldırıldı; yeni sandık firmanın o günkü kendi siparişlerinin
  hepsine otomatik bağlanır, kayıtlı sandıklar bağlarını korur (başka firma / başka gün bağlanmaz). Yükleme günü firma
  satırında işlemler iki satırda: PDF / Excel, Özet / Sandık.
- **FGO:** cam proforma / avans / faturasının açıklamasında sipariş başlığı yerine belgenin kur cümlesi (kur yoksa ya da
  RON belgede boş); nihai faturada ürün adı "Sticla …" (proforma ve avans değişmedi).
- **Fiyat gizliliği:** müşteri fiyatı olmayan eski tekliflerde satış / fabrika fiyatı müşteriye ve denetimciye gösterilmez
  (tutar "—"); yükleme tutarı, yükleme onayı kopyası ve kârlılık da iç fiyata geri düşmez.

## 3.65.1 — 10.10.2026

Paket B düzeltmesi (karar 226). Veritabanı şeması değişmedi.

- **Tekliflerim tarih aralığı:** aralık yeniden teklifin **gönderildiği güne** göre seçer (eski davranış); seçilen teklifler
  yükleme gününe göre gruplanmaya devam eder (aralıktaki teklifin bütün yükleme bölümleri listelenir). Liste ve PDF aynı.

## 3.65.0 — 10.10.2026

Paket B — müşteri paneli (kararlar 226–229). Veritabanı şeması değişti (yalnızca ekleme; mevcut veri değişmez).

- **Tekliflerim yükleme gününe göre:** liste ve PDF teklifleri YÜKLEME gününe göre gruplar; her grup kendi "Göster" /
  "Gizle" düğmesiyle açılır / kapanır. Tarih aralığı yükleme gününe uygulanır; tarihi henüz belli olmayan siparişler
  "Yükleme tarihi henüz belli değil" grubunda. PDF'te her yükleme günü ayrı başlık, altında her sipariş kendi başlığıyla
  (yükleme günü + teklif tarihi + tutar), satırlar, yükleme toplamı ve genel toplam (m², cam adedi, tutar); metraj 3
  ondalıkla gösterilir (hesap değişmedi); uzun açıklamalar iki satıra kayar, uzun sipariş sonraki sayfada "devam" başlığıyla
  sürer. Kısmi yüklenen sipariş, onaylı yükleme / aktarım kayıtlarına göre her günde yalnızca kendi bölümüyle görünür;
  bölümlerin toplamı siparişin tutarına eşittir (çift sayım yok). Yalnızca müşteri fiyatı.
- **Teknik çizim:** müşterinin revizyon ekranında çizim üzerine İğne, Dikdörtgen, Serbest ve Metin işaretleri geri geldi.
  İşaretler sürüme ve revizyon talebine bağlı saklanır, sayfaya oranlıdır (yakınlaştırmada yerinde kalır); taslak sayfa
  yenilenince kaybolmaz. İşaret açıklamaları "Nota de revizie"ye "#işaret no" maddesi olarak eklenir ve notla birlikte bir
  kez çevrilir. Kayıtlı işaretleri sürümü görebilen herkes salt okunur görür. Eski sürüme karar verilemez (sunucu denetimi).
- **"Bir mesajınız var":** müşteri sipariş listesinde, okunmamış gelişmesi olan siparişin yanında kırmızı uyarı.
  Okunma kuralı daraltıldı (karar 224 → 228): sipariş sayfasını açmak uyarıları tek başına okumaz; her uyarı gösterildiği
  bölüm (çizim, teklif, kararlar, teslim, sayfa başlığı) ekranda gerçekten görülünce, mesaj ise kendisi görülünce yalnızca
  o kullanıcı için okunur. Sayfa yeniden çizdirilmez; zil ve sayaçlar korunur.
- **Fiyat listeli profil siparişi:** firmaya bağlı etkin profil fiyat listesi olan müşteri, Yeni Profil Siparişi
  formunda fiyatları, satır tutarlarını ve toplamı görür; alış günü zorunlu, telefon ve plaka isteğe bağlı. Sipariş
  yönetici teklifi ve müşteri onayı olmadan doğrudan onaylı açılır (FGO açıksa tek proforma; stok rezervesi ve stok
  uyarısı olağan). Fiyatı belli olmayan ürün varsa ya da liste pasifse eski akış. Çift tıklama / yeniden deneme ikinci
  sipariş açmaz (tek seferlik form anahtarı).
- **Teslim bilgisi ve depo formu:** müşteri teslim bilgilerini alış gününden bir gün öncesine kadar değiştirebilir.
  Alış günü, telefon ve plaka tamamlanmadan sipariş depoya gönderilmez ve depo e-postası gitmez; "Ödeme alındı" yalnızca
  ödemeyi kaydeder, bilgiler tamamlanınca ödenmiş sipariş bir kez depoya iletilir. Eksikler sipariş sayfasında yazılır.
- Veritabanı şeması: `ProfileOrder.direct`, `ProfileOrder.requestKey` (benzersiz) — yalnızca ekleme.

## 3.64.1 — 10.10.2026

Paket A düzeltmesi (karar 224). Veritabanı şeması değişmedi.

- **Sipariş açılınca okundu:** işaretlemeden sonra sipariş sayfası artık yeniden çizdirilmiyor; yalnızca zil tazeleniyor.
  Açık formların (ör. siparişi silme adımları) durumu korunuyor, "yeni" mesaj vurgusu bu ziyaret boyunca kalıyor ve
  yeniden işaretleme döngüsü oluşmuyor. Menü sayaçları bir sonraki ortak yenilemede (en geç 60 sn) güncellenir.
- Testler: müşteri silme veritabanı testinde sandık bağı bileşik anahtarla silinir; bildirim uçtan uca testi istemci
  tarafı gezinmeyle çalışır.

## 3.64.0 — 10.10.2026

Paket A — kullanıcılar, roller, güvenlik ve bildirimler (kararlar 219–225). Veritabanı şeması değişti: yeni rol
`YONETICI_YARDIMCISI`, iki yeni yetki (`OPS_SETTINGS_MANAGE`, `CUSTOMER_DELETE`), `User.deletedAt` ve `LoginEvent` tablosu
(yalnızca ekleme; mevcut veri silinmez / değişmez).

- **Yönetici Yardımcısı:** yeni rol, kendi hesabıyla; yöneticinin operasyonel yetkilerinin tamamı (siparişler ve silme,
  müşteriler ve müşteri silme, operasyonel ayarlar, fabrika ve müşteri fiyatları, teklif hazırlama / onay, mevcut FGO işlemleri,
  çizim, yükleme, sandık, stok, tedarik). Kullanıcı / rol yönetimi, kullanıcının e-postasını değiştirme, güvenlik ve kritik
  ayarlar (FGO bağlantısı, not çevirisi anahtarı, antivirüs) ve giriş logları yok — arayüzde ve sunucuda. Menüde
  "Kullanıcılar" yok; Ayarlar yalnızca operasyonel bölümlerle açılır. Yönetici yeni rolü Kullanıcılar ekranından verir.
- **Bildirimler:** yardımcı yöneticinin operasyonel e-postalarını ve zil bildirimlerini alır; hesap kilidi bildirimi yalnızca
  gerçek yöneticiye. Pasif kullanıcılara operasyonel e-posta gitmez (sipariş sahibi müşteri kullanıcısı, çizimci, satışçı,
  yönetici, diğer roller).
- **Kullanıcı silme (yalnızca yönetici):** önizleme + e-posta adresini yazarak onay; kimlik bilgileri silinir, hesap kapanır,
  adres yeniden kullanılabilir; notlar ve geçmiş "Silinmiş kullanıcı" olarak kalır. Yönetici hesabı ve kişinin kendi hesabı
  silinemez.
- **Müşteri silme (yönetici ve yardımcısı):** firma sayfasında önizleme (silinecek kayıtlar, engeller) + firma adını yazarak
  onay. Yalnızca o firmanın siparişleri ve onlara bağlı kayıtlar silinir; başka müşteriler, paylaşılan dosyalar, ortak
  yüklemeler ve denetim kaydı kalır. FGO belgesi / ödeme / onaylı yükleme / teslim kaydı gibi resmî ya da değiştirilemez izi
  olan firma silinemez. Toplu silme yok.
- **E-posta değişikliği (yalnızca yönetici):** biçim ve benzersizlik denetimi; önce yeni adrese tek kullanımlık, süreli kod
  gider (gönderilemezse hiçbir şey değişmez), sonra adres değişir, şifre sıfırlanır, bütün oturumlar kapanır; denetim kaydı.
- **Giriş Logları (Ayarlar, yalnızca yönetici):** kullanıcı, rol, tarih / saat, IP, sonuç; süzgeç ve sayfalama; 365 gün
  saklanır, sonra otomatik silinir. Şifre, kod ve denenen e-posta adresi kaydedilmez; kimliği kesin olmayan deneme "Bilinmeyen
  hesap".
- **Sipariş uyarıları:** iç ekibin sipariş listesinde kullanıcıya özel mavi sayaç (yeni gelişme); sipariş sayfası açılınca
  yalnızca açan kullanıcının o siparişteki uyarıları ve mesajları okunur (karar 205'in yerine). Müşteri göstergesi Paket B'de.
- **Mesajlar:** sipariş notları "Mesajları göster" düğmesi olmadan doğrudan açık. Müşterinin Yeni Sipariş formundaki ilk mesajı
  sipariş oluşturulduktan sonra bir kez Türkçeye çevrilir (yönetici, yardımcısı, satış, çizim görür; denetimci yalnızca özgün).
- Testler: `test/paket-a.test.js`, `test/db/paket-a.test.js`, `e2e/48-paket-a.spec.ts`; yetki matrisi, bildirim kitleleri,
  Paket 9 okuma kuralı ve yapı testleri yeni kararlara göre güncellendi. Gerçek FGO / ANAF / SMTP / Google çağrısı yok.

## 3.63.0 — 09.10.2026

Yönetici paneli düzeltme paketi 1 (kararlar 215–218). Veritabanı şeması değişmedi.

- **Yükleme sayfası:** üst açıklamalar kısaldı, firma tablosu sıkılaştı (kısa başlıklar, tam adı üzerine gelince). Firma
  satırında yönetici "PDF | Excel | Özet | Sandık", satış yalnızca "Sandık" görür; firma PDF / Excel / Özet adresleri satışa
  sunucuda da kapalıdır (satışın nakliye listesi ve günün Yükleme Özeti değişmedi). Masaüstünde yatay kaydırma yok: tablo
  alanına sığmazsa her firma etiketli bir kart olur; geniş ekranda dört işlem tek satırda; telefonda (390 px) taşma yok.
- **Firma PDF / Excel:** her siparişin teklif satırları ("Tekliflerim" ayrıntısında: açıklama, poz, ölçü, adet, m², birim
  fiyat, tutar, ara toplam); sandık parası ayrı kalem; yalnızca müşteri teklif tutarı (fabrika tutarı yok), farklı para
  birimleri ayrı toplanır. Excel'de ikinci sayfa ayrıntı; PDF ile aynı veri. Logo, düzen ve dosya adları aynı.
- **Özet:** yöneticide fabrika satış ve müşteri teklifi para birimi başına ayrı kutularda, sipariş tablosunda ve her
  siparişin satırlarında ayrı sütun gruplarında; adet, m², CNC, delik, sandık ve ağırlıklar aynı hesaptan.
- **Sandık:** yönetici ve satış mevcut yetkiyle düzenler; kaydedince firma satırı ve Özet güncellenir; misafir yükün sandığı
  ve ağırlığı yine bir kez sayılır. Dar ekranda sandık formu da etiketli ızgaradır.
- **Profil Siparişleri:** yöneticinin menüsünde profil sipariş listesi, katalog, hesaplama ayarı, profil fiyatları ve stok
  tek bölümde; bölüm adının yanında fiyatını bekleyen yeni profil siparişlerinin sayısı (kırmızı yuvarlak, sunucuda sayılır).
- **Yöneticinin "Sıra bende"si:** yalnızca Yeni siparişler, Teklif hazırlanacaklar, SLA riski / gecikenler ve Profil — fiyat
  bekleyenler. Fiyat onayı bekleyen teklifler Teklifler sayfasında, çizim tabloları Çizim Paneli'nde. Satışın ekranı aynı.
- **Yöneticinin e-postaları:** yeni müşteri siparişi (cam ve profil), satışın fabrika fiyatını gerçekten değiştirmesi (aynı
  fiyatı yeniden göndermek e-posta üretmez), satışın teklifi geri alması (yöneticinin zilindeki eski "teklif gönderildi"
  bildirimi de okunmuş sayılır), telafi camında farklı fiyat / bedelsiz kararı ve müşterinin profil teklifini onaylaması.
  Şifre sıfırlamada yöneticiye e-posta yok. Olay başına bir e-posta; yeniden denemede tekrar gitmez; işlemi yapan yöneticiye
  kendi işlemi gitmez; tutar yazılmaz. Diğer rollerin, mali belgelerin ve kritik bildirimlerin e-postaları değişmedi.

## 3.62.1 — 09.10.2026

Satış paneli düzeltme paketi 1 — ek gereksinimler (karar 214). Veritabanı şeması değişmedi; yetkiler ve görünürlük aynı.

- **Satışın sandık parası yöneticinin düzeninde:** cam satırlarının altındaki "+Sandık" kaldırıldı. Sandık parası tablonun
  altında, "+ Cam ekle"nin yanındaki "+ Sandık parası" düğmesiyle eklenir; normal, numaralı teklif kalemidir (kendi adedi ve
  birim fiyatı, ölçüsüz). Yönetici satırı "Sandık ücreti · satışın" rozetiyle görür; yöneticinin kendi sandık bedeli satışa
  yine hiçbir yerde görünmez. Belgeler değişmedi: sandık parası faturada ve yükleme özetlerinde camın tutarına dahil,
  proformada ayrı satır; toplamda bir kez sayılır.
- **Sipariş sayfasında bölüm sırası:** teknik çizimi olan siparişte yönetici, satış, müşteri ve denetimci ekranında Sipariş
  Bilgileri → Teklif Tablosu → Teknik Çizim ve Onaylar (masaüstü ve telefonda aynı). Çizim ekibinin ekranı değişmedi.

## 3.62.0 — 09.10.2026

Satış paneli düzeltme paketi 1 (kararlar 211–213). Veritabanı şeması değişmedi.

- **Satışın sandık ücreti:** satış teklif tablosunda cam satırının "+Sandık" düğmesiyle (CNC / delik gibi) kendi sandık ücretini
  ekler ve değiştirir; satır camın altında, numarasız, adetle fiyatlanır. Yönetici satırı "Sandık ücreti · satışın" rozetiyle
  görür ve müşteri fiyatını girer. Tutar teklif toplamına bir kez girer; faturada üstündeki camın tutarına eklenir, proformada
  ayrı satırdır. Yöneticinin eklediği sandık bedeli satışa hiçbir ekranda ve yanıtta görünmez; satırların sahibi değişmez.
- **"Yöneticiye göndermeyi geri al":** satış, yöneticiye gönderdiği teklifi yönetici fiyatlandırıp müşteriye göndermeden geri
  alabilir; teklif yeniden düzenlenir ve gönderilir. Yalnızca teklifi gönderen satışçı; yönetici aynı anda gönderirse yalnızca
  biri kaydedilir. Geçmiş ve denetim kaydı durur; teklif yöneticinin fiyat onayı listesinden çıkar, yeniden gönderilince döner.
- **Uzun teklif tablosunda ↑ / ↓:** teklif yöneticiye gönderildikten sonra (salt okunur) da görünür; tablonun başına ve sonuna
  kaydırır (üst çubuğun altında kalmaz); kısa tabloda yok; telefonda da çalışır.

## 3.61.0 — 09.10.2026

Paket 10 — finans, avans faturaları, ödeme eşleştirme ve FGO güvenliği (kararlar 206–210). Veritabanı şeması yalnızca ekleme:
elle ödeme kaydı (`ManualPayment`, silinemez — veritabanı tetikleyicisi), avansın dayanağı (`FgoDocument.basis`,
`BillingBatch.basis`) ve "Önemli kararlar" tekilleştirme anahtarı (`AdminAlert.dedupeKey`). Eski kayıtlar eşleştirilmedi, hiçbir
belge kesilmedi.

- **Elle ödeme kaydı (yalnızca yönetici):** siparişin yeni "Ödemeler ve avans" kartında ödeme tarihi, tutar, para birimi, yöntem
  ve açıklama / referans ile. Kayıt FGO'da belge kesmez; EUR ödeme proformanın kayıtlı kuruyla RON'a çevrilir. Kayıt silinmez,
  gerekçeyle geçersiz kılınır; her şey denetim kaydına yazılır.
- **Aynı ödeme iki kez avanslanmaz:** avans faturası = FGO'nun doğruladığı tahsilat ile elle kayıtlardan büyük olanı − avansı
  kesilen. 2.000 EUR elle kaydedilip avansı kesildikten sonra aynı tutar FGO'da görünürse ikinci avans faturası istenemez.
  Kısmi, fazla ve uyuşmayan ödemeler "inceleme gerekli" olarak gösterilir.
- **Aynı müşteride aynı tutar:** başka siparişte aynı tutarlı ödeme / avans varsa kayıt da avans isteği de durur; yönetici
  eşleşmeleri görüp kutuyu işaretleyerek açıkça onaylar, onay "Önemli kararlar"a düşer.
- **Profil siparişi:** cam kuralıyla isteğe bağlı avans faturası; teslim faturası kesilmiş avansları eksi satırla düşer ve
  avansı kesilmemiş tahsilat yüzünden beklemez.
- **Sonucu belirsiz FGO belgesi:** belge kesme isteği FGO'ya ulaşmış olabilir ama yanıt alınamadıysa iş yeniden gönderilmez;
  yönetici FGO'yu kontrol edip belgeyi seri + numarayla doğrulayarak kaydeder, ya da belge yoksa açık onayla yeniden gönderir /
  vazgeçer. Bağlantı hiç kurulamadıysa eskisi gibi yeniden denenir.
- **"Önemli kararlar":** elle kayıt ile FGO uyuşmazlığı, fazla ödeme, FGO'da doğrulanmayan elle avans, iptal edilmiş siparişin
  proformasına tahsilat, onaylanan aynı tutar ve belirsiz FGO belgesi — her durum bir kez; kayda giden bağlantıyla.
- Değişmeyenler: BT kuru kuralı (günlük elle kur, saklanan kur değişmez), mali belge e-postası (TAKİP gönderir; E-mail facturare →
  firma e-postası → "Email yok"), tedarikçi / fabrika / nakliye / kârlılık ekranları, satış ve çizimde firma maskesi.

## 3.60.0 — 09.10.2026

Profil ve aksesuar hesaplayıcısı (korkuluk kuralları) ve Paket 9 mesaj "okundu" düzeltmesi (kararlar 203–205). Veritabanı
şeması: sistem türü (`ProfileSystem.kind`: korkuluk profili / küpeşte) ve cam kalınlığının müşteriye görünen adı
(`ProfileGlassThickness.label`); migration elle yazıldı, yalnızca sütun ekler.

- **Korkuluk hesaplayıcısı hazır gelir:** FBL 90 / FBL 115 korkuluk profilleri, MR23 / RM29 küpeşteler ve 6+6 / 8+8 cam
  hesaplayıcı ayarına bir kez yazılır (yönetici bir değer girmek zorunda değil). FBL: 6 m boy, her boy için bir PANA-L ve bir
  PANA-12 (6+6) / PANA-16 (8+8) poşeti; MR23: 6 m boy + MC12 (27 m / kutu, 6+6) ya da MC16 (43 m / kutu, 8+8); RM29: RM12 (6+6) /
  RM16 (8+8), conta yok. GK15 ve AD45 hesaplayıcıya girmez. Yöneticinin değiştirdiği ayar ve paket içerikleri ezilmez; katalogda bir
  kod eksikse ya da birimi yanlışsa hiçbir şey yazılmaz ve hesaplayıcı ayarı sayfası eksik kodları gösterir.
- **Müşteri ekranı:** Cam tipi, Profil rengi (7016 MAT / Eloxat), Profil tipi, Küpeşte (Yok / MR23 / RM29) ve Toplam metre —
  masaüstünde tek satır, tablet ve telefonda alt alta, taşma yok. Profil ve küpeşte birlikte hesaplanır; sonuç tablosu ürün kodu,
  açıklama, renk, miktar ve birimi gösterir. Forma aktarım eskisi gibi: üzerine yazılacak miktarlar önce gösterilir, onaysız hiçbir
  şey değişmez. Hesap sipariş, stok hareketi veya bildirim oluşturmaz. Türkçe ve Romence.
- **Yönetici:** hesaplayıcı ayarında sistemin türü (korkuluk profili / küpeşte / müşteriye gösterilmez) ve cam kalınlığının adı
  (ör. 6+6) düzenlenir; değişiklikler denetim kaydına yazılır.
- **Mesaj okundu düzeltmesi:** siparişi açmak, yenilemek ve otomatik yenileme mesajları artık okumaz. Okunmamış mesaj varsa Notlar
  listesi kapalı başlar ("Mesajları göster (n yeni)"); mesaj ekranda görülünce okunur (sayaç ve zil bildirimi birlikte). Mesaj
  bildirimine tıklamak Notlar bölümünü açar, bildirimi mesaj görülünce okur; öbür bildirimler eskisi gibi tıklanınca okunur.
  Okunma kullanıcıya özeldir; başka kullanıcının sayacı değişmez.

## 3.59.0 — 09.10.2026

Fonksiyonel paket 9 — genel UX, bildirimler, dil ayarları, anlık arama ve oturum güvenliği (kararlar 198–202). Veritabanı şeması:
mesajların okunma kaydı (`OrderNoteRead`, kullanıcı + sipariş) ve not formunun tek kullanımlık anahtarı (`OrderNote.requestKey`).
Migration elle yazıldı: mevcut notlar okunmuş sayılır (eski mesajlar birden kırmızı sayaç olarak çıkmaz); notlara dokunulmaz.

- **Dil ayarı bütün rollerde:** "Ayarlar" (müşteri) / "Hesabım → Hesap ayarları" (iç ekip): Otomatik (varsayılan — giriş ekranının
  algıladığı dil), Türkçe, Română. Seçilen dil hemen geçerli olur ve her yeni girişte kullanılır. Bildirim sesi her rolde; e-posta
  tercihi yalnızca müşteride.
- **Müşteri e-postasının dili:** olay oluşturulurken belirlenip saklanır (kayıtlı tercih → Otomatik'te algılanan dil → Romence);
  işçi sonradan değiştirmez. Tedarikçi sipariş e-postası her zaman Türkçe; mali belge e-postaları değişmedi.
- **Mesaj sayaçları:** okunmamış mesaj sayısı kırmızı sayaçla sipariş listesinde (satırda, mesajlara götürür), sipariş sayfasının
  "Notlar" başlığında (yeni mesajlar işaretli) ve sol menüde "Siparişler"in yanında. Sayı kullanıcıya özel ve kalıcıdır; yalnızca
  görebildiği siparişler ve mesajlar (müşteri iç notu saymaz), başkasının yazdığı mesajlar. Sipariş açılınca okundu olur (geri
  gitmez); yenileme sayacı geri getirmez.
- **Bildirim zili:** müşteriye açık her mesaj tek bildirim — müşterinin mesajı yöneticiye, ilgili satışçıya ve atanmış çizimciye
  (profil siparişinde yalnızca yöneticiye); iç ekibin mesajı müşteriye; iç not kimseye. Bildirim hemen düşer, tıklayınca mesajlara
  gider; mesaj metni bildirime girmez; satış / çizimde firma adı maskeli. Sipariş açılınca o mesajların bildirimi de okunur.
- **Tekilleştirme:** çift tıklama / yeniden gönderim / paralel istek ikinci mesaj ve ikinci bildirim yazmaz (tek kullanımlık form
  anahtarı); diğer olaylar mevcut tekilleştirmeyle.
- **Anlık arama:** sipariş listelerinde ve cam kataloğunda yazdıkça süzer (300 ms); geç gelen eski yanıt yenisini ezmez; boş arama
  normal liste; "Aranıyor…" ve "sonuç yok" durumları; firma adıyla arama yok; liste sunucuda süzülür (en çok 300 satır).
- 30 dakika hareketsizlik çıkışı ve not çevirisi değişmedi; testlerle yeniden doğrulandı. Paket 7 ve Paket 8 ekranları aynı.

## 3.58.1 — 08.10.2026

Paket 8 doğrulama düzeltmesi (davranış değişmedi): teslimat belgesi yardımcılarının (`deliveryDocs`, `takesDeliveryDocs`) tür
bildirimleri eklendi — sipariş sayfası ve depo bağlantısı sayfasındaki fotoğraf / rapor listeleri tip denetiminden geçer.

## 3.58.0 — 08.10.2026

Fonksiyonel paket 8 — depo, teslimat, çalışma takvimleri ve teslimat belgeleri (kararlar 192–197). Veritabanı şeması: çalışma
takvimi istisnası (`WorkCalendarOverride` + enum `WorkCalendar`), teslimat fotoğrafı (`DeliveryPhoto`) ve teslimat raporu
(`DeliveryReport`). Migration elle yazıldı: tablolar ve fotoğraf / raporun değişmezliği (veritabanı tetikleyicisi) aynı adımda;
mevcut verilere dokunulmaz.

- **Çalışma takvimleri (Ayarlar → Çalışma Takvimleri):** Romanya deposu (Europe/Bucharest) ve Türkiye fabrikası
  (Europe/Istanbul) için iki ayrı takvim. Hafta sonu ve resmî tatiller otomatik kapalı; yönetici bir günü elle açık ya da kapalı
  işaretler (otomatik kuraldan önce gelir; denetim kaydında). Tatil verisi kodla gelir ve sürümlenir
  (`server/calendar/holidays.js`: Romanya ve Türkiye 2026–2027, dinî bayramlar dahil; her yıl iki kaynakla doğrulandı); sayfa
  açılışında dış servise bağlanılmaz; verisi olmayan yıl tahmin edilmez — yöneticiye açık uyarı. Cam siparişlerinin yükleme
  tarihi formülü ve tarihleri değişmedi.
- **Profil teslim günü (12:00 kuralı):** teslim günü siparişin depoya iletildiği ana göre ("Ödeme alındı" ya da "Siparişi depoya
  gönder"): depo çalışma gününde 12:00'ye kadar → bir sonraki çalışma günü; 12:00'den sonra → ondan sonraki çalışma günü; hafta
  sonu / tatil / kapalı günde → ilk çalışma gününün ertesi. Saat sunucuda (Bükreş saati). Onay ekranındaki en erken gün aynı
  kuraldan; iletim anında erken kalan gün ileri kayar ve müşteriye bildirilir. Müşteri ekranında "Teslimat" kartı: tahmini gün,
  durum, "tahminidir, stok hesaba katılmaz" açıklaması. Yönetici günü depoda iken de değiştirir: denetimde, geçmişte ve müşteriye
  değişiklik başına tek bildirim (uygulama içi + tercihe bağlı e-posta). Stok yetersizliği siparişi engellemez.
- **Teslimat fotoğrafları:** depo bağlantısı ve yönetici, depoya iletilmiş siparişe birden çok fotoğraf ekler (JPG / PNG,
  fotoğraf başına 20 MB; içerik denetimi, antivirüs, kota). Her fotoğraf ayrı yüklenir — biri reddedilirse ötekiler kalır;
  ilerleme ve hata fotoğraf başına görünür; aynı fotoğraf ikinci kez kayıt olmaz (eşzamanlı istekte de). Siparişin müşterisi ve
  siparişi gören iç ekip görür; başka firma, satış ve çizim göremez; müşteriye iç ekipten kişi adı gitmez.
- **Teslimat raporu:** depo bağlantısı ya da yönetici oluşturur — oluşturulduğu anın kopyası (sipariş no, firma, teslim günü,
  ürünler ve miktarlar, durum, açıklama, fotoğraflar); sonradan değişmez, her yeni rapor yeni sürüm. PDF ortak altyapıyla (GKH
  logosu, sayfa numarası, Türkçe / Romence harfler; telefon fotoğrafının yönü düzeltilir), görenin dilinde. Yönetici ve müşteri
  siparişin sayfasından açar; bağlantı kalıcıdır (teslimden ve arşivden sonra da), yetki her açılışta denetlenir; sipariş
  geçmişindeki kayıt rapor listesine götürür.
- **Depo akışı ve teslim onayı değişmedi:** yeni durum yok; stok yalnızca depoya iletimde düşer (çift düşüm yok), iptal bir kez geri
  ekler; teslim onayı bir kez işlenir (ikinci onay yeni olay, stok hareketi ya da bildirim yazmaz). Teslimde FGO otomatik faturası
  aynı.
- **Tedarikçi tahmini yükleme tarihi:** Türkiye fabrikasının kapalı gününe (hafta sonu, resmî tatil, elle kapalı gün) denk gelirse
  yöneticiye uyarı; tarih ve 2 takvim günü önceki hatırlatma değişmez.
- Testler: `test/calendar.test.js`, `test/delivery.test.js`, `test/db/delivery.test.js`, `e2e/42-depo-teslimat.spec.ts`; profil,
  bildirim ve yükleme yolu testleri yeni kurala göre güncellendi.

## 3.57.1 — 08.10.2026

Paket 7 doğrulama düzeltmesi: Yüklemeler'de ev sahibi firmanın sandık formu, satış sandığı seçtikten hemen sonra (sayfa
yenilenmeden) misafir yükün satırını sandığın altında gösterir — misafir yük bilgisi formun iç durumundan değil, sunucudan gelen
güncel veriden okunur (kaydedilen yeni sandıklar da hemen eşleşir; misafir yükü olan sandığın numarası değiştirilemez, sandık
silinemez). Uçtan uca testlerde tablo başlıkları (ekranda CSS ile büyük harf) metin içeriğiyle karşılaştırılır.

## 3.57.0 — 08.10.2026

Fonksiyonel paket 7 — Yüklemeler firma tablosu, misafir yük, sandıklar, takvim ve Excel / PDF standardı (kararlar 186–191).
Veritabanı şeması değişmedi (migration yok).

- **Firma bazlı yükleme tablosu:** her yükleme gününde firma başına TEK satır — Firma, Sipariş adedi, Cam adedi, CNC adedi,
  Delik adedi, Toplam m², Net ağırlık, Sandık adedi, Brüt ağırlık, Fabrika satış tutarı, Teklif tutarı, İşlemler. Firma adına
  tıklayınca alt siparişler açılır (Sipariş No · Cam · CNC · Delik · Toplam m² · Fabrika Satış · Teklif Tutarı); ana satır ve alt
  toplam aynı işlevden gelir, her zaman eşittir. Sipariş adedi ile cam adedi ayrıdır; fabrika satış ve teklif tutarı karışmaz;
  farklı para birimleri toplanmaz. Tutar sütunları role göre (fabrika satış: yönetici, satış · teklif: yönetici, denetimci).
  Tek atıf kuralı `server/loading/day-firms.js`: ticari değerler siparişin sahibinde, sandık / ağırlık camı taşıyan firmada.
- **Firma işlemleri:** Sandık (firmanın o günkü sandıkları), PDF, Excel (yalnızca o firma ve gün; finansal olarak yalnızca
  müşteri teklif tutarı — fabrika satış tutarı hiçbir rolde yok, satışın çıktısında tutar yok) ve Özet (firma + gün; fabrika satış
  ve teklif tutarı yalnızca yöneticide). Yetki sunucuda: müşteri ve çizim erişemez, başka gün / firma veri döndürmez.
- **Misafir yük:** A'nın siparişi B'nin sandığıyla gidiyorsa sipariş A'nın satırında kalır; sandık ve ağırlık B'de bir kez
  sayılır (brüt iki kez hesaplanmaz); A için sandık açılmaz. A'nın sandık bölümünde açık uyarı "Bu sipariş [B] firmasının
  sandıkları ile gelecektir."; misafir sipariş için "+ Sandık ekle" kapalı ve sunucu da reddeder (`GUEST_ORDER`, `GUEST_ONLY`);
  ev sahibi seçilince siparişin kendi firmasındaki sandık bağı kalkar. B'nin sandık listesinde misafir camın sipariş / cam
  bilgisi görünür. İlişki kalkınca normal sandık yönetimi.
- **Takvim:** sağ üstte iki eşit yuvarlak — açık sarı (koyu sayı) günün sipariş sayısı, açık kırmızı / pembe (koyu kırmızı sayı)
  misafir yük sayısı (gerçek ilişkilerden; 0 ise gösterilmez); sayı yuvarlağın içinde, mobilde de.
- **"Yükleme yapıldı":** "Eksiksiz Yüklendi" düğmesinin adı "Yükleme yapıldı"; onaydaki "Yüklenmeyen cam var" girişi kaldırıldı
  (yüklenmeyen cam kayıttan sonra "Düzelt" ile girilir). Fatura hatırlatma sayacı bu kayıttan sonra başlar (uyarı günü = kaydın
  günü + ayardaki gün). İşlem tekrarlanamaz: yeni kayıt / hatırlatma oluşmaz. FGO, 45 gün arşiv ve "Yüklendi" kuralları değişmedi.
- **Yükleme Özeti (Excel):** "Sandık (Fiziksel)" sütunu kaldırıldı; firma bazlı özet (firma tablosuyla aynı hesap), misafir yük
  ayrı tabloda (ticari sahip · fiziksel sandık sahibi · sandık), satır dökümü ikinci sayfada.
- **Excel / PDF standardı:** bütün Excel çıktıları ortak yazıcıdan (`server/files/xlsx-report.js`): saydam PNG logo (oran
  korunur), başlık ve tarih, biçimli başlık satırı, sütun genişlikleri, AutoFilter, dondurulmuş başlık, birim / ondalık / para
  biçimleri, metin kaydırma, gereksiz boş satır / sütun yok, baskı alanı ve sayfa düzeni, yinelenen başlık. PDF'lerde ortak
  logo ve ortak altbilgi (firma adı + sayfa / toplam); yeni firma yükleme PDF'i. İçerik ve yetkiler değişmedi; müşteri
  çıktılarında fabrika fiyatı yok.
- **Dosya adları** panel dilinde ve güvenli karakterlerle (`server/files/export-name.js`, `lib/exports.ts`):
  "Yukleme-Ozeti-2026-10-08.xlsx" / "Rezumat-Incarcare-2026-10-08.xlsx", "Tekliflerim-…pdf" / "Ofertele-Mele-…pdf",
  mali belge PDF'i "Fatura-GKH101.pdf" / "Factura-GKH101.pdf" (belge numarası ve içerik aynı).
- **Maskeleme:** satış (ve çizim) firma adlarını her yerde ilk 3 karakter + 10 yıldız görür — tablo, alt sipariş, takvim, misafir
  uyarısı, sandık ekranı, ipuçları, sayfa verisi ve çıktılar; sunucuda.
- Testler: `test/day-firms.test.js`, `test/firm-export.test.js`, `test/xlsx-report.test.js`, `test/db/guest-crates.test.js`,
  `test/db/notifications.test.js` (sayaç kayıttan başlar), `e2e/41-yukleme-firma.spec.ts`; yükleme, muhasebe ve müşteri e2e'leri
  yeni ekrana göre güncellendi.

## 3.56.0 — 08.10.2026

Fonksiyonel paket 6 — tedarikçi yönetimi, satın alma ve tedarikçi hesapları (kararlar 179–185). Veritabanı şeması: tedarikçi
(`Supplier`), tedarikçi siparişi, revizyonu, satırı ve teknik eki (`SupplierOrder` + enum `SupplierOrderStatus`,
`SupplierOrderRevision`, `SupplierOrderLine`, `SupplierOrderFile`), tedarikçi ödemesi (`SupplierPayment`), ürünün alış bilgisi
(`ProfileProduct.supplierId` / `purchasePrice` / `purchaseCurrency` / `purchaseUnit`) ve yeni yetki `SUPPLIER_MANAGE` (yalnızca
yönetici). Migration elle yazıldı: tablolar ve kesinleşmiş revizyonun değişmezliği (veritabanı tetikleyicileri) aynı adımda.

- **Ayarlar → Tedarikçiler:** menüdeki "Entegrasyonlar" artık "Ayarlar" (aynı adres; Entegrasyonlar ve Tedarikçiler sekmeleri).
  Tedarikçi: firma adı, iletişim kişisi, e-posta, telefon, adres, para birimi, etkin / pasif — sabit liste yok, silinmez (pasif
  yapılır). Sipariş e-postası yalnızca burada kayıtlı tek adrese gider; e-posta yoksa ya da geçersizse gönderim engellenir ve
  açık hata gösterilir. Her değişiklik denetim kaydında.
- **Ürün–tedarikçi ilişkisi:** Profil Kataloğu'ndaki ürün formunda (yalnızca yönetici) tedarikçi, alış fiyatı, alış para birimi,
  sipariş birimi; müşterinin fiyatından ayrı. Kayıtlı alış fiyatı siparişe yalnızca aynı tedarikçi ve aynı para biriminde gelir;
  fiyatı olmayan ürün siparişe eklenir, "Fiyat yok" olarak görünür — fiyat uydurulmaz.
- **Tedarikçi Siparişleri** (menüde "Satın Alma"): taslak (numara TS-yıl-sıra, değiştirilebilir), satırlar (ürün kodu, açıklama,
  Renk/RAL, miktar, birim, birim alış fiyatı, toplam), genel toplam, not, teknik ekler. Profil Stoğu satırından ve kritik stok
  listesinden "Sipariş hazırla". Taslağı kaydetmek, ürün / tarih değiştirmek, ek eklemek, sayfayı yenilemek e-posta göndermez;
  tedarikçiye yalnızca "Siparişi onayla / gönder" ile gider (içerik kesinleşir, mevcut e-posta kuyruğuna tek iş yazılır). İşçi
  e-postayı en çok bir kez gönderir: çift tıklama, eşzamanlı istek, yenileme ya da yeniden deneme ikinci e-posta üretmez; gönderim
  sırasında yarıda kalan iş belirsiz sayılır ve kendiliğinden yeniden gönderilmez; gönderilemeyen sipariş "Gönderilemedi" olur
  (asla "Gönderildi" değil), yöneticiye bildirilir ve "Tekrar gönder" ile açıkça yeniden yollanır. Gönderilmiş sipariş
  değiştirilmez; değişiklik yeni revizyonla yapılır ve ayrıca onaylanıp gönderilir. Gönderim geçmişi ve işlem geçmişi siparişte.
- **E-posta:** tek merkezi Türkçe şablon — konu "GKH Trading Invest – Sipariş [NO] – [TEDARİKÇİ]", tablo Ürün Kodu · Açıklama ·
  Renk/RAL · Miktar · Birim · Birim Fiyat · Toplam (fiyatı olmayan satır varsa fiyat sütunları ve genel toplam kaldırılır), not,
  ekler, kapanış ve "GKH Trading Invest SRL"; üstte ortak saydam GKH logosu.
- **Tahmini Yükleme Tarihi:** yalnızca yönetici elle girer ve değiştirir; cam siparişlerinin yükleme tarihleriyle ilgisi yok,
  müşteriye gösterilmez. Tarihten 2 takvim günü önce yöneticiye uygulama içi hatırlatma (sipariş + tarih başına bir kez; tarih
  değişince yeni tarihe göre).
- **Tedarikçi Hesapları:** para birimi başına toplam borç (onaylanmış siparişler; taslak borç oluşturmaz, iptal düşer), toplam
  ödeme, kalan; fiyatı eksik siparişler ayrıca gösterilir. Ödemeyi yönetici elle girer (tarih, tutar, para birimi, açıklama);
  aynı form iki kez gelse de bir kez yazılır; ödeme silinmez, gerekçeyle iptal edilir. Para birimleri toplanmaz.
- **Stok:** sipariş oluşturmak, e-posta göndermek, tarih girmek ve "Teslim alındı" stoğu değiştirmez (giriş Profil Stoğu'ndan);
  açık siparişlerdeki "Beklenen" miktar yöneticiye ayrı sütunda gösterilir. Denetimci, satış, çizim ve müşteri tedarik verisine
  erişemez.
- Testler: `test/suppliers.test.js`, `test/db/suppliers.test.js`, `e2e/40-tedarikci.spec.ts`; yükleme yolu, istek gövdesi,
  bildirim ve marka testleri yeni yolu da kapsar.

## 3.55.3 — 08.10.2026

Paket 5 doğrulama düzeltmesi: hesaplayıcının kalem adları büyük / küçük harf ve Türkçe noktalı / noktasız I ayrımı yapmadan
eşleşir — "Profil", "PROFIL", "PROFİL" ve "profıl" aynı kalemdir. Önceden Latin klavyeyle büyük harfle yazılan "PROFIL" ayrı bir
kalem sayılıyor, aynı kalemde çakışan satır reddedilmiyordu. Birim testi eklendi.

## 3.55.2 — 08.10.2026

Paket 5 doğrulama düzeltmesi: hesaplayıcının okuma servisleri (`loadCalcAdmin`, `loadCalcOptions`) dönüş türlerini açıkça
bildiriyor — yöneticinin "Profil Hesaplayıcı" sayfası ile müşterinin yeni sipariş sayfası tür denetiminden geçer. Davranış
değişmedi.

## 3.55.1 — 08.10.2026

Paket 5 doğrulama düzeltmesi: yeni salt okunur stok yetkisi (`STOCK_VIEW`) veritabanının yetki listesine (`PermissionKey`) de
eklendi — temel veriler (seed) rol yetkilerini bu listeyle eşitlediği için yetki şemada yokken kurulum duruyordu. Yeni birim testi:
yetki matrisindeki her anahtar şemada, şemadaki her anahtar matriste. Davranış değişmedi.

## 3.55.0 — 08.10.2026

Fonksiyonel paket 5 — profil hesaplayıcı ve stok yönetimi (kararlar 175–178). Veritabanı şeması: ürünün paket içeriği ve kritik
stok eşiği (`ProfileProduct.packContent` / `packMeasure` / `criticalStock`), hesaplayıcının cam kalınlıkları, sistemleri ve
satırları (`ProfileGlassThickness`, `ProfileSystem`, `ProfileCalcItem`), salt okunur stok yetkisi (`PermissionKey.STOCK_VIEW`);
migration CI'da üretilir.

- **Profil hesaplayıcı (yönetici yapılandırır):** Profil Kataloğu → "Profil Hesaplayıcı": cam kalınlıkları, sistemler (ör. MR23,
  RM29) ve her sistemin kalemleri — ürün, renk (RAL 7016 / Eloxat) ya da cam kalınlığı koşulu, 1 m korkuluk için tüketim. Bir
  kalemin satırları birbirinin seçeneğidir (MR23'ün conta kalemi: 12,76 mm → MC12, 16,76 mm → MC16; RM29'da bu kalem yoksa MC
  hesaplanmaz); çakışan satır eklenemez. Ürünün paket içeriği (kutu = conta metresi, bar = profil boyu, poşet = parça) katalogdaki
  ürün formunda. Adet = yukarı yuvarla(metre × tüketim ÷ paket içeriği); aynı ürün iki kalemde geçerse ihtiyaç toplanıp bir kez
  yuvarlanır. Yalnızca kesin paket içerikleri gelir: GK15 137, AD45 24, MC12 27, MC16 43 m / kutu — katsayı, bar boyu, torba
  içeriği, kalınlık ve sistem tahmin edilmez; RM29 kendiliğinden eklenmez. Her değişiklik denetim kaydında.
- **Eksik değer:** seçime uyan satır, tüketim ya da paket içeriği yoksa hiçbir miktar üretilmez; ekran eksik değeri ve yerini
  adıyla söyler (müşteriye ayrıca "yöneticinin tamamlaması gerekiyor"). Yöneticinin ekranında sistem başına "Eksikler" listesi ve
  "Hazır" rozeti.
- **Müşteri:** profil siparişi formunun üstünde yatay "Metraj hesaplayıcı" (sistem, renk, cam kalınlığı, toplam metre). Sonuç
  mevcut forma aktarılır ve değiştirilebilir ("hesaplandı" / "değiştirildi" işareti); yeniden hesapta üzerine yazılacak adetler
  önce gösterilir ("Vazgeç" / "Evet, üzerine yaz"). Köşe, kapak, flanş gibi adetli aksesuarlar elle eklenir. Sipariş akışı aynı.
- **Stok uyarısı engellemez:** "Siparişi gönder"den önce yetmeyen ürünler gereken / mevcut / eksik ile gösterilir ("Yine de
  gönder"); siparişte tek "Önemli kararlar" kaydı (değişmedi). Müşteri yalnızca kendi siparişindeki eksik ürünlerin değerlerini
  görür (mevcut eksiye düşmez); genel stok listesi müşteriye, satışa ve çizime gitmez.
- **Stok ekranı:** "Rezerve" sütunu (onaylı, depoya gitmemiş siparişlerin adedi — stok hareketi değildir), ürün başına kritik
  eşik ve durum. Stok eşiğe inince ürün başına tek "Kritik stok" kaydı ("Önemli kararlar"). Denetimci stok ekranını salt okunur
  görür (Excel ve değişiklik yok).
- **Eşzamanlılık:** sayım, Excel'den stok, depo çıkışı ve iptal iadesi aynı ürün kilidini aynı sırayla alır — sayımın kaydettiği
  önce / sonra her zaman gerçek stoktur. Eski stok hareketleri ve siparişler değişmedi.

## 3.54.0 — 08.10.2026

Fonksiyonel paket 4 — yönetici paneli, sipariş ve teklif yönetimi (kararlar 170–174). Veritabanı şeması: teklif satırına sandık
bedeli işareti (`OfferLine.crateFee`); migration CI'da üretilir.

- **Sipariş bilgileri (yönetici):** yöneticinin sipariş ekranında "İstenen camlar" ve "Sandıklar" bölümü yok. Yalnızca sunum
  sadeleşti: sandık kayıtları, Yüklemeler'deki sandık girişi, ağırlık ve nakliye listesi aynen çalışır.
- **Müşteri fiyatı her zaman güncellenir:** gönderilmemiş teklifte olağan fiyat onayı; müşteriye gönderilmiş teklifte yeni sürüm
  ("Teklifi güncelle ve müşteriye gönder" onay penceresiyle — müşteri yeni fiyatı yalnızca bu gönderimden sonra görür; eski sürüm
  aynen kalır). Yüklendi olarak işaretlenmiş siparişte de güncellenir. FGO belgesi, müşteri belgesi, kuyrukta bekleyen belge isteği
  ya da onaylı yükleme varsa fiyat değişmez: "Teklifi güncelle" yerine neden gösterilir (belge no / onay günü); sunucu da reddeder.
- **Fiyat hareketi:** yöneticinin her müşteri fiyatı değişikliği denetim kaydına yazılır (kullanıcı, zaman, sipariş, teklif
  sürümü, satır satır eski → yeni fiyat, toplam) ve yöneticinin "Hareketler"inde görünür. Satış, müşteri ve denetimci görmez.
- **Sandık bedeli yalnızca yöneticinin:** "+ Sandık parası" yalnızca yöneticinin teklif tablosunda ("Sandık bedeli · satış görmez"
  rozeti). Yönetici ve müşteri teklifte görür, müşteri tutarına girer; satışın teklif tablosuna, sayfasına ve verisine hiç gitmez
  (satışın kaydı satırı korur, satış sandık satırı ekleyemez). Tutar, fatura ve yükleme hesabı değişmedi.
- **Bildirim:** teklif müşteriye gönderilince (ilk gönderim ya da yeni sürüm) yalnızca müşteri bilgilendirilir; satışa zil ve
  e-posta yok. Satışın öbür bildirimleri değişmedi.
- **Siparişi sil (yalnızca yönetici) iki aşamalı:** 1) silinecek sipariş numarası ve sonucu, 2) sipariş numarası yazılarak ayrı son
  onay; "Vazgeç" her adımda; sunucu da numarayı ve siparişin bu arada değişmediğini denetler. FGO belgesi, müşteri belgesi, onaylı
  yükleme, "yüklendi" işareti ya da profilde proforma / ödeme / depo / teslim kaydı olan sipariş silinmez — neden gösterilir ve
  engellenen deneme denetime yazılır. Silme yine yumuşaktır (kayıtlar durur, geri yüklenir).

## 3.53.2 — 08.10.2026

Paket 3 doğrulama düzeltmesi: müşterinin "düzeltilmiş dosya" alanının etiketi gönder düğmesinin adından ayrıldı
("Düzeltilmiş çizim dosyaları (en az bir DWG ya da DXF)" / "Fișierele corectate ale desenului …"; düğme "Düzeltilmiş dosyayı
gönder") — ekran okuyucu dosya alanını da düğme olarak okuduğu için iki öğe aynı adı taşımıyor. Uçtan uca testler çizimcinin iki
bölümlü sipariş ekranına (teknik çizim dosyaları / onay ve revizyon) göre güncellendi. İş akışı değişmedi.

## 3.53.1 — 08.10.2026

Paket 3 doğrulama düzeltmesi: teklif kontrolü kuralının belge açıklaması (JSDoc) son üretim çiziminin tarihini de kabul edecek
şekilde düzeltildi (tip denetimi). Davranış değişmedi.

## 3.53.0 — 08.10.2026

Fonksiyonel paket 3 — çizimci paneli, DWG/DXF ve revizyon (kararlar 167–169). Veritabanı şeması: yeni çizim hattı durumu
`DUZELTME_BEKLIYOR`, revizyon kaydının türü (`DrawingRevision.kind`: müşterinin talebi / "çizim hatalı" açıklaması), müşterinin
çizim kararının dosya listesi (`Drawing.sourceFiles`) ve sürüm notunun çevirisi (`Drawing.translation*`); migration CI'da üretilir.

- **DXF/DWG olarak gelen çizimler (çizim ekibinin menüsü):** müşteri çizimini DWG / DXF olarak gönderdiyse çizimci önce karar
  verir; her siparişte üç ayrı karar: **Üretime Hazır** (müşteri onayı beklenmez, sipariş "Müşteriden onaylı çizimler"e geçer),
  **Çizim Hatalı** (açıklama zorunlu; müşteriye bildirim; müşteri mevcut siparişten düzeltilmiş dosya gönderir ya da fabrikadan
  çizim ister — ikisi de çizimcinin kuyruğuna düşer), **Çizimi Güncelle** (müşterinin dosyası korunur; yeni çizim olağan "Kontrol Et →
  Müşteriye gönder" akışıyla müşterinin onayına gider). Kararlar, dosyalar ve açıklamalar geçmişte kalır; her karar denetim kaydına
  yazılır. Yönetici aynı listeyi Çizim Ekibi menüsünden açar.
- **Bildirimler gecikmeden:** müşteri onaylayınca / revizyon isteyince / dosya gönderince bildirim işlemden hemen sonra yazılır
  (işçinin turu beklenmez; işçi yedek). Onay bildirimi onaylanan çizim sürümünün ekranına götürür. Aynı olay iki kez bildirilmez,
  e-posta olay başına bir kez.
- **Revizyon:** revizyon istenen sipariş listelerde kırmızı satır ve "Revizyon istendi" rozetiyle; çizimcinin sipariş sayfasının
  üstünde kırmızı bilgilendirme (numaralı not + Türkçe çevirisi). Önceki sürümler ve talepler geçmişte kalır; eski bir sürümün kararı
  yeni sürüme taşınmaz.
- **Çizimcinin sipariş ekranı:** 1) müşteri sipariş dosyaları 2) teknik çizim dosyaları 3) çizim onayı ve revizyon 4) notlar
  5) sipariş bilgileri. Teklif / finans bilgisi yok; firma adı maskeli.
- **Çeviri:** "çizim hatalı" açıklaması ve sürümün müşteri notu bir kez Romence'ye çevrilip saklanır (müşteri görür, iç ekip özgün
  notu görür, denetimci yalnızca özgün notu). Çevrilemeyen not için iç ekipte **"Çeviriyi yeniden dene"**; aynı anda iki istek
  sağlayıcıya tek istek gönderir; tamamlanmış çeviri tekrarlanmaz; sayfa yenilemesi çeviri yapmaz.
- **Bölüm adları:** "Müşteriden onay beklenenler", "Müşteriden onaylı çizimler".

## 3.52.1 — 08.10.2026

Paket 2 doğrulama düzeltmeleri (uçtan uca testlerde bulundu; yayından önce). Veritabanı şeması değişmedi.

- **Tekliflerim:** liste yalnızca müşteri bir tarih aralığı gösterince ("Göster") yüklenir. Ana sayfanın her açılışı ve
  60 saniyelik otomatik yenileme döküm sorgusu yapmaz; aynı siparişin bağlantısı sayfada iki kez çıkmaz. Form varsayılan
  olarak bu ayı gösterir; "PDF indir" onunla da çalışır.
- **Stok yetersizliği (yönetici):** siparişteki "Stok durumu" tablosu (gereken / mevcut / eksik) sipariş gelir gelmez — fiyat
  beklerken — görünür ve stok düşene (depoya gidene) kadar kalır; 3.52.0'da yalnızca müşteri onayından sonra görünüyordu.

## 3.52.0 — 08.10.2026

Fonksiyonel paket 2 — müşteri paneli ve teklif yönetimi (kararlar 160–166). Veritabanı şeması: revizyon talebine çeviri
alanları eklendi (`DrawingRevision.translation*`; migration CI'da üretilir).

- **Cam siparişi: "Cam adedi" alanı kaldırıldı.** Müşteri yalnızca cam tipini seçer (tek cam kuralı aynen); adetleri,
  ölçüleri ve fiyatı satış ekibi dosyalara göre teklif tablosunda girer (tablo 1 adetle açılır). Sunucu formdan adet almaz.
  Eski siparişlerde girilmiş adet görünmeye devam eder. Yönetici / satış teklif tablosu değişmedi.
- **Profil siparişi (müşteri ekranı):** dosya yükleme alanı yok (sunucu da reddeder; iç ekip iç dosya ekleyebilir);
  "Depoya gönderildi" müşteride görünmez; "Teslim" yalnızca tarih (saat yok). Onay ve depo akışı değişmedi.
- **Yeni çizim:** bildirim zili siparişin "yeni çizim onayınızı bekliyor" kırmızı bilgilendirmesine götürür; sipariş
  sayfasında belirgin kırmızı uyarı; ana işlem **"Aç ve incele" / "Deschide și verifică"**. Boş "İşaretler / Marcaje"
  bölümü kaldırıldı; müşterinin revizyon ekranında çizim üzerine işaretleme yok.
- **Revizyon notu numaralı maddeler** ("Revizyon notu / Nota de revizie" altında madde başına bir alan, "+ Madde ekle").
  Not **bir kez** Türkçeye çevrilip saklanır: iç ekip özgün not + çeviriyi görür, müşteri ve denetimci yalnızca özgün notu;
  sayfa yenilemesi çeviri yapmaz. Eski işaretli talepler iç ekipte işaretleriyle görünür.
- **Tekliflerim (müşteri ana sayfası):** başlangıç / bitiş tarihi; firmanın cam teklifleri (her siparişin son gönderilen
  teklifi), liste ve **PDF dökümü** — her teklif ayrı ve ayrıntılı (cam satırları, adet, m², müşteri fiyatı), sonda toplam m²
  ve toplam tutar (para birimi başına); GKH logosu; Türkçe / Romence harfler; dosya adı panel dilinde. Yalnızca kendi
  firmasının teklifleri; fabrika / satış fiyatı hiçbir yerde yok.
- **Stok yetersizliği uyarısı (profil):** sipariş engellenmez; yöneticinin "Önemli kararlar"ına tek kayıt (gereken / mevcut /
  eksik), sipariş "Stok yetersiz" olarak işaretlenir; yönetici "Gördüm" ile kararını kapatır. Müşteri uyarıyı ve ürünleri görür,
  stok sayılarını görmez.
- **Müşteri bildirimleri:** bağlantı ilgili bölüme iner (yeni çizim → kırmızı bilgilendirme, teklif → teklif bölümü); iç
  olaylar müşteriye gitmez (test listesiyle sabit); yenileme yeni bildirim / e-posta / çeviri üretmez.

## 3.51.1 — 08.10.2026

Fonksiyonel paket 1 son düzeltme (kararlar 158–159). Veritabanı şeması değişmedi.

- **Otomatik "Yüklendi" kaldırıldı — yerine fiziksel yüklemeye bağlı otomatik arşiv.** 3.51.0'da yükleme gününden 45 gün
  geçmiş ve hâlâ "Üretimde" duran sipariş, yüklenip yüklenmediğine bakılmadan "Yüklendi" yapılıyordu; bu yanlıştı.
  - Artık sipariş hiçbir durumda yalnızca tarih geçtiği için "Yüklendi" olmaz. "Yüklendi"yi yalnızca bir kişi verir
    (satışın "Yüklendi" düğmesi).
  - **Fiziksel yüklemesi kanıtlı** sipariş, yükleme gününden **45 gün** sonra kendiliğinden **Arşivlendi** olur (mevcut arşiv
    durumu; "Yüklenen ve arşiv" sekmesi). Kanıt: satışın "Yüklendi" dediği sipariş ya da yükleme onayında camının tamamı
    yüklenmiş sipariş (yüklenmeyen camı ileri güne aktarılıp o gün yüklenmiş ya da yerine telafi açılmış olabilir). Gün,
    camın yüklendiği son gündür.
  - Yükleme onayı olmayan, camı kırık / eksik kalmış (aktarılmamış), ileri güne aktarılmış camı bekleyen, beklemedeki ya da
    yükleme onayından sonra teklifine cam eklenmiş sipariş "Üretimde" kalır.
  - Otomatik arşiv fiili yükleme gününü, sandıkları, yükleme onayını, faturaları / FGO belgelerini değiştirmez; müşteriye
    bildirim ya da e-posta gitmez; geçmişe "Arşivlendi (otomatik)" yazılır. Aynı sipariş iki kez arşivlenmez.
  - **Onarım:** 3.51.0'ın bu yolla "Yüklendi" yaptığı siparişler yayından sonraki ilk turda kendiliğinden **"Üretimde"ye
    geri alınır** (geçmişe ve denetim kaydına yazılır); fiziksel yüklemesi kanıtlı ve 45 günü dolmuş olanlar ardından arşive
    geçer. 3.51.0'ın "Yüklendi" satırı müşterinin geçmişinde artık görünmez. Bir kişinin bu arada arşivlediği ya da iptal
    ettiği siparişe dokunulmaz.
  - **Dikkat:** ilk turda yükleme günü 45 günden eski olan kanıtlı siparişler arşive geçer (satışın "Yüklendi" dediği
    siparişler "Yüklendi" → "Arşivlendi").
- **Telafi "Farklı fiyat" — teklif tutarlılığı doğrulandı:** ana siparişin adedi teklifin yeni sürümüyle düşer (eski sürüm
  durur); telafi siparişinin teklifi yönetici fiyatlandırıp gönderene kadar müşteriye görünmez — yönetici fiyatı taslak
  olarak kaydetse de; gönderince müşteri nihai teklifi görür. Yüklenmiş ya da FGO belgeli ana sipariş değişmez (telafi ek
  üretimdir).
  - **Düzeltme:** telafi açılırken ana sipariş (ya da hedef sipariş) aynı anda başka biri tarafından değiştirilirse (ör.
    yöneticinin "teklifi güncelle"si) telafi artık eski satırlardan yeni sürüm yazmaz; hiçbir şey kaydedilmez ve "Aynı anda
    başka bir işlem yapıldı" uyarısı verilir — sayfa yenilenip yeniden denenir.
- **Değişmeyen:** firma adı maskesi (ilk 3 karakter + 10 yıldız), satış paneli, iki kademeli fiyat, yetkiler.

## 3.51.0 — 08.10.2026

Fonksiyonel paket 1: satış paneli + telafi camı (kararlar 155–157). Veritabanı şeması değişmedi.

- **Satış paneli sadeleşti** (yalnızca satışçının ekranları; yönetici ve çizim ekibi aynı).
  - **Siparişler → "Sıra bende":** yalnızca **Yeni siparişler** ve **SLA riski / gecikenler**. "Onaylanmış çizimler" ve öteki
    bölümler bu sekmeden kalktı; siparişler "Tüm aktif siparişler" sekmesinde durmaya devam eder.
  - **Teklifler:** yalnızca **Fiyatımı bekleyenler** (teklif tablosu açık, teklif satışta) ve **Teklif tablosu açılmamış
    siparişler**. Yönetici onayındaki ve müşterideki teklifler satışın bu sayfasında listelenmez.
- **Otomatik "Yüklendi":** yükleme gününden **45 gün** geçmiş ve hâlâ "Üretimde" duran cam siparişi kendiliğinden
  "Yüklendi" olur ve **Yüklenen ve arşiv** sekmesine geçer (saatte bir denetlenir). Yeni bir durum yoktur — satışın
  "Yüklendi" düğmesiyle aynı durumdur; geçmişe "Yüklendi (otomatik)" yazılır. Yükleme günü ve sandıklar değişmez, müşteriye
  ayrıca bildirim gitmez. Beklemedeki, teklifi / çizimi bitmemiş ve ileri güne aktarılmış camı bekleyen sipariş kapanmaz.
  - **Dikkat:** yayından sonraki ilk saatte, yükleme günü 45 günden eski olup hâlâ "Üretimde" duran bütün siparişler bu
    sekmeye geçer. Kapanan siparişte (elle "Yüklendi" denmiş gibi) yükleme tarihi ve teklif değiştirilemez.
- **Telafi camı — kaynak adedi:** telafi açılınca ana siparişte o camın adedi telafi adedi kadar **düşer**
  (20 cam → 3 telafi → ana siparişte 17). Adet, m² ve tutar iki siparişte iki kez sayılmaz. Ana siparişin müşterideki teklifi
  yeni sürümle güncellenir (eski sürüm durur).
  - Bu yalnızca **yüklenmemiş ve belgesiz** siparişte yapılır. Yüklemesi onaylanmış, FGO belgesi olan ya da kapanmış
    siparişten açılan telafide ana sipariş değişmez (telafi eskisi gibi ek üretimdir) — ekran bunu kayıttan önce ve sonra söyler.
  - Siparişin bütün camı için telafi açılamaz (ana siparişte en az bir cam kalmalıdır).
- **Telafi camı — işlemler:** telafi edilen camın CNC / delik işlemleri telafi camına **taşınır**; taşınan işlemlerin
  **müşteri fiyatı her durumda 0**'dır (fabrika maliyeti durur). Teklif tablosundaki olağan "+" değişmedi: yalnızca cam
  cinsini çoğaltır, işlem kopyalamaz.
- **Telafi camı — fiyat:** satışın üç seçeneği vardır ve hiçbirinde fiyat giremez (müşteri fiyatı tutarını da görmez):
  - **Bedelsiz** — cam 0; teklif doğrudan müşterinin paneline gider, yönetici yeniden fiyatlandırmaz. Bedelsiz telafi
    proformaya, faturaya ve FGO'ya gitmez.
  - **Aynı fiyat** — yöneticinin kaynak siparişte verdiği müşteri fiyatı kendiliğinden kullanılır; teklif doğrudan müşteriye
    gider, yönetici yeniden fiyatlandırmaz.
  - **Farklı fiyat** — fiyatı yönetici belirler; telafi yöneticinin fiyatlandırmasına gider ve fiyatlandırılmadan müşteriye
    gitmez (yeni telafi siparişi fiyat onayı sırasına düşer; teklifi müşteride olan siparişte yönetici onayı bekler).
- **Yönetici — Önemli kararlar ve bildirim:** her telafi "Önemli kararlar"da bir kayıt olarak görünür (karar, önceki →
  uygulanan müşteri fiyatı, hedef sipariş, ana siparişte kalan adet) ve yöneticiye bir uygulama içi bildirim düşer
  (yinelenmez).
- **Hareketler / denetim kaydı:** işlemi yapan, kaynak sipariş ve cam satırı, telafi, adet, karar (bedelsiz / aynı fiyat /
  farklı fiyat), önceki ve uygulanan fiyat ve zaman kayıtlıdır; yöneticinin sonradan belirlediği fiyat da kayda geçer.
- **Yetki:** telafi açma ve fiyat kararını seçme satış ve yöneticide; fiyat belirleme yalnızca yöneticide. Müşteri, çizim
  ve denetimci telafi açamaz, fiyat kararını değiştiremez (sunucuda denetlenir).
- **Değişmeyen:** satış ve çizim için firma adı maskesi (ilk 3 karakter + 10 yıldız), iki kademeli fiyat, olağan teklif
  akışı (satış → yönetici fiyatı → müşteri), fatura / proforma kuralları. FGO'ya hiçbir istek atılmadı.

## 3.50.24 — 07.10.2026

- **Alan adı taşıması: eski adres yeni adrese kalıcı olarak yönlenir.** Uygulamanın adresi artık
  **https://takip.gkh.ro**. Eski adrese (`takip.sistembalustrada.ro`) gelen her istek — eski e-postalardaki bağlantılar,
  yer imleri — sayfanın yolu ve sorgusu aynen korunarak yeni adrese yönlendirilir (308). Eski adres uygulamayı artık
  kendisi sunmaz; yalnızca yönlendirir. Yeni adresin davranışı (güvenlik başlıkları, gövde sınırları, gövde kapısı)
  değişmedi.
  - Eski adın HTTPS sertifikasını Caddy kendisi alır ve yeniler; bunun için eski alan adının DNS kaydı sunucuyu
    göstermeye devam etmelidir.
  - Yalnızca `deploy/Caddyfile` değişti: uygulama kodu, veritabanı ve ayarlar (`APP_DOMAIN`, `APP_URL`) aynı (karar 154).

## 3.50.23 — 07.10.2026

- **Güvenlik: teklif tablosuna "Excel'den Aktar" ön izlemesi artık sunucuyu zorlayacak kadar büyük metin üretemez**
  (canlıya çıkış öncesi saldırı turu, NEW-GL-01).
  - Özel hazırlanmış küçük bir Excel dosyası (birkaç on KB), aynı uzun metni binlerce hücrede yineleyerek ön izlemede
    gigabaytlarca metin ürettirebiliyordu. Dosyayı müşteri siparişe yükleyebildiği ve pencere açılınca ilk Excel
    kendiliğinden okunduğu için bu, uygulamanın belleğini tüketip siteyi durdurabilirdi.
  - Artık ön izleme sınırlıdır: ilk 1000 satır × 30 sütun (eskisi gibi), tek hücrede en çok 32.767 karakter (Excel'in kendi
    sınırı), toplamda en çok 1.000.000 karakter. Sınır aşılırsa dosya ön izlenmez ve açık bir mesaj görünür:
    "Excel dosyasındaki metin ön izleme için çok uzun…". Satırlar elle girilebilir ya da sade bir ölçü listesi yüklenebilir.
  - Olağan ölçü listeleri (.xls ve .xlsx) eskisi gibi okunur, eşlenir ve aktarılır; 5 MB dosya sınırı aynıdır.
- **Güvenlik: çok uzun adlı dosya yüklemesi artık sunucuda kayıtsız dosya bırakamaz** (NEW-GL-02).
  - Adı 180 karakterden uzun ve özel biçimde seçilmiş bir dosya, yükleme sırasında beklenmeyen bir hataya yol açıyor;
    yarım kalan dosya sunucunun geçici klasöründe, aynı istekte ondan önce yüklenen dosyalar da kalıcı klasörde, hiçbir
    kayda ve kotaya girmeden kalıyordu. Yineleyerek disk doldurulabilirdi (müşteri, ekip ve depo bağlantısı yollarından).
  - Artık uzun dosya adı kısaltılırken **uzantısı korunur** (ör. "….pdf" yine ".pdf" ile biter) ve böyle bir dosya olağan
    bir yükleme gibi işlenir: içeriği uzantısına uyuyorsa kabul edilir, uymuyorsa açık mesajla reddedilir.
  - Bir yükleme hangi nedenle başarısız olursa olsun (içerik uyuşmuyor, virüs, tarayıcıya ulaşılamadı, bağlantı koptu, disk
    hatası) geçici dosya silinir; aynı istekte birlikte gönderilen dosyalar da saklanmaz — ya hepsi ya hiçbiri.
  - Depo bağlantısında adı ".zip.pdf" ile biten çok uzun adlı bir ZIP dosyası PDF gibi kabul edilebiliyordu; artık
    reddedilir (yalnızca PDF, JPG, PNG).
  - Bir dosya silinemezse (çok ender, sunucu kaynaklı) işlem bozulmaz; yalnızca teknik hata kodu günlüğe ve denetim
    kaydına yazılır (dosya adı ya da klasör yolu yazılmaz).
  - Değişmeyenler: izin verilen dosya türleri, 100 MB sınırı, yükleme kotaları, virüs taraması, indirme ve tüm iş
    akışları. 180 karakterden kısa adlı dosyalarda hiçbir şey değişmez.

## 3.50.22 — 07.10.2026

- **Güvenlik: sunucunun ayar dosyasına yanlışlıkla yazılan test / demo ayarları artık canlı sistemi zayıflatamaz**
  (güvenlik denetimi AUD-13).
  - Yalnızca test ve demo ortamı için olan dört ayar vardı (demo kipi, e-postaları göndermek yerine klasöre yazma, sahte
    not çevirisi, çerezlerin güvenli bağlantı şartını kaldırma). Bunlardan biri sunucunun ayar dosyasında unutulursa ya da
    bir demo dosyasından kopyalanırsa canlı sistemi sessizce zayıflatabiliyordu: e-postalar gitmez ama "gönderildi"
    görünür, giriş sayfasında demo kutusu çıkar, notlara sahte çeviri yazılır.
  - Artık gerçek sunucu bu dört ayarı **yok sayar** ve güvenli biçimde çalışmaya devam eder: demo kapalıdır, e-postalar
    gerçek e-posta sunucusuyla gider, notlar gerçek sağlayıcıyla çevrilir, çerezler yalnızca güvenli bağlantıyla
    gönderilir. Site **kapanmaz**.
  - Böyle bir ayar bulunursa **Yönetici → Entegrasyonlar** sayfasının başında **"Ortam uyarıları"** kartı görünür: hangi
    ayarın yok sayıldığını adıyla gösterir (değerini göstermez). Satır sunucudaki dosyadan kaldırılınca kart kaybolur.
    Uyarı yoksa kart hiç görünmez — bugün için beklenen durum budur.
  - Arka plan işçisi (e-postalar, FGO işleri, virüs taraması) artık uygulamayla aynı ayar denetimini yapar: aynı ayarları
    o da yok sayar ve ayar dosyası bozuksa uygulama gibi o da başlamaz.
  - Demo için örnek veri yükleyen betik gerçek sunucuda çalışmaz ve içinde gerçek kullanıcı ya da sipariş olan bir
    veritabanına hiçbir koşulda yazmaz.
  - Değişmeyenler: giriş, oturum süresi (30 dakika), e-posta, not çevirisi, virüs taraması ve tüm iş akışları — sunucunun
    ayar dosyasında bu test ayarları yoksa hiçbir şey değişmez.

## 3.50.21 — 07.10.2026

- **Güvenlik: antivirüs tarayıcısının adresi artık uygulamadan değiştirilemez; tarayıcının yanıtına güvenilmez**
  (güvenlik denetimi AUD-12).
  - Yönetici → Entegrasyonlar → Antivirüs bölümündeki **"Tarayıcı adresi" ve "Port" alanları kaldırıldı**; ikisi de
    ekranda yalnızca salt-okunur gösterilir. Adres ve port artık yalnızca sunucu ayarından gelir (sunucuda zaten
    `clamav:3310`). Eskiden bu alanlar başka bir adrese çevrilirse yüklenen dosyalar o adrese gönderilebiliyor ve
    virüslü dosya "temiz" sayılabiliyordu. Veritabanında kalmış eski adres değerleri kullanılmaz; adres içeren elle
    hazırlanmış bir istek de hedefi değiştiremez.
  - **Sizin için değişen tek şey:** tarayıcıyı başka bir adrese taşımak artık sunucu tarafında yapılır. Açma / kapama ve
    "tarayıcıya ulaşılamazsa" seçimi (kabul et, sonra tara / reddet) eskisi gibi bu ekrandan yapılır.
  - Tarayıcıdan gelen yanıt artık sınırlıdır: en çok birkaç KB okunur, bir tarama **en çok 5 dakika** sürer (karşı taraf
    düzenli veri göndererek bunu uzatamaz; mevcut "yanıt gelmiyor" süresi ayrıca geçerlidir).
  - Yanıt biçimi denetlenir: dosya yalnızca tarayıcı açıkça "temiz" dediğinde temiz sayılır; bozuk ya da tanınmayan bir
    yanıt hatadır (dosya, seçiminize göre "taranmadı" işaretlenir ya da reddedilir). Virüs kararı eskisi gibi korunur.
  - Virüs adı ekranda ve kayıtlarda yalnızca harf / rakam ve birkaç işaretle, en çok 200 karakter olarak görünür.
  - "Test başarısız" ve "Tarama durdu" iletileri artık teknik hata metni yerine kısa, anlaşılır bir neden gösterir
    (ör. "tarayıcıya ulaşılamıyor", "tarayıcı zamanında yanıt vermedi").
  - Değişmeyenler: dosya yükleme, virüslü dosyanın reddedilmesi ve karantina, taranmamış dosyaların arka planda
    taranması, yükleme sınırları, müşteri / ekip / depo yükleme adımları.

## 3.50.20 — 07.10.2026

- **Güvenlik: giriş kilidi denetim kaydı artık sınırsız büyümez; kod denemeleri kayda geçer; yöneticiye kilit bildirimi**
  (güvenlik denetimi AUD-11).
  - Eskiden hesap ya da adres kilitliyken gelen **her** giriş isteği denetim kaydına bir satır ekliyordu. Kilitli istek
    hiçbir sınıra girmediği için, giriş yapmamış biri silinemeyen bu kaydı istediği kadar büyütebiliyordu. Artık **bir
    kilit, bir kayıttır**: kayıt, kilidi oluşturan (sınırı dolduran) hatalı denemeyle birlikte bir kez yazılır;
    kilitliyken gelen istekler hiçbir şey yazmaz.
  - Kilit kaydında hangi sınırın dolduğu da yazar (aynı e-posta + adres, e-posta geneli ya da adres geneli) ve kilidin
    giriş ekranından mı kod ekranından mı oluştuğu.
  - Davet / şifre sıfırlama kodu: gerçek bir davette gerçekten denenen her **yanlış kod** artık denetim kaydına geçer
    (davet başına en çok 5). Davet yoksa, kullanılmışsa, süresi dolmuşsa ya da kilitliyse kod hiç denenmediği için kayıt
    da yazılmaz.
  - Bir hesaba her adresten yapılan hatalı denemeler **e-posta geneli** sınırı doldurduğunda yöneticilere uygulama içi
    bildirim gider ("Güvenlik: bir hesabın girişi çok sayıda hatalı deneme nedeniyle kilitlendi" + kullanıcı). Aynı
    kullanıcı için günde en çok bir bildirim; e-posta gönderilmez; satış, çizim, denetimci ve müşteri bu bildirimi almaz.
  - Kayıtlara şifre, davet kodu ya da denenen e-posta dizgisi yazılmaz; hesabı olmayan bir e-posta için kullanıcıya
    bağlı kayıt oluşturulmaz.
  - Değişmeyenler: sınırlar (15 dakikada 5 / 20 / 30), kilit süresi, ekrandaki iletiler, başarılı girişin önceki
    hataları temizlemesi.
  - **Bilinen kalan risk (karar 149):** e-posta adresini bilen biri, farklı adreslerden hatalı denemeler yaparak bir
    kullanıcının girişini geçici olarak kilitleyebilir (hatalı denemeler durduktan en geç 15 dakika sonra açılır; açık
    oturumlar etkilenmez). Bu davranış bu sürümde bilerek değiştirilmedi; güvenilen cihaz / iki adımlı giriş ayrı bir
    güvenlik maddesi olarak duruyor. Öneri: e-postası dışarıda bilinmeyen yedek bir yönetici hesabı bulundurun.

## 3.50.19 — 07.10.2026

- **Güvenlik: giriş ve davet kodu deneme sınırları, aynı anda gönderilen isteklerle aşılamaz** (güvenlik denetimi AUD-10).
  - Hatalı giriş sınırı (15 dakikada aynı e-posta ve adresten 5, aynı e-postaya 20, aynı adresten 30 deneme) ve davet
    kodundaki "en çok 5 deneme" kuralı, istekler sırayla geldiğinde doğru çalışıyordu; aynı anda çok sayıda istek
    gönderen biri bu sınırların üstünde şifre ya da kod deneyebiliyordu. Artık her deneme, şifre / kod denetlenmeden
    önce sayılır: kaç istek aynı anda gelirse gelsin sınırın üstünde deneme yapılamaz.
  - Davet kodu: beş yanlış denemeden sonra kod kilitlenir ve doğru kod da kabul edilmez (yöneticiden yeni kod istenir —
    eskisi gibi). Doğru girilen kod deneme hakkı harcamaz.
  - Olağan kullanımda görünen bir değişiklik yoktur: sınırlar, kilit süresi ve ekrandaki iletiler aynıdır; başarılı giriş
    o e-posta ve adresin önceki hatalarını eskisi gibi temizler.
  - Not: doğrulaması süren denemeler de sınıra sayılır. Aynı kullanıcı aynı adresten aynı anda beşten çok giriş isteği
    gönderirse fazlası "çok fazla deneme" yanıtı alır (olağan kullanımda oluşmaz).

## 3.50.18 — 07.10.2026

- **Güvenlik: sipariş notlarına ve not çevirisine sınır geldi** (güvenlik denetimi AUD-9).
  - Bir kullanıcı kısa sürede çok sayıda not gönderemez: müşteri kullanıcısı 10 dakikada en çok 20, iç ekip (yönetici,
    satış, çizim) 10 dakikada en çok 60 not yazabilir. Sınır dolunca not kaydedilmez ve "Kısa sürede çok fazla not
    gönderdiniz. Lütfen birkaç dakika sonra yeniden deneyin." iletisi görünür (müşteriye Romence).
  - Bir siparişte toplam en çok 500 not olabilir (iç notlar dahil); dolunca yeni not eklenemez.
  - Not çevirisi: bir müşteri kullanıcısının notları için saatte en çok 30 çeviri yapılır. Sınır dolunca not **yine
    kaydedilir**, yalnızca çevrilmez; iç ekip notun altında nedenini görür ve sonra "Çeviriyi yeniden dene" ile çevirtir.
    Müşteri ve denetimci bu bilgiyi görmez. Sayfayı yenilemek çeviriyi kendiliğinden başlatmaz.
  - "Çeviriyi yeniden dene": bir kullanıcı 10 dakikada en çok 20 kez deneyebilir; sonrasında not olduğu gibi kalır.
  - Olağan kullanımda görünen bir değişiklik yoktur: bu sayılar gündelik yazışmanın çok üstündedir. Amaç, ele geçirilmiş
    ya da kötüye kullanılan bir hesabın sınırsız kayıt ve sınırsız ücretli çeviri üretmesini önlemektir.
  - Not: sınır sayaçları uygulama yeniden başlayınca (her güncellemede) sıfırlanır.

## 3.50.17 — 06.10.2026

- **Güvenlik: geri çekilen çizim sürümünün dosyaları artık müşteriye kapalı** (güvenlik denetimi AUD-8).
  - Çizimci bir sürümü geri çektiğinde müşteri o sürümün dosyalarını artık açamaz ve indiremez; sürüm için müşteriye
    yazılmış not da görünmez. Bağlantıyı bilse de dosyaya ulaşamaz.
  - Müşteri sürümün geri çekildiğini, tarihini ve geri çekme gerekçesini görmeye devam eder.
  - Yönetici, satış, çizim ekibi ve denetimci için hiçbir şey değişmedi: geri çekilen sürümün dosyaları ve notu durur.
  - Gönderilmiş, onaylanmış ve revizyon istenmiş sürümler müşteriye eskisi gibi açıktır.
  - Not: geri çekmeden önce müşterinin indirdiği kopya geri alınamaz; dosyanın açılıp açılmadığı denetim kaydında görünür.

## 3.50.16 — 06.10.2026

- **Güvenlik: dil değiştirme bağlantısı artık başka bir siteye yönlendiremez** (güvenlik denetimi AUD-6).
  - Giriş ekranındaki RO | TR bağlantısının "geri dön" adresi özel hazırlanmış bir bağlantıyla başka bir siteyi
    gösterebiliyordu. Artık yalnızca TAKİP'in kendi sayfalarına dönülür; şüpheli adres giriş sayfasına çevrilir
    (dil yine değişir).
  - Aynı denetim bildirimlerdeki bağlantılara da uygulanır: uygulama dışını gösteren bir bağlantı tıklanabilir olmaz.
  - Olağan kullanımda görünen bir değişiklik yoktur: dil değiştirince aynı sayfada kalınır, bildirimler eskisi gibi
    ilgili sayfayı açar.

## 3.50.15 — 06.10.2026

- **Güvenlik: FGO'dan gelen belge bağlantıları artık her kullanımda denetleniyor** (güvenlik denetimi AUD-5 ve AUD-7).
  - Proforma / fatura PDF'i indirilirken yalnızca FGO'nun kendi adresine gidilir. Bağlantı başka bir adrese yönlendirirse
    oraya gidilmez; yönlendirme en çok üç kez izlenir.
  - İndirilen PDF en çok 15 MB olabilir; daha büyük ya da PDF olmayan yanıt alınmadan bırakılır (sunucunun belleğini
    dolduramaz).
  - FGO'nun verdiği bağlantı FGO adresi değilse kayda yazılmaz, müşteri e-postasına konmaz ve ekranlarda tıklanabilir
    gösterilmez; belge numarası ve tarihi yine görünür.
  - Olağan kullanımda görünen bir değişiklik yoktur: belge e-postaları PDF ekiyle gider, Tahsilat ve sipariş sayfalarındaki
    belge bağlantıları eskisi gibi açılır.
  - Not: bir belge e-postası PDF'siz giderse Muhasebe → Tahsilat'taki e-posta durumunda nedeni yazar ("PDF alınamadı: …").

## 3.50.14 — 06.10.2026

- **Güvenlik: giriş yapmamış biri artık dosya yükleme sayfalarına büyük istek gönderemez** (güvenlik denetimi AUD-4'ün
  kalan bölümü). Dosya yüklenebilen sayfalar (yeni sipariş, sipariş sayfası, depo bağlantısı, yönetim Excel yüklemeleri)
  büyük isteği herkesten kabul ediyordu; giriş yapmamış biri bu sayfalara büyük istekler göndererek sunucunun belleğini
  doldurabiliyordu.
  - Ön sunucu artık büyük bir isteği uygulamaya iletmeden önce gönderenin **geçerli bir oturumu** (depo bağlantısında:
    **geçerli bir bağlantısı**) olup olmadığına bakar. Yoksa istek, içeriği hiç okunmadan reddedilir.
  - Giriş yapmış kullanıcılar için hiçbir şey değişmedi: dosya yükleme kuralları aynı (dosya başına 100 MB, bir seferde
    toplam 250 MB; yönetim Excel dosyaları 5 MB), depo teslim bağlantısı giriş gerektirmeden çalışmaya devam eder.
  - Küçük işlemler (not yazma, durum değiştirme, küçük dosya) eskisi gibi çalışır.
  - Bu denetim bir ön korumadır; her işlem kendi oturum ve yetki denetimini eskisi gibi yapar.
  - Bu sürüm yayınlanırken site birkaç saniyeliğine yeniden bağlanır (ön sunucu yeni ayarı okur).
  - Not: giriş yapmış bir kullanıcının çok büyük dosyaları hâlâ sunucunun belleğini zorlayabilir; uygulama için bellek
    sınırı bu sürümde de eklenmedi (SEC-12 kararını bekliyor).

## 3.50.13 — 06.10.2026

- **Sunucu: güncelleme artık ön sunucuyu (Caddy) da doğruluyor.** Önceden güncelleme yalnızca uygulamanın açıldığına
  bakıyordu; ön sunucunun ayarını bozan bir güncelleme siteyi kapatıp yine de "başarılı" görünebilirdi.
  - Ön sunucu ayarı değişen güncellemede yeni ayar, hiçbir şeye dokunulmadan önce çalışan ön sunucunun kendisiyle
    denetlenir; geçersizse güncelleme başlamaz ve site olduğu gibi çalışmaya devam eder.
  - Güncellemeden sonra sitenin HTTPS üzerinden yeni sürümle yanıt verdiğine bakılır. Vermiyorsa güncelleme başarısız
    sayılır ve önceki sürüme (önceki ön sunucu ayarıyla birlikte) kendiliğinden dönülür.
  - Uygulamada görünen bir değişiklik yoktur.

## 3.50.12 — 06.10.2026

- **Güvenlik: sunucuya gönderilebilecek istek boyutu artık adrese göre sınırlı** (güvenlik denetimi AUD-4). Önceden her
  adres 260 MB'a kadar istek kabul ediyordu; giriş yapmamış biri giriş sayfasına büyük istekler göndererek sunucunun
  belleğini doldurabiliyordu.
  - Dosya yüklenmeyen her adres (giriş, ilk şifre, listeler, yükleme sekmesi, yönetim sayfaları) en çok **2 MB** kabul eder.
  - Yönetim Excel yüklemeleri (fiyat, katalog, stok) **6 MB**; sipariş sayfaları ve depo bağlantısı eskisi gibi **260 MB**.
    Dosya yükleme kuralları değişmedi: dosya başına 100 MB, bir seferde toplam 250 MB.
  - Bir isteğin gövdesi en çok 1 saatte tamamlanmalıdır (önceden süre sınırı yoktu).
  - Bu sürüm yayınlanırken site birkaç saniyeliğine yeniden bağlanır (ön sunucu yeni ayarı okur).
  - Not: sipariş sayfalarının ve depo bağlantısının adresleri, dosya yüklenebildiği için büyük isteği giriş yapmamış
    istemciden de kabul etmeye devam eder; bunu kapatmak ayrı bir karar gerektirir (karar 141). Uygulama için bellek
    sınırı bu sürümde eklenmedi (SEC-12).

## 3.50.11 — 06.10.2026

- **Güvenlik: Excel dosyalarını okuyan bölüm, özel hazırlanmış dosyalarla sistemi yavaşlatma / kilitleme girişimlerine
  karşı sınırlandı** (güvenlik denetimi AUD-3).
  - "Excel'den Aktar" (teklif tablosu) en çok **5 MB**'lık Excel dosyasını okur; daha büyük dosya okunmadan, açık bir
    mesajla reddedilir ("Excel dosyası çok büyük (en fazla 5 MB)…"). Büyük Excel dosyası siparişe eskisi gibi yüklenebilir
    ve indirilebilir; yalnızca teklif tablosuna aktarılamaz. Yönetim ekranlarındaki Excel yüklemeleri zaten 5 MB sınırlıydı.
  - Bozuk ya da kasıtlı olarak hazırlanmış `.xls` / `.xlsx` dosyaları (içi beyan ettiğinden büyük çıkan, kendi içinde
    döngüye giren ya da etiketleri kapanmayan dosyalar) artık hemen "Excel dosyası okunamadı" ile reddedilir; sunucuyu
    meşgul etmez.
  - Olağan `.xls` ve `.xlsx` dosyaları, ön izleme ve Genişlik / Yükseklik / Adet eşlemesi aynen çalışır. Dosya yükleme,
    çizimler, PDF'ler ve katalog görselleri bu değişiklikten etkilenmez.

## 3.50.10 — 06.10.2026

- **Güvenlik: sipariş geçmişi ve kişi bilgileri role göre sunucuda temizlenir** (güvenlik denetimi AUD-1, AUD-2).
  - Satış ve çizim ekibi müşteri firmasının adını zaten göremiyordu; artık müşteri tarafındaki KİŞİLERİ de tanıyamaz:
    not yazarı, siparişi açan, dosyayı yükleyen, çizimi onaylayan / revizyon isteyen ve geçmişte işlemi yapan müşteri
    kullanıcısının adı ve e-posta adresi hiçbir yanıtta yoktur; yerine yalnızca "Müşteri" yazar.
  - Sipariş geçmişinde her olayın satırını ve notunu kimin göreceği olay türüne göre belirlenir: mali belge e-postasının
    alıcı adresi ve FGO hata metni yalnızca yöneticiye; satış tutarı çizim ekibine ve denetimciye gitmez; FGO / muhasebe
    işleri yalnızca yöneticinin geçmişinde. Kural okurken uygulandığı için **daha önce yazılmış kayıtlar da** korunur;
    geçmiş kayıtlar değiştirilmez.
  - Yeni kayıtlar bu bilgileri hiç taşımaz: belge e-postası olayına yalnızca belge numarası yazılır, teklif gönderim
    olayına tutar yazılmaz (tutar denetim kaydında kalır).
  - Yönetici, denetimci ve müşteri için görünen bilgiler, yetkiler ve iş akışları değişmedi.

## 3.50.9 — 06.10.2026

- **Sunucu güvenliği: arka plan işçisinin kapsayıcısı ayrıcalıksız.** İşçi zaten root değildi (3.50.8); artık kapsayıcısında
  bütün Linux yetenekleri de bırakılıyor (`cap_drop: ALL`) ve süreç sonradan yetki kazanamıyor (`no-new-privileges`).
  Yalnızca işçi kapsayıcısı değişti; uygulama, veritabanı, Caddy, antivirüs ve yönetim araçları aynıdır.
  - İşçinin işleri aynen çalışır: antivirüs taraması ve karantina, depo PDF'i ve depo e-postası, bildirimler, FGO işleri
    ve eşitleme, belge e-postaları, oturum temizliği, hatırlatmalar. Yedek ve geri yükleme değişmedi.

## 3.50.8 — 06.10.2026

- **Sunucu güvenliği: arka plan işçisi artık root olarak çalışmıyor.** İşçi, uygulamayla aynı kullanıcıyla (1001:1001)
  çalışır; ürettiği depo PDF'leri, ay klasörleri ve karantina klasörü bu kullanıcıya ait oluşur. Yayın sırasında, işçi
  başlamadan önce, yüklenen dosyalar biriminde eski sürümlerden root'a ait kalmış kayıtların **yalnızca sahipliği**
  düzeltilir: hiçbir dosya silinmez, taşınmaz, adı ya da içeriği değişmez; dosya adresleri ve veritabanı kayıtları aynıdır.
  İşlem yinelenebilir (düzeltilecek kayıt yoksa hiçbir şey yapmaz).
  - Antivirüs taraması ve karantina, depo PDF'i ve depo e-postası, FGO işleri ve eşitleme, belge e-postaları, bildirimler,
    oturum temizliği, hatırlatmalar, yedek ve geri yükleme aynen çalışır. Migration ve yönetim komutları değişmedi.
  - `takip durum` artık işçinin kullanıcısını ve dosyaların sahipliğini de gösterir.

## 3.50.7 — 06.10.2026

- **Sunucu: yerel yedek dosyaları yalnızca root'a açık oluşur.** Yedek klasörü zaten yalnızca root'a açıktı (0700) ama
  içindeki yedek dosyaları herkesin okuyabileceği izinle (0644) oluşuyordu. Artık veritabanı yedeği, dosya arşivi,
  bunların geçici dosyaları, şifreleme sırasındaki ara dosyalar ve Google Drive'dan indirilen yedekler oluşturuldukları
  andan itibaren 0600'dür. Şifreleme, Drive'a yükleme, doğrulama, geri yükleme ve saklama süresi değişmedi; var olan
  yedek dosyalarına dokunulmaz.

## 3.50.6 — 05.10.2026

- **Güvenlik: 30 dakika işlem yapılmayan oturum kendiliğinden kapanır** (bütün roller). Kural sunucudadır: son gerçek
  kullanıcı etkinliğinden 30 dakika sonra oturum geçersiz olur — sayfalar giriş ekranına yönlenir ("30 dakika boyunca
  işlem yapılmadı" açıklamasıyla), dosya / veri adresleri ve formlar reddedilir, tarayıcı kapatılıp sonra dönülse de
  eski oturum açılmaz.
  - **Oturumu yalnızca gerçek etkinlik uzatır:** klavye, fare, tekerlek, dokunma. TAKİP'in dakikada bir yaptığı
    otomatik yenileme, bildirim yoklaması ve arka plan istekleri oturumu **uzatmaz**; sekmeyi açık bırakmak kullanıcıyı
    içeride tutmaz.
  - Çalışan kullanıcı etkilenmez: etkinlik sürdükçe oturum açık kalır (en çok dakikada bir küçük bir bildirim; etkinlik
    yoksa hiç istek yok). Birden çok sekmede: bir sekmede çalışmak aynı tarayıcıdaki oturumu canlı tutar.
  - Açık sekme süre dolunca kendiliğinden giriş sayfasına gider. "Çıkış" eskisi gibi çalışır; yetkiler değişmedi.
  - Eski "7 gün boşta kalma" kuralının yerini aldı; 30 günlük mutlak oturum ömrü aynen sürer. Bu sürümün yayınıyla
    30 dakikadır işlem yapmamış açık oturumlar bir kez yeniden giriş ister.

## 3.50.5 — 05.10.2026

- **Sunucu: önbellek temizliği kaydı ve ikinci adım.** İki adımlı temizlikte ilk adımdan sonraki boyut da kayda
  yazılır; ikinci adım (kullanılmayan önbelleğin tamamı) yalnızca önbellek gerçekten sınırın üstünde kaldıysa
  çalışır — boyut o an okunamadıysa yeniden okunur, körlemesine ikinci temizlik yapılmaz. Yine yalnızca derleme
  önbelleği silinir.

## 3.50.4 — 05.10.2026

- **Sunucu: her yayında ~1,2 GB'lık derleme katmanı yeniden üretilmiyor.** Önbelleğin bu kadar hızlı büyümesinin asıl
  nedeni: her sürümde `package.json`daki sürüm numarası değiştiği için Docker bağımlılık kurulumunu (`npm ci`,
  ~1,2 GB) her yayında baştan yapıyor, her seferinde yeni bir katman bırakıyordu. Artık bağımlılıklar sürüm numarası
  sabitlenmiş bir kopyadan kurulur: bağımlılıklar değişmedikçe bu katman önbellekten gelir (yayın da ~1 dakika
  kısalır). Uygulamanın gösterdiği sürüm numarası ve çalışan kod değişmedi. Yayın başına biriken önbellek yaklaşık
  1,9 GB'tan 0,65 GB'a iner.

## 3.50.3 — 05.10.2026

- **Sunucu: Docker derleme önbelleği artık gerçekten temizleniyor.** Önbellek 10 GB'ı aşınca yalnızca **7 günden
  eski** önbellek siliniyordu; önbellek ise 2–3 günde 70 GB'ı geçtiği için hiçbir şey silinmiyordu (kayıtta:
  temizlikten önce 72 GB, sonra yine 72 GB). Yeni kural: önbellek **10 GB'ı aşarsa** kullanılmayan derleme önbelleği
  yaşına bakılmadan silinir, en son kullanılan **~4 GB** tutulur (bir sonraki derleme hızlı kalsın). 10 GB'ın altında
  hiçbir şey yapılmaz.
  - **Yalnızca derleme önbelleği** silinir (`docker builder prune`). İmajlara (yayındaki ve geri dönüş imajı),
    çalışan / durmuş kapsayıcılara, veritabanına, yüklenen dosyalara, antivirüs ve Caddy verisine, yedeklere
    dokunulmaz.
  - Kayda önceki boyut, yapılan işlem, sonuç, sonraki boyut ve disk doluluğu yazılır.
  - Denetim başarılı yayından sonra, derlemesi başarısız olan yayından sonra ve — bu sürüme geçişte — yayından
    hemen sonraki ilk denetimde çalışır; sunucuda elle bir şey yapmak gerekmez. İstenirse: `takip cache temizle`.

## 3.50.2 — 05.10.2026

- **E-postalarda gönderen adı**: TAKİP'in gönderdiği bütün e-postalarda gönderen artık
  **GKH Trading Invest SRL <info@gkh.ro>** olarak görünür (önceden alıcı yalnızca adresi görüyordu). Gönderen
  **adresi değişmedi**; yalnızca görünen ad eklendi. Sipariş / teklif bildirimleri, müşteri ve ekip bildirimleri,
  proforma / fatura e-postaları, depo e-postası, davet / doğrulama kodu ve SMTP deneme e-postası — hepsi için tek
  yerden (ortak gönderim noktası) uygulanır; ileride eklenecek e-postalar da kendiliğinden aynı kimlikle gider.
  Alıcılar, konular, içerik, ekler, logo, kuyruk ve yeniden deneme davranışı değişmedi. Sunucuda ayar değişikliği
  gerekmez.

## 3.50.1 — 05.10.2026

- **Sipariş geçmişi (iç ekip)**: "Belge FGO'da silinmiş; kaydı kaldırıldı" gibi sistem olayları artık kod
  (`FGO_DOC_DELETED`) yerine metniyle görünür. Müşterinin gördüğü geçmiş değişmedi. (3.50.0 canlıya çıkmadan
  bu düzeltmeyle birlikte yayımlandı.)

## 3.50.0 — 05.10.2026

- **FGO'da elle silinmiş belge: "TAKİP'ten kaldır"** (Muhasebe → Cam Tahsilat / Profil Tahsilat). Yönetici bir belgeyi
  doğrudan FGO'da sildiğinde TAKİP'teki kaydı kalıyor ve saatlik eşitleme her saat "Factura nu exista" hatası
  yazıyordu. Artık son kontrolde FGO'nun "belge yok" dediği belgeler sayfanın üstünde listelenir ve satırlarında
  **"TAKİP'ten kaldır"** (RO: "Șterge din TAKİP") düğmesi çıkar. Sağlam belgelerde düğme görünmez.
  - İşlem **yalnızca TAKİP'teki kaydı** kaldırır; **FGO'da hiçbir belge silinmez** (FGO'ya yalnızca o belgenin durumu
    sorulur). Onay penceresi bunu açıkça söyler.
  - Düğmeye basılınca belge FGO'ya **o an yeniden sorulur**. Kayıt yalnızca FGO kesin olarak "belge yok" derse
    kaldırılır. Belge FGO'da duruyorsa kaldırılmaz; FGO'ya ulaşılamıyorsa, zaman aşımı / kimlik hatası / belirsiz bir
    yanıt varsa **hiçbir değişiklik yapılmaz**.
  - Kayıt kalkınca sipariş belgeden önceki hâline döner (ör. "Proforma" yeniden istenebilir), bekleyen müşteri
    e-postası gönderilmez, saatlik eşitleme o belgeyi artık sormaz. Bu, "FGO ile Güncelle"nin zaten kullandığı
    temizlik yoludur; ikinci bir silme yolu eklenmedi.
  - Yalnızca yönetici (muhasebe yetkisi). Her istek — reddedilenler dahil — denetim kaydına yazılır.
- **Daha sıkı "belge yok" kuralı**: bir belgenin FGO'da silindiği yalnızca FGO'nun belgeden söz eden kalıcı yanıtıyla
  ("Factura nu exista") kabul edilir. "Firma nu exista", kimlik / anahtar hatası ya da istek sınırı gibi yanıtlar
  artık "belge silinmiş" sayılmaz ("FGO ile Güncelle" ve fatura numarası temizliği de aynı kuralı kullanır).
- Canlıdaki PRF 563 / 564 / 565 kendiliğinden silinmez: yönetici yeni düğmeyle, her biri FGO'da doğrulanarak kaldırır.

## 3.49.2 — 04.10.2026

- **Yeni resmî logo (saydam zeminli PNG)**: PDF'lerde ve e-postalarda kullanılan GKH Trading Invest logosu, ürün
  sahibinin gönderdiği saydam zeminli yeni logo ile değiştirildi (bina işareti + "GKH Trading Invest" yazısı).
  Gönderilen dosyada yazı beyazdı ve beyaz kâğıtta / e-postada görünmüyordu; ürün sahibinin seçimiyle yazı **koyu**
  renge çevrildi — bina işareti, ölçü ve saydamlık gönderilen dosyayla birebir aynıdır (kırpılmadı, gerilmedi).
  Teklif PDF'i, Comanda Depozit, nakliye listesi ve bütün e-postalar (bildirimler, proforma / fatura, depo, davet /
  doğrulama kodu) yeni logoyu kendiliğinden kullanır. PDF'lerde logo saydamlığıyla gömülür; e-postada PNG olarak
  eklenir. Giriş ekranındaki ve sol menüdeki "GKH Digital" logosu değişmedi.
- **Notlar — iç ekip kendi notunu yalnızca özgün dilinde görür**: yönetici, satış ve çizim ekibinin Türkçe notunun
  Romence çevirisi müşteri içindir; artık iç ekibe gösterilmez. Müşteri: özgün Türkçe + Romence çeviri. İç ekip ve
  denetimci: yalnızca özgün Türkçe. Müşterinin Romence notunda değişiklik yok (iç ekip: özgün + Türkçe; müşteri ve
  denetimci: yalnızca özgün). Çevirinin ne zaman yapıldığı ve nasıl saklandığı değişmedi; sayfa yenileme, otomatik
  yenileme ve işçi yine hiçbir koşulda çeviri istemez. Çevrilemeyen notta "Çeviriyi yeniden dene" iç ekipte durur.
- **Nakliye listesi**: logonun yanındaki firma adı "GKH Trading" yerine resmî ad **"GKH Trading Invest SRL"**.

## 3.49.1 — 04.10.2026

- **Not çevirisi — denetimci**: denetimci notları yalnızca **özgün dilinde** görür. Saklanan otomatik çeviri, "çeviri
  yapılamadı" bilgisi ve "Çeviriyi yeniden dene" düğmesi denetimciye gösterilmez. Notları (iç notlar dahil) görme
  yetkisi değişmedi. Yönetici, satış ve çizim ekibi ile müşteri için görünüm aynı.
- **Not çevirisi — yenileme çeviri yapmaz**: sayfa açılışı, tarayıcı yenilemesi, 60 saniyelik otomatik yenileme ve
  arka plan işçisi hiçbir koşulda Google'a çeviri isteği göndermez. Çeviri yalnızca yeni not yazılırken bir kez ve
  çevrilemeyen bir notta "Çeviriyi yeniden dene"ye basıldığında istenir. Tamamlanmış çeviriler yeniden çevrilmez;
  çevrilemeyen notlar kendiliğinden yeniden denenmez; eski (çevirisiz) notlar görüntülenince çevrilmez.
- **Resmî GKH logosu — PDF'ler**: TAKİP'in ürettiği belgelerin başlığında resmî GKH Trading Invest logosu yer alır:
  müşteri teklifi (PDF), Comanda Depozit formu ve nakliye listesi. Logo belgeye gömülüdür ve oranı korunur.
  (FGO'nun ürettiği proforma / fatura PDF'leri değişmedi.)
- **Resmî GKH logosu — e-postalar**: TAKİP'in gönderdiği bütün e-postalar (sipariş bildirimleri, çizim / onay / revizyon,
  teklif ve yükleme bildirimleri, proforma / fatura e-postaları, depo e-postası, davet ve doğrulama kodu) aynı ortak
  düzenle, en üstte GKH logosuyla gider. Logo e-postanın içine gömülüdür (dış adresten yüklenmez). Alıcılar, konu,
  içerik, ekler ve düz metin sürümü değişmedi.
- Hesaplar, fiyatlar, FGO ve bildirim kuralları değişmedi; şema değişmedi.

## 3.49.0 — 04.10.2026

- **Notlarda otomatik çeviri**: müşteri ile ekip, sipariş sayfasındaki Notlar bölümünde çeviri yapmadan yazışır.
  - Müşterinin (Romence) notu Türkçeye çevrilir: yönetici, satış ve çizim ekibi özgün notu ve hemen altında
    "Türkçe · otomatik çevrilmiştir" etiketiyle Türkçesini görür.
  - Yönetici, satış ya da çizimcinin (Türkçe) notu Romenceye çevrilir: müşteri özgün notu ve altında
    "Română · tradus automat" etiketiyle Romencesini görür.
  - Özgün not her zaman olduğu gibi durur. Çeviri not yazılırken **bir kez** yapılır ve saklanır; sayfa açılınca /
    yenilenince yeniden çeviri yapılmaz.
  - **İç notlar** çevrilmez, Google'a gönderilmez ve eskisi gibi müşteriye hiç görünmez.
  - Çeviri yapılamazsa (Google yanıt vermedi, kota doldu, anahtar geçersiz) not **yine kaydedilir**; ekip notun altında
    "Otomatik çeviri yapılamadı" bilgisini ve "Çeviriyi yeniden dene" düğmesini görür. Müşteriye hata bilgisi gösterilmez.
  - Eski notlar olduğu gibi kalır (geriye dönük çeviri yapılmaz).
- **Yönetici → Entegrasyonlar → "Not çevirisi"**: çeviriyi aç / kapat, Google Cloud API anahtarını gir, "Bağlantıyı
  dene". Anahtar yalnızca buradan girilir, şifreli saklanır ve bir daha gösterilmez (yalnızca "kayıtlı" yazar).
  Çeviri kapalıyken notlar eskisi gibi çalışır.
- Kapsam yalnızca sipariş sayfasındaki Notlar bölümüdür; çizim işaretleri, teklif satırı notları, e-postalar ve
  bildirimler çevrilmez.
- Testlerde gerçek Google'a istek gitmez (sahte çeviri sağlayıcısı); FGO davranışı değişmedi.

## 3.48.1 — 04.10.2026

Yalnızca test / sağlamlaştırma sürümü: ekranlarda ve kurallarda **hiçbir değişiklik yoktur** (3.48.0 davranışı aynen).

- **Tarayıcı testleri (uçtan uca)** — 3.48.0'da eklenen üç ekran artık tarayıcıda da sınanıyor
  (`e2e/22-siparis-secimi-fatura-uyarisi.spec.ts`):
  - müşteri proformasında sipariş seçimi: uygun siparişler tek tek seçilir; önizleme ve tutarlar yalnızca seçilenlerden
    hesaplanır; belge yalnızca seçilenlerden kesilir; seçilmeyen sipariş sonradan da uygundur;
  - onaylı yüklemenin faturasında sipariş seçimi: seçim fatura grubu başınadır; yalnızca seçilen siparişlerin fiilen
    yüklenen adedi faturalanır (kısmi yüklemede 10 adedin 8'i); kalan sipariş aynı yüklemeden sonra faturalanabilir;
  - Yönetici → Entegrasyonlar → "Fatura edilmemiş sipariş uyarısı" ayarı (0–60; sınır dışı değer sunucuda reddedilir;
    yalnızca yönetici) ve Cam Tahsilat'taki kalıcı "FATURA BEKLİYOR" listesi: proforma, avans faturası ve kuyruktaki
    fatura isteği uyarıyı kapatmaz; satır yalnızca kapanış faturası kesilince kalkar.
- **Veritabanı testi**: "muhasebe işlemi gerekli" diye dondurulan kapsam (fazla faturalanmış camın sonraki yüklemesi)
  "fatura bekliyor" uyarısı üretmez — faturalama ekranının dışladığı kapsamla aynı karar; dondurmanın nedeni kalkınca
  iki ekran birlikte değişir.
- **Güvenlik**: testlerde gerçek FGO / ANAF / BNR'ye hiçbir istek gitmez. Uçtan uca test veritabanında FGO kapalıdır ve
  kapalı kalır; kesilmiş belge gereken adımlar, uygulamanın gerçek servisleri üzerinden **sahte FGO** ile ve ağ
  istekleri engellenerek yürür (`e2e/fake-fgo.ts`). FGO numaralandırması, IdExtern, birim eşlemesi, tahsilat
  eşitlemesi, kur politikası ve FGO ayarlarına dokunulmadı; şema değişmedi.
- **CI**: her test adımının kesin toplamları (kaç test, kaç başarılı / başarısız / atlanan) artık yeşil çalışmada da
  not olarak yayınlanıyor (`scripts/ci-step.sh`); sonuç günlük indirilmeden okunabilir.

## 3.48.0 — 04.10.2026

- **Özel durum — başka firmanın yüklemesiyle gidecek** (yeniden düzenlendi): yönetici artık sipariş ya da sandık seçmez.
  Sipariş sayfasında, teklif tablosunun hemen altındaki kutuyu işaretler ve yalnızca **hedef firmayı** seçer (o yükleme
  gününde yüklemesi olan firmalar; her firma bir kez). Sandık o an girilmemiş olabilir.
  Sandığı **satış**, Yüklemeler ekranında o firmanın sandıklarını girerken seçer: misafir yük, firmanın sandık bölümünde
  kendiliğinden "ÖZEL DURUM / MİSAFİR YÜK" olarak görünür. Satış yalnızca yöneticinin seçtiği firmanın o günkü
  sandıklarından birini seçebilir; firmayı değiştiremez.
- **Kırmızı uyarı**: sandık seçilene kadar Yüklemeler'de "Özel durum — sandık seçimi bekliyor" (sipariş, firma, hedef
  firma). Hiçbir sandık kendiliğinden atanmaz.
- **İki firmaya da bildirim**: sandık seçilince sipariş sahibi firmaya "camınız başka bir firmanın sandığına yerleştirildi"
  (sandık no, gün), sandığın firmasına "Încărcătură suplimentară: sticla firmei … a fost încărcată în lada dvs. nr. …"
  bildirimi gider. Sandığın firması yalnızca misafir firmanın adını, sipariş numarasını, sandık numarasını ve günü
  görür — fiyat, teklif, belge, dosya görmez. Sandık değişirse / kaldırılırsa bir kez daha bildirilir.
- **Nakliye listesi**: misafir yük, taşındığı sandığın altında "MİSAFİR YÜK: firma · sipariş" olarak yazar; sandığı
  bekleyen özel durumlar ayrıca listelenir. Ağırlık kuralı aynı.
  Ticari hiçbir şey değişmez: sipariş, teklif, proforma, fatura ve muhasebe gerçek müşteride kalır.
- **Proforma ve faturada sipariş seçimi**: müşteri proformasında ve onaylı yüklemenin Faturalama bölümünde, uygun
  siparişlerin yanındaki kutularla belgeye girecek siparişleri seçebilirsiniz ("Seçimi uygula"). Belge yalnızca seçilen
  siparişlerden kesilir; seçilmeyen sipariş olduğu gibi kalır ve sonraki belgeye girer. Uygun olmayan siparişler
  nedenleriyle listelenir; çift faturalama, avans ve kur kuralları aynen geçerlidir.
- **Fatura bekliyor uyarısı**: yüklemesi onaylanmış ama kapanış faturası kesilmemiş siparişler, ayardaki gün dolunca
  Muhasebe → Cam Tahsilat'ın başında "FATURA BEKLİYOR" listesinde görünür ve yöneticiye bildirim gider. Proforma ve
  avans faturası uyarıyı kapatmaz; fatura kesilince kendiliğinden kalkar. Kısmi yüklemede yalnızca yüklenen cam sayılır.
  Gün sayısı: Yönetici → Entegrasyonlar → "Fatura edilmemiş sipariş uyarısı" (varsayılan 6 gün, 0–60).

## 3.47.0 — 04.10.2026

- **Yönetici teklif tablosunda "Tek fiyatı tüm satırlara uygula"**: satıştaki araç artık yönetici fiyat tablosunun altında da
  var. İşaretliyken bir cam satırına yazdığınız m² müşteri fiyatı tüm m² cam satırlarına yazılır; CNC, delik, sandık parası
  ve bedelsiz satırlar değişmez; satış fiyatlarına dokunulmaz. Satıştaki davranış aynı.
- **Çizim Ekibi (yönetici menüsü)**: soldaki menüde yeni "Çizim Ekibi → Çizim Paneli". Çizim ekibinin gördüğü panelin
  aynısıdır (yapılacak çizimler, onay bekleyenler, onaylanmış çizimler, SLA) — ekibin tamamı için ve firma adları tam
  görünür. Çizim ekibinin kendi ekranı değişmedi (firma adları maskeli).

## 3.46.0 — 04.10.2026

Güvenlik sertleştirmesi (3.45.0 güvenlik denetiminin onaylanan maddeleri). İş akışları, fiyatlar, FGO belgeleri değişmedi.

- **Giriş sınırı atlatılamaz**: istemcinin gönderdiği "gerçek IP" başlıklarına (CF-Connecting-IP, X-Real-IP…) artık
  güvenilmiyor; adres yalnızca sunucudaki Caddy'den alınır. Hatalı giriş sınırı ve denetim kaydı aynı adresi kullanır.
- **Şifre**: yeni şifreler en az **10 karakter** (uzun bir parola / birkaç kelime kullanılabilir; harf + rakam zorunluluğu
  kalktı). Mevcut şifreler çalışmaya devam eder; kimse zorla sıfırlanmaz.
- **İlk giriş**: giriş ekranı artık davet bekleyen hesabı ayırt etmez (hesap var mı yok mu anlaşılmasın). İlk giriş,
  davet e-postasındaki bağlantıdan ya da giriş ekranındaki "E-postanızdaki doğrulama koduyla şifrenizi belirleyin"
  bağlantısından yapılır.
- **Oturum**: 7 gün hiç kullanılmayan oturum kapanır (en uzun süre yine 30 gün). Eski oturum kayıtları kendiliğinden temizlenir.
- **Dosya yükleme sınırları**: bir seferde en çok 20 dosya; sipariş başına toplam 2 GB; müşteri firması saatte 1 GB / 120
  dosya, günde 3 GB; sunucuda boş alan 1 GB'ın altına inecekse yeni dosya kabul edilmez (hiçbir dosya silinmez).
- **Gizlilik**: satış ve çizim ekibine firmanın fatura e-postası ve kur politikası gitmez (EUR teklifteki kur notu bu
  rollerde görünmez); müşteriye özel kur yüzdesi ve fiyat tablosu bağlantısı yönetici dışında kimseye gitmez. Müşterinin
  sandık satırında başka müşterinin siparişinden iz bulunmaz.
- **Mali belge PDF'i**: kullanıcı başına 5 dakikada 30 istek; aynı belge 5 dakika içinde yeniden açılınca FGO'ya gidilmez.
- **Dil**: paneldeki dil seçimi aynı şekilde çalışır; kullanıcının dili artık yalnızca bu seçimle (ve girişte) kaydedilir.
- **Yedek şifreleme (sunucu)**: Google Drive'a giden yedekler şifrelenebilir — `takip yedek-sifreleme kur`. Varsayılan
  kapalıdır; anahtarı sunucu dışına kaydettiğinizi onaylamadan ve şifreli yedek Drive'dan çözülerek geri yüklenmeden
  açılmaz. Şifresiz eski yedekler silinmez. Ayrıntı: `deploy/README.md`.

## 3.45.0 — 04.10.2026

- **Cam ayrılınca toplam değişmez**: işlem (CNC / delik) eklemek için adetli cam satırı ayrıldığında (5 → 4 + 1) toplam m²,
  müşteri tutarı ve maliyet artık kuruşu kuruşuna aynı kalır. Önceden m² satır başına yuvarlandığı için bazı ölçülerde
  0,01 m² (ve fiyatla çarpımı kadar tutar) fark oluşuyordu. Ayrılan satırlar aynı kalemdir: m² kalemin toplam adedinden
  hesaplanır, satırlar bu toplamı paylaşır. Proforma ve faturada ayrılmış cam ayrı satır olmaz; belge, cam ayrılmadan
  önceki belgeyle aynıdır. Ayrılmamış satırların hesabı değişmedi.
- **Fatura e-postası (E-mail facturare)**: Müşteriler → firma → "Fatura bilgileri" bölümüne isteğe bağlı yeni alan.
  Proforma, avans faturası ve fatura e-postaları önce bu adrese gider; boşsa firmanın kayıtlı e-postasına; ikisi de yoksa
  durum "Email yok" olur. "Email yok" görünen kesilmiş belge için adresi girip Muhasebe → Tahsilat'ta "Tekrar gönder"e
  basmak yeterlidir (FGO'da yeni belge kesilmez). Kullanıcıların e-posta bildirimlerini kapatması mali belge e-postasını
  engellemez.

## 3.44.0 — 04.10.2026

- **Telafi camında fiyat**: satış artık yalnızca iki seçenek görür — **"Aynı fiyat"** (yöneticinin kaynak teklifte
  belirlediği müşteri fiyatı aynen kullanılır; yöneticinin yeniden fiyat girmesi gerekmez) ya da **"Bedelsiz"**. Satış
  telafi için yeni bir fiyat giremez; farklı müşteri fiyatını yalnızca yönetici belirler. Bedelsizde fabrika maliyeti
  durur (kârlılıkta görünür). Bedelsiz telafi "Önemli kararlar"da önceki müşteri fiyatıyla birlikte görünür; "aynı fiyat"
  seçildiğinde fiyat uyarısı açılmaz. Satış ekranında müşteri fiyatının tutarı gösterilmez; yönetici formda
  "Mevcut müşteri fiyatı"nı tutarıyla görür.
- **CNC / delik tek bir cama aittir**: adedi 1'den büyük cam satırında "+CNC / +Delik" denince camlardan biri
  kendiliğinden ayrı satıra ayrılır (5 → 4 + 1) ve işlem o cama eklenir; birim fiyatlar, toplam adet ve tutar değişmez.
  İşlemli camın adedi kilitlidir; aynı işlemli camdan bir tane daha için "+ aynısı". İşlemsiz camlar satırında adetle
  durur. Adedi 1'den büyük cama bağlı işlemle teklif kaydedilemez (sunucu da reddeder).
- **Telafide işlemler aynen kopyalanır**: oran / yuvarlama yok. İşlemsiz camın telafisi işlemsizdir; işlemli camın
  telafisi aynı CNC / delikleri taşır. Telafi formunda her cam seçeneği "işlemsiz" ya da işlemleriyle yazar.

## 3.43.4 — 04.10.2026

- Muhasebe → Tahsilat: sütun aralıkları biraz daraltıldı; e-posta sütunu 1440 px ekranda tam görünür.

## 3.43.3 — 04.10.2026

- Muhasebe → Tahsilat: e-posta sütununun başlığı kısaltıldı ("E-posta"); sütun 1440 px ekranda sağdan kesilmiyor.

## 3.43.2 — 04.10.2026

- Muhasebe → Tahsilat tablosu ekrana sığar: "FGO kontrol" zamanı ödeme durumunun altında yazar, son sütun müşteri
  e-postasının durumu ve "Tekrar gönder" düğmesidir (önceden e-posta sütunu sağda ekran dışında kalıyordu).

## 3.43.1 — 04.10.2026

- 3.43.0'ın yayın öncesi düzeltmesi (müşteri belge ekranının yetki tanımı: yeni yetki yerine mevcut müşteri hesabı
  yetkisi); davranış değişikliği yok.

## 3.43.0 — 04.10.2026

- **FGO belgesinde sipariş numarası**: her kalemin açıklamasında (FGO'da "detalii articol") kaynak TAKİP siparişi yazar —
  "Comanda UMI7". Birden çok siparişi kapsayan müşteri belgesinde her kalem kendi siparişini taşır. Kalemin adı, birimi,
  miktarı, fiyatı, TVA'sı, kur, toplamlar ve numaralandırma değişmedi.
- **Müşteriye belge e-postasını yalnızca TAKİP gönderir** (FGO göndermez): belge FGO'da kesilip kaydedilince bir kez,
  Romence; belge türü, numara, kesim tarihi, sipariş(ler), toplam ve **PDF ekte**. Profil siparişinin proforma ve
  faturası da artık bu e-postayla gider (aynı belge için ikinci, genel bildirim e-postası gönderilmez). Kesilemeyen
  belge için e-posta gitmez.
- **Muhasebe → Tahsilat**: her belgenin satırında müşteri e-postasının durumu — Gönderildi / Bekliyor / Başarısız /
  Email yok — ve **"E-postayı tekrar gönder"**. Bu düğme yalnızca e-postayı yeniden gönderir; FGO'da yeni belge
  kesilmez, numara ve faturalama değişmez. Firmanın e-postası yoksa belge yine geçerlidir, durum "Email yok" olur.
- **Müşteri ekranı "Documente financiare"** (menüde): firmanın proforma, avans faturası ve faturaları (cam + profil) —
  numara, tarih, sipariş(ler), toplam, ödeme durumu (Neplătit / Plătit parțial / Plătit; FGO'dan) ve "Vezi PDF".
  Müşteri yalnızca kendi firmasının belgelerini görür; başka firmanın belgesi adres değiştirilerek de açılamaz.
- Belge kesilince müşteriye uygulama içi bildirim: "Proforma este disponibilă." / "Factura este disponibilă."
- **Sonraki fatura numarası** (tek seferlik elle numara): FGO belgeyi kestiği anda alan boşaltılır — belge kaydı
  yazılamasa bile aynı numara sonraki faturaya bir daha gönderilmez.
- Veritabanı değişikliği yok.

## 3.42.1 — 04.10.2026

- Teklif tablosu: "Kırık / Telafi" sütunu daraltıldı (düğme iki satıra inebilir). Yöneticinin üç fiyat sütunlu
  tablosunda düğme sağ kenarda kesilmiyor, yatay kaydırma gerekmiyor.

## 3.42.0 — 03.10.2026

- **Kırık / telafi camı**: müşteriye gönderilmiş teklifin cam satırında **"Kırık / Telafi"** düğmesi (CNC, delik ve sandık
  parası satırlarında yok). Tek kısa form: cam → adet → fiyat → hedef → özet ve açık onay ("Yukarıdaki kararı
  onaylıyorum…"). Kaynak sipariş ve teklifi **değişmez**; telafi camı (ölçü, ağırlık, ona ait CNC / delik) kaynaktan
  kopyalanır. Yüklenmeyen cam kaydından bağımsızdır: yüklenip teslim edilmiş camdan da açılır.
- **Fiyat**: normal fiyat, **Bedelsiz** (müşteri fiyatı 0 — fabrika maliyeti durur, kârlılıkta görünür) ya da başka fiyat.
  Yönetici müşteri fiyatına karar verir; satış müşteri fiyatını görmez, kendi satış fiyatına karar verir (değiştirirse
  müşteri fiyatını yönetici girer). Normalden farklı her karar "Önemli kararlar"da ve denetim kaydında görünür.
- **Hedef — iki seçenek her zaman var**: müşterinin ileri tarihli bir siparişine TELAFİ satırı olarak ekle (sipariş no ve
  yükleme günüyle listelenir) ya da **yeni telafi siparişi** (ABC124-T, sonra -T2, -T3 …) için ileri bir yükleme günü seç.
  Teklifi müşteride olan siparişe satışın eklediği telafi yöneticinin onayını bekler; yeni telafi siparişinin teklifi
  yöneticinin fiyat onayına düşer. Sonrası olağan akıştır (yükleme, sandık, fatura, kârlılık).
- **"Önemli kararlar" kartı** sipariş sayfasında: telafi geçmişi (kaynak cam, normal fiyat, telafi fiyatı, hedef, kim, ne
  zaman) ve "Kırık / Telafi Camı Oluştur" düğmesi (aynı formu açar). Yöneticinin Önemli kararlar listesinde fiyat kararı
  ve onay bekleyen telafiler de görünür.
- **Yüklenmeyen camla ilişki**: telafi, onaylı yüklemede yüklenmeyen camın yerine açılıyorsa ilişkilendirilir; o adet
  ayrıca ileri güne aktarılamaz (aynı cam iki kez üretilmez).
- **Özel durum — başka müşterinin sandığına ekle**: mevcut fiziksel yerleşim bu adla, yalnızca yöneticide (davranış
  aynı: siparişin müşterisi, faturası ve kârlılığı değişmez).
- **Siparişi sil / geri yükle** (yalnızca yönetici): sipariş sayfasının en altında, iki adımlı (bölüm + onay kutusu).
  Sipariş listelerden, aramadan, yükleme planından ve müşterinin ekranından kalkar; **kayıtlar silinmez** (FGO belgeleri,
  onaylı yüklemeler, muhasebe, çizim geçmişi, denetim kaydı durur; FGO'da hiçbir işlem yapılmaz). Siparişler sayfasındaki
  "Silinen siparişler" bölümünden geri yüklenir.
- Veritabanı: `Compensation` tablosu; `Order` (telafi siparişi sırası, silinme bilgisi) ve `OfferLine` (TELAFİ işareti)
  alanları. Sipariş numarası tekilliği telafi sırasını da kapsar.

## 3.41.1 — 03.10.2026

- **FGO: aynı belge iki kez gönderilemez (işçiler arası yarış kapatıldı)**: bir FGO işi kesilirken (istek sürerken) kuyruğu
  okuyan ikinci bir işçi — arka plan işçisi ile düğmeye basınca yapılan anında deneme — aynı işi alıp FGO'ya ikinci
  isteği gönderebiliyordu. Artık iş tek bir veritabanı güncellemesiyle sahiplenilir ve aynı anda 10 dakikalık "işlem
  kirası" alır: kira sürerken başka hiçbir işçi işi göremez. Cam (sipariş başına), müşteri partisi ve profil belgeleri
  aynı kuralı kullanır (`server/integrations/fgo-claim.js`).
- İşçi yarıda kalırsa iş kira dolunca yeniden denenir; hata sonrası bekleme süreleri, deneme sınırı, FGO'ya giden
  `IdExtern` ve veritabanındaki tekrar engelleri değişmedi. Kuyruk yapısı ve veritabanı şeması değişmedi.
- Günün BT kuru girilince yalnızca kur bekleyen (hata almış) işler öne alınır; o anda kesilmekte olan işe dokunulmaz.

## 3.41.0 — 03.10.2026

- **Bildirimler (zil)**: üst çubukta zil ve okunmamış sayacı (1, 3, 9 … 99+). Listede okunmamış bildirimler belirgin;
  listeyi açmak okundu yapmaz — bildirime tıklayınca, "okundu" ile ya da "tümünü okundu işaretle" ile okunur. Bildirim
  ilgili sipariş / yükleme / faturalama sayfasını açar (sayfa kendi yetkisini denetler).
- **Yeni bildirimde açılır bildirim ve kısa ses**: panel açıkken gelen yeni bildirim sağ altta kısa bir açılır
  bildirimle gösterilir; aynı anda birkaç bildirim geldiyse tek özet. Girişte var olan eski okunmamış bildirimler
  yalnızca sayaçta görünür — ses ve açılır bildirim üretmez. Bir yoklamada kaç bildirim gelirse gelsin tek ses; birden
  çok sekme açıksa parti bir kez seslendirilir. Ses tarayıcının izin verdiği andan sonra (ilk etkileşim) çalar;
  engellenirse sessizce geçilir.
- **Sekme başlığı**: okunmamış bildirim varken "(3) Takip — …", kalmayınca başlık eski hâline döner.
- **Bildirim sesi tercihi** ("Sunet notificări": Activat / Dezactivat): zildeki anahtardan ve müşteri Ayarlar
  sayfasından, kullanıcı başına, çıkış gerekmeden. Yalnızca sesi kapatır; zil, açılır bildirim ve e-postalar sürer.
- **Kapsanan olaylar**: yeni cam / profil siparişi (satış + yönetici / yalnızca yönetici), çizime yönlendirme, çizimin
  müşteriye gönderilmesi, müşterinin revizyon isteği ve onayı (atanmış çizimci + ilgili satışçı), satış teklifinin
  yöneticiye gelmesi, satışa geri gönderilmesi, teklifin müşteriye gönderilmesi / güncellenmesi, profil teklifi ve
  onayı, proforma / fatura, yükleme tarihi, yüklendi, yüklenmeyen cam (yeniden planlama gerekir), aktarım, yükleme
  düzeltmesinde "muhasebe işlemi gerekli", FGO'da kesilemeyen belge, proformaya gelen tahsilat için avans faturası.
  Alıcılar e-posta kurallarıyla aynı; işlemi yapan kendi işlemini almaz. E-postalar değişmedi (ayrı kanal).
- Satış ve çizim bildirimlerinde firma adı maskeli; müşteri yalnızca kendi siparişlerinin bildirimlerini görür;
  bildirimlerde tutar yoktur.

## 3.40.1 — 03.10.2026

- Onaylı yükleme kalemleri: bir yüklemede aynı cam satırı (ya da aynı aktarım) için "yüklenen" ve "yüklenmeyen"
  kayıtlarının tekilliği veritabanında yeni eklenen her kalem için zorunlu (iç sağlamlaştırma; ekranlarda değişiklik yok).

## 3.40.0 — 03.10.2026

- **Onaylı yüklemeyi düzeltme ("Düzelt")**: yönetici, yanlış onaylanan yüklenen / yüklenmeyen adedi düzeltebilir
  (10 yüklendi → 8 + 2 yüklenmedi; 8 + 2 → 10; tamamı yüklenmedi). İlk onay kaydı **değişmez ve silinmez**: düzeltme
  ayrı bir kayıt olarak eklenir (düzeltme no, zorunlu neden, kim, ne zaman). Kaydetmeden önce önizleme gösterilir
  (önce → sonra, etkilenen aktarımlar, finansal etki). Düzeltilen gün "Düzeltildi" rozetiyle görünür; tablo geçerli
  durumu, "Düzeltme tarihçesi" ilk onay kaydını ve her düzeltmeyi gösterir. Yalnızca var olan cam satırları düzeltilir;
  onayda hiç olmayan sipariş / satır eklenemez.
- **Düzeltme ve aktarım**: yüklenmeyen adet artarsa aktarılabilecek adet artar; azalırsa artık sığmayan etkin aktarım
  kendiliğinden kapanır. Kalanı ileri bir yüklemede zaten onaylanmış aktarımın altına düşüren düzeltme yapılamaz
  (önce o yükleme düzeltilir).
- **Düzeltme ve fatura — "Muhasebe işlemi gerekli"**: faturası kuyruktayken ya da kesilemeyip beklerken düzeltme
  yapılamaz. Kesilmiş faturanın kapsamı düzeltmeyle değişirse (eksik / fazla faturalandı) **hiçbir belge otomatik
  kesilmez ve kesilmiş belge değiştirilmez**; Faturalama bölümünde ve Tedarikçi Hesap Durumu'nda "Muhasebe işlemi
  gerekli" uyarısı çıkar ve o kapsam yeniden faturalanmaz (fazla faturalanan cam ileri güne aktarılıp yüklense de).
  Storno / düzeltme faturası sonraki aşamadadır.
- Kârlılık ve fatura önizlemesi geçerli (düzeltilmiş) fiili yüklemeyi izler; hiçbir adet iki kez sayılmaz.
- **Kısmi aktarım**: yüklenmeyen camın tamamı yerine bir kısmı da ileri güne aktarılabilir (2 adet → 1 adet 23.10, 1 adet
  30.10). Aktarılan adetlerin toplamı kalanı aşamaz; her aktarım yeni gününde yalnızca kendi adediyle görünür.
- **Sipariş sayfası — Finans / FGO**: proforma ödemesi artık **yalnızca FGO'dan** okunur; "Ödeme alındı" ile elle tutar
  girişi kaldırıldı. FGO'da proformaya gelen tahsilatın avansı kesilmemiş kısmı için "Avans Faturası Gönder" düğmesi
  cam yüklendikten sonra da çıkar (FGO tahsilatı / avansı kesilen / avansı kesilecek tutar gösterilir). Sonradan gelen
  her ek tahsilat için yeni bir avans faturası kesilebilir; avansı kesilmemiş tahsilat varken kapanış faturası
  kesilmez, kapanış faturası kesilmiş bütün avansları düşer.

## 3.39.0 — 03.10.2026

- **Yüklenmeyen cam (kırık / eksik / hazır değil)**: yükleme onayında cam satırı başına yüklenmeyen adet ve nedeni
  girilir ("Yüklenmeyen cam var"). Satır "yüklenen" ve "yüklenmeyen" olarak kaydedilir; yüklenmeyen cam faturalanmaz
  ve kârlılığa girmez. Boş bırakılan satırlar eskisi gibi eksiksiz yüklenmiş sayılır.
- **Yeniden planlama**: onaylı günün "Yüklenmeyen camlar" bölümünde yönetici kalan adedi ileri bir yükleme gününe
  aktarır. Yeni günde sipariş **yalnızca kalan adetle** ve "… yüklemesinden aktarıldı" notuyla görünür; o gün
  onaylanırken yine kısmen yüklenmezse kalan yeniden aktarılır. Eski yükleme onayı hiç değişmez; kopya sipariş açılmaz.
  Aktarım başka güne alınabilir ya da vazgeçilebilir (onaylanana kadar).
- Aktarılan kalan, fiilen yüklendiği yüklemede ve bir kez faturalanır; müşteri proformasındaki sipariş aynı proforma
  zincirinde kalır (ikinci proforma kesilmez).
- **Başka müşterinin sandığı (fiziksel yerleşim)**: yönetici bir siparişi aynı yükleme gününde başka bir müşterinin
  sandığına koyabilir. Siparişin müşterisi, teklifi, proforması, faturası, kuru ve sandık parası değişmez. Yükleme
  ekranında, yükleme dökümünde (Excel, yeni "SANDIK (FİZİKSEL)" sütunu) ve nakliye listesinde sandık ve ev sahibi
  yazar. Müşteri yalnızca kendi siparişinin sandık numarasını görür; müşteriler birbirinin siparişini, fiyatını ya
  da sandık ölçülerini görmez.
- İçinde başka müşterinin siparişi olan sandık, sandık formundan silinemez (önce yerleşim kaldırılır).
- Aktarım ve başka müşterinin sandığına yerleşim yalnızca yöneticidedir; denetim kaydına yazılır.

## 3.38.2 — 03.10.2026

- Müşteri faturası: siparişin kendi belge zinciri denetimi ortak kapsam denetimini kullanır (iç düzenleme; davranış
  değişmedi). Belgesi FGO'da silinmiş ya da isteği kesilemeyip bırakılmış sipariş müşteri faturasına girebilir.

## 3.38.1 — 03.10.2026

- Müşteri faturası: iç düzeltme (tip tanımı); davranış değişmedi.

## 3.38.0 — 03.10.2026

- **Onaylı yüklemeden müşteri faturası**: Yüklemeler → onaylı gün → "Faturalama" (yalnızca yönetici). Yükleme onayındaki
  **yüklenen** kalemler müşteriye göre ayrılır; müşteri başına **tek FGO faturası** kesilir (iki müşteri → iki fatura).
  Kaynak yalnızca yükleme onayıdır: planlanan gün, güncel teklif ya da fiyat tablosu faturayı etkilemez.
- **Kısmi yükleme**: 10 adedin 8'i yüklendiyse yalnızca 8 adet faturalanır; kalan 2 adet ileride yüklendiği onayın
  faturasına girer (iki kez faturalanmaz).
- **Önizleme**: sipariş, cam, yüklenen adet / m², tutar, kur ve RON toplamı fatura kesilmeden önce görülür; kesilen belge
  önizlemeyle aynıdır. Her satırın açıklaması kaynak sipariş numarasıyla başlar ("Comanda ABC001 — …"); belge
  açıklamasında siparişler ve onaylı yükleme günü yazar.
- **Müşteri proforması → avans → fatura**: müşteri proformasındaki siparişlerde fatura proformanın kuruyla kesilir ve
  yalnızca o yüklemede yüklenen kapsamı içerir; proformanın kalan kapsamı sonraki yüklemelerin faturasını bekler.
  Proformaya FGO'da tahsilat göründüyse önce **avans faturası** kesilir (tutar = FGO'da görünen tahsilat; yüklemeden
  önce ya da sonra, "Müşteri proforması" sayfasından ya da Faturalama bölümünden); fatura avansı "Stornare avans"
  satırıyla düşer. Avansı kesilmemiş tahsilat varken fatura kesilmez.
- **Proformasız** yüklemede fatura doğrudan kesilir; kur o anda müşterinin kur politikasından belirlenip faturayla
  kaydedilir (yönetici elle kur girebilir).
- Farklı para birimleri ve farklı kur kayıtları tek faturada birleştirilmez (ayrı fatura grubu olur; kur ortalaması yok).
  Siparişin kendi belge zinciri varsa (sipariş başına proforma / avans) faturası yine sipariş sayfasından kesilir.
- **Cam Tahsilat**: müşteri proforması + avans faturası + müşteri faturası **tek borç** olarak toplanır; faturalanan kısım
  faturada, henüz faturalanmamış kısım proformada sayılır. Her belge kaynak siparişleri ve yükleme günüyle görünür.
- Çift tıklama / yeniden deneme ikinci bir fatura üretmez. Kesilemeyen fatura kapsamı tutar; yeniden denenebilir ya da
  vazgeçilebilir. Belge FGO'da silinirse yalnızca belge kaydı geri alınır; yükleme onayı hiçbir durumda değişmez.

## 3.37.2 — 03.10.2026

- Müşteri proforması: iç düzeltme (tip tanımları); davranış değişmedi.

## 3.37.0 — 03.10.2026

- **Müşteri proforması (yükleme öncesi)**: Muhasebe → Cam Tahsilat → "Müşteri proforması". Yönetici bir müşteriyi ve
  gelecekteki bir ya da birkaç yükleme gününü seçer; o günlere planlı, teklifi müşteriye gönderilmiş cam siparişleri
  **tek FGO proformasında** toplanır (sipariş ya da gün başına ayrı proforma değil). Seçilmeyen günlerin ve başka
  müşterilerin siparişleri girmez.
- **Önizleme**: gün → sipariş → satır, tutarlar, toplam ve uygulanacak kur proforma kesilmeden önce görülür; kesilen
  belge önizlemeyle aynıdır. Proformaya giremeyen siparişler nedeniyle listelenir (iptal, beklemede, teklif
  gönderilmemiş, fiyat eksik, başka bir belgede, yüklemesi onaylanmış).
- **Sipariş numaraları belgede**: her satırın açıklaması kaynak sipariş numarasıyla başlar ("Comanda ABC001 — …");
  belgenin açıklamasında siparişler ve seçilen yükleme günleri yazar.
- **Kur**: müşterinin kur politikasından; yönetici kuru elle de girebilir. Kur ve içerik proforma oluşturulurken
  kaydedilir; sonradan yükleme günü, teklif ya da kur değişse de belge değişmez.
- **Çift faturalama engeli**: müşteri proformasındaki sipariş için sipariş başına ayrı belge kesilemez; kendi belgesi
  olan sipariş müşteri proformasına giremez. Çift tıklama ya da yeniden deneme ikinci bir proforma üretmez.
- **Cam Tahsilat**: müşteri proforması bir kez görünür (müşteri, kaynak siparişler, yükleme günleri, tutar, ödenen,
  kalan); ödeme durumu mevcut FGO eşitlemesiyle yenilenir. Belge FGO'da silinirse yalnızca belge kaydı kalkar,
  siparişler yeni bir proforma için yeniden uygun olur.
- Farklı para birimli siparişler tek proformada birleştirilmez. Kesilemeyen proforma yeniden denenebilir ya da
  vazgeçilebilir. Yalnızca yönetici.
- Yapılmadı (Aşama 7D-3): yükleme sonrası müşteri faturası. Müşteri proformasındaki siparişlerin yükleme sonrası
  faturası o aşamada müşteri düzeyinde kesilecek.

## 3.36.1 — 03.10.2026

- **Tekliflerdeki kur notu müşterinin kur politikasına göre**: "Banca Transilvania satış kuru" sabit metni kaldırıldı.
  Teklif ekranında, teklif PDF / Excel'inde ve profil sipariş formunda not artık politikaya göre yazılır: BT satış kuru,
  BNR kuru ya da "sözleşme kuru". Müşteriye özel yüzde müşteriye hiçbir yerde gösterilmez.
- **FGO belgesindeki kur cümlesi**: "Curs de vânzare BT: … RON/EUR", "Curs BNR: … RON/EUR (data …)" ya da (BNR + % ve
  elle girilen kurda) "Curs de schimb aplicat: … RON/EUR". Yüzde belgeye yazılmaz; uygulanan kur kayıtta saklanır.

## 3.36.0 — 03.10.2026

- **Kur politikası cam ve profil siparişlerinde aynı**: profil proforması ve faturası da müşterinin kur politikasıyla
  (BT / BNR / BNR + %) kesilir. Kur proformada belirlenir ve kaydedilir; fatura aynı kurla kesilir.
- **Her müşterinin bir kur politikası var**: "seçilmedi" seçeneği kaldırıldı; politikası seçilmemiş müşteriler ve yeni
  müşteriler *BT satış kuru – în unitățile BT* ile başlar (günün BT kuru, Entegrasyonlar'dan elle).
- **BNR kuru**: belge kesilirken BNR'nin yayımlamış olduğu son kur kullanılır (cumartesi kesilen belgede cuma kuru);
  BNR'nin kur günü belgeyle birlikte saklanır.
- **BT'nin XML dosyası artık hiçbir belgede kullanılmıyor**: Entegrasyonlar'daki "Kur kaynağı", "BT kur adresi" ve
  "Kuru dene" kaldırıldı. Gereken kur alınamazsa belge bekler; başka bir kura geçilmez. Yönetici kuru elle girebilir.
- FGO belgesinin açıklamasında kur gerçek kaynağıyla yazılır: "Curs BT vânzare", "Curs BNR" ya da (yüzde eklenmiş / elle
  girilmiş kurda) "Curs de schimb".
- Günün BT kuru girilince kur bekleyen cam belgeleri de hemen yeniden denenir.

## 3.35.1 — 03.10.2026

- BNR kuru: BNR'nin güncel dosya biçimi tanınıyor (dosya okunuyor ama "alınamadı" deniyordu). Kur yalnızca
  `curs.bnr.ro` adresinden alınır; BNR'nin ana sayfaya yönlenen eski adresi kullanılmaz.

## 3.35.0 — 03.10.2026

- **Müşteri kur politikası**: Yönetici → Müşteriler → müşteri sayfasında "Kur politikası" seçilir: *BT satış kuru – în
  unitățile BT*, *BNR kuru* ya da *BNR kuru + %* (yüzde müşteriye özel; ör. 5,1000 + %2 = 5,2020). Politika seçilmemiş
  müşterilerde hiçbir şey değişmez: bugüne kadarki kural (Entegrasyonlar'daki günün BT kuru) geçerlidir. Kesilmiş
  belgeler değişmez.
- **BNR kuru** doğrudan BNR'nin resmî dosyasından alınır. **BT "În unitățile BT → Vânzare" kuru otomatik alınamıyor**:
  bu politikada yöneticinin Entegrasyonlar'a girdiği günün BT kuru kullanılır ve "ELLE" diye işaretlenir; BT'nin XML
  dosyasındaki (farklı) kur bu politikada hiç kullanılmaz.
- Müşteri sayfasında ve cam siparişinin Finans / FGO bölümünde bugünün kuru gösterilir: politika, taban kur, yüzde,
  uygulanan kur, kaynak ve günü. Yönetici proformayı isterken kuru elle de girebilir; belge "ELLE" diye saklanır.
- Cam proforması artık kuru müşterinin politikasından alır ve kurla birlikte nereden geldiğini de saklar; avans ve
  kapanış faturası aynı kurla kesilir, sonradan BNR / BT ya da politika değişse de değişmez.
- Profil siparişlerinin faturalaması değişmedi (BT kuru, önceki gibi). Müşteri + yükleme başına tek FGO belgesi
  yapılmadı (Aşama 7D-2).

## 3.34.1 — 03.10.2026

- Onaylı yükleme kayıtları veritabanında da korunur: değiştirme ve silme veritabanı düzeyinde reddedilir (yalnızca yeni
  kayıt eklenebilir).

## 3.34.0 — 03.10.2026

- **Yükleme onayı ("Eksiksiz Yüklendi")**: planlanan yükleme günü artık camın yüklendiği anlamına gelmez. Yüklemeler →
  gün ayrıntısının altında yönetici, o günün müşteri → sipariş → cam listesini (adet, m², satış, maliyet) kontrol edip
  yüklemeyi onaylar. Onay; müşteriyi, siparişi, camı, adedi, m²'yi, maliyeti ve müşteriye giden fiyatı o anki hâliyle
  kaydeder. Kayıt sonradan değişmez: teklif, fiyat tablosu, katalog ya da yükleme tarihi değişse de aynı kalır. Aynı gün
  iki kez onaylanamaz; gelecekteki gün onaylanamaz; onaylayan ve zamanı denetim kaydına ve sipariş geçmişine yazılır.
  Yalnızca yönetici onaylayabilir. Eski yüklemeler onaylanmış sayılmaz.
- **Kârlılık**: onaylı yüklemelerde tutarlar onay kaydından gelir; onaylanmamış günlerde eski hesap sürer. Tedarikçi
  Hesap Durumu'nda her yükleme "onaylı" ya da "planlanan" olarak işaretlenir.
- **Eksik maliyetler**: Tedarikçi Hesap Durumu'nda yönetici, maliyeti kayıtlı olmayan satırın yalnızca fabrika birim
  maliyetini girebilir. Müşteri fiyatı değişmez; kayıtlı maliyetin üzerine yazılamaz; her giriş denetim kaydına yazılır.
  Onaylı yüklemeye girmiş siparişte maliyet bu ekrandan değiştirilemez.
- **Cam faturası koruması**: proforma ödenmiş ama avans faturası kesilmemişse, yüklenmiş siparişin kapanış faturası
  kesilmez ve nedeni sipariş sayfasında yazılır (düşüm otomatik yapılmaz). Ödenmemiş proformalı ve avans faturalı
  siparişlerde akış aynı.
- Yapılmadı (Aşama 7D): müşteri + onaylı yükleme başına tek FGO belgesi. Yükleme sonrası fatura hâlâ sipariş başına.

## 3.33.2 — 02.10.2026

- Muhasebe ekranları, görünüm: "FGO ile Güncelle" başlığın sağında; tahsilat tablosu ve tedarikçi özeti geniş ekranda
  yana taşmaz (kısa sütun başlıkları, son kontrol saati ikinci satırda); para birimi sütunu olan tablolarda tutarlar
  yalın yazılır.

## 3.33.1 — 02.10.2026

- 3.33.0'ın yayın öncesi düzeltmesi (tip tanımı); davranış değişikliği yok.

## 3.33.0 — 02.10.2026

- **Fatura numarası**: numarayı artık FGO verir. Sistem "son numara + 1" üretmez ve kendiliğinden sayaç tutmaz.
  Entegrasyonlar → "Sonraki fatura numarası" yalnızca isteğe bağlı, tek seferlik elle numaradır: doluysa sıradaki
  fatura tam o numarayla istenir, fatura kesilince alan boşalır. FGO numarayı reddederse FGO'nun kendi hata mesajı
  gösterilir, başka numara denenmez. Kaydedilen numara her zaman FGO'nun döndürdüğü numaradır.
- **Tahsilat toplamları**: aynı borç iki kez sayılmaz. Fatura kesildiyse proforma toplamdan çıkar ("faturaya döndü");
  cam avans faturası proformanın o kadarının yerine geçer. Belgelerin hepsi listede durur. Liste sipariş başına
  gruplanır; süzgeç: Tümü / Açık / Ödendi.
- **Yükleme kârlılığı**: satış (yöneticinin müşteri fiyatı) ve maliyet (satış fiyatı — teklif hazırlanırken fabrika
  fiyat tablosundan) artık teklif satırlarından, fatura ve yükleme dökümüyle aynı kuralla hesaplanır. Müşteri fiyatı
  değişince maliyet değişmez. Müşteriye bedelsiz verilen camın fabrika maliyeti sayılır. Yöneticinin teklife eklediği
  satır eklendiği andaki fabrika fiyatını alır; fabrika fiyatı bulunamayan satır sessizce 0 sayılmaz, sipariş
  "maliyet eksik" olarak gösterilir.
- **FGO ödeme durumu**: işçi açık belgeleri (ödenmemiş / kısmi) saatte bir FGO'dan yeniler. "FGO ile Güncelle" durur;
  ikisi aynı anda çalışmaz. Otomatik güncelleme kayıt silmez, sipariş adımını değiştirmez.
- **Muhasebe ekranları** (Profil Tahsilat, Cam Tahsilat, Tedarikçi Hesap Durumu) ortak görünüme alındı: para birimi
  başına özet kartları, hizalı tutar sütunları, durum rozetleri, fabrika bakiye kartları.
- Güvenlik testleri: müşteri, satış, çizim ve denetimci muhasebe sayfalarına adresle giremez; müşteri ve satış form
  gönderimini taklit ederek muhasebe / FGO işlemi çalıştıramaz.
- **Yapılmadı (şema onayı bekliyor)**: yükleme onayı ("Eksiksiz Yüklendi"), müşteri + yükleme başına tek FGO belgesi
  ve kârlılığın onaylı yüklemeden hesaplanması. Önerilen şema: `docs/decisions.md` → "Beklemede".

## 3.32.3 — 02.10.2026

- **Eski çok camlı taslaklar**: tek cam kuralından önce kaydedilmiş, birden çok cam içeren taslak artık yalnızca ilk
  camla açılmaz. Taslak açılınca bütün camlar (ad ve adet) listelenir ve taslağın bu hâliyle gönderilemeyeceği
  yazılır; müşteri bu sipariş için tutulacak camı seçip onaylar. Onaylayana kadar taslakta hiçbir şey değişmez.
  Onaydan sonra taslakta yalnızca seçilen cam kalır (dosyalar, not, ad ve numara aynı), diğer camlar için ayrı
  sipariş açılması gerektiği bildirilir ve normal sipariş formu açılır. Gönderilmiş eski siparişler değişmedi.

## 3.32.2 — 02.10.2026

- Yeni Sipariş: hata sonrasında cam seçiminin geri yazılması sağlamlaştırıldı.

## 3.32.1 — 02.10.2026

- Yeni Sipariş: sunucu bir hata döndürdüğünde (ör. numara kullanılıyor) cam seçimi artık boşalmaz; seçilen
  dosyalar ve taslaktan çıkarılacak dosya işaretleri de yerinde kalır.

## 3.32.0 — 02.10.2026

- **Müşteri "Yeni Sipariş" ekranı** (eski TAKİP düzeni, yeni görünüm): sayfa başlığı ve açıklama, seçili sipariş tipi
  ("Sipariş tipini değiştir"), belirgin bölümler, altta sabit gönderim çubuğu (eksikler listesi + Taslak kaydet /
  Siparişi gönder).
  - **Tek cam**: müşteri bir siparişte yalnızca bir cam tipi seçer (etiketli cam + adet alanı). Sunucu da yeni
    siparişte sıfır ya da birden çok camı kabul etmez. Eski çok camlı siparişler ve satış / yönetici teklif
    tablosu ("+ Cam ekle") aynen durur.
  - **Tahmini yükleme tarihi** notu belirgin bir kutuda; tarih siparişe yazılan tarihle aynı hesaptan gelir.
  - **Dosyalar**: "Dosyaları buraya sürükleyin" alanı; seçilen dosyalar ad ve boyutla listelenir, birkaç seferde
    eklenebilir, listeden çıkarılabilir; hata olursa yeniden seçmek gerekmez. Yükleme kuralları ve virüs taraması aynı.
  - **Ek bilgi** alanı belirgin başlıkla.
- **Profil sipariş formu**: aynı görünüm; birim ve adet sütunları tüm kategorilerde hizalı, kategori başlığında
  ürün ve seçili ürün sayısı. Profil akışı (yönetici fiyatı, müşteri onayı, teslim alma tarihi) değişmedi.

## 3.31.2 — 02.10.2026

- Çizim yüklendikten sonraki bildirim yeni akışı anlatır: “Kontrol Et” ile açıp müşteriye gönderin.

## 3.31.1 — 02.10.2026

- Çizim görüntüleyici: yazı tipi gömülmemiş PDF'ler artık cihazdaki yazı tipiyle değil, uygulamayla gelen standart
  yazı tipleriyle çizilir — çizim her cihazda aynı görünür.

## 3.31.0 — 02.10.2026

- **Çizim akışı (mevcut akış genişletildi; yeni tablo ya da durum yok)**:
  - **Zorunlu kontrol**: Yükle → "Kontrol Et" → görüntüleyici → "Müşteriye gönder" → onay penceresi. Sipariş
    sayfasında gönderme düğmesi yok; sunucu da kontrol ekranı açılmadan gelen gönderimi reddeder (kontrolden sonra
    taslağa dosya eklenir / çıkarılırsa ya da 2 saat geçerse yeniden kontrol gerekir).
  - **Müşterinin açabileceği dosya şart**: sürümde virüs taramasından temiz en az bir PDF, JPG ya da PNG yoksa
    gönderilemez. DWG, DXF, STEP gibi teknik dosyalar ek olarak kalır.
  - **Müşteri**: "Bu çizimi onayla" artık görüntüleyicide de var; onay sürüm başınadır ve kesindir. Onay yetkisi
    olmayan müşteri kullanıcısı ne onaylayabilir ne revizyon isteyebilir (yalnızca inceler).
  - **Çizimci sipariş sayfası**: müşteri sipariş dosyaları → teknik çizimler ve onay (yükleme bu bölümde) → notlar →
    sipariş bilgileri; büyük durum kartları yerine başlıkta küçük rozetler.
  - **Görüntüleyici**: karar / gönderim / revizyon notu çizimin yanında; serbest çizimde nokta kaybı giderildi;
    pdf.js yazı tipleri ve cMap'ler uygulamanın kendi adresinden gelir (dış sunucu yok).
- **E-posta**: müşteri revizyon istediğinde ya da çizimi onayladığında atanmış çizimci ve ilgili satışçı bilgilendirilir
  (yönetici değil); revizyon e-postasında müşterinin notu da yazar. Müşteriye giden çizim e-postası değişmedi.
- **"Müşteri tarafından onaylanmış çizimler"** listesi çizim ekibinin yanında satış ve yöneticide de görünür;
  yükleme gününe göre süzülür, en yeni / en eski sıralanır.

## 3.30.0 — 02.10.2026

- **Yükleme Dökümü Excel**: tek satır = müşteri + para birimi + cam + camın birim fiyatı. Aynı cam farklı fiyatla ayrı
  satırlarda kalır (fiyatlar ortalanmaz); aynı müşteri, cam ve fiyat siparişler arasında tek satırda toplanır (sipariş
  ve proje adları birlikte). CNC, delik ve sandık parası eskisi gibi ait olduğu camın tutarına dahildir.
- **Müşteri "Yükleme takvimim"**: müşteri kendi sandıklarının numarasını, uzunluk × genişlik × yüksekliğini, net ve
  brüt ağırlığını görür (salt okunur; aynı sandık kayıtları). Başka firmanın sandığı görünmez; iç not gösterilmez.

## 3.29.0 — 02.10.2026

- **Görünüm, 4. aşama: Yüklemeler ve sandıklar** (yükleme günü, hesaplar, yetkiler ve sandık kayıtları aynı):
  - Sayfa başlığının sağında gün seçimi + "Nakliye Listesi" + "Yükleme Dökümü Excel"; takvimde yüklemesi olan günler
    belirgin, seçili gün çerçeveli.
  - Gün ayrıntısı: çerçeveli tablo; her müşteri bir başlık satırı (ad, sandık etiketi, toplamlar), altında siparişleri,
    onların altında "Sandıklar" bölümü; belirgin toplam satırı; siparişin sandık numaraları rozet olarak.
  - Sandık girişi: daha büyük giriş alanları, hizalı sütunlar, ayrı sil sütunu, altta araç çubuğu (+ Sandık ekle,
    net / brüt toplam, kaydet).
  - Müşterinin "Yükleme takvimim" sayfası aynı görünümle; gördüğü veri değişmedi (yalnızca kendi siparişleri,
    sandık numaraları ve ağırlıkları).
- Yükleme Dökümü Excel: kural değişmedi; sandık parasının faturadaki gibi camın tutarına eklendiği testle sabitlendi.

## 3.28.1 — 02.10.2026

- Sipariş sayfası düzeni ve teklif tablosu araçları için uçtan uca test (kilitli olmayan satış hesabıyla).

## 3.28.0 — 02.10.2026

- **Görünüm, 3. aşama: sipariş sayfası ve teklif tablosu** (iş akışı, fiyat hesabı, yetki ve veri aynı):
  - Bölüm sırası (yönetici, satış, denetimci, müşteri): yapılabilecek işlemler → müşteri sipariş dosyaları → notlar →
    sipariş bilgileri → teknik çizimler ve onay → teklif → finans / sandık. Çizim ekibinin sırası değişmedi.
  - Sipariş bilgileri tam genişlikte (solda gri etiket, sağda değer).
  - Teklif tablosu: çerçeveli hücreler, kalan genişliğin tamamını alan açıklama sütunu (cam adı artık kırpılmıyor;
    dar ekranda tam ad kutunun altında), satır işlemleri (+CNC, +Delik, bedelsiz) açıklamanın altında, belirgin
    "aynı camdan +" düğmesi, ayrı sil sütunu, belirgin toplam satırı; araç çubuğu: + Cam ekle · + Sandık parası ·
    Excel'den Aktar · Tek fiyatı tüm satırlara uygula · Tabloyu temizle.
  - Yeni (satış, yalnızca düzenleme kolaylığı): **"Tek fiyatı tüm satırlara uygula"** — işaretliyken bir m² cam
    satırına yazılan fiyat tüm m² cam satırlarına yazılır; CNC, delik, sandık parası ve bedelsiz satırlar değişmez.
  - Excel'den Aktar penceresi: geçersiz satırların listesi (satır no + neden), seçilen sütunlar vurgulu.
  - Düğmeler: onay işlemleri yeşil (fiyatı onayla ve gönder, çizimi onayla), sipariş iptali dolu kırmızı.

## 3.27.0 — 02.10.2026

- **Görünüm, 2. aşama** (yalnızca arayüz; iş akışı, yetki, veri ve adresler aynı) — eski TAKİP'e yakın, daha sade:
  - Sol menü: üstte "TAKİP" + sürüm ve menüyü gizleme oku, büyük GKH logosu, bölüm başlıkları, rahat satır
    yüksekliği, altta "Developed by" satırı. Menü kapalıyken sol kenarda küçük sekme hep görünür.
  - Üst çubuk: rol sağda rozet olarak (dar ekranda adın altında), müşteride adın altında firma adı.
  - Paneller ve listeler (yönetici, satış, müşteri, çizim): bölüm başlığında yuvarlak sayaç, başlıkla aynı hizada
    tablolar, satırın üzerine gelince hafif zemin, ortalanmış hücreler, küçük satır düğmeleri, sola yaslı boş
    durum metni, daha belirgin sayaç kutuları. Dar ekranda liste tabloları sütunları ezmeden yatay kayar.
  - Düğmeler: ana (mavi), ikincil (çerçeveli), olumlu (yeşil), kritik / silme (kırmızı) sınıfları.

## 3.26.0 — 02.10.2026

- **Ortak görsel temel** (yalnızca görünüm; iş akışı, yetki, veri ve adresler aynı): tek stil dosyasında merkezi
  belirteçler (renk, yazı, boşluk, köşe, gölge), GKH mavisi, açık gri zemin ve menü, beyaz kartlar, yumuşak durum
  rozetleri, daha okunur yazı boyutları (gövde 15 px, tablo 14,5 px, en küçük 13 px), büyük giriş alanları, görünür
  klavye odağı. Menü, üst çubuk, kart, düğme, form, tablo, uyarı, pencere ve boş / bekleme durumları tüm rollerde
  aynı. Yazı tipi Inter (uygulamayla birlikte sunulur). Kurallar: `docs/UI-DESIGN.md`.

## 3.25.2 — 02.10.2026

- **FGO ölçü birimi düzeltmesi**: "bucăți" birimli (ACCESORII) profil ürünü olan siparişlerde proforma
  "Continut[UM] … 5 caractere" hatasıyla reddediliyordu. Birimler artık tek eşlemeden gelir (cam `mp`, adet `buc`,
  `cutii`, `pungi`, `bară`; "bucăți" → `buc`) ve belge FGO'ya gitmeden önce doğrulanır (boş değil, en çok 5 karakter).
  Reddedilen sipariş için sipariş sayfasında "FGO'da yeniden dene".

## 3.25.1 — 02.10.2026

- Çizim görüntüleyici için uçtan uca test (gerçek PDF ve görselle): "Kontrol Et", çizim üzerine işaretli revizyon
  talebi, işaretlerin çizimcide görünmesi, başka firmanın ekranı açamaması, "onaylanmış çizimler" kuyruğu.

## 3.25.0 — 02.10.2026

- **Çizim görüntüleyici**: PDF ve görseller uygulama içinde açılır ("Aç ve incele"; çizimci için gönderimden önce
  "Kontrol Et"). Müşteri **"Revizyon iste"** ile çizim üzerine işaret koyar (İğne, Dikdörtgen, Serbest, Metin) ve
  zorunlu revizyon notunu yazar; işaretler talebe kaydedilir, çizimci ve iç ekip çizim üzerinde görür.
- Çizim paneli: "Yapılacak çizimler", "Onay bekleyen çizimler" ve yeni **"Müşteri tarafından onaylanmış çizimler"**
  (yükleme gününe göre gruplu, en yeni / en eski).
- Çizimcinin sipariş sayfası: müşteri sipariş dosyaları → teknik çizimler → notlar → sipariş bilgileri; teklif, sandık
  ve cam (ticari) bölümleri gösterilmez. Müşteri listesinde durum: "Çizim onay bekliyor".

## 3.24.0 — 02.10.2026

- Yüklemeler: **Yükleme Dökümü Excel** — seçilen yükleme gününün tüm müşteri / siparişleri tek dosyada; müşteriye göre
  gruplu, müşteri içinde aynı cam tek satırda (adet ve m² toplamı); tutar faturadaki kuralla (cam + CNC / delik / diğer
  kalemler camın tutarına dahil). Yönetici, satış ve denetimci indirir; satışta satış fiyatı ve maskeli firma adı.

## 3.23.0 — 02.10.2026

- Müşteri menüsünde **Ayarlar**: sabit dil (her girişte bu dil açılır) ve e-posta bildirimlerini açma / kapama
  (şifre / davet e-postaları ve fatura belgeleri etkilenmez).
- Satışın sipariş sayfası: "Müşteri sipariş dosyaları" en üstte, hemen altında "Notlar"; "İstenen camlar" ve
  "Sandıklar" bölümleri bu ekranda gösterilmez (veriler durur).

## 3.22.0 — 02.10.2026

- Satış teklif tablosu: **+ Sandık parası** (adetle fiyatlanan teklif satırı), **Tabloyu temizle** (onayla; tablo
  müşterinin siparişindeki ilk hâline döner), cam adının yanında **+** (aynı camdan yeni satır, hemen altına).
- **Excel'den Aktar** artık eski **.xls** dosyalarını da okur (.xlsx ile aynı ön izleme, sütun eşleştirme ve doğrulama).

## 3.21.4 — 02.10.2026

- Sunucu: gece yedeğindeki eski derleme önbelleği temizliği kaldırıldı; tek otomatik temizlik başarılı yayından sonraki
  10 GB / 7 gün denetimi.

## 3.21.3 — 02.10.2026

- Sunucu: başarılı yayından sonra Docker derleme önbelleği denetlenir; 10 GB'ı aşmışsa 7 günden eski önbellek silinir
  (imajlara, birimlere, veriye dokunulmaz; hata yayını bozmaz). Yeni komut: `takip cache`.

## 3.21.2 — 01.10.2026

- Sunucu: ClamAV kapsayıcısının sağlık denetimi IPv4 (127.0.0.1) ile yapılır; çalışan servis artık "unhealthy" görünmez.

## 3.21.1 — 01.10.2026

- Sunucu yedeği: her gün 03:00 (Romanya saati); veritabanı + dosyalar ortak zaman damgalı çift, geçici veritabanına geri
  yüklenerek doğrulanır, Google Drive'a kopyalanıp md5 ile doğrulanır; yerelde ve Drive'da son 14 çift. Yeni komutlar:
  `takip restore yesterday | TARİH`, `takip restore-test [TARİH]`.

## 3.21.0 — 01.10.2026

- **Bildirim e-postaları** (mevcut SMTP ve bildirim kuyruğu): müşteriye teklif / proforma / fatura (profil), yükleme
  tarihi değişikliği ve çizim onayı; iç ekibe yeni sipariş (cam → satış, profil → yönetici), çizim işleri ve müşteri
  onayları. İşlem tamamlandıktan sonra işçi gönderir; hata işlemi etkilemez, yeniden denenir, sonunda kuyrukta FAILED
  olarak kalır. Cam FGO belgeleri zaten ayrı e-postayla gittiği için tekrar gönderilmez. `NOTIFY_EMAILS=false` ile kapatılır.

## 3.20.1 — 01.10.2026

- Tip düzeltmesi (Excel dosya yolu).

## 3.20.0 — 01.10.2026

- Müşteri yeni CAM siparişinde yalnızca bir cam tipi seçer ("Cam ekle" kaldırıldı; sunucu ikinci camı kabul etmez).
  Eski siparişler değişmez.
- Satış teklif tablosu: müşteri Excel (.xlsx) yüklediyse **Excel'den Aktar** — ön izleme, Genişlik / Yükseklik / Adet
  sütun eşleştirmesi, geçersiz satırlar işaretli, geçerli/geçersiz sayısı; aktarılan satırlara siparişteki cam uygulanır
  ve elle eklenen satırla aynı fiyat kuralı işler.
- Uzun teklif tablosunda sağda küçük ↑ / ↓ (tablonun başına / sonuna).

## 3.19.1 — 01.10.2026

- Test düzeltmesi (fiyatsız satır, boş fiyat formda 0 olarak gelir).

## 3.19.0 — 01.10.2026

- Teklif: **PDF İndir / Excel İndir** (cam siparişi, teklif bölümü). Yönetici her zaman indirir; müşteri PDF'i her zaman,
  Excel'i yalnızca yöneticinin o siparişte verdiği izinle ("Müşteri Excel indirebilir") indirir — izin sunucuda denetlenir.
  PDF ve Excel aynı satırları ve müşteri fiyatlarını içerir.
- Satış, fiyatı eksik teklifi yöneticiye gönderemez (sunucuda da denetlenir; cam, CNC, delik ve diğer satırlar; 0 kabul
  edilmez, "bedelsiz" satır hariç). Hata mesajı eksik satırı (ürün adıyla) gösterir. Taslak kaydı engellenmez.

## 3.18.0 — 01.10.2026

- Yüklemeler: **Nakliye Listesi** (PDF) — seçilen yükleme gününün sandıkları müşteri koduna göre (sandık no, ölçü, ağırlık,
  not, ara toplam), sandık adedi ve toplam ağırlık, sandığı girilmemiş siparişler. Yönetici, satış ve denetimci indirir
  (yeni yetki `TRANSPORT_LIST_VIEW`); müşteri göremez.

## 3.17.1 — 01.10.2026

- Demo verisi de yeni tahmini yükleme hesabını kullanır.

## 3.17.0 — 01.10.2026

- Panel sayfalarındaki veriler 60 saniyede bir kendiliğinden yenilenir (sayfa yeniden yüklenmez; forma yazılan veri kaybolmaz).
- CAM siparişi tahmini yükleme tarihi: Çarşamba–Salı dönemindeki siparişler dönemin Çarşambasından 23 gün sonraki Cuma
  (30.09–06.10.2026 → 23.10.2026). Yeni sipariş formunda gösterilir ve yeni siparişin tahmini yükleme tarihi olur;
  mevcut siparişlerin tarihleri değişmez.
- Profil siparişi (müşteri): "Predare" yalnızca tarih (saat yok).

## 3.16.7 — 01.10.2026

- Muhasebe → **Profil Tahsilat**'ta da "FGO ile Güncelle" FGO'da silinmiş belgelerin kaydını kaldırır ve siparişi geri alır:
  fatura silindiyse sipariş "Teslim edildi" adımına döner (arşivden çıkar), proforma silindiyse "Onaylandı" adımına; yeni
  belge "FGO'da yeniden dene" ile kesilir. Siparişin geçmişine "Belge FGO'da silinmiş" satırı yazılır.
- Cam siparişinde proforma silindiyse kur ve elle girilen ödeme de sıfırlanır.

## 3.16.6 — 01.10.2026

- **Fatura numarası düzeltildi:** Entegrasyonlar → FGO → "Sonraki fatura numarası" doluysa fatura tam bu numarayla kesilir
  ve her faturadan sonra kendiliğinden bir artar (önceden sistemde kalan silinmiş deneme faturaları numarayı yukarı itiyordu).
- FGO'da silinmiş belgelerin kaydı (numara gerektiğinde ya da Muhasebe → "FGO ile Güncelle"de) sistemden kaldırılır; numarası
  yeniden kullanılır. FGO istenenden farklı numara keserse "Önemli kararlar"da uyarı çıkar.

## 3.16.5 — 01.10.2026

- FGO **fatura numarası** = sistemdeki son fatura numarası + 1 (cam avans/kapanış ve profil faturası). Entegrasyonlar → FGO'da
  "Sonraki fatura numarası (en az)" girilebilir (FGO'da elle kesilen faturalar için); sıradaki numara orada görünür.
- Faturada CNC, delik ve diğer kalemler cama **TVA hariç** eklenir ve satırın TVA dahil toplamı proformadaki satırların
  toplamı olarak gönderilir: fatura genel toplamı proformayla aynı (kuruş farkı kalmaz).

## 3.16.4 — 01.10.2026

- Cam **proformaları ayrıntılı**: her cam satırı ayrı (Romence nitelik, m²), CNC ve delik ayrı satırlarda. "Yalnızca cam,
  işlemler cama eklenir" kuralı yalnızca **faturalarda**.

## 3.16.3 — 01.10.2026

- Cam proforma ve faturalarında **yalnızca cam** yazılır: satır adı camın Romence niteliği (ölçü ve adet yok); CNC ve delik
  tutarları ilgili camın tutarına eklenir; aynı nitelikteki camlar tek satırda (m² toplamı).

## 3.16.2 — 01.10.2026

- Cam proforma ve faturalarında açıklama yalnızca siparişin açıklaması; satırlar Romence (cam adı, "Prelucrare CNC", "Gaură").
- Cam siparişi bilgilerinde proforma, avans faturası ve fatura ayrı satırlarda, bağlantısıyla (müşteri panelinde de).

## 3.16.1 — 01.10.2026 · Cam siparişi FGO belgeleri

- Cam siparişi sayfasında yönetici için **Finans / FGO** bölümü: belgeler (tür, no, toplam, tahsil edilen, kalan, durum) ve
  duruma göre tek düğme: **Proforma Gönder** → (ödeme) **Avans Faturası Gönder** → (yüklenince) **Fatura Gönder**.
  Müşteri onayı yok; sipariş durumu değişmez.
- Proforma ödendi: FGO'da tahsilat görünürse ya da yönetici "Ödeme alındı" (tutar) derse. Avans faturası tahsil edilen
  tutar kadar; kapanış faturasında avans eksi satırla düşülür. Cam yükleme gününden 2 gün sonra "yüklendi" sayılır.
- Aynı belge iki kez kesilemez (ekranda, sunucuda, veritabanında ve FGO'da).
- Belge, firmanın Müşteriler kartındaki e-postasına Romence e-postayla (belge no, tutar, PDF bağlantısı) gider.
- Belgeler Muhasebe → Cam Tahsilat'ta da görünür (aynı kayıt).
- FGO ayarlarında **günlük belge sınırı** (deneme için varsayılan 3; 0 = sınırsız).

## 3.15.1 — 01.10.2026 · Muhasebe

- Yönetici menüsünde **Muhasebe**: Profil Tahsilat, Cam Tahsilat, Tedarikçi Hesap Durumu (yalnızca yönetici).
- **Profil / Cam Tahsilat:** FGO'da kesilen proforma ve faturalar; toplam, tahsil edilen, kalan ve durum (Ödenmedi /
  Kısmi Ödendi / Ödendi) FGO'dan okunur ("FGO ile Güncelle"). Cam belgeleri sonraki aşamada; şimdilik boş.
- **Tedarikçi Hesap Durumu:** yükleme günü başına cam m², satış, maliyet, transport ve kâr; transport elle girilir.
  Fabrika cari hesabı: ödemeler (tarih, tutar, para birimi, açıklama) yüklemelerden bağımsız; bakiye = maliyet − ödeme.
  Para birimleri ayrı gösterilir.

## 3.14.1 — 01.10.2026

- FGO: "The value … is not valid for IdExtern" hatası düzeltildi (müşteri kimliği FGO'ya gönderilmiyor; FGO orada tam sayı bekliyor).

## 3.14.0 — 01.10.2026 · Okunabilirlik

- **Sipariş bilgileri** eski TAKIP düzeninde: alt alta satırlar, solda gri zeminde kalın etiket, sağda büyük değer, satır
  arası ince çizgi; masaüstünde en fazla ~980 px genişlik. Başlık satırı eklendi; cam ve sandık etiketi ayrı satırlarda
  (müşteri kaydından). Kim neyi görür değişmedi.
- **Yazılar büyüdü** (ortak stiller): metin 15 px, tablo ve form 14 px, kart başlıkları 19 px, etiketler 14 px kalın,
  küçük bilgiler en az 13 px.

## 3.13.7 — 01.10.2026

- **Kur kaynağı ayarı** (Entegrasyonlar → FGO): varsayılan **elle** — proforma, yöneticinin girdiği günün "În unități BT" EUR satış kuruyla kesilir (BT'nin dosyasındaki kur bu tabloyla aynı değil). Kur girilmemişse proforma bekler; kur girilince bekleyen proformalar bir dakika içinde kesilir.

- BT kuru artık BT'nin sunucular için yayımladığı resmî kur dosyasından (`dev.bancatransilvania.ro/exchange.xml`) alınır; web sayfası sunucuya HTTP 403 veriyordu. Kayıtlı eski adres kendiliğinden yenisine çevrilir.

- BT kuru sayfadaki **"În unități BT"** tablosunun EUR satış (vânzare) sütunundan okunur; diğer tablolar ve çevirici karıştırılmaz.

- BT kur sayfası sunucuya "HTTP 403" verdiğinde: istek artık normal bir tarayıcı gibi yapılır; yine okunamazsa
  **günün kuru** (Yönetici → Entegrasyonlar, elle, yalnızca o gün geçerli) kullanılır. O da yoksa proforma işi bekler
  ve yeniden denenir.
- BT tablosunda (BNR · alış · satış) satış kuru doğru sütundan okunur.
- Sunucuda `takip kur`: BT kur sayfasının sunucudan okunup okunamadığını gösterir.

## 3.13.1 — 01.10.2026 · Aşama 6b (FGO bağlantısı)

- **FGO:** Yönetici → Entegrasyonlar'da FGO bölümü (açık/kapalı, test/gerçek ortam, CUI, şifreli saklanan API anahtarı,
  PRF / GKH serileri, TVA %21, BT kur adresi; "Bağlantıyı dene" ve "Kuru dene").
- **Proforma kendiliğinden:** müşteri profil teklifini onaylayınca PRF serisinde RON proforma kesilir. Birim fiyat = EUR
  fiyat × o günün Banca Transilvania EUR satış kuru. Kur, günü ve proforma bağlantısı siparişte görünür.
- **Fatura kendiliğinden:** mal teslim edilince (depo bağlantısı ya da yönetici) GKH serisinde, **proformanın kuruyla**
  fatura kesilir ve sipariş arşive geçer.
- Kur alınamazsa ya da FGO belgeyi reddederse "Önemli kararlar"a uyarı düşer; siparişte "FGO'da yeniden dene" (kuru elle
  girerek). Elle düğmeler yedek olarak kalır; FGO açıkken elle proformada kur girilmesi gerekir.
- **Müşteri fatura bilgileri** (Yönetim → Müşteriler → firma): CUI, Nr. Reg. Com., ülke, județ, localitate, adres.
- Ödeme FGO'dan okunamadığı için "Ödeme alındı" elle işaretlenmeye devam eder.

## 3.12.3 — 01.10.2026

- Sipariş bilgilerinde **Cam etiketi** ve **Sandık etiketi** ayrı satırlarda; değerler müşteri kaydından (Yönetim → Müşteriler).
- Menü kapalıyken içerik ekranın tüm genişliğini kullanır.
- Menü kapalıyken açma oku, fare sol kenara hangi yükseklikte gelirse orada belirir; uzaklaşınca kaybolur.

## 3.12.2 — 01.10.2026

- Dar ekranda kapalı menü tamamen gizlenir (klavyeyle de odaklanılmaz); Hareketler menünün en altına yerleşir.

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
