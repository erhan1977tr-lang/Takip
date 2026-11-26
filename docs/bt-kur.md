# Günün BT kuru — otomatik okuma (kurulum ve işletme)

Karar 328, CLAUDE.md madde 30. Kod: `server/fx/bt-auto.js`, `app/kur/bt/route.ts`, `scripts/bt-kur/`.

BT (Banca Transilvania) sunucumuzun ve bütün veri merkezlerinin IP adreslerini engellediği için kur sayfasını
sunucu almaz. İzin verilen bir bilgisayardaki Windows görevi sayfayı alır ve olduğu gibi TAKİP'e gönderir; kuru
okuyan ve denetleyen TAKİP'tir (sayfa denetimden geçmezse hiçbir şey yazılmaz).

BT, PowerShell'in doğrudan isteğini ve görünmez (headless) Edge'i de reddediyor (403 / Access Denied). Bu yüzden görev
önce doğrudan dener; olmazsa Edge'i ayrı bir profille (`edge-profil` klasörü — kullanıcının kendi Edge'i, sekmeleri ve
oturumları kullanılmaz) ekranın dışında normal pencerede açar, sayfayı yerel hata ayıklama bağlantısından
(127.0.0.1:9333) okur ve yalnızca bu Edge'i kapatır. Elle deneme: `powershell -ExecutionPolicy Bypass -File .\bt-kur.ps1 -Once`.

## Kurulum (bir kez)

1. TAKİP → Ayarlar → Entegrasyonlar → **Otomatik okuma**: kutuyu işaretleyin → Kaydet → **Yeni anahtar oluştur**.
   Anahtar (`btk_…`) yalnızca bir kez gösterilir; sunucuda yalnızca SHA-256 özeti tutulur.
2. Görevi çalıştıracak bilgisayarda `scripts/bt-kur/` klasöründeki `kur.ps1` ve `bt-kur.ps1` aynı klasörde olsun.
   O klasörde, görevi çalıştıracak Windows kullanıcısıyla:
   `powershell -ExecutionPolicy Bypass -File .\kur.ps1` → anahtarı yapıştırın.
3. Görev "TAKIP BT kuru" adıyla her gün 07:00, 12:30 ve 15:00'te çalışır (bilgisayarın yerel saati — saat dilimi
   Romanya olmalı). Bilgisayar o saatte kapalıysa açılınca hemen çalışır. Kurulum sonunda bir deneme gönderilir.

Anahtar `anahtar.dat` içinde Windows'un kullanıcıya bağlı şifrelemesiyle (DPAPI) durur: başka kullanıcı ya da
bilgisayar çözemez. Bilgisayar / kullanıcı değişirse 2. adımı yeni yerde tekrarlayın.

## İşleyiş

- Başarısız denemede 10 dakikada bir, en çok 1 saat yeniden dener. Yanlış anahtar (401) ya da otomatik okuma
  kapalı (409) ise yeniden denemez.
- Günlük: klasördeki `bt-kur.log` (son 500 satır). Başarılı satırda TAKİP'in yanıtı (`rate`, `applied`) yazar.
- Yöneticinin aynı gün elle girdiği kur her zaman önceliklidir.
- Otomatik okuma açıkken o gün kur yoksa son iyi kur en çok 3 gün kullanılır; okuma penceresi kursuz biterse
  Yönetici günde okuma saati başına bir uygulama içi bildirim (`FX_AUTO_FAILED`) alır.

## Anahtarı yenileme / kaldırma

- Yenileme: Entegrasyonlar'da yeni anahtar oluşturun (eski anahtar geçersiz olur) ve `kur.ps1`'i yeniden çalıştırın.
- Kaldırma: `Unregister-ScheduledTask -TaskName 'TAKIP BT kuru' -Confirm:$false` ve Entegrasyonlar'da otomatik okumayı
  kapatın (kapalıyken eski kural geçerlidir: yalnızca o günün elle girilen kuru).
