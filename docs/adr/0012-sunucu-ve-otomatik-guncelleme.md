# 0012 — Sunucu kurulumu ve otomatik güncelleme

**Durum:** Kabul · 29.09.2026

## Bağlam
Ürün sahibi uygulamanın Contabo sunucusunda çalışmasını ve geliştirme sürdükçe güncellemelerin siteye kendiliğinden
yansımasını istedi. Ortam: **gerçek kullanım** (örnek veri yok), adres: sunucunun IP'sinden `*.sslip.io` (HTTPS).

## Karar
- **Tek sunucu, Docker Compose:** PostgreSQL + uygulama + Caddy (Let's Encrypt). Veritabanı dışarıya açık değil.
- **Çekme (pull) usulü yayın:** sunucu 2 dakikada bir GitHub'daki dalı kontrol eder; GitHub'a sunucu için hiçbir
  gizli anahtar (SSH, token) konmaz, sunucuya dışarıdan erişim gerekmez. Depo herkese açık olduğu için okuma serbest.
- **CI kapısı:** yalnızca `build-test` işi başarılı olan commit yayınlanır. CI'nin GITHUB_TOKEN ile yazdığı commit'ler
  yeni CI başlatmadığı için, "CI:" ile başlayan bot commit'lerinde üst commit'in sonucu kullanılır (içerik o koşuda
  üretilip test edildi).
- **İmaj sunucuda derlenir** (`takip:<commit>`, `takip:<commit>-tools`); dış kayıt defteri ve kimlik bilgisi gerekmez.
  Son iki sürümün imajı tutulur.
- **Güvenli sıra:** derleme → veritabanı yedeği → migration → başlatma → sağlık kontrolü. Başarısızlıkta önceki sürüm
  kalır ya da geri dönülür; aynı commit bir daha denenmez. Migration'lar geri alınamaz; geri dönüş gerekirse yedekten
  (`/opt/takip/backups`) elle yapılır.
- **Gizli anahtarlar** (AUTH_SECRET, POSTGRES_PASSWORD) kurulumda sunucuda üretilir; SMTP şifresi `takip smtp` ile
  yalnızca sunucuya yazılır. Hiçbiri git'e, CI'ye ya da sohbete girmez.
- Kurulum ve güncelleme betikleri her değişiklikte temiz bir Ubuntu makinede CI ile denenir
  (`.github/workflows/deploy-test.yml`).

## Sonuçlar
- `backend` dalı doğrudan canlıya gider. Gerçek müşteri kullanımı başladığında izlenen dal `main` yapılabilir
  (`takip dal main`); o zaman canlıya çıkış, `main`'e birleştirme ile olur.
- Derleme sunucuda 2–5 dakika sürer; yayın sırasında birkaç saniyelik kesinti olur.
- Yedekler aynı sunucuda; sunucu dışı yedek Aşama 10'da.
