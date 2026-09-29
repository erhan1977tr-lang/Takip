# 0003 — Yetki ve müşteri adı maskeleme sunucuda

**Durum:** Kabul · 29.09.2026

## Karar
- Roller: Yönetici (`ADMIN`), Müşteri (`MUSTERI`), Satış (`SATIS`), Çizim (`CIZIM`), Denetimci (`DENETIMCI`, Aşama 1'de eklenir).
- Yetki her zaman sunucuda kontrol edilir: sayfa, server action, dosya indirme. Düğmeyi gizlemek yetki değildir.
- Kaynak düzeyinde kapsam: müşteri yalnızca kendi firmasının siparişlerini, çizim ekibi yalnızca çizimli siparişleri görür
  (`lib/orders.ts → orderScope`). Profil siparişleri satış ve çizim kapsamına hiç girmez (Aşama 6).
- **Denetimci ilk sürümde yalnızca okur** (karar 8). Yetkileri açıkça tanımlanır, yönetici ya da satıştan türetilmez.
  Tam firma adını görür (tanım §4).
- **Maskeleme:** satış ve çizim ekibi firma adının ilk 3 karakterini ve ardından sabit 10 yıldız görür
  (`GLA**********`, karar 7). Maskeleme sunucuda, veri istemciye gitmeden yapılır. Tam ad HTML'e, RSC yüküne
  ya da istemci bileşen özelliklerine hiç girmez.
- Yönetici fiyatı (ADR 0009) aynı kuralla korunur: yönetici dışındaki iç kullanıcılara hiç gönderilmez.

## Uygulama (Aşama 1, 3.3.0)
- **Yetki matrisi** `server/auth/permissions.js` (tek kaynak; `test/permissions.test.js` tam matrisi sabitler).
  Sayfa ve server action'lar `requirePermission('...')` çağırır; iş akışı eylemleri `availableActions` içinde yine
  yetkilere göre hesaplanır. Rol adıyla erişim kontrolü yapılmaz (rol adı yalnızca görünüm farkları için).
- **Veri temizleme** `lib/orders.ts`: `loadOrder` → `sanitizeOrder`, listeler → `sanitizeRows`. Rolün göremediği
  veri veritabanından geldiği anda çıkarılır: maskeli firma adı ve boş iletişim alanları (satış, çizim), iç notlar ve
  iç dosyalar (müşteri), gönderilmemiş teklifler (müşteri, denetimci), teklif satırları ve tutarları (çizim; durum kalır),
  yönetici fiyatı (satış, çizim).
- **Dosyalar** `/dosya/...`: sipariş kapsamı + iç dosya yetkisi; kapsam dışı dosya 404.
- Denetimci: `ORDER_VIEW, OFFER_VIEW, PRICE_FINAL_VIEW, SHIPMENT_VIEW, FILE_INTERNAL_VIEW, NOTE_INTERNAL_VIEW,
  CUSTOMER_NAME_VIEW` — hepsi okuma yetkisi (birim test bunu denetler).

## Doğrulama
`e2e/demo.spec.ts` içindeki sızıntı testi: satış ve çizim hesaplarıyla erişebildikleri her sayfanın ham yanıtında
(HTML + RSC verisi) hiçbir müşteri firmasının tam adı ya da iletişim bilgisi geçmemeli (`e2e/demo.spec.ts`, `e2e/05-yetki.spec.ts`).
Ayrıca: denetimcinin sayfalarında işlem formu olmaması, müşterinin iç notu hiçbir yanıtta görmemesi, müşterinin başka
firmanın ya da iç ekibin dosyasını adresini bilse de indirememesi.
