# ADR 0015 — Son sağlıklı sürüm kaydı, yayın sağlığı ve güvenli geri dönüş

Durum: kabul (3.92.0, 16.10.2026, karar 287)

## Bağlam

Otomatik yayın (ADR 0012) yalnızca uygulama kapsayıcısının sağlığına ve Caddy üzerinden `/surum`'a bakıyordu; açılmayan
sürümde migration uygulanmış olsa bile önceki imaja dönüyordu (eski kod yeni şemayla). İşçinin çalışıp çalışmadığı,
`/surum`'daki sürüm numarası ve uygulamanın veritabanını okuyabildiği denetlenmiyordu. "Son sağlıklı sürüm" kalıcı olarak
kaydedilmiyordu; imaj temizliği yalnızca yayındaki ve bir önceki etiketi tutuyordu.

## Karar

1. **Kayıt** (`/opt/takip/state/releases`): tam sağlık denetiminden geçen her sürüm için sürüm, tam SHA, imaj etiketi,
   uygulama + araç imaj kimliği, zamanlar, veritabanının kendi migration listesi (ad + checksum) ve kaynak. Geçici dosyadan
   taşınarak yazılır; başarısız yayın yazmaz. Göstergeler: son sağlıklı + aday. İmaj temizliği göstergeleri korur.
2. **Uyumluluk kanıtı = veritabanının kendi kaydı.** Geri dönüş yalnızca veritabanındaki uygulanmış migration listesi hedefin
   doğrulandığı andakiyle birebir aynıysa güvenlidir. Ek SQL çözümlemesi ("yalnızca tablo ekleyen migration uyumludur")
   bilerek yapılmadı: kanıt değil tahmin olurdu. Sonuç: migration içeren her yayından sonra otomatik / elle geri dönüş
   reddedilir; bu yayınlarda çözüm düzeltme sürümüdür.
3. **Yoklama:** hedef (ya da yeni) sürümün araç imajındaki Prisma istemcisi bütün modelleri bir READ ONLY işlemde okur.
   Betik araca gömülüdür (eski imajlarda da çalışır); yeni HTTP uç noktası açılmadı.
4. **Kip:** varsayılan `gozlem` — yayın sonrası sağlık sorunu algılanır, kaydedilir, geri dönüş değerlendirilir, e-posta
   gider; canlı servis değiştirilmez. `otomatik` yalnızca sahibin açık onayıyla (`takip rollback-modu otomatik`).
   Yayın SIRASINDA açılmayan sürümde önceki imaja dönüş (karar 142'nin davranışı) korunur, ama yalnızca migration
   uygulanmadıysa.
5. **Kapı:** CI + kurulum testi (karar 276) + demo testi (yolları değiştiyse; CI'nin kendi commit'i yeni koşu gerektirmez);
   derlenen kaynak ve imajdaki `GIT_SHA` onaylanan commit olmalı.
6. **Kesinti:** `release-op` işareti; yarıda kalan yayın olağan akışla yeniden denenir, yarıda kalan geri dönüş aynı
   denetimlerle tamamlanır; e-posta.
7. **Alarm:** yedek alarmının altyapısı (sabit metin, bilinen kodlar, alıcılar); gizli değer yok.

## Sonuçlar

- Veritabanı hiçbir otomatik süreçte yedeğe dönmez; migration geri alınmaz.
- 3.92.0'ın ilk yayını aracın önceki sürümüyle yapılır (araç yayın sırasında önceki kopyasından çalışır); 3.92.0'ın kaydı
  ilk boşta denetimde ("bootstrap") yazılır. 3.92.0'dan önceki sürüme (3.91.1) kayıtlı geri dönüş adayı yoktur; aday,
  3.92.0'dan sonraki ilk yayınla oluşur.
- Yeni sürümün yazdığı verinin (ör. yeni bir durum değeri, JSON alanı) eski kodca yorumlanması şemadan bağımsızdır ve
  kanıtlanamaz — geri dönüş kararı verilirken yönetici bunu değerlendirir (geri-donus.md).
