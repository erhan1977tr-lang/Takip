# 0005 — Denetim kaydı yalnızca eklenir

**Durum:** Kabul · 29.09.2026

## Karar
- `AuditLog` satırları hiçbir koşulda güncellenmez ya da silinmez. Bu, uygulama kodundan bağımsız olarak veritabanında
  tetikleyiciyle zorlanır: `UPDATE`, `DELETE` ve `TRUNCATE` hata verir.
- Tek istisna bakım anahtarı: aynı oturumda `SET takip.audit_maintenance = 'on'` yapılırsa tetikleyici izin verir.
  Yalnızca test veritabanını temizlemek ve yasal zorunlu silme için kullanılır; uygulama kodu kullanmaz.
- Kullanıcılar silinmez, pasifleştirilir. (Kullanıcı satırı silinmeye çalışılırsa denetim kaydındaki bağlantı
  boşaltılamayacağı için silme de başarısız olur — bu istenen davranıştır.)
- Kaydedilecekler (tanım §22): giriş/güvenlik olayları, iş akışı geçişleri, çizim onay/revizyon, teklif gönderme/geri alma,
  fiyat işlemleri, gerekli yerlerde dosya erişimi, yönetici ayar değişiklikleri, müşteri adına işlem.
- Arayüzde denetim kaydı için düzenle/sil düğmesi olmaz.

## Sonraki aşamalar
Aşama 2: kullanıcının rolü, IP ve (güvenli olduğu yerde) önce/sonra verisi alanları; onaya bağlı kayıtlar için özet (checksum).
