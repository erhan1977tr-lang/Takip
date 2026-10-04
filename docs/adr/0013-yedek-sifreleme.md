# 0013 — Yedek şifreleme (Google Drive kopyası)

**Durum:** Kabul · 04.10.2026 · güvenlik denetimi SEC-02, karar 121

## Bağlam
Gece yedeği (PostgreSQL dökümü + yüklenen dosyaların arşivi) yerelde tutuluyor ve Google Drive'a **şifresiz**
kopyalanıyordu. Drive hesabı ya da rclone yetkisi ele geçirilirse bütün müşteri, sipariş, fiyat ve dosya verisi
okunabilir. Öte yandan şifreleme, anahtar kaybolduğunda yedeklerin hepsini açılmaz yapar; "sunucudaki tek bir
belgesiz dosya kayboldu, bütün yedekler gitti" durumu kabul edilemez.

## Karar
- **Araç: [age](https://age-encryption.org)** (X25519 + ChaCha20-Poly1305; Ubuntu / Debian paketinde). Kendi
  şifreleme düzenimiz yok; parola türetme, mod ya da biçim seçimi yapılmaz. Şifreli dosya doğrulamalıdır: bozulmuş
  ya da başka anahtarla şifrelenmiş dosya "çözülmüş gibi" görünmez, hata verir.
- **Ne şifrelenir:** yalnızca **Google Drive'a giden kopya** (`db-….dump.age`, `dosyalar-….tgz.age`). Şifreleme
  açıkken Drive'a şifresiz dosya hiçbir koşulda gönderilmez (şifrelenemiyorsa Drive adımı hata verir, yerel yedek durur).
- **Yerel kopya açık kalır** (`/opt/takip/backups`, 0700, yalnızca root): canlı veritabanı ve yükleme klasörüyle aynı
  diskte, aynı korumadadır — onu okuyabilen zaten canlı veriyi okur. Anahtarsız kullanılabilen güvenlik ağıdır:
  anahtar dosyası bozulsa bile son 14 günün yerel yedeği ve yayın öncesi yedekler kullanılabilir.
- **Anahtar:** `/opt/takip/backup-key.txt` (age kimlik dosyası, 0600 root). Sunucuda üretilir. Yedeğe, Drive'a,
  git'e, günlüklere ve komut çıktısına **girmez**; yalnızca kurulum sırasında terminale bir kez yazılır.
  Sunucu yalnızca kendi çözebildiği anahtara şifreler (etkin açık anahtarın gizli kısmı dosyada yoksa şifrelemez).
- **Açma elle ve doğrulamalıdır — kendiliğinden açılmaz:** `takip yedek-sifreleme kur`
  1. anahtarı üretir, terminale yazar; sahibi **sunucu dışına** (şifre yöneticisi + kâğıt) kaydeder ve gizli anahtarın
     son 6 karakterini yazarak onaylar — onay yoksa hiçbir şey değişmez;
  2. tam bir yedek alır (döküm geçici veritabanına geri yüklenerek, arşiv okunarak doğrulanır);
  3. şifreler ve **hemen çözerek** özetini aslıyla karşılaştırır;
  4. Drive'a yükler, md5 ile doğrular;
  5. Drive'dan **indirir, çözer**, arşivi okur ve dökümü geçici veritabanına geri yükler;
  6. ancak bunların hepsi başarılıysa şifrelemeyi açık işaretler (`/opt/takip/state/backup-encryption`).
  Herhangi bir adım başarısızsa yedek akışı eskisi gibi çalışmaya devam eder.
- **Gece yedeği (açıkken):** aynı adımlar (2–4). Saklama: Drive'da son 14 **şifreli** çift; yerelde son 14 çift.
- **Şifresiz eski Drive yedekleri silinmez.** Şifreleme açıkken Drive temizliği yalnızca `.age` dosyalarına bakar.
  Ne yapılacağına ürün sahibi karar verir (`takip yedek-sifreleme` kaç şifresiz dosya kaldığını gösterir).
- **Geri yükleme:** `takip restore TARİH` önce yerel çifti kullanır (değişmedi); yoksa Drive'dan — şifreliyse indirir,
  anahtarla çözer. `takip restore-test [TARİH]` şifreleme açıkken **Drive'daki şifreli kopyayı** sınar: yalnızca root'un
  okuyabildiği geçici klasöre (`/opt/takip/backups/.gecici.*`) indirir, çözer, geçici veritabanına (`takip_yedek_dene`)
  yükler, sonra klasörü ve geçici veritabanını siler. Canlı veriye dokunmaz.
- **Anahtar yenileme:** `takip yedek-sifreleme yenile` yeni anahtar üretir, dosyanın başına ekler (eskiler kalır —
  eski yedekler açılabilsin), aynı onay ve denemeden sonra yeni anahtara geçer. Eski anahtar, onunla şifrelenmiş son
  yedek Drive'dan düştükten (14 gün) sonra sunucu dışındaki kayıttan da çıkarılabilir.

## Sunucu tamamen kaybolursa
1. Yeni sunucuya kurulum (`deploy/install.sh`), rclone'un Google Drive bağlantısı (`rclone config`, uzak ad `gkhdrive`).
2. Sunucu dışında saklanan anahtar `/opt/takip/backup-key.txt` dosyasına yazılır; `chmod 600`.
3. `takip restore-test TARİH` → sonra `takip restore TARİH`.
4. `takip yedek-sifreleme kur` (var olan anahtarla şifrelemeyi yeniden açar).

Sunucu olmadan elle: `age -d -i backup-key.txt db-….dump.age > db.dump` → `pg_restore`;
`age -d -i backup-key.txt dosyalar-….tgz.age | tar -xz`.

**Anahtar hem sunucuda hem sunucu dışında kaybolursa şifreli Drive yedekleri açılamaz** — bu yüzden iki ayrı yerde
saklanır ve kayıt onayı olmadan şifreleme açılmaz.

## Sonuçlar
- Drive / rclone ele geçirilirse yedeklerin içeriği okunamaz (dosya adları ve boyutları görünür).
- Sunucunun kendisi ele geçirilirse şifreleme koruma sağlamaz (canlı veri zaten oradadır); bu ADR'nin kapsamı değildir.
- Kurulum, gece yedeği, Drive'dan çözerek geri yükleme, anahtarsız / yanlış anahtarla hata ve anahtar yenileme temiz
  bir Ubuntu makinede CI ile denenir (`.github/workflows/deploy-test.yml`).
