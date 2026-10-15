# TAKİP Telegram asistanı (3.84.0, karar 278; 3.85.0, karar 280)

Türkçe ve Romence yazılı / sesli soruları gerçek TAKİP verisiyle yanıtlayan, **salt okunur** Telegram botu. Yazılı soruya
yalnızca yazılı; sesli soruya yazılı (tam ayrıntı) + sesli (kısa özet, `gpt-4o-mini-tts`, ses `coral`) yanıt verir. Yanıt
sorunun dilindedir; Türkçede "sahip" diye hitap eder ve "Başka bir emrin olur mu, sahip?" ile biter (Romence: "stăpâne",
"Mai ai vreo poruncă, stăpâne?"). İşçi süreci (`worker`)
çalıştırır; sunucuda yeni port / webhook / gelen bağlantı yoktur (Telegram'a ve yapay zekâ API'sine yalnızca giden istek).

## Güvenlik

- Yalnızca `TELEGRAM_ALLOWED_USER_ID` kullanıcısının botla **özel** sohbetteki iletileri yanıtlanır; başka herkes ve
  gruplar yanıtsız kalır.
- Model veritabanına erişemez, SQL yazamaz: yalnızca `server/assistant/tools.js` araçlarını doğrulanmış parametrelerle
  çağırır; her araç PostgreSQL `READ ONLY` işleminde çalışır (yazma veritabanında reddedilir). Veri değiştirme, belge /
  fatura, FGO, e-posta, bildirim yok. Asistan veritabanına kayıt bile yazmaz.
- Sınırlar: dakikada 8, günde 300 soru; soru başına en çok 4 model turu ve 8 araç çağrısı; metin 1000 karakter, ses 2 dakika.
- Jeton ve anahtar yalnızca sunucudaki `/opt/takip/.env` dosyasında. Günlüğe yalnızca durum kodları yazılır (soru, yanıt,
  kullanıcı kimliği, jeton, anahtar yazılmaz).

## Kurulum (bir kez)

1. **Bot jetonu:** Telegram'da `@BotFather` → `/newbot` → ad ve kullanıcı adı → verilen jetonu kopyalayın.
2. **Kullanıcı kimliğiniz:** Telegram'da `@userinfobot`'a herhangi bir ileti gönderin → "Id" satırındaki sayı.
3. **Yapay zekâ anahtarı:** platform.openai.com → API keys → yeni anahtar. Aynı yerde aylık harcama sınırı koyun.
4. **Sunucuya yazın** (SSH; değerler ekrana / geçmişe / git'e gitmesin diye düzenleyiciyle):

   ```
   sudo nano /opt/takip/.env
   ```

   Dosyanın sonuna üç satır ekleyin, kaydedin (Ctrl+O, Enter, Ctrl+X):

   ```
   TELEGRAM_BOT_TOKEN=<jeton>
   TELEGRAM_ALLOWED_USER_ID=<kimlik>
   OPENAI_API_KEY=<anahtar>
   ```

   Ardından izinleri doğrulayın: `sudo chmod 600 /opt/takip/.env`.
5. Bir sonraki yayın işçiyi yeni ayarlarla başlatır. Yayından SONRA eklediyseniz / değiştirdiyseniz işçiyi yeniden oluşturun:
   `sudo docker compose -p takip --env-file /opt/takip/.env -f /opt/takip/src/deploy/docker-compose.yml up -d worker`.
   Durum: `sudo docker compose -p takip --env-file /opt/takip/.env -f /opt/takip/src/deploy/docker-compose.yml logs --tail=50 worker | grep asistan`
   → `asistan: açık` görünmeli.
6. Telegram'da bota `/yardim` yazın.

Değerlerden biri eksik ya da biçimi yanlışsa bot **kapalı** kalır (uygulama ve işçi çalışmaya devam eder); işçi günlüğünde
yalnızca neden kodu görünür: `asistan kapalı: BAD_TOKEN | BAD_USER_ID | BAD_API_KEY`.

İsteğe bağlı: `ASSISTANT_MODEL` (varsayılan `gpt-4.1-mini`), `ASSISTANT_STT_MODEL` (varsayılan `gpt-4o-mini-transcribe`),
`ASSISTANT_TTS_MODEL` (varsayılan `gpt-4o-mini-tts`), `ASSISTANT_TTS_VOICE` (varsayılan `coral`). Ses üretilemezse yazılı
yanıt yine gider (işçi günlüğünde `asistan: ses yanıtı <kod>`).

## Araçlar

`genel_ozet`, `siparis_ara`, `siparis_detay`, `siparis_camlari` (cam türü, ölçü, adet, satır / toplam m² — ticari ve bedelsiz
telafi ayrı), `yukleme_durumu` (siparişin yüklenen / planlanan / planlanmamış kalan miktarı), `yukleme_gunu` (günün onaylı ya
da planlanan miktarı, sandık sayısı), `sandiklar` (sandık no, içerik, misafir yük; her sandık bir kez), `musteri_bilgi`,
`yukleme_plani`, `stok_durumu`, `alacaklar`, `fatura_belgeleri`, `faturalanmamis_yuklemeler`, `tedarikci_hesaplari`.
Metraj ve yükleme miktarları TAKİP'in kendi kurallarıyla (m² 3 ondalık). Sipariş numarası "ALE40", "ale 40", "ALE-40"
biçimlerinde aranır; sonuç "bulunamadı" (benzerleri / kaldırılmış) ile "veri eksik" (ör. teklif tablosu yok) ayrıdır. Yeni araç: aynı dosyaya, alan şemasıyla ve yalnızca
okuma yöntemleriyle (`test/assistant.test.js` yapı testi).
