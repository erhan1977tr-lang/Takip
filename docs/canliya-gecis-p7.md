# Canlıya geçiş — P1…P7 (3.66.1 → 3.73.x) — karar 250

Hedef: **11 Ekim 2026, 13:00 (Romanya saati)**. Canlıya geçiş = `backend` dalının bu sürüme getirilmesi (sunucu, CI'dan
geçen commit'i 2 dakika içinde kendiliğinden yayınlar). Bu belge yalnızca hazırlıktır: **merge / push / deploy ürün
sahibinin ayrı onayıyla yapılır.**

## 1. Ne değişiyor

| Paket | Sürüm | Özet | Veritabanı |
|---|---|---|---|
| P1 | 3.67 | Nihai cam faturası yalnızca onaylı yüklemeden (karar 239) | **1 migration** (aşağıda) |
| P2 | 3.68 | Telafi ekranı = sunucu yolu, teklif m² | — |
| P3 | 3.69 | Yükleme özeti Excel iki sayfa | — |
| P4 | 3.70 | Proformada aynı cam tek satır | — |
| P5 | 3.71 | Müşteri listesi, revizyon işaretleri, otomatik arşiv yalnızca onaylı yükleme | — |
| P6 | 3.72 | `takip yonetici-kurtar`; `takip yonetici` yalnızca yeni yönetici | — |
| P7 | 3.73 | Güvenlik sertleştirme, fatura görünürlüğü, yedek alarmı + bekçi | — (yeni systemd zamanlayıcısı) |

**Migration:** yalnızca `20261010124850_ci` — `BillingBatch.chainOrderId` (boş olabilir) + `BillingBatchLine.refDocId`
(boş olabilir) + bir indeks. Yalnızca EKLEME; mevcut satır değişmez; eski kod yeni sütunları yok sayar. Canlıdaki son
migration `20261010045151_ci` olmalı (K1 bölüm 1). Yayın aracı migration'dan ÖNCE veritabanı yedeği alır.

## 2. Ön kontroller (sunucuda, root; hiçbiri canlı veriye yazmaz)

Ortak kısaltma:

```sh
cd /opt/takip
dc() { docker compose -p takip --env-file /opt/takip/.env -f /opt/takip/src/deploy/docker-compose.yml "$@"; }
ro() { dc exec -T -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=60s' db psql -U takip -d takip -X -v ON_ERROR_STOP=1 -P pager=off; }
```

SQL dosyaları depodadır (`deploy/canliya-gecis/`); sunucuya kopyalanır (ör. `/root/`). Henüz `backend`'e gelmedikleri için
`/opt/takip/src` altında yoktur.

| # | Komut | Canlıya etkisi | Beklenen |
|---|---|---|---|
| K1 | `ro < /root/p7-onkontrol.sql \| tee /root/p7-onkontrol-$(date +%F-%H%M).txt` | Yok (READ ONLY işlem + oturum) | Bölüm 0 `salt_okunur = on`; **2 ve 3: 0 satır**; 4: 0 (ya da işçi bitirince 0); 5: 0 satır; 7 ve 8: 0 satır (varsa sipariş muhasebe kararıyla bekler — NO-GO değil, bilinçli kabul); 11: ≥ 1; 12: 0 satır; 1: yarım migration 0, P1 kaydı 0, önceki son migration 1 |
| K2 | `takip durum` | Yok | Sürüm 3.66.1 / `36ae29f`, dal `backend`, son yayın başarısız değil, servisler çalışıyor |
| K3 | `df -h /opt/takip /var/lib/docker` | Yok | Birkaç GB boş (derleme + yedek) |
| K4 | `takip yedek-sifreleme durum` ve `ls -l --time-style=long-iso /opt/takip/backups \| tail -n 8` | Yok | Bugünün 03:00 yedeği yerelde ve Drive'da |
| K5 | `takip yedek-dene yesterday` | **Salt okunur değil:** canlı `takip`'e dokunmaz; geçici `takip_yedek_dene` veritabanını oluşturur, yükler, sayar, siler. Yoğun saatte çalıştırmayın | "✔ Veritabanı geçici veritabanına yüklendi" |
| K6 | `grep -E '^(DEMO_MODE\|MAIL_OUTBOX_DIR\|TRANSLATE_FAKE\|COOKIE_SECURE)=' /opt/takip/.env` | Yok | Boş çıktı |

## 3. Yayın (onaydan sonra)

1. K1–K6 temiz. K1 bölüm 4 (kuyruk) 0 olana kadar bekleyin (işçi birkaç dakikada bitirir).
2. `backend` ← bu sürüm (fast-forward). Sunucu en geç 2 dakikada CI sonucunu görüp yayınlar; izlemek: `takip durum`,
   `tail -f /opt/takip/logs/deploy.log`.
3. Yayın aracı: derler → migration öncesi yedek → migration → yeni sürüm → sağlık + HTTPS denetimi; açılmazsa kendiliğinden
   önceki imaja döner (veritabanı ileri kalır — bkz. 5).

## 4. Yayın sonrası (ilk 30 dakika)

| # | Komut / adım | Beklenen |
|---|---|---|
| S1 | `takip durum` | Sürüm 3.73.x, yeni commit, servisler çalışıyor |
| S2 | `ro < /root/p7-onkontrol.sql \| sed -n '/=== 12/,/=== 13/p'` | 2 satır (yeni sütunlar) |
| S3 | `ro < /root/p7-geri-donus.sql` | Hepsi 0 (yeni kuralla henüz fatura yok) |
| S4 | `sudo takip yedek-kontrol` sonra `takip yedek-kontrol durum` | Bekçi zamanlayıcısı kurulur / etkinleşir; "Şu anki sorunlar: yok" |
| S5 | `.env`'e `BACKUP_ALERT_EMAIL=adres1,adres2` (önerilir; boşsa etkin yöneticiler alır) | Yeniden başlatma gerekmez |
| S6 | Tarayıcı: yönetici girişi; bir cam siparişi; Yüklemeler → onaylı bir günün **Faturalama** kartı (yalnızca önizleme, **"Fatura oluştur"a basmayın**); müşteri hesabıyla liste (Aktif / Yüklenen ve arşiv); satış hesabıyla firma adlarının maskeli olduğu | Hata yok |
| S7 | `takip log 200` | `Error` / `Unhandled` yok |

## 5. Geri dönüş sınırları

- **Otomatik:** sağlık / HTTPS denetimi başarısızsa araç önceki imaja döner. Migration geri alınmaz — yalnızca boş olabilen iki
  sütun ve bir indeks eklendiği için eski sürüm (3.66.1) bu şemayla çalışır.
- **Elle geri dönüş (önceki imaja / `backend`'i geri almak) YALNIZCA `p7-geri-donus.sql` bütün sayıları 0 iken.** Yeni
  kuralla bir **sipariş zinciri faturası** kesildikten sonra (bölüm 1 > 0) eski sürüm aynı siparişe sipariş sayfasından
  **ikinci kapanış faturası** kestirebilir ve alacakları yanlış gruplar → **geri dönülmez, ileriye düzeltilir.**
- **FGO'da kesilmiş belge geri alınamaz.** TAKİP FGO'da belge silmez / iptal etmez (karar 132). Yanlış belge FGO'da elle
  işlenir; TAKİP'teki kaydı "TAKİP'ten kaldır" ile (FGO "yok" derse) kaldırılır. Storno / düzeltme faturası 7F-2'dedir (yok).
- **Veritabanını yedekten geri yükleme** (`takip restore`) yayın sonrası kesilmiş FGO belgelerinin kayıtlarını siler — FGO'da
  belge durur, TAKİP'te kaybolur. Bu durumda geri yükleme yerine ileriye düzeltme yapılır.
- Yayın sonrası **ilk faturalama işleminden önce** S3 çalıştırılıp 0 görüldüyse, o ana kadar geri dönüş risksizdir.

## 6. GO / NO-GO

**NO-GO** (biri bile varsa yayın ertelenir):
- K1 bölüm 2 (kuyrukta eski kapanış faturası işi) ya da bölüm 3 (BELİRSİZ FGO işi) satır döndürüyor ve karara bağlanmadı.
- K1 bölüm 1: yarım / geri alınmış migration var ya da önceki son migration kaydı yok.
- K5 yedek denemesi "✘" ile bitiyor ya da bugünün yedeği yok.
- K2: son yayın başarısız ya da servis çalışmıyor; K3: disk dolu.
- CI (P7 dalının son commit'i): "CI" veya "Sunucu kurulumu" kırmızı.
- K1 bölüm 11: etkin yönetici yok.

**GO, bilinçli kabulle:** K1 bölüm 5 / 6 satırları (fiilen yüklenmiş siparişlerin "Yükleme yapıldı" kaydı yayından sonra
girilebilir; o zamana kadar bu siparişler faturalanamaz), bölüm 7 / 8 (o siparişler muhasebe kararına kadar faturalanmaz).

## 7. Kısa operatör komutları

```sh
takip durum                         # sürüm, servisler, son yayın
tail -f /opt/takip/logs/deploy.log  # yayın izleme
takip log 200                       # uygulama günlüğü
takip yedek-kontrol durum           # yedek bekçisi: son başarılı yedek, açık alarm (yalnızca okur)
sudo takip yedek-kontrol            # bekçiyi şimdi çalıştır (zamanlayıcıyı kurar / etkinleştirir)
sudo takip yedek                    # elle yedek (yerel + Drive)
takip yedek-dene yesterday          # yedeği geçici veritabanında dene (canlıya dokunmaz; geçici DB oluşturur/siler)
sudo takip yonetici-kurtar E-POSTA  # yöneticiye acil erişim (docs/yonetici-kurtarma.md)
sudo takip yonetici E-POSTA "AD"    # YENİ yönetici hesabı (var olan hesap değişmez)
```

## 8. Güvenlik testi (Strix) — kapsam ve sınırlar

- **Hedef: yalnızca canlı OLMAYAN ortam.** Seçenekler: (a) ayrı bir sunucuya `install.sh` ile kurulmuş kopya (kendi alan adı,
  boş veritabanı, test kullanıcıları), (b) Codespaces demo ortamı. **`takip.gkh.ro`, `takip.sistembalustrada.ro` ve canlı
  sunucunun IP'si kapsam DIŞI.**
- **Dış servisler kapsam dışı ve kapalı:** FGO (Entegrasyonlar'da kapalı; anahtar girilmez), ANAF, BNR, Google çeviri
  (`TRANSLATE_FAKE=1` yalnızca işaretsiz test kurulumunda), SMTP (`MAIL_OUTBOX_DIR` ya da sahte SMTP). Gerçek müşteri verisi,
  gerçek hesap, gerçek parola kullanılmaz; veriler sentetiktir.
- **Hesaplar:** beş rolün her biri için ayrı test hesabı (yönetici, yönetici yardımcısı, satış, çizim, denetimci, iki ayrı
  firmanın müşterisi) — yatay (firma A ↔ B) ve dikey (satış → yönetici) yetki denemeleri için.
- **Kapsamda:** kimlik doğrulama / oturum (`/login`, `/setup`, `/oturum/*`), sunucu işlemleri (Server Actions) ve rota
  işleyicileri, dosya erişimi (`/dosya/*`, `/belgeler/*/pdf`, depo bağlantısı `/depo/*`), maskeleme, iki katmanlı fiyat,
  yükleme / fatura önizleme ekranları, yükleme sınırları ve gövde kapısı.
- **Sınırlar:** hacimsel DoS / yük testi yok (en çok dakikada birkaç yüz istek); sosyal mühendislik yok; sunucuya SSH / root
  denemesi yok (`takip yonetici-kurtar` yalnızca kod incelemesiyle); FGO'ya istek üreten düğmeler kapalı ortamda bile
  "FGO_DISABLED" ile durur — açılmaz.
- **Çıktı:** bulgu başına adım, istek / yanıt (gizli değer maskeli), etkilenen rol, önem; bulgular bu depoya karar
  numarasıyla işlenir. Test süresince ortam sahibine iletişim kanalı açık tutulur; test sonunda ortam silinir.

## 9. Açık riskler (bu yayında bilinçli kabul)

- `PAYMENT_AFTER_INVOICE` (karar 239 seçenek a): çözüm düğmesi yok; o siparişin kalan faturası muhasebe kararına kadar bekler
  (artık "fatura bekliyor" listesinde nedeniyle görünür).
- `OPS_WITHOUT_GLASS` / `CHAIN_ROOT_MISSING`: otomatik faturalanmaz; görünür ve hatırlatılır, karar muhasebede.
- Avans düşümü satırı FGO'ya net birim fiyatla gider; FGO'nun yeniden hesapladığı toplam ±0,01 RON sapabilir (P1 öncesiyle
  aynı davranış).
- Yazılımda, işçi FGO'dan başarılı yanıt aldıktan sonra kaydı yazamadan çökerse parti FAILED olur ve yeniden denemede FGO
  "yinelenen belge" der: **FAILED + yinelenen belge hatasında partiden vazgeçilmez**, önce FGO'da belge aranır.
- Önceki denetimden açık: AUD-14 (scrypt maliyeti), FGO API istemcisinin yönlendirmeyi izlemesi (karar gerekir), SEC-03/08/12/
  13/14/16 (ertelenmiş).
- Yedek alarmı yalnızca araç kapsayıcısı çalışabildiğinde e-posta gönderebilir (Docker tamamen çöktüyse gönderemez; durum
  `logs/backup-alert.log`'a yazılır). Veritabanı çalışmıyorsa yönetici listesi okunamaz — `BACKUP_ALERT_EMAIL` önerilir.
