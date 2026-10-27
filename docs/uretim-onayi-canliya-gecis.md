# Müşteri üretim onayı — canlıya geçiş (4.2.9)

Hedef: 28.10.2026 Çarşamba (yedek: 29.10.2026 Perşembe). Canlı: 4.2.0 (`backend`). Yeni sürüm: `claude/uretim-onayi`.
Karar: 305, 305b, 305c (`docs/decisions.md`), CLAUDE.md madde 168.

**İki aşama, her biri ürün sahibinin ayrı açık onayıyla.** Aşama 1 müşteriye görünen hiçbir şey değiştirmez (özellik
KAPALI). Aşama 2 özelliği açar, siparişleri bildirimsiz kapsama alır, bildirimi önce pilot siparişlere, sonra kalanlara
gönderir. Bu belgedeki salt okunur kontroller (Aşama 0) onay gerektirmez; yazan her adım işaretlidir (✎).

## Ortak kısaltma (sunucuda, root)

```sh
cd /opt/takip
dc() { docker compose -p takip --env-file /opt/takip/.env -f /opt/takip/src/deploy/docker-compose.yml "$@"; }
ro() { dc exec -T -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=60s' db psql -U takip -d takip -X -v ON_ERROR_STOP=1 -P pager=off; }
onay() { dc run --rm --no-deps -T -e SUDO_USER="${SUDO_USER:-$USER}" tools node scripts/production-approval-enroll.mjs "$@"; }
```

`ro` her sorguyu READ ONLY oturumda çalıştırır. `onay` (kapsama alma betiği) yalnızca Aşama 2'de, 4.2.9 yayındayken
kullanılır; `--uygula` vermeden yalnızca ön izleme yapar (salt okunur işlem).

## Aşama 0 — hazırlık (salt okunur; canlıya etkisi yok)

SQL dosyaları henüz `backend`'de olmadığı için dalın sabit commit'inden alınır:

```sh
C=e8b43a4fc45fb354df538f15b0efe86d16cbb173   # testlerden geçmiş dal commit'i (SQL dosyaları bu commit'ten beri değişmedi)
for f in uretim-onayi-kapsam.sql uretim-onayi-bildirim-sagligi.sql; do
  curl -fsSL "https://raw.githubusercontent.com/erhan1977tr-lang/Takip/$C/deploy/canliya-gecis/$f" -o "/root/$f"
done
```

| # | Komut | Beklenen | Değilse |
|---|---|---|---|
| K1 | `takip durum` | Sürüm 4.2.0, dal `backend`, son yayın başarısız değil, servisler çalışıyor, "E-posta: <sunucu>" satırı (ayarlı) | Dur, incele |
| K2 | `takip surum-durum` | Son sağlıklı sürüm 4.2.0 kaydı var | Dur (önce `takip surum-dogrula`) |
| K3 | `takip yedek-kontrol durum` | Sorun kodu yok; son yerel + Google Drive yedeği < 26 saat | Dur: `takip yedek`, sonra yeniden |
| K4 | `grep -ciE '^NOTIFY_EMAILS=(0\|false\|no\|off)\s*$' /opt/takip/.env` | `0` (sipariş e-postaları açık) | Aşama 2 bildirimi yapılmaz |
| K5 | `grep -cE '^(SMTP_HOST\|SMTP_USER\|SMTP_PASS\|MAIL_FROM)=.+' /opt/takip/.env` | `4` (değerler ekrana yazılmaz) | Aşama 2 bildirimi yapılmaz |
| K6 | `ro < /root/uretim-onayi-bildirim-sagligi.sql \| tee /root/bildirim-sagligi-$(date +%F-%H%M).txt` | 2: son başarılı gönderim yakın tarihli, `basarisiz_7g` ≈ 0; 3 ve 4: 0 satır / 0; 6: `kayit` = 1 | E-posta sorunu çözülmeden Aşama 2 yok |
| K7 | `ro < /root/uretim-onayi-kapsam.sql \| tee /root/uretim-onayi-kapsam-$(date +%F-%H%M).txt` | Kategori sayıları (REQUEST / FLAG_ONLY / LOADED / FINAL_INVOICED / COMPENSATION / NO_OFFER); 30.10.2026 siparişleri listede YOK | NO_OFFER ve LOADED satırları ürün sahibine gösterilir |
| K8 | `df -h /opt/takip /var/lib/docker` | Birkaç GB boş (derleme + yedek) | `takip cache temizle` |

