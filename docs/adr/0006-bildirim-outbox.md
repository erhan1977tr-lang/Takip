# 0006 — Bildirimler için outbox

**Durum:** Kabul · 29.09.2026

## Karar
- E-posta ve diğer dış gönderimler sipariş işleminin içinde yapılmaz. Geçiş aynı veritabanı işleminde
  `notification_outbox` tablosuna bir satır yazar; ayrı bir çalışan (worker) satırları okuyup gönderir,
  başarısız olursa artan aralıklarla yeniden dener ve sonucu satıra yazar.
- Müşterinin bildirim tercihleri gönderim anında uygulanır.
- Aşama 0'da yalnızca arayüz (`server/domain/outbox.js`: `enqueue(tx, event)`) ve testi vardır; tablo ve çalışan Aşama 8'de.
