# Sunucu kurulumu (Contabo ya da herhangi bir VPS)

Uygulama tek bir sunucuda Docker ile çalışır: **PostgreSQL** (veritabanı), **uygulama** (Next.js), **Caddy**
(HTTPS sertifikasını Let's Encrypt'ten kendisi alır ve yeniler), **ClamAV** (yüklenen dosyaların virüs taraması)
ve **işçi** (taranamamış dosyaları sonradan tarar). Sunucu, GitHub'daki `backend` dalını izler:
testlerden (CI) geçen her yeni sürümü birkaç dakika içinde kendisi yayınlar.

## Kurulum (bir kez, ~15 dakika)

Gerekli: Ubuntu 22.04 / 24.04 ya da Debian 12, en az 4 GB bellek (antivirüsle birlikte 8 GB önerilir), root erişimi.

0. **GitHub erişim anahtarı** (depo özel olduğu için sunucunun kodu okuyabilmesi gerekir):
   github.com → sağ üstte profil → **Settings** → **Developer settings** → **Personal access tokens** →
   **Fine-grained tokens** → **Generate new token**
   - Token name: `Takip sunucu` · Expiration: 1 yıl (dolunca sunucuda `takip github` ile yenilenir)
   - Repository access: **Only select repositories** → `Takip`
   - Permissions → Repository permissions: **Contents: Read-only**, **Actions: Read-only**
   - **Generate token** → çıkan `github_pat_…` anahtarını kopyalayın. Yalnızca sunucuda soruluca yapıştırın;
     başka hiçbir yere (sohbet, e-posta) yazmayın.
1. Bilgisayarınızda **PowerShell** (Windows) ya da **Terminal** (Mac) açın ve sunucuya bağlanın:
   ```
   ssh root@SUNUCU_IP_ADRESI
   ```
   İlk bağlantıda `yes` yazın. Şifreyi yazarken ekranda hiçbir şey görünmez; yazıp Enter'a basın.
   **Şifreyi hiçbir yere (sohbet, e-posta) yapıştırmayın.**
2. Şu satırı yapıştırıp Enter'a basın; `GitHub anahtarı:` sorusunda anahtarı yapıştırın (ekranda görünmez):
   ```
   read -rsp "GitHub anahtarı: " GH_TOKEN && echo && export GH_TOKEN && curl -fsSL -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/erhan1977tr-lang/Takip/contents/deploy/install.sh?ref=backend" | bash
   ```
3. Sorulanları yanıtlayın: ilk yöneticinin e-postası, adı soyadı, şirket adı.
4. Sonunda ekranda **adres** ve **tek kullanımlık kod** çıkar. Adresi açın → e-postanızı yazın → şifre alanını
   boş bırakıp Giriş'e basın → kodu girin → kendi şifrenizi belirleyin.

Alan adı verilmezse sunucunun IP'sinden ücretsiz bir adres kullanılır (`185-12-34-56.sslip.io` gibi; HTTPS çalışır).
Kendi alan adınıza geçmek için: alan adının DNS'inde `A` kaydını sunucunun IP'sine yönlendirin, sonra sunucuda
kurulum komutunu `| bash -s -- --domain takip.alanadiniz.ro` ile yeniden çalıştırın.

## Günlük kullanım (sunucuda)

