# Sürüm notları

Sürüm numarası logonun altında görünür ve her güncellemede artar:
**yeni özellik → ikinci hane** (3.1.0), **düzeltme → üçüncü hane** (3.0.1).
Önceki sistem v2.25 olduğu için yeni sistem 3.0.0 ile başladı.

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
