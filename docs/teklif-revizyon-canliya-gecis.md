# Müşteri teklif revizyonu — canlıya geçiş (4.2.10)

Canlı: 4.2.9 (`backend` = `2dada04f`). Yeni sürüm: `claude/teklif-revizyon` (4.2.10). Karar 306 (`docs/decisions.md`),
CLAUDE.md madde 169. **Her yazan adım (✎) ürün sahibinin ayrı açık onayını ister**; salt okunur kontroller onay istemez.

## Ne değişir

- Yeni iş akışı / durum yok: müşterinin değişiklik talebi üretimdeki siparişte de satışa revizyon taslağı açar; satış
  "Yönetici Onayına Gönder"ir, yönetici gönderir (4.2.9 onay kuralı aynen). Sipariş durumu, üretim, çizim, yükleme,
  proforma / FGO / ANAF ve muhasebe kayıtlarına dokunulmaz.
- **Migration:** tek, eklemeli — `Offer` tablosuna 5 boş olabilen sütun (talep notunun çevirisi). Mevcut satırlar değişmez,
  veri taşıma / geri doldurma yok. Migration'dan sonra `takip rollback` 4.2.9'a dönmeyi reddeder (veritabanı migration listesi
  farklı — karar 287); sorun çıkarsa düzeltme ileri yapılır (4.2.9 geçişindeki gibi).
- Müşteriye yeni bildirim yok. Satışçıya yeni e-posta: müşteri değişiklik istediğinde (uygulama içi bildirim zaten vardı).

## Ortak kısaltma (sunucuda, root)

```sh
cd /opt/takip
dc() { docker compose -p takip --env-file /opt/takip/.env -f /opt/takip/src/deploy/docker-compose.yml "$@"; }
ro() { dc exec -T -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=60s' db psql -U takip -d takip -X -v ON_ERROR_STOP=1 -P pager=off; }
```

## Aşama 0 — hazırlık (salt okunur)

Kontrol betiği `backend`'de henüz yok; dalın sabit commit'inden alınır (betik 4.2.9 şemasıyla da çalışır):

```sh
C=82001f555013c03df590c75e03add168a8e28f72
curl -fsSL "https://raw.githubusercontent.com/erhan1977tr-lang/Takip/$C/deploy/canliya-gecis/teklif-revizyon-kontrol.sql" -o /root/teklif-revizyon-kontrol.sql
```

| # | Komut | Beklenen | Değilse |
|---|---|---|---|
| K1 | `takip durum` | Sürüm 4.2.9, dal `backend`, son yayın başarısız değil, servisler çalışıyor | Dur, incele |
| K2 | `takip surum-durum` | Son sağlıklı sürüm 4.2.9 kaydı var | Dur (önce `takip surum-dogrula`) |
| K3 | `takip yedek-kontrol durum` | Sorun kodu yok; son yerel + Google Drive yedeği < 26 saat | Dur: `takip yedek`, sonra yeniden |
| K4 | `df -h /opt/takip /var/lib/docker` | Birkaç GB boş | `takip cache temizle` |
| K5 | `ro < /root/teklif-revizyon-kontrol.sql \| tee /root/teklif-revizyon-once-$(date +%F-%H%M).txt` | 2–3: açık revizyonlar (ALE81 `TASLAK_YOK`); 4: ALE81 satırında mali kilit sütunları 0 | 4'te kilit varsa ALE81 için "Revizyon taslağını aç" `PRICE_LOCKED` ile reddedilir — ürün sahibine gösterilir |

**GO:** K1–K4 tamam. K5 çıktısı saklanır (geçiş sonrası karşılaştırma).

## Aşama 1 — yayın (✎ onay gerekir)

1. ✎ `takip yedek` — tam yedek; ardından `takip yedek-kontrol durum` temiz.
2. ✎ GitHub'da `claude/teklif-revizyon` → `backend` PR, **"Create a merge commit"** (squash / rebase YOK — karar 289).
3. Kapılar: birleştirme commit'inin KENDİ `backend` koşuları — CI, Sunucu kurulumu (deploy/** değişti), Demo ortamı —
   yeşil olmalı. Biri kırmızıysa yayın olmaz; canlı 4.2.9 çalışmaya devam eder.
4. Yayın (otomatik): derleme → otomatik veritabanı yedeği → migration → sağlık denetimi. Uygulama ≈ 1 dakika yeniden
   başlar — yükleme / fatura işlemleriyle çakışmayan bir saat seçin.

## Yayın sonrası (salt okunur)

| # | Komut / ekran | Beklenen |
|---|---|---|
| S1 | `takip durum`, `takip surum-durum` | Sürüm 4.2.10, sağlıklı kayıt yazıldı |
| S2 | `ro < /opt/takip/src/deploy/canliya-gecis/teklif-revizyon-kontrol.sql` | K5 ile aynı siparişler ve aşamalar (migration satır değiştirmez) |
| S3 | Satış hesabıyla Teklifler | Başta "Müşteri Revizyon Bekleyen Teklifler"; ALE81 "Taslak açılmadı"; menüde "Teklifler" sayacı |
| S4 | Yönetici → Ayarlar → Müşteri üretim onayı | Ayar yayından önceki gibi (geçiş ayarı değiştirmez) |

S3'te hiçbir düğmeye basılmaz: sayfayı açmak veri yazmaz, çeviri yapmaz.

## ALE81

- Yayın ALE81'in talep kaydını, sürümlerini, onay / yükleme engeli durumunu değiştirmez (onaysız yükleme engeli sürer).
- İş akışı: satış (ya da yönetici) siparişi açar → "Revizyon taslağını aç" (tek seferlik; talep kaydı değişmez; çift tıklamada
  tek taslak; denetim kaydı). Bu işlem müşteriye bildirim göndermez. Not çevirisi açıksa talep notu bu sırada **bir kez**
  Türkçeye çevrilir (Google'a tek çağrı). Ardından olağan akış: düzelt → "Yönetici Onayına Gönder" → yönetici gönderir →
  müşteri yeni sürümü onaylar.
- Bu adım gerçek iş işlemidir (ürün sahibinin / satışın kararı); geçişin parçası değildir, betikle yapılmaz.

## Sorun olursa

- Kapılar kırmızı / derleme hatası: yayın olmaz, 4.2.9 sürer. Düzeltme yeni commit'le.
- Migration'dan önce durursa: otomatik geri dönüş önceki imaja döner.
- Migration'dan sonra: veritabanı geri yüklenmez (ayrı onay gerekir); düzeltme ileri yapılır.
