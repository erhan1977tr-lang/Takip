# 4.3.0 — Satışçı–çizimci ayrımı: canlıya alma ve geri dönüş (karar 300)

Bu belge yalnızca 4.3.0 yayın adayı içindir. Genel geri dönüş aracı: `docs/geri-donus.md` (karar 287); felaket kurtarma: `docs/felaket-kurtarma.md`.

## Yayının veritabanına yaptığı değişiklik

CI'nin ürettiği tek migration (`prisma/migrations/20261022063523_ci`): yalnızca **ekleyici**.

- `User.defaultDrawerId` (null), `Order.salesUserId / salesAssignedAt / salesAssignedVia / salesAssignedById / routingRuleId` (null),
  `Crate.salesUserId` (null), `FactoryPayment.salesUserId` (null), yeni tablo `GlassRoutingRule`, enum değeri `PermissionKey.ORDER_ASSIGN`,
  iki indeks. Hiçbir sütun silinmez, daraltılmaz, yeniden adlandırılmaz; veri dönüştürülmez.
- Migration geçmiş veriye **hiçbir şey yazmaz**. Geçmiş siparişlerin sahibi (`salesUserId`) boş kalır.

Uygulama koduna göre sonuç: yayından hemen sonra **bütün var olan cam siparişleri "atamasız"** olur — satış ve çizim ekibi
hiçbir siparişi göremez, yönetici hepsini "Atama bekleyen" tablosunda görür; yeni siparişler de (kural yazılamadığı için)
atama bekler. Bu, tasarım gereğidir (atamasız siparişe ekip erişimi açılmaz): canlı kullanım ancak **bağlama** ile sürer.

## Canlıya alma sırası (bakım penceresi)

1. **Ön hazırlık (pencere öncesi):** CI (backend), kurulum testi ve demo testi yeşil; imajlar hazır (karar 287 — gate).
   Ürün sahibi Kullanıcılar ekranında satışçıların **varsayılan çizimcilerini** doğrular (ortak görüntüleme — karar 301 —
   ve çizimcisi boş geçmiş siparişlerin çizimcisi buna göre belirlenir).
2. **Tam yedek (çift):** `sudo takip yedek` → veritabanı + dosyalar çifti (yerel + Drive). Bu çift geri dönüşün dayanağıdır.
   Otomatik yayın ayrıca yalnızca veritabanı dökümü alır (`db-<zaman>-once-<sha>.dump`); dosya yedeği olmadan çift sayılmaz.
3. **Yayın:** `backend`'e birleştirme (merge commit) → otomatik yayın (`takip guncelle`). Yayın sonrası sağlık denetimi ve
   `/surum` karar 287'deki gibi.
4. **Bağlama — önizleme (yazmaz; 4.3.17 D-1, karar 302):**
   `sudo takip satis-bagla [--odeme SATIS-E-POSTA]`
   Çıktı: tarihsel satışçıya göre **dağılım** (satışçı başına sipariş sayısı), **sahipsiz kalacak siparişler** (iz yok /
   birden çok satışçı / satışçı pasif — numara ve aday hesaplarla), çizimcisi atanacak sipariş sayısı, sandık planı (bağlanacak
   / eski kayıt kalacak: boş, karışık, belirsiz), fabrika ödemeleri, para birimi başına toplamlar ve **ONAY KODU**.
   Hesabı boş fabrika ödemesi varsa `--odeme E-POSTA` olmadan engel (ödeme hesabı tahmin edilmez).
   Sahipsiz siparişler için ürün sahibinin kararı ya komuta eklenir (`--ata GLA68=satis@... ` — her karar ayrı `--ata`) ya da
   bağlamadan sonra panelde "Satışçıya ata" ile verilir (yalnızca açık siparişler; kapanmış siparişler yalnızca `--ata` ile).
   Karar eklendiğinde onay kodu değişir: önizleme aynı seçeneklerle yeniden çalıştırılır.
5. **Bağlama — uygulama (yalnızca onaylanmış dağılım):** aynı seçenekler + `--uygula --onay <ONAY KODU>`. İşlemin içinde dağılım
   yeniden hesaplanır; önizlemeden sonra bir sipariş / olay / sandık / ödeme / karar değiştiyse `APPROVAL_MISMATCH` — hiçbir
   şey yazılmaz, önizleme yeniden yapılır. Tek işlem; toplamlar ya da kayıt sayıları değişirse geri alınır ("TOTALS_CHANGED" /
   "ACCOUNTS_MISMATCH"). Sonuç: siparişler tarihsel / kararlaştırılan satışçıya (MIGRATION), çizimcisi boş olanlara o satışçının
   varsayılan çizimcisi (var olan çizimci değişmez), tek sahipli sandıklar, fabrika ödemeleri kararlaştırılan hesaba, bağlama
   işareti. **Otomatik yönlendirme kuralı yazılmaz**: yeni siparişlerde sorumlu satışçıyı yönetici seçer (MANUAL — karar 302).
   Görev, bildirim, durum değişikliği, dış servis çağrısı yok.
