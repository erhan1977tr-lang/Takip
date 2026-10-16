# Felaket kurtarma (DR) — prosedür ve tatbikat kontrol listesi

3.92.0, karar 287 · ADR 0013 (yedek şifreleme) · ADR 0015. Bu belge **geri dönüşten (rollback) ayrı** bir süreçtir:
geri dönüş yalnızca uygulama imajını değiştirir ([geri-donus.md](geri-donus.md)); felaket kurtarma **veriyi** (veritabanı +
yüklenen dosyalar) yedekten geri getirir ve **her zaman insan kararıyla, onayla** yapılır. Hiçbir otomatik süreç veritabanını
yedeğe döndürmez.

## 1. Ne zaman felaket kurtarma

| Durum | Süreç |
|-------|-------|
| Yeni sürüm hatalı, veri sağlam | **Geri dönüş** (`takip rollback-kontrol` → `takip rollback`) ya da düzeltme sürümü |
| Migration uygulanmış, eski kodla uyum kanıtlanamıyor | Düzeltme sürümü (önerilen); felaket kurtarma yalnızca veri bozulduysa |
| Veri silindi / bozuldu (hatalı işlem, hatalı migration) | **Felaket kurtarma — aynı sunucuda** (`takip restore`) |
| Sunucu / disk kaybı | **Felaket kurtarma — yeni sunucu** (kurulum + Google Drive'daki yedek) |

## 2. Yedekler (değişmedi)

- Her gece 03:00 (Europe/Bucharest): `db-ZAMAN.dump` (pg_dump -Fc) + `dosyalar-ZAMAN.tgz`; yerelde geçici veritabanına geri
  yüklenerek doğrulanır, Google Drive'a kopyalanır (md5 + şifreliyse çözülerek doğrulama). Saklama: yerel 14, Drive 60 gün.
- Her yayından önce ayrıca güvenlik yedeği: `db-YYYYMMDD-HHMMSS-once-<kısa SHA>.dump`.
- Durumu salt okunur görmek: `sudo takip surum-durum` (son tam yedek, doğrulanmış son çift), `sudo takip yedek-kontrol durum`,
  `sudo takip yedek-sifreleme`.
- Şifreleme anahtarı (açıksa): sunucuda `/opt/takip/backup-key.txt`, **sahibinin sunucu dışındaki kopyası** — anahtar
  olmadan Drive'daki şifreli yedek açılamaz.

## 3. Aynı sunucuda geri yükleme (veri hatası)

1. Hasarın kapsamını ve zamanını belirleyin (hangi gün / saat öncesine dönülmeli; o saatten sonraki her kayıt kaybolur).
2. `sudo takip restore-test TARİH` — yedeği canlıya dokunmadan geçici veritabanında dener.
3. Kullanıcıları bilgilendirin; yazma işlemlerini durdurun.
4. `sudo takip restore TARİH` — önce güvenlik yedeği alır, tarihi yazarak onaylanır; veritabanı + dosyalar geri yüklenir,
   migration yeniden uygulanır, uygulama + işçi başlatılır.
5. Doğrulama: `sudo takip durum`, `https://takip.gkh.ro/surum`, birkaç kritik kayıt (son siparişler, stok, FGO belgeleri).
6. Yedekten sonra oluşmuş kayıtları (FGO'da kesilmiş belgeler, gönderilmiş e-postalar, mal kabulleri) **dış sistemlerle
   karşılaştırın**: FGO'daki belgeler silinmez; TAKİP'teki eksikleri elle tamamlayın.
7. Geri yükleme yayın kaydını değiştirmez; gerekirse `sudo takip surum-dogrula`.

## 4. Yeni sunucuya kurtarma (sunucu kaybı)

1. Yeni Ubuntu sunucu; DNS `takip.gkh.ro` → yeni IP (**yalnızca bu adres**; eski `takip.sistembalustrada.ro` kullanılmaz).
2. `deploy/install.sh` ile kurulum (README "Kurulum"); `takip github` (salt okunur erişim anahtarı).
3. rclone Google Drive bağlantısı (`gkhdrive:`) — yalnızca sahibin hesabıyla; şifreleme açıksa anahtar dosyası
   `/opt/takip/backup-key.txt` (0600) sahibin kopyasından.
4. `sudo takip restore-test TARİH` → `sudo takip restore TARİH` (Drive'dan indirilir, şifreliyse çözülür).
5. SMTP (`takip smtp`), FGO ve diğer entegrasyon ayarları: veritabanındakiler geri gelir; `.env`'deki sunucu ayarları
   (SMTP, Telegram, OpenAI) yeniden girilir — `.env` yedeğe girmez.
6. Doğrulama (madde 3.5–3.6) + `sudo takip yedek` (yeni sunucuda ilk tam yedek).

## 5. Kontrollü DR tatbikatı — kontrol listesi (canlı veritabanına DOKUNULMAZ)

Tatbikat **ayrı bir test sunucusunda** ya da canlıda yalnızca `restore-test` ile yapılır; canlı veritabanına geri yükleme
tatbikatı yapılmaz. Önerilen sıklık: üç ayda bir.

- [ ] Tarih / sorumlu / hedef süre (RTO) ve kabul edilebilir veri kaybı (RPO: en çok 24 saat — gece yedeği) yazıldı.
- [ ] `sudo takip yedek-kontrol durum`: son tam yedek < 26 saat, açık alarm yok.
- [ ] Canlıda `sudo takip restore-test` (yerel) ve şifreleme açıksa Drive'daki şifreli kopyayla deneme başarılı.
- [ ] Şifreleme anahtarının sunucu dışındaki kopyasına erişildi (anahtar sunucudakiyle aynı alıcıyı veriyor:
      `age-keygen -y`).
- [ ] Ayrı test sunucusu kuruldu (`install.sh`, test alan adı — **takip.gkh.ro değil**), rclone salt okunur bağlantı.
- [ ] Test sunucusunda Drive'daki yedekten `takip restore` yapıldı; süre ölçüldü.
- [ ] Test sunucusunda doğrulama: giriş, son siparişler, stok, belgeler; kayıt sayıları canlıdakiyle (yedek anındaki) uyumlu.
- [ ] Test sunucusunda e-posta / FGO / Telegram **kapalı** (gerçek müşteriye, FGO'ya, tedarikçiye hiçbir şey gitmedi).
- [ ] Test sunucusu silindi; yedek kopyaları ve anahtar test sunucusundan kaldırıldı.
- [ ] Sonuç (süre, sorunlar, belge düzeltmeleri) proje belgelerine yazıldı.

## 6. Yapılmayanlar

- Otomatik veritabanı geri yükleme, otomatik migration geri alma, veri silme — hiçbir süreçte yok.
- Canlı veritabanına tatbikat amaçlı geri yükleme — yapılmaz.