İsteğe bağlı SMTP denemesi (yalnızca KENDİ adresinize örnek davet e-postası; veritabanına yazmaz, müşteriye gitmez):
`dc run --rm --no-deps -T tools node scripts/test-mail.mjs SIZIN@ADRESINIZ tr`. K6'da yakın tarihli `SENT` satırları
gerçek gönderimin zaten çalıştığını gösterir; deneme e-postası buna ek güvencedir.

**Aşama 1 GO:** K1–K5 ve K8 tamam, K3'te sorun yok. K6 / K7 Aşama 2 kararının girdisidir.

## Aşama 1 — yeni sürüm + migration, özellik KAPALI (✎ onay #1 gerekir)

Süre: birleştirmeden yayına ≈ 60 dakika (CI ≈ 25 dk, sunucu kurulum testi ≈ 55 dk, demo ≈ 3 dk paralel; sonra 2 dakika
içinde otomatik yayın). Yayın sırasında uygulama ≈ 1 dakika yeniden başlar: 30.10 yükleme günündeki "Yükleme yapıldı"
gibi işlemlerle çakışmayan bir saat seçin (öneri: sabah erken).

1. ✎ `takip yedek` — tam yedek (veritabanı + dosyalar + Google Drive). Ardından `takip yedek-kontrol durum` temiz olmalı.
2. ✎ GitHub'da `claude/uretim-onayi` → `backend` PR, **"Create a merge commit"** (squash / rebase YOK — karar 289).
3. Kapılar: birleştirme commit'inin KENDİ `backend` koşuları — CI, Sunucu kurulumu (deploy/** değişti), Demo ortamı
   (package.json değişti) — yeşil olmalı. Biri kırmızıysa yayın olmaz; canlı 4.2.0 çalışmaya devam eder.
4. Yayın (otomatik, ya da kapılar yeşilken `takip guncelle`): derleme → **otomatik veritabanı yedeği**
   (`/opt/takip/backups/db-…-once-<sha>.dump`) → 3 migration → temel seed (rol yetkileri) → yeni uygulama + işçi →
   sağlık denetimi → "son sağlıklı sürüm" kaydı.
5. Doğrulama (salt okunur):
   - `takip durum` → 4.2.9, birleştirme commit'i, son yayın başarılı; `takip surum-durum` → sağlıklı kayıt 4.2.9.
   - `curl -s https://takip.gkh.ro/surum` → 4.2.9.
   - `ro < /opt/takip/src/deploy/canliya-gecis/uretim-onayi-asama-kontrol.sql` → 1: `ayar_satiri` 0 (KAPALI);
     2: 0 satır; 3: hepsi 0; 4: `ORDER_PRODUCTION_APPROVAL_*` satırı yok.
   - `takip log 200` → hata yok.
6. Elle duman testi (yönetici, müşteriye görünen işlem yapmadan):
   - Cam siparişleri (HAZIRLANIYOR / URETIMDE): "Müşteri onayı" kartı ve "Onay gerekli" rozeti YOK.
   - Ayarlar → Entegrasyonlar → "Müşteri üretim onayı": **Kapalı**.
   - Yüklemeler → 30.10.2026: gün açılır, "Yükleme yapıldı" ön izlemesinde onay uyarısı YOK (gerçek yükleme olmadan onaylamayın).
   - Muhasebe (Cam / Profil Tahsilat, proforma ekranı), profil siparişleri, tedarikçi siparişleri, çizim paneli açılır.
   - Günün ilk gerçek "teklifi müşteriye gönder" işleminde sipariş 4.2.0'daki gibi üretime geçer (çizim onaylıysa / gerekmiyorsa).
7. Sorun çıkarsa: aşağıdaki "Müdahale planı".

**Aşama 2 GO:** Aşama 1 doğrulaması ve duman testi tamam, K4–K6 temiz, ürün sahibinin onayı #2.

