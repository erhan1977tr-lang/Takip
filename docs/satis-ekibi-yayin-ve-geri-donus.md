# 4.3.x — Satışçı–çizimci ayrımı ve Fabrika Ekipleri: canlıya alma ve geri dönüş (karar 300, 302, 304)

Bu belge 4.3.x yayın adayı (4.3.0 … 4.3.19 — tek paket, canlıda değil) içindir. Genel geri dönüş aracı: `docs/geri-donus.md` (karar 287); felaket kurtarma: `docs/felaket-kurtarma.md`.

## Yayının veritabanına yaptığı değişiklik

CI'nin ürettiği tek migration (`prisma/migrations/20261022063523_ci`): yalnızca **ekleyici**.

- `User.defaultDrawerId` (null), `Order.salesUserId / salesAssignedAt / salesAssignedVia / salesAssignedById / routingRuleId` (null),
  `Crate.salesUserId` (null), `FactoryPayment.salesUserId` (null), yeni tablo `GlassRoutingRule`, enum değeri `PermissionKey.ORDER_ASSIGN`,
  iki indeks. Hiçbir sütun silinmez, daraltılmaz, yeniden adlandırılmaz; veri dönüştürülmez.
- Migration geçmiş veriye **hiçbir şey yazmaz**. Geçmiş siparişlerin sahibi (`salesUserId`) boş kalır.

4.3.19 (karar 304) CI'nin üreteceği **ikinci** migration: yalnızca yeni tablo `FactoryTeam` (`id`, `name` tekil, `salesUserId`
tekil + `User`'a yabancı anahtar — RESTRICT, `isActive`, `createdById`, `createdAt`, `updatedAt`). Var olan tablo / sütun /
veri değişmez; tablo boş başlar (ekipler kurulumdan sonra yönetici ekranından açılır). 4.3.17 / 4.3.18'in ortak görüntüleme ve
çizimci değiştirme özellikleri kaldırıldı — şema değişikliği getirmemişlerdi.

Uygulama koduna göre sonuç: yayından hemen sonra **bütün var olan cam siparişleri "atamasız"** olur — satış ve çizim ekibi
hiçbir siparişi göremez, yönetici hepsini "Atama bekleyen" tablosunda görür; yeni siparişler de (kural yazılamadığı için)
atama bekler. Bu, tasarım gereğidir (atamasız siparişe ekip erişimi açılmaz): canlı kullanım ancak **bağlama** ile sürer.

## Canlıya alma sırası (bakım penceresi)

1. **Ön hazırlık (pencere öncesi):** CI (backend), kurulum testi ve demo testi yeşil; imajlar hazır (karar 287 — gate).
   Ürün sahibi **canlı eşleşme raporunu** çalıştırır (salt okunur — `deploy/canliya-gecis/ekip-eslesmeleri.sql`, aşağıda) ve
   satışçıların **varsayılan çizimcilerini** / fiyat tablolarını doğrular (çizimcisi boş geçmiş siparişlerin çizimcisi buna
   göre belirlenir; aynı çizimci / tablo iki satışçıda ise Fabrika Ekipleri kurulurken biri seçilmelidir).
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
6. **Fabrika Ekipleri (karar 304):** Ayarlar → Fabrika Ekipleri'nde var olan hesaplarla ekipler açılır (ör. "Trakya":
   Murat + meltem + Trakya tablosu; "GlassWorld": Hamza + Erhan + kendi tablosu). Ekran yalnızca satışçının var olan
   alanlarını yazar; çizimci / tablo başka aktif ekipte ise reddeder. Ekip açmak hiçbir siparişi değiştirmez.
7. **Doğrulama:** her satışçı yalnızca kendi siparişlerini görür (ekip arkadaşı görüntülemesi yok); sahipsiz kalanlar
   yöneticinin "Atama bekleyen" tablosunda;
   müşteri sayfası ekip kimliği göstermez; Muhasebe → Cam Fabrika Hesap Durumu'nda satışçı hesaplarının toplamı = genel toplam;
   `Ayarlar → Satış Yönlendirme` "Kural yok — yeni siparişler atama bekler".
