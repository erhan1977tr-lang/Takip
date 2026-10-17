# Güvenli geri dönüş (rollback) — işletme kılavuzu

3.92.0, karar 287 · ADR 0015 · araç: `deploy/takip.sh` (sunucuda `takip`).

> **Geri dönüş ≠ felaket kurtarma.** Geri dönüş YALNIZCA uygulama ve arka plan işçisinin imajını önceki doğrulanmış
> sağlıklı sürüme çevirir; **veritabanına dokunmaz** (yedekten geri yükleme, migration geri alma, veri silme yoktur).
> Veri kaybı / bozulması / sunucu kaybı için: [felaket-kurtarma.md](felaket-kurtarma.md).

## 1. Ne kaydedilir

Her yayın, sağlık denetiminin **tamamından** geçince `/opt/takip/state/releases/<SHA>.kayit` yazar (yalnızca root, 0600):

| Alan | Anlamı |
|------|--------|
| `sha`, `version`, `tag` | tam commit, uygulama sürümü, çalışan imaj etiketi |
| `app_image`, `tools_image` | uygulama ve işçi/araç imajının Docker kimliği (`sha256:…`) |
| `deployed_at`, `verified_at` | yayın ve sağlık doğrulama zamanı (UTC) |
| `migrations_count`, `migrations_last`, `migrations_sha256` | o anda veritabanında uygulanmış migration'lar (liste `<SHA>.migrations`, veritabanının kendisinden: ad + checksum) |
| `health`, `source` | geçen denetimler; `deploy` · `bootstrap` (ilk kayıt) · `rollback` · `elle-dogrulama` |

Göstergeler: `release-healthy` (son doğrulanmış sağlıklı sürüm) ve `release-healthy-prev` (geri dönüş adayı).
Başarısız / sağlıksız yayın kayıt yazmaz ve göstergeleri değiştirmez. İmaj temizliği göstergelerdeki sürümlerin imajlarını
hiçbir zaman silmez. İşlem geçmişi: `/opt/takip/logs/release.log` (yalnızca eklenir; gizli değer içermez).

## 2. Yayın sırasında ne olur

1. **Kapı:** izlenen dalın (backend) kendi koşularında CI başarılı **ve** (yolları değiştiyse) sunucu kurulum testi ve demo
   testi başarılı; başarısız / iptal / süren / okunamayan sonuçta yayın yok. Derlemeden sonra dal ucu ve kapı yeniden
   denetlenir; derlenen kaynak (`git rev-parse HEAD`) ve imaja gömülen `GIT_SHA` onaylanan commit'in kendisi olmalı.
2. **Yayın öncesi denetim** (hiçbir şeyi değiştirmez): uygulama / işçi durumu, PostgreSQL erişimi (yoksa yayın yok),
   yarım kalmış migration (varsa yayın yok), son tam yedeğin yaşı, son sağlıklı sürümün imajları, **bu yayının uygulayacağı
   migration'lar** → "yayından sonra önceki sürüme otomatik dönüş mümkün / MÜMKÜN OLMAYACAK" önceden kayda yazılır.
3. Güvenlik yedeği, migration, başlatma (eskisi gibi).
4. **Uygulama açılmazsa / site Caddy üzerinden yeni sürümü vermezse:** veritabanının migration durumu yayın öncesiyle aynıysa
   önceki sürüme dönülür (eski davranış — kanıtlı güvenli); migration uygulandıysa **dönülmez** (eski kod yeni şemayla
   çalıştırılmaz) ve yöneticiye e-posta gider.
5. **Tam sağlık denetimi** (geçici gecikmeye karşı 3 tur, 15 sn arayla): uygulama sağlıklı ve doğru imajla · işçi çalışıyor,
   sürekli yeniden başlamıyor, doğru imajla · PostgreSQL · yarım migration yok · `https://takip.gkh.ro/surum` (sunucunun
   kendisi üzerinden, Caddy içinden) beklenen sürüm + commit · **salt okunur yoklama**: yeni sürümün Prisma istemcisi bütün
   modelleri tek bir `READ ONLY` işlemde okur (yazma yok, veri günlüğe yazılmaz). Yeni uç nokta açılmadı.
6. Geçerse kayıt yazılır. Geçmezse **gözlem kipinde**: algılanır, kaydedilir, son sağlıklı sürüme dönüşün güvenli olup
   olmadığı hesaplanır, yöneticiye e-posta gider — **canlı servis kendiliğinden eski sürüme geçirilmez**; commit "başarısız"
   işaretlenir (yeni commit gelene kadar yeniden yayınlanmaz). Bu işaret (`state/failed`) yalnızca YAYIN denemesinin
   başarısızlığıdır: testlerden (CI / sunucu kurulumu / demo) geçmeyen commit buraya yazılmaz; GitHub'da testler yeniden
   çalıştırılıp en son deneme başarılı olursa aynı commit yayınlanır (karar 291; kayıt `state/gate-failed`).