## Aşama 2 — özelliği aç, bildirimsiz kapsama al, kontrollü bildirim (✎ onay #2 gerekir)

Adımlar aynı oturumda, ara vermeden yapılır: kapsama alınan hazırlık siparişleri müşteri onayına kadar üretime geçmez,
bu yüzden kapsama alma ile bildirim arasındaki süre kısa tutulur.

1. Ön kontrol (salt okunur): `ro < /opt/takip/src/deploy/canliya-gecis/uretim-onayi-kapsam.sql` (K7 ile karşılaştırın) ve
   aşama kontrolünün 5. bölümü.
2. ✎ Yönetici: Ayarlar → Entegrasyonlar → Müşteri üretim onayı → "Müşteri üretim onayı iste" işaretli, kesim günü
   **2026-11-06**, Kaydet. Bundan sonra oluşturulan ve planlanan yüklemesi ≥ 06.11 olan yeni siparişler kapsamda doğar.
   Mevcut siparişler bu düğmeyle değişmez.
3. Ön izleme (salt okunur): `onay | tee /root/onay-onizleme-$(date +%F-%H%M).txt` — "Özellik ayarı: AÇIK", kategori
   sayıları K7 ile uyumlu, onay kodu.
4. ✎ Bildirimsiz kapsama alma: `onay --uygula --onay KOD --bildirimsiz` → "Onay talebi açılan: … · yalnızca kapsama
   alınan: … · dokunulmayan: …". Müşteriye hiçbir şey gitmez, süre başlamaz. (Ön izlemeden sonra bir siparişte işlem
   olduysa kod tutmaz: hiçbir şey yazılmaz, 3. adım yeniden.)
5. Doğrulama: aşama kontrolü → 2: bayraklı sipariş sayısı; 3: `talep_acik` = REQUEST sayısı, `iletildi` 0; 4: talep satırı yok.
6. Pilot (2–3 sipariş, e-posta adresi geçerli, iletişimi kolay müşteriler — aşama kontrolü bölüm 6'dan):
   - `onay --bildirim --siparis GLA68,GLA70` (ön izleme + kod)
   - ✎ `onay --bildirim --siparis GLA68,GLA70 --uygula --onay KOD`
   - 1–2 dakika sonra aşama kontrolü bölüm 6 → `ILETILDI_BEKLIYOR` + `son_tarih`; sipariş sayfasında "İletildi (e-posta)" ve son
     tarih; müşteri e-postayı aldı mı (pilot müşteriye sorulabilir). `ILETILEMEDI_…` görülürse DUR: SMTP / adres incelenir;
     gerekirse acil durdurma.
7. ✎ Kalanlar: `onay --bildirim` (ön izleme + kod) → `onay --bildirim --uygula --onay KOD`. İşçi turda 20 bildirim işler;
   birkaç dakika içinde tamamlanır. Aşama kontrolü 3 / 6 ve bildirim sağlığı 1–3 ile izlenir.
8. Günlük izleme (06.11'e kadar): aşama kontrolü bölüm 6; yöneticiye gelen "iletilemedi" / "gecikti" bildirimleri;
   müşteriye iletimden 1 iş günü sonra tek hatırlatma; ≥ 06.11 yükleme günlerinde onaysız siparişler "Yükleme yapıldı"
   kartında bağlantılarıyla listelenir — yalnızca yönetici sipariş sayfasında gerekçeli istisna verebilir.

## Acil durdurma (✎ yönetici, tek adım)

Ayarlar → Entegrasyonlar → "Müşteri üretim onayı iste" işaretini kaldır → Kaydet. Etkisi hemen (sayfa / işçi her işlemde
ayarı okur):

- Onay zorunluluğu, onaysız üretime geçiş engeli ve onaysız yükleme engeli kalkar (4.2.0 iş akışı).
- Yeni onay talebi, hatırlatma ve gecikme bildirimi yazılmaz / gönderilmez; kuyrukta kalmış talep / hatırlatma e-postası
  ve zili ATLANIR; teklif e-postası onay metni olmadan gider.
- Toplu durum değişikliği yapılmaz. Yalnızca müşteri onayını beklediği için HAZIRLANIYOR'da kalmış siparişler (çizim
  onaylı / gereksiz, teklif müşteride) kendiliğinden üretime geçmez — 4.2.0'da üretime geçiren tetikleyiciler (teklifin
  gönderilmesi, çizim onayı, beklemeden çıkarma) zaten geçmiştir. Bunlar aşama kontrolünün **7. bölümünde** listelenir; her biri için
  sipariş sayfasında **"Beklemeye Al" → "Beklemeden çıkar"** yapılır: ikincisi olağan kuralla üretime geçirir (müşteriye "üretimde"
  bildirimi 4.2.0'daki gibi gider; bekletme / devam müşteriye görünmez). "Teklifi güncelle" üretime geçirmez.
- Müşterinin değişiklik talebiyle açılmış, henüz gönderilmemiş taslak sürüm kapalıyken de durur: satış → yönetici →
  müşteriye gönderim yolu izlenir (gönderimde sipariş üretime geçer).
- Verilmiş onaylar, kapsam bayrakları, istisnalar ve denetim kayıtları silinmez; açıkken yazılmış zil bildirimleri
  (ör. "Üretim onayınız bekleniyor") müşterinin listesinde geçmiş kayıt olarak kalır.

Yeniden açınca kendiliğinden talep / bildirim yazılmaz. Kapalıyken müşteriye gönderilmiş sürümler onay bekler hâle gelir:
talepleri yönetici sipariş sayfasından ("Onay talebini yeniden gönder") ya da `onay --bildirim` ile, sürüm başına bir kez
başlatır. Kapanmadan önce iletilmiş ama hatırlatması henüz gitmemiş bir sürümün TEK hatırlatması açıldıktan sonra gider
(iletimden itibaren 30 gün içinde); ikinci hatırlatma yazılmaz.

## Müdahale planı (veri kaybı olmadan)

Migration'lar yalnızca EKLEME yapar (boş olabilen sütunlar, varsayılanı `false` olan bir bayrak, bir yetki değeri, üç
yabancı anahtar); mevcut satır değişmez, veri silinmez. Yayın aracı migration sonrası otomatik geri dönmez ve
`takip rollback` migration listesi değiştiği için reddeder (karar 287 — bilinçli).