6. **Doğrulama:** her satışçı kendi tarihsel siparişlerini, aynı çizimciye bağlı ekip arkadaşının siparişlerini yalnızca
   görüntüleme olarak görür ("Sıra bende" yalnızca kendi işi); sahipsiz kalanlar yöneticinin "Atama bekleyen" tablosunda;
   müşteri sayfası ekip kimliği göstermez; Muhasebe → Cam Fabrika Hesap Durumu'nda satışçı hesaplarının toplamı = genel toplam;
   `Ayarlar → Satış Yönlendirme` "Kural yok — yeni siparişler atama bekler".
7. **Otomatik yönlendirme** gerekirse ayrı kararla: Ayarlar → Satış Yönlendirme'den yönetici yazar.

## Geri dönüş

### A) Yayın başarısız / sağlık denetimi geçmedi (bağlama yapılmadan)

Karar 287'nin aracı: `takip rollback-kontrol` → **MIGRATION_CHANGED** (hedef 4.2.0'ın migration listesi ile canlı liste
farklı) → araç geri dönüşü **güvenli saymaz** ve tasarım gereği reddeder. Yani 4.3.0'da **otomatik / tek komutla** geri dönüş yoktur.

Bununla birlikte 4.2.0 kodu 4.3.0 şemasıyla **çalışır**: migration yalnızca ekleyicidir, 4.2.0'ın Prisma istemcisi yeni
sütun ve tabloyu görmez, hiçbir 4.2.0 sorgusu yeni sütunlara bağlı değildir. Bu "kanıt" aracın kuralına göre yeterli
değildir (karar 287: uyumluluk yalnızca migration listesi eşitliğinden okunur); el ile geri dönüş şöyledir:

- `sudo takip restore <bugün>` → adım 2'deki çift geri yüklenir (veritabanı + dosyalar **birlikte**, önce güvenlik yedeği,
  onay ister). Çiftten sonra girilmiş kayıtlar kaybolur; bu yüzden bakım penceresi: yayın ile bağlama arasında kullanıcı
  yoktur. Veritabanı 4.2.0 şemasına döner (migration kaydı dahil).
- Uygulama imajı: `takip rollback --onay <4.2.0 SHA>` artık güvenli sayılır (listeler eşit) — ya da `takip dal` ile
  backend'e 4.2.0'ı geri alan commit.

### B) Bağlama uygulandıktan sonra (ilk gün)

Bağlama yalnızca boş alanları doldurur (sahip, çizimci kopyası, sandık / ödeme hesabı, işaret, kural). 4.2.0 koduna dönmek
bu alanları **görmez**; veri tutarlılığı bozulmaz. Yine de araç A'daki gibi reddeder; yöntem A ile aynıdır (çift restore
= bağlamadan önceki an; bağlamadan sonra girilen kayıtlar kaybolur) ya da — veri kaybı kabul edilmiyorsa — **yalnızca
uygulama imajı** 4.2.0'a el ile alınır (`compose` ile eski imaj; karar 287 aracı dışında, yazılı onayla). Bu ikinci yol
"migration ile geri dönüş garantisi yok" uyarısının kendisidir: şema 4.3.0 kalır, 4.2.0 kodu ekleyici alanları yok sayar.

### C) İkinci ekip açıldıktan sonra

4.2.0'a dönmek = **küresel erişim** (her satışçı her siparişi, her çizimci her çizimi görür). İkinci ekip açıldıktan sonra
eski koda dönüş bu nedenle iş kuralı olarak **kabul edilemez**; geri dönüş yerine ileriye düzeltme (hotfix) uygulanır.
İkinci ekip ayrı talimatla açıldığından bu karar o anda verilir.

## Prova durumu (bu adayda)

- Ekleyici migration + 4.2.0 kodunun 4.3.0 şemasında çalışması: CI'da **doğrudan prova edilmedi** (CI yalnızca 4.3.0'ı
  kurar). Karar 287'nin gerçek-Docker testi (`deploy/test/release-rollback-real.sh`) migration farkında geri dönüşün
  **reddedildiğini** doğrular — bu adayda geçerli olan davranış budur.
- `takip restore` yolu kurulum testlerinde (`deploy/test/backup-*.sh`, `restore-test`) prova edilir; 4.3.0'a özgü bir
  prova eklenmedi.
- Bağlama betiği: veritabanı testlerinde (`test/db/sales-link.test.js`, `test/db/sales-team.test.js`) tarihsel dağılım,
  sahipsiz kalanlar, onay kodu (yanlış / eski kod → hiçbir şey yazılmaz), toplam koruması, `updatedAt` koruması, süre sınırları
  ve ikinci uygulama reddi sentetik veriyle doğrulanır. **Canlıda çalıştırılmadı.**

**Yayın engeli olarak bildirilir:** tek komutla, veri kaybı olmadan ve araç kuralına uyan bir geri dönüş yöntemi 4.3.0
için **yoktur**. Güvenli yol, bakım penceresinde alınan tam çift + `takip restore` (veri kaybı penceresi = yayın ile
bağlama arası) ya da "yalnızca imaj" el ile geri dönüşüdür (şema 4.3.0 kalır). Ürün sahibi bu yollardan birini yazılı
onaylamadan canlı yayın yapılmamalıdır.
