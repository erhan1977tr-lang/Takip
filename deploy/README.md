# Sunucu kurulumu (Contabo ya da herhangi bir VPS)

Uygulama tek bir sunucuda Docker ile çalışır: **PostgreSQL** (veritabanı), **uygulama** (Next.js) ve **Caddy**
(HTTPS sertifikasını Let's Encrypt'ten kendisi alır ve yeniler). Sunucu, GitHub'daki `backend` dalını izler:
testlerden (CI) geçen her yeni sürümü birkaç dakika içinde kendisi yayınlar.

## Kurulum (bir kez, ~15 dakika)

Gerekli: Ubuntu 22.04 / 24.04 ya da Debian 12, en az 4 GB bellek, root erişimi.

1. Bilgisayarınızda **PowerShell** (Windows) ya da **Terminal** (Mac) açın ve sunucuya bağlanın:
   ```
   ssh root@SUNUCU_IP_ADRESI
   ```
   İlk bağlantıda `yes` yazın. Şifreyi yazarken ekranda hiçbir şey görünmez; yazıp Enter'a basın.
   **Şifreyi hiçbir yere (sohbet, e-posta) yapıştırmayın.**
2. Şu satırı yapıştırıp Enter'a basın:
   ```
   curl -fsSL https://raw.githubusercontent.com/erhan1977tr-lang/Takip/backend/deploy/install.sh | bash
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
| `takip durum` | Yayındaki sürüm, son güncellemeler, servisler, disk, yedekler |
| `takip smtp` | E-posta ayarları (kullanıcılara davet kodu gidebilmesi için gerekli) + deneme e-postası |
| `takip yonetici E-POSTA "Ad Soyad"` | Yeni yönetici açar; `--reset` ile şifresini sıfırlar. Tek kullanımlık kod ekrana yazılır |
| `takip guncelle` | Yeni sürüm varsa beklemeden yayınla |
| `takip yedek` | Hemen yedek al |
| `takip log` | Uygulamanın son günlük satırları |
| `takip dal main` | Otomatik güncellemenin izlediği dalı değiştirir |

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
/opt/takip/src         uygulamanın kaynağı (git)
/opt/takip/backups     veritabanı (14 gün) ve dosya (7 gün) yedekleri — her gece ~03:30 ve her yayından önce
/opt/takip/logs        yayın ve derleme kayıtları
/opt/takip/state       yayındaki commit, izlenen dal
```

## Güvenlik

- Güvenlik duvarı (ufw): yalnızca SSH, 80 ve 443 açık. Veritabanı dışarıya kapalı.
- fail2ban: SSH'ye art arda hatalı girişleri engeller. Sistem güvenlik güncellemeleri otomatik.
- Önerilen: SSH anahtarıyla girişe geçip root şifre girişini kapatmak.
- Yedekler şimdilik aynı sunucuda; sunucu dışına kopyalama Aşama 10'da.