1. **Özellikle ilgili sorun** → acil durdurma (yukarıda). Veri değişmez; 4.2.0 iş akışı geri gelir.
2. **4.2.9'un başka bir yerinde hata** → düzeltme ileri: dalda düzeltme commit'i → CI + kurulum testi → yeni PR →
   birleştirme → otomatik yayın. Bu sürede özellik kapalı tutulur.
3. **Uygulama açılmıyorsa** → yayın aracı migration öncesi aşamada önceki sürüme döner; migration sonrası açılmazsa
   (`failed` + alarm) `takip log`, `takip rollback-kontrol` ile incelenir, düzeltme ileri yapılır.
4. **Son çare** (yalnızca ürün sahibinin kararıyla): `takip restore` ile yayın öncesi yedeğe dönüş — yedekten sonra girilen
   bütün veriler (siparişler, teklifler, yüklemeler) KAYBOLUR. Önce `takip restore-test` ile yedeğin açıldığı denenir.

## Kapsam ve davranış özeti (hatırlatma)

- Kapsam = siparişin bayrağı (planlanan yükleme ≥ 06.11.2026); 30.10.2026 yüklemeleri bayraksızdır, hiçbir engel görmez.
- Yükleme tarihi değişikliği onayı bozmaz; yeni sürüm / talep / süre / hatırlatma oluşturmaz. Bayraklı sipariş tarihi
  kesimden önceye çekilse de onaysız yüklenemez.
- Onay teklif SÜRÜMÜNE bağlıdır: müşteriye yeni sürüm gönderilince yeniden onay istenir; gönderilmemiş taslak onayı bozmaz.
- Süre talep müşteriye iletildiğinde başlar (2 Romanya iş günü); iletilemeyen talepte süre başlamaz, yönetici bilgilendirilir.
- Proforma onaydan önce ya da sonra kesilebilir; proforma siparişi üretime geçirmez. FGO / ANAF akışları değişmedi.