8. **Otomatik yönlendirme** gerekirse ayrı kararla: Ayarlar → Satış Yönlendirme'den yönetici yazar.

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

### D) 4.3.19 (Fabrika Ekipleri) — migration ve geri dönüş riski

- 4.3.19'un migration'ı yalnızca `FactoryTeam` tablosunu ekler. Canlı 4.2.0'dan 4.3.x paketine geçişte iki migration birlikte
  uygulanır; A–C aynen geçerlidir (geri dönüş aracı migration farkında reddeder).
- Prova ortamında 4.3.18'den 4.3.19'a geçilip geri dönülmek istenirse: migration listesi farklı olduğundan `takip rollback`
  **güvenli saymaz** (MIGRATION_CHANGED). 4.3.18 kodu `FactoryTeam` tablosunu görmez ve ona bağlı değildir; ancak 4.3.18
  bağımsız çizimci değiştirme ve ortak görüntülemeyi yeniden açar (karar 304 ile kaldırılan davranış). Bu nedenle geri dönüş
  yerine ileriye düzeltme tercih edilir; zorunluysa yalnızca prova veritabanında, yedekten geri yükleme ile.
- Ekipler açıldıktan sonra **pasifleştirme** geri alınabilir (Aktif yap); ekip silme yoktur. Ekip ekranının yazdığı
  çizimci / fiyat tablosu değişikliği denetim kaydında (önce / sonra) durur ve aynı ekrandan geri çevrilir.

### Canlı eşleşme raporu (salt okunur — yalnızca ürün sahibi çalıştırır)

`deploy/canliya-gecis/ekip-eslesmeleri.sql`: READ ONLY işlem, yalnızca SELECT, ROLLBACK ile biter. Şifre, e-posta, token,
tutar, müşteri adı okumaz; kişiler ad + kimliğin ilk 8 karakteriyle, kayıtlar sayı olarak. Bölüm 0 şemayı denetler (4.3.0
alanları yoksa yalnızca bölüm 0 sonucunu iletin). Örnek: `psql "$DATABASE_URL" -f ekip-eslesmeleri.sql`. Test: CI'da
migration'ları uygulanmış şemada hatasız çalıştığı ve yazmadığı doğrulanır (`test/db/golive-sql.test.js`).

### Yerel prova adımları (Ubuntu / WSL prova ortamı — canlı değil)

1. `git fetch && git checkout claude/satisci-cizimci && git pull` (CI'nin yazdığı migration commit'i dahil).
2. Prova veritabanının ayrı bir kopyasında (canlı değil): `npx prisma migrate deploy` → `FactoryTeam` tablosu eklenir.
3. `npm run build && npm start` (ya da prova kurulumundaki `takip` komutları; prova `.env`'inde gerçek FGO / SMTP / Telegram
   anahtarı olmamalı).
4. Yönetici: Ayarlar → Fabrika Ekipleri → iki ekip (var olan satışçı + çizimci + tablo). Aynı çizimciyle ikinci ekip →
   "başka bir aktif ekipte" hatası.
5. Bir siparişte: "Sorumlu satışçı: … · Değiştir" — form kapalı; açınca pasif ekibin satışçısı listede yok; çizimci formu yok.
6. Satışçı B ile A'nın sipariş adresi / dosya adresi → 404. Müşteri sayfasında ekip adı yok.
7. Nakliye listesi PDF'i: bölüm başlıkları ekip adı, ara toplamlar + genel toplam.
8. B ekibini pasif yap → kullanıcı hesabı açık; yönlendirme kuralı B'yi gösteriyorsa yeni sipariş atama bekler, uyarı görünür.

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
