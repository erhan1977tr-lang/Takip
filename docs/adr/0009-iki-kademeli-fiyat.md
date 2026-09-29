# 0009 — İki kademeli fiyat: satış fiyatı ve yönetim kopyası

**Durum:** Kabul (uygulama Aşama 5) · 29.09.2026

## Bağlam
Satış teklifi hazırlar ama müşteriye gönderemez; yönetici fiyatlandırır ve gönderir. Ürün sahibi iki ayrı fiyatın
tutulmasını istedi (karar 4).

## Karar
- Satış teklif sürümü oluşturur ve kendi fiyatlarını girer: **satış fiyatı / satış tutarı**.
- Yönetici bu sürümden **yönetim kopyası** açar (yeni sürüm, ör. "v2 — yönetim kopyası"). Kopya satış fiyatlarını
  salt okunur taşır ve yöneticinin **teklif fiyatı / teklif tutarı** sütunlarını ekler.
- Müşteriye yalnızca yönetim kopyası ve yalnızca teklif fiyatları gider. Müşteri satış fiyatını hiç görmez.
- Teklif (yönetici) fiyatlarını yönetici dışında hiçbir iç kullanıcı görmez; satış ve çizim yanıtlarında bu alanlar
  sunucuda çıkarılır (maskeleme ile aynı ilke, ADR 0003).
- Yönetici ekranları (teklif, yükleme) iki tutarı ayrı sütunlarda gösterir: satış tutarı ve teklif tutarı.
- Gönderilen her sürüm değişmez bir anlık görüntüdür; sonradan düzeltme yeni sürümle yapılır.
- Teklif belgesi alanları: firma adı, proje adı, cam etiketi, sandık etiketi, termin süresi; çıktılar PDF, Excel,
  WhatsApp metni ve "müşteriye Excel" (yalnızca teklif fiyatları).

## Açık konu
KDV varsayılanı (dahil/hariç) — Aşama 5'ten önce sorulacak.
