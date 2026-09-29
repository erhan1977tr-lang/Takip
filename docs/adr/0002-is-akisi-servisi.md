# 0002 — İş akışı geçişleri tek domain servisinde

**Durum:** Uygulandı (3.5.0) · 29.09.2026

## Bağlam
Bugün durum değişiklikleri birkaç server action içinde `tx.order.update(...)` ile yapılıyor. Tanım,
geçişlerin tek yerde doğrulanmasını, geçmiş + denetim + bildirim kaydıyla birlikte yazılmasını ister.

## Karar
`server/domain/` altında iki parça:

1. **`workflow.js` — saf akış tanımı.** Her sipariş tipi için durumlar ve eylemler tanımlanır:
   `{ from: [...durumlar], to, roles: [...], orderTypes?, guard?(ctx) }`. `workflow.check(state, action, actor, ctx)`
   geçişin geçerli olup olmadığını ve nedenini (kod olarak) döner. Veritabanına dokunmaz; birim testle doğrulanır.
2. **`transition.js` — `transitionOrder()`.** Sırasıyla: siparişi ve kullanıcıyı yükle → eylemi doğrula →
   gerekli veriyi doğrula → tek veritabanı işleminde durumu güncelle → durum geçmişi ekle → denetim kaydı ekle →
   bildirimi outbox'a yaz → role göre temizlenmiş sonucu döndür. Kalıcılık adımları (geçmiş, denetim, outbox)
   dışarıdan verilir; böylece servis veritabanı olmadan da test edilebilir.

Eşzamanlı düzenleme için sipariş satırında `version` alanıyla iyimser kilit (optimistic lock) kullanılacak (Aşama 2).

## Sonuçlar
- Aşama 0'da iskelet ve testleri eklenir; mevcut server action'lar Aşama 2'den itibaren bu servise taşınır.
- Durum sütununu doğrudan güncelleyen kod incelemede reddedilir.

## Uygulama notları (3.5.0)
- Cam siparişinin 21 işlemi `server/orders/transitions.js` → `runOrderAction` üzerinden: akış kontrolü mevcut
  kurallarla (`availableActions`), değişiklik + `OrderEvent` (önceki/sonraki durum) + `AuditLog` (rol, IP) +
  `NotificationOutbox` tek veritabanı işleminde. Otomatik üretime geçiş aynı işlemde ayrı bir geçmiş kaydıdır.
- İyimser kilit: her işlem `Order.version`'ı artırır (satır kilidi); aynı anda gelen ikinci işlem `CONFLICT` alır.
  Teklif düzenleyicisi sayfanın sürümünü gönderir; çizim onayı/revizyonu ekrandaki çizim sürümünü (`drawingId`) gönderir,
  bu arada yeni sürüm yüklendiyse `STALE_DRAWING`.
- Sipariş oluşturma `server/orders/create.js` (firma bazlı `pg_advisory_xact_lock`, numara kuralı: karar 5).
- Notlar ve dosya ekleme durum değişikliği değildir; yetki kontrolüyle doğrudan yazılır (dosya eklemek denetime girer).