| Komut | Ne yapar |
|---|---|
| `takip durum` | Yayındaki sürüm, son güncellemeler, servisler (işçinin kullanıcısı, yükleme dosyalarının sahipliği), disk, yedekler |
| `takip smtp` | E-posta ayarları (kullanıcılara davet kodu gidebilmesi için gerekli) + deneme e-postası |
| `takip yonetici E-POSTA "Ad Soyad"` | Yeni yönetici açar; `--reset` ile şifresini sıfırlar. Tek kullanımlık kod ekrana yazılır |
| `takip guncelle` | Yeni sürüm varsa beklemeden yayınla |
| `takip yedek` | Hemen yedek al (veritabanı + dosyalar, Google Drive'a kopya) |
| `takip restore yesterday` / `takip restore 2026-09-30` | O günün en son tam yedeğine geri dön (önce güvenlik yedeği; tarihi yazarak onay) |
| `takip restore-test [TARİH]` | Yedeği canlıya dokunmadan geçici veritabanında dener (şifreleme açıksa Drive'daki şifreli kopyayı indirip çözerek) |
| `takip yedek-sifreleme` | Google Drive kopyasının şifrelenmesi: durum · `kur` (anahtar + deneme + açma) · `yenile` (anahtar yenileme) · `kapat` |
| `takip log` | Uygulamanın son günlük satırları |
| `takip cache` | Docker derleme önbelleği boyutu, geri kazanılabilir alan, disk kullanımı. Önbellek 10 GB'ı aşarsa yayından sonra kullanılmayan derleme önbelleği kendiliğinden silinir (en son kullanılan ~4 GB tutulur). Yalnızca derleme önbelleği: imajlara, kapsayıcılara, veritabanına, yüklenen dosyalara ve yedeklere dokunulmaz |
| `takip cache temizle` | Aynı denetimi şimdi yapar (sınır aşılmadıysa hiçbir şey silmez) |
| `takip dal main` | Otomatik güncellemenin izlediği dalı değiştirir |
| `takip github` | GitHub erişim anahtarını yeniler (süresi dolunca `takip durum` bunu söyler) |
| `takip antivirus` | Antivirüs çalışıyor mu, test virüsünü (EICAR) yakalıyor mu; bekleyen ve karantinadaki dosya sayısı |
| `takip kur [ADRES]` | Banca Transilvania EUR satış kuru sunucudan okunabiliyor mu (FGO proforması için) |

## Otomatik güncelleme nasıl çalışır

- `takip-deploy.timer` 2 dakikada bir GitHub'daki dalın son commit'ine bakar.
- Commit GitHub Actions'taki **CI** testlerinden (`build-test`) geçmediyse yayınlanmaz. CI'nin kendisinin yazdığı
  commit'ler (kilit dosyası, migration) bir önceki commit'in test sonucuyla değerlendirilir.
- Yalnızca test/belge değiştiyse uygulama yeniden derlenmez.
- Yayın sırası: sunucuda derleme → **veritabanı yedeği** → migration + temel veri → yeni sürüm → sağlık kontrolü.
  Derleme ya da migration başarısızsa önceki sürüm çalışmaya devam eder; yeni sürüm açılmazsa önceki sürüme dönülür.
- Kayıt: `/opt/takip/logs/deploy.log` (ayrıntı: `derleme-<commit>.log`). Yayındaki sürüm: `https://ADRES/surum`.

## Dosyalar

```
/opt/takip/.env        ayarlar ve gizli anahtarlar (yalnızca bu sunucuda; kurulumda üretilir, chmod 600)
/opt/takip/github-token  GitHub okuma anahtarı (chmod 600; uygulamanın ortamına girmez)
/opt/takip/backup-key.txt  yedek şifreleme anahtarı (chmod 600; yalnızca şifreleme açıldıysa; kopyası SUNUCU DIŞINDA saklanır)
/opt/takip/src         uygulamanın kaynağı (git)
/opt/takip/backups     her gün 03:00 (Romanya): db-YYYY-MM-DD_HHMMSS.dump + dosyalar-YYYY-MM-DD_HHMMSS.tgz, son 14 çift;
                       yayın öncesi yedekler db-YYYYMMDD-HHMMSS-once-<commit>.dump (14 gün)
/opt/takip/logs        yayın ve derleme kayıtları
/opt/takip/state       yayındaki commit, izlenen dal
```

## Güvenlik

- Güvenlik duvarı (ufw): yalnızca SSH, 80 ve 443 açık. Veritabanı dışarıya kapalı.
- fail2ban: SSH'ye art arda hatalı girişleri engeller. Sistem güvenlik güncellemeleri otomatik.
- Önerilen: SSH anahtarıyla girişe geçip root şifre girişini kapatmak.
- Yedekler her gece Google Drive'a da kopyalanır (rclone, `gkhdrive:GKH_TAKIP_BACKUPS/{database,uploads}`; .env'de `BACKUP_REMOTE` ile değiştirilebilir), md5 ile doğrulanır; Drive'da da son 14 çift. Kayıt: `/opt/takip/logs/backup.log`.
- Veritabanı yedeği her gece geçici bir veritabanına geri yüklenerek denenir. .env, github-token, rclone ayarı ve yedek anahtarı yedeğe girmez.
- Yerel yedekler yalnızca root'a açıktır: klasör `0700`, içinde oluşan her yedek dosyası (geçici dosyalar dahil) `0600`.
- Uygulama ve arka plan işçisi root olmadan çalışır (kullanıcı `1001:1001`). Yüklenen dosyaların (`takip_uploads`) sahibi de
  1001:1001'dir; her yayında işçi başlamadan önce `uploads-init` servisi başka kullanıcıya ait kalmış kayıtların yalnızca
  sahipliğini düzeltir (dosya silmez, taşımaz, içeriğini değiştirmez). `takip durum` bunu gösterir. Migration ve yönetim
  komutları (`tools`) root kalır.

## Yedek şifreleme (Google Drive kopyası)

Ayrıntı ve gerekçe: `docs/adr/0013-yedek-sifreleme.md`. Varsayılan **kapalıdır**; sunucu sahibi açar:

```
apt-get update && apt-get install -y age     # bir kez (yeni kurulumlarda install.sh kurar)
takip yedek-sifreleme                        # durum: açık mı, Drive'da kaç şifreli / şifresiz yedek var
takip yedek-sifreleme kur                    # anahtar üretir, ekrana yazar → SUNUCU DIŞINA kaydedin → dener → açar
```

- `kur` anahtarı ekrana **bir kez** yazar. Şifre yöneticinize kaydedin **ve** kâğıda yazdırıp saklayın; Google Drive'a,
  e-postaya, sohbete, git'e koymayın. Kaydettiğinizi gizli anahtarın son 6 karakterini yazarak onaylarsınız.
- Sonra tam bir şifreli yedek alınır, Drive'a yüklenir, Drive'dan indirilip çözülerek geçici veritabanına geri yüklenir.
  Hepsi başarılıysa şifreleme açılır; değilse hiçbir şey değişmez.
- Açıkken Drive'a yalnızca `….dump.age` / `….tgz.age` gider. Yerel yedekler (`/opt/takip/backups`, yalnızca root) açık kalır.
- Anahtar sunucuda: `/opt/takip/backup-key.txt` (chmod 600). **Sunucu dışındaki kopyası kaybolursa ve sunucu da
  kaybolursa şifreli yedekler açılamaz.**
- Şifresiz eski Drive yedekleri silinmez; `takip yedek-sifreleme` kaç tane kaldığını gösterir.
- Anahtar yenileme: `takip yedek-sifreleme yenile` (yeni anahtarı da sunucu dışına kaydedin; eskisini 14 gün daha saklayın).
- Sunucu kaybolduysa: yeni sunucuya kurulum + rclone → anahtarı `/opt/takip/backup-key.txt` dosyasına yazın (`chmod 600`)
  → `takip restore-test TARİH` → `takip restore TARİH` → `takip yedek-sifreleme kur`.
