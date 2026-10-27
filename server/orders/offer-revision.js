// Müşteri teklif revizyonu (4.2.10, karar 306 — ürün sahibinin 27.10.2026 kararları). Saf kurallar: bağımlılık yok, tarayıcıda da
// çalışır.
//
// Akış mevcut teklif mekanizmasıdır: MÜŞTERİ "Ölçülerde değişiklik var" (request_offer_change, açıklama zorunlu) → gönderilmiş
// sürümün satırlarından taslak açılır → SATIŞ düzeltir, "Yönetici Onayına Gönder" (submit_offer) → YÖNETİCİ onaylayıp müşteriye
// gönderir (approve_offer — yeni sürüm, kapsamdaki siparişte 4.2.9 kuralıyla yeni üretim onayı talebi) ya da satışa geri gönderir
// (return_offer). Müşteri yeniden değişiklik isterse aynı döngü; eski sürümler, notlar, onaylar ve denetim kayıtları kalır.
//
// Açık müşteri revizyonu VERİDEN türetilir (yeni durum alanı yok): siparişin müşteriye gönderilmiş SON sürümünde müşteri değişiklik
// istedi (changeRequestedAt) ve o sürümden sonra henüz yeni sürüm gönderilmedi. Yalnızca müşteri üretim onayı kapsamındaki
// (bayraklı) cam siparişinde — talep zaten yalnızca orada yapılabilir.
//   NO_DRAFT  talep var, taslak yok (4.2.10 öncesinde URETIMDE siparişte alınmış talep — ör. ALE81; "Revizyon taslağını aç")
//   SALES     taslak satışta (HAZIRLANIYOR) — satışın "Müşteri Revizyon Bekleyen Teklifler" listesinde ve menü sayacında
//   ADMIN     taslak yönetici onayında (YONETIMDE)

/** @typedef {{ id?: string, status: string, changeRequestedAt?: Date | string | null, createdAt?: Date | string }} RevOffer */

/** Açık revizyonun aşamaları */
export const REVISION_STAGES = Object.freeze(['NO_DRAFT', 'SALES', 'ADMIN']);

/**
 * Siparişin açık müşteri revizyonu (yoksa null).
 * @param {{ productionApprovalRequired?: boolean | null, orderTypeCode?: string | null, offers?: RevOffer[] }} order
 *   offers: EN YENİDEN eskiye (siparişin bütün sürümleri ya da en azından son gönderilmiş sürüme kadar olanlar)
 *   version: talepli gönderilmiş sürümün numarası (siparişin sürümleri eskiden yeniye 1, 2, 3 … — offers bütün sürümlerse)
 * @returns {{ stage: 'NO_DRAFT' | 'SALES' | 'ADMIN', sent: RevOffer, draft: RevOffer | null, version: number } | null}
 */
export function customerRevision(order) {
  if (!order?.productionApprovalRequired || order.orderTypeCode === 'PROFILE_ORDER') return null;
  const offers = Array.isArray(order.offers) ? order.offers : [];
  const at = offers.findIndex((o) => o?.status === 'GONDERILDI');
  if (at < 0) return null;
  const sent = offers[at];
  if (!sent.changeRequestedAt) return null;
  const version = offers.length - at;
  if (at === 0) return { stage: 'NO_DRAFT', sent, draft: null, version };
  // Gönderilmiş sürümden sonra açılan sürüm (en yenisi) — yalnızca satışta / yöneticide olabilir; başka bir durum kural dışıdır
  const draft = offers[0];
  if (draft.status === 'HAZIRLANIYOR') return { stage: 'SALES', sent, draft, version };
  if (draft.status === 'YONETIMDE') return { stage: 'ADMIN', sent, draft, version };
  return null;
}

/** availableActions için aşama (yoksa null) */
export const revisionStage = (order) => customerRevision(order)?.stage ?? null;

/**
 * Satışın "Müşteri Revizyon Bekleyen Teklifler" listesine giren sipariş mi: açık revizyonun taslağı satışta (yöneticiden geri
 * gönderilen dahil) ya da talebin henüz taslağı yok (eski talep — taslak açılması bekleniyor). Kapanmış / iptal sipariş girmez.
 * @param {{ status: string, productionApprovalRequired?: boolean | null, orderTypeCode?: string | null, offers?: RevOffer[] }} order
 */
export function awaitingSalesRevision(order) {
  if (!['HAZIRLANIYOR', 'URETIMDE'].includes(order?.status)) return false;
  const stage = revisionStage(order);
  return stage === 'SALES' || stage === 'NO_DRAFT';
}

/**
 * Menü sayacının ve listenin sorgu koşulu (Prisma where; çağıran kullanıcının kapsamını — orderScope — ekler). Veritabanı ön
 * süzgeci: kapsamdaki, hazırlanan / üretimdeki cam siparişi ve değişiklik istenmiş gönderilmiş bir sürümü var. Kesin karar
 * awaitingSalesRevision ile verilir (son gönderilmiş sürümün talepli olması, taslağın aşaması).
 */
export const revisionCandidateWhere = () => ({
  orderTypeCode: 'GLASS_ORDER',
  productionApprovalRequired: true,
  status: { in: ['HAZIRLANIYOR', 'URETIMDE'] },
  offers: { some: { status: 'GONDERILDI', changeRequestedAt: { not: null } } },
});

/** Ön süzgeçten geçen siparişler için gereken teklif alanları (en yeniden eskiye) */
export const REVISION_OFFER_SELECT = Object.freeze({ id: true, status: true, changeRequestedAt: true, createdAt: true });
