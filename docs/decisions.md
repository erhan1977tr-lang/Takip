# Kararlar ve yol haritası

Kaynaklar: `CLAUDE.md` (proje kuralları) ve `docs/spec/GKH_TAKIP_REBUILD_SPEC.md` (ana tanım, v1.0).
Bu dosya, tanımla mevcut sistemin çeliştiği yerlerde ürün sahibinin **verdiği kararları** kaydeder.
Tanım ile bu dosya çelişirse bu dosya geçerlidir.

## Onaylanan kararlar (29.09.2026)

| # | Konu | Karar | Tanımdaki karşılığı |
|---|------|-------|---------------------|
| 1 | Çizim ve teklif | **Paralel** yürür. Satış incelemesinden sonra çizim (gerekiyorsa) ve teklif birbirini beklemez. | Tanım sıralı akış çiziyor (çizim → teklif). |
| 2 | Müşteri onayı | Müşteri teklifi **onaylamaz**. Çizim onaylı/gereksiz **ve** teklif müşteriye gönderilmişse sipariş kendiliğinden üretime geçer. | Tanım "customer-visible offer / approval" diyor. |
| 3 | Reddetme / iptal | Satış siparişi reddedemez. **Yalnızca yönetici iptal eder.** | — |
| 4 | Fiyat | **İki kademe:** satış kendi fiyatını girer (satış fiyatı / satış tutarı). Yönetici teklifin **yönetim kopyasını** yeni sürüm olarak açar, müşteri fiyatını girer (teklif fiyatı / teklif tutarı). Müşteri yalnızca yönetici fiyatını görür. Yönetici fiyatını yönetici dışında kimse görmez. Yönetici ekranlarında (teklif, yükleme) iki sütun yan yana. | Tanım tek fiyat katmanı anlatıyor. Ayrıntı: ADR 0009. |
| 5 | Sipariş no | **Firma kodu + müşterinin sipariş numarası** (`GLA68`). Numara zorunlu; formda firmanın bir sonraki numarasıyla dolu gelir, müşteri değiştirebilir; sipariş oluştuktan sonra sabit. Firma kodları benzersiz olduğundan numaralar çakışmaz. Önerilen numara değiştirilmemişken aynı anda başka sipariş aldıysa bir sonraki numara otomatik verilir. (29.09.2026'da netleşti; ilk yorumdaki "ayrı sistem numarası" düzeltildi.) | Tanım müşteri numarasının ayrı tutulmasını öneriyor; ürün sahibi kuralı netleştirdi. |
| 6 | Adresler | Ortak sayfa adresleri kalır (`/siparisler`, `/teklifler`, `/yuklemeler`, `/admin/...`); sayfa role göre içerik gösterir. | Tanım `/customer/...`, `/sales/...` öneriyor. |
| 7 | Maskeleme | Sabit uzunluk: ilk 3 karakter + 10 yıldız (`GLA**********`). Ad uzunluğu da gizlenir. Sunucuda yapılır. | Tanım adın uzunluğu kadar yıldız gösteriyor. |
| 8 | Denetimci | İlk sürümde **yalnızca görüntüler**, hiçbir işlem yapamaz. | Tanımda belirsiz bırakılmış. |
| 9 | Dil | Romence ve Türkçe kalır. İngilizce arayüz yok. | Tanım İngilizce örnekler kullanıyor. |
| 10 | Antivirüs | Müşterinin ya da başkasının yüklediği her dosya taranır; ayarlar yönetici **Entegrasyonlar** sayfasından. Ayrıntı: ADR 0010. | Tanım "scan/validate uploads as appropriate". |

## Aşama 1 kararları (29.09.2026)

| # | Konu | Karar |
|---|------|-------|
| 11 | Denetimci ne görür | Tüm cam siparişleri, tam firma adı, iç notlar ve iç dosyalar; teklif olarak **yalnızca müşteriye gönderilmiş** olanı (müşterinin gördüğü tutarla). Hazırlanan teklifler ve yönetim kopyası fiyatları görünmez. Hiçbir işlem yapamaz. |
| 12 | Şifre | En az **6 karakter** (en az bir harf ve bir rakam). Hatalı deneme sınırı: aynı e-posta + IP 15 dakikada 5, aynı e-posta 20, aynı IP 30 → geçici kilit. |
| 13 | Firma kodu | Tüm sistemde **tam 3 harf** (A–Z). Eski kodlar 3 harfe çevrildi, siparişlerin numaraları da yeni koda göre güncellendi. Siparişi olan firmanın kodu değişmez. |
| 14 | Müşteri adına işlem | Aşama 9'a kaldı. |

## Aşama 2 kararları (29.09.2026)

| # | Konu | Karar |
|---|------|-------|
| 17 | Dosya türleri | Müşteri ve çizimci için: PDF, DWG, DXF, STEP/STP, IGS/IGES, XLS/XLSX, DOC/DOCX, ZIP, JPG/JPEG, PNG; dosya başına en fazla 100 MB. İçerik uzantıyla uyuşmalı. |
| 18 | Antivirüs ulaşılamazsa | Dosya kabul edilir, "taranmadı" işaretlenir, işçi sonra tarar. "Taranmadı" dosya uyarıyla indirilebilir; virüslü dosya karantinada, indirilemez. Yönetici Entegrasyonlar'dan "reddet"e çevirebilir. |
| 19 | Sunucu belleği | 8 GB; ClamAV (~1,5 GB) aynı sunucuda çalışır. |

## Aşama 3 kararları (29.09.2026)

| # | Konu | Karar |
|---|------|-------|
| 20 | Cam adları | Katalogda her camın Türkçe ve Romence adı + rengi (İngilizcesi Excel'de durur). **Herkes camı seçtiği arayüz dilinde görür** (müşteri de iç ekip de). Sipariş satırı iki dildeki adı ve ağırlığı sipariş anındaki haliyle saklar. |
| 21 | Cam kataloğu Excel'i | Yönetici kataloğu Excel'le indirip yükler. Düzen ürün sahibinin dosyasıyla aynı: `Cam adı (TR) · Renk (TR) · Cam adı (RO) · Renk (RO) · Cam adı (EN) · Renk (EN) · Ağırlık (kg/m²) · Aktif`. Cam, Türkçe ad + renkten tanınır; yüklemede önce önizleme, sonra onay. Dosyada olmayan cama dokunulmaz (silinmez). |
| 22 | Cam ağırlığı | kg/m², zorunlu. Yüklemelerde (ağırlık hesabı) kullanılır; **tekliflerde görünmez**. |
| 23 | Pasif cam | Hiçbir seçim listesinde görünmez; formdan gönderilirse sunucu reddeder. Eski siparişler değişmez. |
| 24 | Taslak sipariş | Müşteri "Taslak kaydet" ile formu yarım bırakabilir. Taslak sipariş değildir: numarası, SLA'sı yoktur, satışa ve kuyruklara düşmez; yalnızca firmanın müşteri kullanıcıları görür. Numara ve SLA "Gönder"de kesinleşir. |
| 25 | Müşteriden bilgi isteme | Yapılmayacak: satış beklemeye alır, iletişim telefonla ya da notla yürür. |
| 27 | Sandıklar | Sandık ölçü (uzunluk/genişlik/yükseklik) ve son ağırlıkları **Yüklemeler sekmesinde**, yükleme günü + müşteri bazında girilir; satış ya da yönetici girer. Sandık no o gün içinde tektir; sandığın hangi siparişleri taşıdığı seçilir. Sipariş sayfasında giriş yok. Siparişin yükleme günü değişirse sandıkları da yeni güne taşınır (başka siparişle ortak sandık eski günde kalır; numara doluysa kayar). |
| 28 | Çizimci atama | Şimdilik tek çizimci: "Çizim Ekibine Gönder"de iş kendiliğinden ona atanır. Birden çok çizimci olursa çizimci işi üstlenir. |
| 29 | Çizim gönderimi | Dosyalar önce taslağa yüklenir (sürüm başına birden çok dosya); "Müşteriye gönder" + "Emin misiniz?" onayıyla müşteriye gider. Her dosya virüs taramasından geçer; temiz olmayan dosyası olan çizim gönderilemez. |
| 30 | Geri çekme | Çizimci gönderdiği sürümü müşteri karar vermeden gerekçeyle geri çekebilir; sürüm geçmişte kalır. |
| 31 | SLA gecikmesi | Yalnızca kırmızı rozet ve kuyruklarda en üste çıkma (bildirim/uyarı yok). |
| 32 | Müşteri fiyatları | Yönetimde müşteriye özel fiyat tabloları (cam, delik, CNC; Excel). Firma bir tabloya bağlanır; yönetim kopyasında müşteri fiyatı buradan gelir, yoksa boş gelir ve yönetici girer. |
| 33 | Yönetim kopyası | Satırlar ortak: yönetici ölçü/adet/satır değiştirirse satışın teklifi de güncellenir; fiyatlar ayrı (satış fiyatı ↔ müşteri fiyatı). Geri gönderilip yeniden gelen teklifte müşteri fiyatları korunur. |
| 34 | KDV | Teklifler KDV hariç gösterilir ("Fiyatlar KDV hariçtir" notu). |
| 26 | Fiyat tabloları (Aşama 3b) | Yönetici fiyat tabloları tutar (cam başına birim fiyat; delik ve CNC için sabit fiyat), Excel'le yükler; her satışçı bir tabloya atanır, atanmayan varsayılanı kullanır. Satışın teklifine fiyatlar dolu gelir; satışçı değiştirebilir, değiştirirse yöneticinin **Önemli kararlar** listesine ve giriş ekranına uyarı düşer. "Açık tekliflere uygula" yok. |

## Aşama 6 kararları — profil siparişi (30.09.2026)

| # | Konu | Karar |
|---|------|-------|
| 35 | Numara | `GLAP12` biçimi (firma kodu + P + sayı); cam numaralarından **ayrı sıra**. Formda bir sonraki numara dolu gelir, müşteri değiştirebilir. |
| 36 | Akış | Fiyat bekliyor → yönetici fiyatlar, **Müşteriye gönder** → müşteri **Onayla** → Proforma → Ödeme alındı → Depoda → Teslim edildi → Faturalandı (arşiv). Satış ve çizim hiçbir adımda yok; iptal yalnızca yönetici. Onaylanmayan teklif müşteride teklif olarak kalır, yönetici panelinde "Onaylanmamış teklifler" kuyruğunda görünür. |
| 37 | Fiyat kaynağı | Profil kataloğunda her ürünün **liste fiyatı** (EUR). Firmaya bir **müşteri profil fiyat tablosu** bağlanabilir; bağlıysa fiyatlar oradan gelir. Yönetici her durumda değiştirebilir. Gönderilen teklif değişmez kopyadır. |
| 38 | Para birimi / TVA | EUR, TVA hariç. **Cam ve profil tekliflerinde** EUR ise: *"Plata pentru prețurile exprimate în EURO se va efectua în RON la cursul de vânzare al Băncii Transilvania din data Facturii Proforme."* |
| 39 | Teslim bilgileri | Müşteri onayda **alış tarihi, telefon, araç plakası** girer (zorunlu). Onayda depoya hiçbir şey gitmez. Müşteri bu bilgileri depo e-postası gidene kadar değiştirebilir; sonra değiştiremez ve uyarı görür. |
| 40 | Alış tarihi | Depo **hafta sonu çalışmaz**. Mal en erken **ödeme gününden sonraki ilk iş günü** alınabilir (teklifte yazar). Ödeme geç gelir ve seçilen gün bundan önce kalırsa gün kendiliğinden o güne kayar. |
| 41 | Depo e-postası | **Ödeme alındı** işaretlenince hemen kuyruğa girer; yönetici ödemeden önce de **Siparişi depoya gönder** diyebilir. Gönderen info@gkh.ro (SMTP), alıcılar varsayılan adrian@partnertrans.ro ve enis@gkh.ro (Yönetici → Entegrasyonlar'dan değişir). Ek: **yalnızca PDF** Comanda Depozit formu (ürün sahibinin Excel düzeni). Gönderim sipariş işleminden ayrı kuyrukla, yeniden denemeli. |
| 42 | Depo teslim onayı | E-postada tek kullanımlık **depo bağlantısı** (60 gün). Depo bağlantıdan müşterinin **imzalı teslim belgesini** yükler ve "teslim edildi" der; belge siparişin iç dosyası olur (virüs taramalı). Yönetici de elle işaretleyebilir. |
| 43 | Stok | Ürün başına stok, hareketler silinemez (giriş, depoya çıkış, sayım, iade). Depoya giden sipariş stoktan kendiliğinden düşer; iptalde iade edilir. Stok yetmezse yöneticiye uyarı, **engel yok**. Müşteri stok görmez. |
| 44 | Denetimci | Profil siparişlerini salt okunur görür; yalnızca müşteriye gönderilmiş fiyatları. |
| 45 | FGO (Aşama 6b) | Fatura sistemi **FGO** (Premium paket). 6b'de: müşteri onayında proforma otomatik, ödeme durumu FGO'dan, teslimde fatura otomatik. 6a'da bu adımlar yöneticinin düğmeleriyle yürür. Anahtarlar yalnızca Entegrasyonlar ekranından sunucuya girilir. |
| 46 | FGO belgeleri (Aşama 6b, 01.10.2026) | Proforma (PRF) ve fatura (GKH) **RON** kesilir: birim fiyat = EUR müşteri fiyatı × **proforma günündeki BT EUR satış kuru** — BT'nin geliştiriciler için yayımladığı resmî kur dosyasındaki (`dev.bancatransilvania.ro/exchange.xml`) EUR *sell* değeri; web sayfası sunucuya HTTP 403 veriyor — ancak bu dosyadaki değer "În unități BT" vânzare kuruyla **aynı değil** (01.10.2026: 5,325 ↔ 5,35). Bu yüzden **varsayılan kur kaynağı "elle"**: yönetici her iş günü Entegrasyonlar'a günün "În unități BT" vânzare kurunu girer; otomatik mod ayarda kalır (2 hane); fatura **proformanın kuruyla** aynen. Kur BT sitesinden alınır (adres Entegrasyonlar'dan değiştirilebilir). BT sitesi sunucuyu reddederse (HTTP 403) yöneticinin Entegrasyonlar'da girdiği **günün kuru** kullanılır (yalnızca o gün geçerli); o da yoksa iş yeniden denenir, yönetici siparişte de elle girebilir. Kur, günü ve kaynağı siparişe kalıcı yazılır. TVA %21 (ayardan). Numaraları FGO verir. |
| 47 | Ödeme | FGO'nun API'si banka tahsilatlarını vermiyor ve tahsilat proformaya işlenmiyor → **"Ödeme alındı" elle** (şimdilik; sonra yeniden bakılacak). |
| 48 | Otomatik kesim | Müşteri onayında proforma, teslimde fatura kuyruktan kesilir (işçi; sipariş işleminin içinde dış istek yok). FGO'nun reddettiği belge yeniden denenmez → "Önemli kararlar"da uyarı + siparişte "FGO'da yeniden dene"; ağ hatası artan aralıklarla denenir. Aynı belge iki kez kesilmesin diye IdExtern (sipariş no + P/F) ve VerificareDuplicat. Elle düğmeler yedek kalır; FGO açıkken elle proformada kur zorunlu. |
| 49 | Proforma türü | FGO belgelerinde proforma türü yok; tür adı ayardan (varsayılan "Proforma"), "Bağlantıyı dene" FGO'nun kabul ettiği türleri listeler. API proforma kesemezse sonra bakılacak. |
| 50 | Anahtar ve müşteri bilgisi | FGO özel anahtarı yalnızca Entegrasyonlar ekranından girilir, AUTH_SECRET'tan türetilen anahtarla şifreli saklanır, bir daha gösterilmez. Müşteri kartına fatura bilgileri eklendi (CUI, Nr. Reg. Com., ülke, județ, localitate, adres); eksikse proforma kesilmez. |

## Muhasebe (01.10.2026)

| # | Konu | Karar |
|---|------|-------|
| 51 | Erişim | Muhasebe yalnızca yönetici (`ACCOUNTING_MANAGE`): Profil Tahsilat, Cam Tahsilat, Tedarikçi Hesap Durumu. |
| 52 | Tahsilat | FGO'da kesilen her belge `FgoDocument` olarak kaydedilir; tutar (TVA dahil) ve tahsil edilen FGO getstatus'tan okunur ("FGO ile Güncelle"; mevcut FGO bağlantısı, ayrı entegrasyon yok). Durum: ödenen 0 → Ödenmedi, 0 < ödenen < toplam → Kısmi, ödenen ≥ toplam → Ödendi. Cam belgeleri için akış sonraki aşamada; ekran şimdilik boş. |
| 53 | Yükleme kârlılığı | Yükleme = yükleme günü (Yüklemeler sekmesiyle aynı). Yükleme günü bugün ya da önce olan, müşteriye teklif gönderilmiş cam siparişleri. Cam satış = müşteriye giden yönetici fiyatı; **cam alış/maliyet = satış fiyatı (satışçının fabrika fiyat tablosundan gelen fiyatı, Offer.amount)** — sistemdeki tek alış verisi bu. Transport yükleme gününe elle girilir (tutar, para birimi, açıklama). Kâr = satış − maliyet − transport. |
| 54 | Fabrika cari | Fabrika ödemeleri yüklemelere/siparişlere bağlı değildir ve dağıtılmaz. Bakiye = toplam cam maliyeti − toplam ödeme. Para birimleri hiçbir toplamda birbirine eklenmez. |

## Cam siparişi FGO belgeleri (01.10.2026)

| # | Konu | Karar |
|---|------|-------|
| 55 | Akış | Müşteri onayı **yok**; sipariş durumu değişmez. Yönetici sipariş sayfasındaki **Finans / FGO** bölümünden: yüklenmemiş → **Proforma Gönder**; proforma ödendi → **Avans Faturası Gönder**; yüklenmiş → **Fatura Gönder**. Her türden sipariş başına tek belge (kilit + durum kontrolü + `FgoDocument @@unique([orderId, kind])` + FGO IdExtern `GLA68-P/A/F`). |
| 56 | Ödendi | FGO'da proformaya tahsilat görünür (Muhasebe → FGO ile Güncelle) **veya** yönetici "Ödeme alındı" der (tutar, RON, TVA dahil). |
| 57 | Avans faturası | FGO API'sinde avans için ayrı belge türü yok: normal fatura (GKH serisi), tek satır "Avans marfă conform proformă PRF…", tutar = tahsil edilen (TVA dahil; satır TVA hariç gönderilir). |
| 58 | Kapanış faturası | Yüklenince: cam satırları (m², CNC/delik adet) + avans varsa eksi satır "Stornare avans conform factură …" (avans faturasının TVA hariç tutarı). |
| 59 | Yüklendi | Yükleme günü (gerçek, yoksa tahmini) + **2 gün**. Yeni yükleme durumu yok. |
| 61 | Belge metinleri (01.10.2026) | Cam proforma ve faturalarında açıklama (FGO Text) **yalnızca siparişin açıklaması** (başlık). **Faturada yalnızca cam:** satır adı yalnızca camın Romence niteliği (ölçü ve adet yazılmaz; yoksa katalogdaki Romence ad ve renk); CNC, delik ve m² dışındaki her satırın tutarı ait olduğu camın (üstündeki cam satırı) tutarına eklenir; aynı nitelikteki camlar m² toplamıyla tek satırda. **Proforma ayrıntılı:** her cam satırı ayrı (yalnızca nitelik, m²), CNC ("Prelucrare CNC") ve delik ("Gaură") ayrı satırlarda adetle. Sipariş bilgilerinde proforma / avans faturası / fatura ayrı satır ve bağlantıyla (müşteri, yönetici, denetimci; satış ve çizim görmez). Camda depo / teslim satırları yok. |
| 60 | Kur ve gönderim | Proforma günün BT kuru (elle girilen günün kuru); avans ve fatura proformanın kuru; proforma yoksa fatura gününün kuru. Belge Müşteriler kartındaki **firma e-postasına** Romence e-postayla (belge no, tutar, FGO PDF bağlantısı) gider (FGO API e-posta göndermiyor). Deneme güvenliği: FGO ayarlarında **günlük belge sınırı** (varsayılan 3; 0 = sınırsız), profil ve cam belgelerinin toplamı. |
| 62 | Fatura numarası (01.10.2026) | Faturalar (cam avans ve kapanış faturası, profil faturası — aynı GKH serisi) **sistemdeki son fatura numarası + 1** ile kesilir (FGO'ya `Numar` gönderilir; `nextInvoiceNumber`). FGO API'sinde son numarayı okuyan uç yok: FGO'da elle fatura kesildiyse ya da sistemde henüz fatura yoksa yönetici Entegrasyonlar → FGO'da "Sonraki fatura numarası (en az)" girer (sistemdeki son + 1 ile bunun büyüğü). İkisi de yoksa numarayı FGO verir. Proformaları FGO numaralandırır. |
| 63 | Faturada TVA hariç birleştirme (01.10.2026) | Faturada cama eklenen CNC, delik ve diğer kalemler **TVA hariç** eklenir: her kalem proformadaki gibi hesaplanır (adet/m² × round2(EUR × kur)), satırın TVA hariç tutarı bunların toplamı; FGO'ya satırın TVA dahil toplamı (proformadaki satırların TVA dahil tutarlarının toplamı) `PretTotal` olarak gider. Böylece fatura genel toplamı proformayla kuruşu kuruşuna aynıdır (birim fiyatı yuvarlayıp m² ile çarpınca ~0,08 lei fark çıkıyordu). |
| 64 | Fatura numarası düzeltmesi (01.10.2026) | 684 girilmesine rağmen 691 kesildi: sistemde FGO'da silinmiş deneme faturalarının kayıtları kaldığı için "en az" kuralı son numarayı (690) + 1 aldı. Yeni kural: Entegrasyonlar → FGO → **Sonraki fatura numarası** doluysa fatura **tam bu numarayla** kesilir ve her faturadan sonra kendiliğinden +1 olur; boşsa sistemdeki son numara + 1. Kullanılacak numara sistemde kayıtlıysa FGO'ya sorulur: FGO'da silinmişse eski kayıt kaldırılır (denetim kaydı `FGO_DOC_REMOVED`) ve numara yeniden kullanılır; FGO'da varsa sonraki numaraya geçilir. FGO gönderilen numaradan farklı numara keserse "Önemli kararlar"a uyarı (`FGO_NUMBER`). Muhasebe → "FGO ile Güncelle" de FGO'da silinmiş belgelerin kaydını kaldırır (silinen faturanın siparişinde düğme yeniden çıkar). |
| 65 | FGO'da silinen belge — profil ve cam (01.10.2026) | Muhasebe → **Profil Tahsilat** ve **Cam Tahsilat**'ta "FGO ile Güncelle" (ve fatura numarası ayırırken) FGO "belge yok" derse kayıt kaldırılır ve sipariş belgeden önceki hâline döner (`server/integrations/fgo-deleted.js`). **Profil:** fatura silindiyse FATURALANDI → TESLIM_EDILDI (arşivden çıkar), proforma silindiyse PROFORMA → ONAYLANDI (kur sıfırlanır); yeni belge sipariş sayfasındaki **"FGO'da yeniden dene"** ile kesilir; daha ileri adımdaki siparişte yalnızca belge bilgisi silinir. İşlem `runProfileAction` (`fgo_doc_deleted`, FGO işçisi) ile: geçmiş "FGO'da silindi", denetim. **Cam:** kayıt silinir, ilgili düğme yeniden çıkar; proforma silindiyse ve başka belge yoksa kur ve elle girilen ödeme de sıfırlanır. Bekleyen belge e-postası atlanır. |
| 66 | CAM tahmini yükleme tarihi (01.10.2026) | Çarşamba başlayıp Salı (dahil) biten dönemdeki siparişler aynı gruptur; tahmini yükleme günü dönemin Çarşambası + 23 gün (Cuma). Ürün sahibinin kesin örnekleri: 30.09–06.10.2026 → 23.10.2026, 07.10–13.10.2026 → 30.10.2026 (yazılı kural "dönem bittikten sonraki 2. Cuma" bu örneklerle 3. Cuma'ya denk geliyor; örnekler esas alındı). Tek hesap: `glassLoadingDate` (`server/orders/rules.js`); yalnızca yeni CAM siparişinin varsayılanı ve formdaki bilgi. Tek kaynak `Order.estimatedShipDate`; mevcut tarihler değişmez. |
| 67 | Otomatik yenileme (01.10.2026) | Tüm panel sayfaları 60 sn'de bir `router.refresh()` (`components/AutoRefresh.tsx`, panel düzeninde tek bileşen); kullanıcı forma yazdıysa form gönderilene ya da sayfa değişene kadar yenilenmez; arka plandaki sekmede yenilenmez. |
| 68 | Nakliye listesi (01.10.2026) | Yüklemeler sayfasında "Nakliye Listesi" (PDF, `/yuklemeler/nakliye?gun=YYYY-MM-DD`); yönetici, satış, denetimci (`TRANSPORT_LIST_VIEW`), müşteri değil. Veri yalnızca mevcut kayıtlardan: o günün `Crate` satırları (müşteri koduna göre grup; ağırlık = brüt, brüt yoksa net + dara, ikisi de yoksa "—") ve o gün yüklenecek CAM siparişleri (gün = gerçek ya da tahmini yükleme günü — elle değiştirilmiş tarih esas); sandığı girilmemiş müşterilerin siparişleri ayrıca yazılır. Fiyat yok. Üretici: `server/loading/transport.js` + `server/pdf/transport-list.js` (mevcut PDF yazıcı). Örnekteki "Misafir yük" ayrı alan olarak sistemde yok; sandığın notu yazılır. |
| 69 | Teklif PDF / Excel (01.10.2026) | Cam siparişinin teklif bölümünde "PDF İndir" / "Excel İndir" (`/siparisler/<id>/teklif?format=pdf\|xlsx`). Yönetici (`OFFER_SEND`): son teklif, müşteri fiyatlarıyla, her zaman. Müşteri (`OFFER_EXPORT`): yalnızca kendisine gönderilmiş teklif; PDF her zaman, Excel yalnızca `Order.customerExcel` (yöneticinin sipariş bazındaki "Müşteri Excel indirebilir" izni, denetim kaydıyla) açıksa — değilse 403. Satış fiyatı dosyalara girmez. Tek üretici: `server/orders/offer-export.js` (veri + Excel) ve `server/pdf/offer.js`. |
| 70 | Satış fiyatı zorunlu (01.10.2026) | Satış teklifi yöneticiye gönderirken (`submit_offer`) her satırın (cam/ürün, CNC, delik, diğer) satış fiyatı > 0 olmalı; yalnızca "bedelsiz" satır muaf (mevcut `offerProblems` kuralı). Sunucuda `server/orders/transitions.js → requireSalesPrices` (hata `SALES_PRICE_MISSING`, eksik satırlar ürün adıyla); taslak kaydı serbest. |
| 71 | Tek cam tipi ve Excel'den aktarma (01.10.2026) | Müşteri yeni CAM siparişinde tek cam tipi seçer (form + `yeni/actions.ts` sunucu kontrolü); eski siparişler/taslaklar silinmez (taslakta birden çoksa formda ilki gelir). Satış teklif tablosunda müşterinin .xlsx dosyası varsa "Excel'den Aktar": dosya sunucuda okunur (`readOfferExcelAction`, mevcut `readXlsx`; hiçbir şey kaydedilmez), ön izlemede sütun eşleştirme ve doğrulama (`server/orders/excel-import.js`: en/boy sayı > 0, adet tam sayı > 0, boş satır atlanır); geçerli satırlar teklif tablosunun cam satırı modeline, siparişteki camla eklenir; fiyat mevcut kural. Eski .xls okunmaz. |
| 72 | Bildirim e-postaları (01.10.2026) | Tek sistem: iş akışının zaten yazdığı `NotificationOutbox` olayları (ORDER_<OLAY>, ORDER_CREATED) işçide mevcut SMTP (`server/mail/*`, .env) ile gönderilir (`server/notifications/email.js`). Müşteri (siparişi açan kullanıcı + firma e-postası): OFFER_SENT, OFFER_UPDATED, PROFILE_OFFER_SENT, PROFORMA, INVOICED (profil), SHIP_DATE, DRAWING_UPLOADED. İç ekip: ORDER_CREATED (cam → satış, profil → yönetici), SENT_TO_DRAWING / REVISION_REQUESTED / DRAWING_APPROVED (atanmış çizimci, yoksa çizim ekibi), PROFILE_APPROVED (yönetici). Cam FGO belgeleri zaten DOC_EMAIL ile gider (FGO API e-posta göndermez) → tekrarlanmaz. İlk çalıştırmadan önceki birikmiş olaylar gönderilmez. Alıcı başına gönderim, hata → 6 denemeye kadar artan aralık, sonra FAILED. Satış/çizim e-postasında firma adı maskeli. Bildirim tercihi modeli henüz yok. `NOTIFY_EMAILS` (varsayılan açık). |
| 73 | Teklif tablosu kolaylıkları (02.10.2026) | "+ Sandık parası": tür CAM, birim adet olan normal teklif satırı (`CRATE_LINE`; kayıtta TR + RO adı; fiyatı satış girer — sandık fiyat tablosu yok; faturada diğer adet kalemleri gibi camın tutarına eklenir). "Tabloyu temizle" (yalnızca satış, onayla): ekrandaki tablo siparişin camlarına ve liste fiyatlarına döner; kaydedilene kadar hiçbir şey yazılmaz, sipariş ve dosyalar değişmez. Cam adının yanındaki "+": aynı camdan boş yeni satır. Excel'den aktarma .xls (BIFF8) de okur: `server/files/xls.js` (bağımlılık yok); .xlsx ile aynı akış. |
| 74 | Müşteri ayarları (02.10.2026) | Müşteri menüsünde "Ayarlar" (`/ayarlar`, yetki `ACCOUNT_SETTINGS`, yalnızca müşteri). **Sabit dil** (`User.fixedLanguage`): girişte giriş ekranının dili yerine bu dil açılır; sağ üstteki dil seçimi o oturum için çalışmaya devam eder; bildirim e-postaları da bu dilde. **E-posta bildirimleri** (`User.emailNotifications`, varsayılan açık): siparişi açan müşteri kullanıcısı kapattıysa o siparişin müşteri bildirimleri (karar 72) gönderilmez; bildirimi kapatmış bir kullanıcının adresine hiç gönderilmez. Davet / şifre e-postaları, cam FGO belge e-postaları, depo e-postası ve iç ekip bildirimleri etkilenmez. |
| 75 | Satışın sipariş sayfası (02.10.2026) | Satış görünümünde (teklif hazırlar, müşteriye gönderemez) sıra: Müşteri sipariş dosyaları → Notlar → diğer bölümler; "İstenen camlar" ve "Sandıklar" gösterilmez. Yalnızca görünüm; veri, yetki ve iş akışı aynı. |
| 76 | Yükleme dökümü Excel (02.10.2026) | Yüklemeler → "Yükleme Dökümü Excel" (`/yuklemeler/dokum?gun=`; `TRANSPORT_LIST_VIEW`: yönetici, satış, denetimci). O günün cam siparişleri (gerçek ya da tahmini yükleme günü) müşteriye göre gruplanır; müşteri içinde aynı cam (Türkçe ad) tek satır, adet ve m² toplanır; tutar fatura kuralıyla (`glassTotals` — cam + ona eklenen CNC / delik / diğer kalemler), birim fiyat = tutar / m². Fiyat rolün görebildiği fiyattır (yönetici / denetimci müşteri fiyatı; satış satış fiyatı, firma adı maskeli — karar 4/7 korunur). Üstte sipariş, satır, cam ağırlığı, sandık, sevk ağırlığı (Yüklemeler sayfasındaki hesap). `server/loading/summary.js`. |

## Sunucu (29.09.2026)

| # | Konu | Karar |
|---|------|-------|
| 15 | Sunucu | Contabo VPS, **gerçek kullanım** (örnek veri yok). Adres **https://takip.sistembalustrada.ro** (30.09.2026; önceki ücretsiz `*.sslip.io` adresi Romanya'da bazı mobil operatörlerde engelli). |
| 16 | Güncelleme | `backend` dalına gelen ve testlerden geçen her sürüm sunucuda kendiliğinden yayınlanır (ADR 0012). |

## Hâlâ açık olan konular (uygulamadan önce sorulacak)

- `GLA64-1` gibi eklerin anlamı → şimdilik üretilmez; müşteri numarası alanında serbest metin olarak durur.
- FGO: proformanın API ile kesilebildiği ve BT kur adresinin doğruluğu gerçek hesapta doğrulanacak; ödemenin otomatik algılanması sonraya kaldı.
- Bildirim olay listesi ve metinleri.
- Sandık / brüt ağırlık formüllerinin tamamı.

## Aşamalar ve mevcut durum

Mevcut uygulama (3.1.x) cam siparişi akışının büyük bölümünü zaten çalıştırıyor. Yeniden yapılanma
**sıfırdan yazma değil**; her aşama mevcut kodu tanıma ve kararlara göre sağlamlaştırır (ADR 0001).

| Aşama | Kapsam | Mevcut durum |
|-------|--------|--------------|
| 0 | Depo, ortam, migration, test, lint, seed, mimari kararlar | 3.2.x'te tamamlandı |
| 1 | Giriş, kullanıcı, firma, rol/yetki, sunucuda maskeleme | **3.3.2'de tamamlandı** |
| 2 | Sipariş tipleri, numaralandırma, dosya, not, geçmiş, denetim servisi | **3.5.0'da tamamlandı** |
| 3 | Cam sipariş formu, katalog, yükleme, satış incelemesi | **3a (3.6.x): katalog, taslak, kuyruklar · 3b (3.7.x): fiyat tabloları, Önemli kararlar** |
| 4 | Çizim: atama, sürüm, onay, revizyon, SLA | **3.9.0'da tamamlandı** |
| 5 | Satış teklifi, yönetici fiyatı, müşteriye gönderim | **3.10.0'da tamamlandı** |
| 6 | Profil siparişi ve profil kataloğu | **6a (3.11.0): katalog, sipariş, fiyat, onay, depo e-postası, stok** · **6b (3.13.0): FGO proforma/fatura, BT kuru** |
| 7 | Yükleme, sandık, ağırlık, dışa aktarma | Takvim ve sandık var; Excel/PDF ve özel durum notu eksik |
| 8 | SMTP, bildirim tercihleri, outbox, WhatsApp, çeviri, görüntüleyici, ERP | SMTP var; outbox, tercih ve diğerleri eksik |
| 9 | Raporlar, politikalar, SLA ayarı, denetim ekranı | Kısmen |
| 10 | Beş rol uçtan uca test, güvenlik testleri, yedekleme, kurulum belgesi | Kısmen |
