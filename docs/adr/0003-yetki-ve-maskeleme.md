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

## Doğrulama
`e2e/demo.spec.ts` içindeki sızıntı testi: satış ve çizim hesaplarıyla erişebildikleri her sayfanın ham yanıtında
(HTML + RSC verisi) hiçbir müşteri firmasının tam adı geçmemeli.