## 3. Geri dönüş ne zaman güvenlidir (hepsi gerekir)

- Hedefin doğrulanmış kaydı var; uygulama ve işçi imajları sunucuda ve kimlikleri kayıttakiyle **aynı**.
- Veritabanındaki uygulanmış migration listesi (**ad + checksum**) hedefin sağlıklı doğrulandığı andaki listeyle **birebir
  aynı** — hedeften sonra tek bir migration bile uygulandıysa geri dönüş **reddedilir**. Uyumluluk dosya adına ya da sürüm
  numarasına bakılarak varsayılmaz; kanıt veritabanının kendi kaydıdır.
- Yarım kalmış migration yok; hedefin Caddyfile'ı (farklıysa) çalışan Caddy'de geçerli.
- Hedefin araç imajı veritabanını salt okunur yoklamayla okuyabiliyor.

Reddedilen durumda seçenekler: düzeltme sürümü yayınlamak (önerilen) ya da sorunun niteliğine göre felaket kurtarma
kılavuzu. **Migration elle geri alınmaz, veritabanı yedeğe döndürülmez** — bunlar ayrı, onaylı süreçlerdir.

## 4. Komutlar (yalnızca root)

| Komut | Ne yapar |
|-------|----------|
| `sudo takip surum-durum` | yayındaki / son sağlıklı sürüm, aday, imaj kimlikleri, uygulama-işçi uyumu, kip, yedek durumu, son işlemler (salt okunur) |
| `sudo takip rollback-durum` | hedef, imajları, ön değerlendirme, geçmiş (salt okunur) |
| `sudo takip rollback-kontrol` | tam değerlendirme (yoklama dahil); 0 = güvenli, 1 = reddedilir + gerekçe; hiçbir şey değiştirmez |
| `sudo takip rollback` | aynı denetimler → hedefi gösterir → **hedefin kısa SHA'sı yazılarak onay** → uygulama + işçi birlikte geçer → tam sağlık denetimi → kayıt + e-posta. `--onay KISA_SHA` terminalsiz onay |
| `sudo takip surum-dogrula` | yayındaki sürümü sağlık denetiminden geçirip kaydeder (ör. geçici bir sorun giderildikten sonra) |
| `sudo takip rollback-modu [gozlem\|otomatik]` | kip; varsayılan **gozlem**. `otomatik` yalnızca sahibin açık onayıyla açılır |

Davranış güvenceleri: yayın, geri dönüş ve geri yükleme aynı kilidi kullanır (biri sürerken öteki reddedilir / bekler);
geri dönülen sürüm otomatik güncellemeyle yeniden yayınlanmaz (yeni commit gelince yayın normal sürer); tekrar çalıştırma
güvenle reddedilir (aday yoksa hiçbir şey değişmez); işlem ortasında sunucu / süreç durursa `release-op` işareti kalır →
sonraki çalıştırma algılar, e-posta gönderir; yarıda kalan **yayın** olağan akışla yeniden denenir (yinelenebilir adımlar),
yarıda kalan **geri dönüş** aynı denetimlerden geçerse tamamlanır. Uygulama ve işçi imajları uyuşmazsa boşta denetim
bildirir.

## 5. Adım adım elle geri dönüş

1. `sudo takip surum-durum` → yayındaki ve hedef sürüm, uyarılar.
2. `sudo takip rollback-kontrol` → **GÜVENLİ** değilse durun; gerekçeyi okuyun (en sık: `MIGRATION_CHANGED`).
3. Kullanıcılara kısa kesinti bildirin (geçiş sırasında site ~10–60 sn yanıt vermeyebilir).
4. `sudo takip rollback` → hedefin kısa SHA'sını yazın.
5. Sonuç: "✔ geri dönüldü … sağlık denetimi geçti (N sn)". `https://takip.gkh.ro/surum` hedef commit'i göstermeli.
6. Hatalı sürümün düzeltmesini yayınlayın (yeni commit → normal kapı ve yayın).

Ölçülen süre (CI'daki gerçek Docker testi, `deploy-test.yml` → "Geri dönüş süresi" notu): denetim + yoklama + kapsayıcı
geçişi + tam sağlık denetimi birkaç dakikanın altında; hedef 5–10 dakika.

## 6. Gizlilik

Kayıtlara, işlem geçmişine ve e-postalara yalnızca sürüm, commit, imaj kimliği, migration adı ve sabit kodlar yazılır.
`.env` değerleri, SMTP / FGO / Telegram / OpenAI anahtarları, GitHub anahtarı, rclone (Google OAuth) ayarı, yoklamanın
okuduğu veriler **yazılmaz** (`deploy/test/release-rollback.sh` senaryo 15 denetler).
