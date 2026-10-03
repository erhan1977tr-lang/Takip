# Sürüm notları

Sürüm numarası logonun altında görünür ve her güncellemede artar:
**yeni özellik → ikinci hane** (3.1.0), **düzeltme → üçüncü hane** (3.0.1).
Önceki sistem v2.25 olduğu için yeni sistem 3.0.0 ile başladı.

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
