// Cam siparişi FGO belgeleri (proforma → avans faturası → kapanış faturası). Profil akışından ayrıdır ve müşteri onayı
// yoktur; sipariş durumu değişmez. Yönetici sipariş sayfasındaki düğmelerle ister; belgeyi işçi keser (FGO isteği
// veritabanı işleminin dışında), kesilen belge FgoDocument'e yazılır (Muhasebe → Cam Tahsilat ile aynı kayıt) ve aynı
// işlemde müşteri e-postası kuyruğa girer (server/documents/delivery.js — e-postayı yalnızca TAKİP gönderir, karar 111).
//
// Kararlar (ürün sahibi, 01.10.2026):
//   - Proforma ödendi = FGO'da proformaya tahsilat görünür ya da yönetici ödemeyi elle kaydetti (Paket 10, karar 206 —
//     karar 104'ün "yönetici tutar giremez" kısmının yerine; eski "Ödeme alındı" GlassBilling.paidAmount okunmaz).
//   - Avans faturası = max(FGO'nun proformada gösterdiği tahsilat, elle kayıtların RON toplamı) − daha önce avansı kesilen
//     tutar (TVA dahil; server/finance/payments.js → paymentState), tek satır "Avans marfă conform proformă …". Aynı ödeme
//     hem elle kaydedilip hem FGO'da görünse de bir kez sayılır. Aynı müşteride aynı tutarlı avans varsa yönetici açıkça
//     onaylamadan istenmez (karar 208). Yüklemeden önce de sonra da kesilebilir; sonradan gelen her tahsilat için yeni bir
//     avans faturası (seq 1, 2, …). Avansı kesilmemiş tahsilat varken kapanış faturası KESİLMEZ.
//   - Belge kesme sonucu belirsiz kalırsa (zaman aşımı, 5xx …) iş körlemesine yeniden denenmez: yönetici FGO'ya bakıp
//     karar verir (server/finance/uncertain.js, karar 209).
//   - Nihai (kapanış) fatura SİPARİŞ DÜZEYİNDE KESİLMEZ (P1, karar 239 — eski "yükleme günü + 2 gün" kuralının ve sipariş
//     sayfasındaki "Fatura Gönder" düğmesinin yerine): nihai fatura yalnızca onaylı yüklemeden, yükleme gününün Faturalama
//     kartında kesilir (server/glass/invoice-batch.js) — yalnızca o onayda YÜKLENEN ve henüz faturalanmamış miktar; kısmi
//     yüklemede kısmi fatura; ödeme şartı yok. Siparişin kendi proforması varsa o fatura siparişin zincirindedir (kur =
//     proformanın kuru, avans faturaları "Stornare avans" eksi satırıyla düşülür). Eski sipariş düzeyi fatura belgeleri
//     (FgoDocument INVOICE) okunur, yenisi istenemez; kuyrukta kalmış eski bir istek FGO'ya gitmeden reddedilir.
//   - Kur: müşterinin kur politikası (server/fx/resolve.js); proformada çözülür ve saklanır, avans ve kapanış faturası
//     proformanın kuruyla; proforma yoksa fatura kesilirken çözülür.
//   - Günlük belge sınırı (deneme güvenliği) FGO ayarlarında.
import { writeAudit, writeHistory } from '../orders/journal.js';
import { offerLineTotals, pieceStartArea } from '../orders/rules.js';
import { can } from '../auth/permissions.js';
import { ofProforma, paymentState, toCents, centsText } from '../finance/payments.js';
import { advanceRisk, financeLock, linkCoveredPayments, orderProformaRef, recordDuplicateAck } from '../finance/service.js';
import { expectedGross, parkUncertain } from '../finance/uncertain.js';
import { getEnv } from '../env.js';
import { parseManualRate } from '../fx/bt.js';
import { bnrRate } from '../fx/bnr.js';
import { FxUnavailable, fxDocumentText, fxSnapshot, resolveExchangeRate } from '../fx/resolve.js';
import {
  FGO_UM, FgoError, dailyLimitReached, emitereForm, fgoEmit, fgoKey, fgoReady, fgoStatus, getFgoSettings, missingBilling, ronTotal, ronPrice, grossOf, reserveInvoiceNumber, afterInvoiceIssued, orderDetail, uncertainEmit,
} from '../integrations/fgo.js';
import { queueDocEmail } from '../documents/delivery.js';
import { claimFgoJob } from '../integrations/fgo-claim.js';
import { dayDate, localDay, localDayStart } from '../profile/dates.js';
import { glassLabel } from '../catalog/glass.js';

export const GLASS_FGO = 'FGO_GLASS';
// Müşteriye belge e-postası (tek sahibi TAKİP): server/documents/delivery.js. Eski içe aktarmalar için buradan da verilir.
export { DOC_EMAIL, dispatchDocEmails, renderDocEmail } from '../documents/delivery.js';
export const KINDS = ['PROFORMA', 'ADVANCE', 'INVOICE'];
const SUFFIX = { PROFORMA: 'P', ADVANCE: 'A', INVOICE: 'F' };
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Siparişin onaylı yükleme kaydı var mı (herhangi bir onayda — yüklenen ya da yüklenmeyen kalem; düzeltmeler dahil). Tarih
 * değil kayıt (karar 92, 239): onaylı yüklemesi olan siparişe sipariş düzeyi proforma kesilmez; nihai fatura yükleme
 * gününün Faturalama kartındadır. Tahmini yükleme tarihi kilidiyle aynı soru (server/orders/ship-date.js).
 * @param {any} db  @param {string} orderId
 */
export async function hasConfirmedLoading(db, orderId) {
  return (await db.loadingConfirmationItem.count({ where: { orderId } })) > 0;
}

/**
 * Siparişin kendi zincirinden onaylı yüklemeyle nihai fatura istendi / kesildi mi (geçersiz kılınmamış INVOICE partisi,
 * BillingBatch.chainOrderId — karar 239). Varsa proformaya sonradan görünen tahsilat otomatik avans sayılmaz.
 * @param {any} db  @param {string} orderId
 */
export async function hasChainInvoice(db, orderId) {
  return (await db.billingBatch.count({ where: { chainOrderId: orderId, kind: 'INVOICE', status: { not: 'VOID' } } })) > 0;
}

/** Müşteriye gönderilmiş son teklif */
export const sentOffer = (order) => order.offers?.find((o) => o.status === 'GONDERILDI') ?? null;

/**
 * FATURA satırları — yalnızca CAM (ürün sahibinin kuralı; proforma için proformaLines): satır adı yalnızca camın Romence niteliği (ölçü / adet yazılmaz);
 * CNC ve delik (ve m² dışındaki her satır) tutarı ait olduğu camın tutarına eklenir — üstündeki cam satırına, yoksa
 * sonraki cama. Aynı nitelikteki camlar tek satırda toplanır (m² toplamı). Bedelsiz ve fiyatsız satırlar yazılmaz.
 * Her grubun parts'ı: o satırda toplanan teklif satırları ({ qty, price } — cam m², işlem adet), proformadaki satırların aynısı.
 * byPrice (yalnızca yükleme dökümü): aynı cam farklı birim fiyatla yazılmışsa ayrı grup olur (fiyatlar birleştirilip
 * ortalanmaz); eklenen işlemler yine ait olduğu cam satırının grubuna gider. Fatura bu seçeneği kullanmaz.
 * includeFree (yalnızca muhasebede maliyet, karar 89): "bedelsiz" satır da kendi fiyatıyla sayılır — müşteriye bedelsiz
 * verilen camın fabrika maliyeti sıfır değildir. Fatura, proforma ve döküm bu seçeneği kullanmaz (bedelsiz satır yazılmaz).
 * Ayrılmış cam (karar 114): işlem eklemek için adetli satırdan ayrılan cam (pieceBase > 0), aynı fiyatlı önceki satırının
 * devamıysa o satırın parçasına EKLENİR (ayrı parça olmaz) — parçalar ayrılmamış satırınkiyle aynı kalır; RON yuvarlaması
 * dahil hiçbir toplam ayırma yüzünden değişmez. Olağan satırlarda (pieceBase 0) hesap eskisiyle aynıdır.
 * @returns {{ name: string, price: number, qty: number, parts: { qty: number, price: number }[] }[]}
 */
function glassGroups(offer, { nameOf = (l) => l.descriptionRo || l.description, priceOf = (l) => l.offerPrice, byPrice = false, includeFree = false } = {}) {
  const groups = new Map();
  let last = null;
  let carry = []; // camdan önce gelen ek işlemler (sonraki cama eklenir)
  for (const l of offer.lines) {
    if ((l.free && !includeFree) || priceOf(l) == null) continue;
    const price = Number(priceOf(l));
    const isGlass = (l.kind ?? 'CAM') === 'CAM' && (l.unit ?? 'm2') === 'm2';
    if (isGlass) {
      const qty = offerLineTotals({ ...l, unitPrice: 0 }).metraj;
      if (!(qty > 0)) continue;
      const name = String(nameOf(l)).trim();
      const key = byPrice ? `${name}|${price}` : name;
      const g = groups.get(key) ?? { name, price, qty: 0, adet: 0, parts: [] };
      g.qty = Math.round((g.qty + qty) * 1000) / 1000;
      g.adet += Math.max(0, Math.trunc(Number(l.adet) || 0));
      // Ayrılmış camın devamı: aynı fiyatlı, kalemde tam bu m²'de biten önceki parçaya eklenir
      const start = pieceStartArea(l);
      const prev = start > 0 ? g.parts.find((p) => p.end != null && p.price === price && Math.abs(p.end - start) < 0.005) : null;
      if (prev) {
        prev.qty = round2(prev.qty + qty);
        prev.end = round2(prev.end + qty);
        g.parts.push(...carry);
      } else {
        g.parts.push({ qty, price, end: round2(start + qty) }, ...carry);
      }
      carry = [];
      groups.set(key, g);
      last = g;
    } else {
      const qty = Math.max(0, Math.trunc(Number(l.adet) || 0));
      if (!(qty > 0)) continue;
      if (last) last.parts.push({ qty, price });
      else carry.push({ qty, price });
    }
  }
  const out = [...groups.values()];
  if (carry.length && out.length) out[out.length - 1].parts.push(...carry);
  return out;
}

/**
 * Aynı fatura kuralıyla (cam + ona eklenen CNC / delik / diğer kalemler) cam başına toplam — yükleme dökümü (Excel) de
 * bunu kullanır (server/loading/summary.js). nameOf: satırın adı (varsayılan Romence), priceOf: hangi fiyat (varsayılan
 * müşteri fiyatı), byPrice: aynı cam farklı birim fiyatla ayrı satır (price = camın birim fiyatı; byPrice yoksa grubun
 * ilk cam satırının fiyatı). @returns {{ name: string, price: number, adet: number, qty: number, total: number }[]}
 */
export const glassTotals = (offer, opts) => glassGroups(offer, opts).map((g) => ({
  name: g.name, price: g.price, adet: g.adet, qty: g.qty, total: round2(g.parts.reduce((s, p) => s + p.qty * p.price, 0)),
}));

/** Fatura cam satırları, EUR toplamıyla @returns {{ code: string, name: string, unit: 'mp', qty: number, eurTotal: number }[]} */
export const glassLines = (offer) => glassGroups(offer).map((g) => ({
  code: '', name: g.name, unit: FGO_UM.m2, qty: g.qty, eurTotal: round2(g.parts.reduce((s, p) => s + p.qty * p.price, 0)),
}));

/**
 * Fatura cam satırları RON olarak (karar 63): eklenen her kalem proformadaki gibi TVA HARİÇ hesaplanır
 * (adet × round2(EUR × kur)); satırın TVA hariç tutarı bunların toplamı, TVA dahil tutarı proformadaki satırların
 * TVA dahil tutarlarının toplamı. FGO'ya TVA dahil toplam (PretTotal) gider; böylece fatura genel toplamı proformayla
 * kuruşu kuruşuna aynı olur (birim fiyatı yuvarlayıp m² ile çarpınca birkaç bani fark çıkıyordu).
 * @returns {{ code: string, name: string, unit: 'mp', qty: number, net: number, gross: number }[]}
 */
export function invoiceLines(offer, rate, vatRate) {
  return glassGroups(offer).map((g) => {
    let net = 0, gross = 0;
    for (const p of g.parts) {
      const n = round2(p.qty * ronPrice(p.price, rate));
      net = round2(net + n);
      gross = round2(gross + grossOf(n, vatRate));
    }
    // Nihai faturada ürün adı "Sticla …" (Paket C — karar 236): gruplama özgün adla yapılır, yalnızca yazılan ad kısalır
    return { code: '', name: invoiceProductName(g.name), unit: FGO_UM.m2, qty: g.qty, net, gross };
  });
}

/**
 * Nihai faturadaki cam adı (Paket C — karar 236, ürün sahibinin seçimi): Romence ad "Sticlă" ile başlıyorsa "Sticla" + teknik
 * kısım yazılır; hemen ardından gelen "securizată" / "laminată" kelimeleri atılır (kalınlık / tip, PVB, şekil ve renk kalır):
 * "STICLĂ SECURIZATĂ LAMINATĂ 4.2.4., PVB OPAQUE (GRI+GRI)" → "Sticla 4.2.4., PVB OPAQUE (GRI+GRI)". "Sticl…" ile
 * başlamayan ad değişmez. Proforma ve avans faturası etkilenmez; tutarlar, miktar ve gruplama değişmez.
 * @param {unknown} name
 */
export function invoiceProductName(name) {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim();
  const m = /^sticl[ăĂaA](?=[\s,.;:-]|$)/i.exec(s);
  if (!m) return s;
  const rest = s.slice(m[0].length).replace(/^(?:[\s,]*(?:securizat|laminat)[ăĂaA]?(?=[\s,.;:-]|$))+/i, '').replace(/^[\s,]+/, '');
  return rest ? `Sticla ${rest}` : 'Sticla';
}

/**
 * Proforma satırları — ayrıntılı (ürün sahibinin kuralı): her cam satırı ayrı (yalnızca Romence niteliği, ölçü/adet
 * yazılmaz; miktar m²), CNC ve delik ayrı satırlar ("Prelucrare CNC", "Gaură"; adetle), m² dışındaki diğer kalemler adetle.
 * Bedelsiz ve fiyatsız satırlar yazılmaz.
 * Müşteri proforması (server/glass/batch.js) da aynı satırları kullanır.
 * @returns {{ code: string, name: string, unit: string, qty: number, eur: number }[]}
 */
export function proformaLines(offer) {
  const out = [];
  // Ayrılmış cam (karar 114): aynı kalemin devamı olan satır önceki satırına eklenir — proforma, cam ayrılmadan önceki
  // satırlarla aynıdır (ends: cam satırının kalemde bittiği m²)
  const ends = new Map();
  for (const l of offer.lines) {
    if (l.free || l.offerPrice == null) continue;
    const eur = Number(l.offerPrice);
    const isGlass = (l.kind ?? 'CAM') === 'CAM' && (l.unit ?? 'm2') === 'm2';
    const qty = isGlass ? offerLineTotals({ ...l, unitPrice: 0 }).metraj : Math.max(0, Math.trunc(Number(l.adet) || 0));
    if (!(qty > 0)) continue;
    const name = l.kind === 'CNC' ? 'Prelucrare CNC' : l.kind === 'DELIK' ? 'Gaură' : String(l.descriptionRo || l.description).trim();
    const start = isGlass ? pieceStartArea(l) : 0;
    const prev = start > 0 ? out.find((r) => ends.has(r) && r.name === name && r.eur === eur && Math.abs(ends.get(r) - start) < 0.005) : null;
    if (prev) {
      prev.qty = round2(prev.qty + qty);
      ends.set(prev, round2(ends.get(prev) + qty));
      continue;
    }
    const row = { code: '', name, unit: isGlass ? FGO_UM.m2 : FGO_UM.adet, qty, eur };
    if (isGlass) ends.set(row, round2(start + qty));
    out.push(row);
  }
  return out;
}

/**
 * Cam belgesinin (proforma / avans / fatura) FGO açıklaması (Paket C — karar 235): uygulanan kur cümlesi (fxDocumentText —
 * "Curs de vânzare BT: …", "Curs BNR: … (data …)", "Curs de schimb aplicat: …"). RON belgede ya da kur kaydı yoksa boş.
 * @param {string} currency  @param {{ fxRate?: unknown } | null | undefined} snap
 */
export function glassDocText(currency, snap) {
  if (currency !== 'EUR' || !snap || snap.fxRate == null || !(Number(snap.fxRate) > 0)) return '';
  return `${fxDocumentText({ fxCurrency: 'EUR', ...snap })}.`;
}

/** TVA dahil tutar → TVA hariç birim fiyat (avans satırı) */
export const netOf = (gross, vatRate) => round2(Number(gross) / (1 + Number(vatRate) / 100));

const EPS = 0.005;

/**
 * Sipariş başına belge zincirinin avans durumu — tek yerde hesaplanır (müşteri partisindeki chainState'in karşılığı;
 * düğmeler, istek, işçi ve ekran aynı sonucu kullanır). Cam ve profil siparişi aynı kural (karar 207).
 *   paid            : FGO'nun proformada gösterdiği tahsilat (TVA dahil) — "FGO doğrulandı"
 *   manualRon       : yöneticinin elle kaydettiği ödemelerin RON toplamı (geçersiz kılınanlar hariç) — "elle"
 *   advanced        : kesilmiş avans faturalarının karşıladığı tahsilat toplamı (FgoDocument.advanced; eski kayıtta total)
 *   advanceRequired : max(paid, manualRon) − advanced (> 0 ise camda kapanış faturası kesilmez, avans faturası istenir)
 *   basis / match   : avansın dayanağı (FGO / MANUAL / FGO_MANUAL) ve iki kaynağın karşılaştırması
 *   nextSeq         : sıradaki avans faturasının sırası
 * @param {{ kind: string, seq?: number | null, paid?: unknown, total?: unknown, advanced?: unknown }[]} docs
 * @param {{ ron: unknown, voidedAt?: unknown, proformaRef?: string | null }[]} [payments]  siparişin elle kayıtları (yalnızca
 *   geçerli proformaya kaydedilenler sayılır — ofProforma)
 */
export function orderChain(docs, payments = []) {
  const proforma = docs.find((d) => d.kind === 'PROFORMA') ?? null;
  const invoice = docs.find((d) => d.kind === 'INVOICE') ?? null;
  const advances = docs.filter((d) => d.kind === 'ADVANCE').sort((a, b) => (a.seq ?? 1) - (b.seq ?? 1));
  const advancedCents = advances.reduce((s, a) => s + toCents(a.advanced ?? a.total ?? 0), 0n);
  const st = paymentState({ fgoPaid: proforma?.paid ?? 0, proformaTotal: proforma?.total ?? null, payments: ofProforma(payments, proforma), advanced: centsText(advancedCents) });
  return {
    proforma, invoice, advances, paid: st.fgoPaid, manualRon: st.manualRon, advanced: st.advanced, advanceRequired: st.advanceRequired,
    basis: st.advanceBasis, match: st.match, review: st.review, nextSeq: advances.reduce((m, a) => Math.max(m, a.seq ?? 1), 0) + 1,
  };
}

/**
 * Sipariş sayfasının belge düğmeleri (yönetici). docs: siparişin FgoDocument'leri; pending: kuyruktaki belge türleri.
 * inBatch: sipariş etkin bir müşteri PROFORMA partisinde (karar 100) — sipariş başına belge istenemez. (Onaylı yüklemeden
 * kesilen müşteri faturası partisi bunu sayılmaz: siparişin kendi proforma zinciri o faturadan sonra da avans alabilir.)
 * loaded: siparişin onaylı yükleme kaydı var (hasConfirmedLoading) — sipariş düzeyi proforma artık istenemez.
 * Avans (karar 104, 207): proformada avansı kesilmemiş tahsilat varsa — yüklemeden önce de sonra da — "avans faturası".
 * Nihai fatura burada YOKTUR (P1, karar 239): onaylı yüklemeden, yükleme gününün Faturalama kartında kesilir; ödeme şartı
 * yoktur. Avansı kesilmemiş tahsilat varken o fatura da kesilmez (önce avans — invoice-batch ADVANCE_REQUIRED).
 * invoiced: siparişin zincirinden onaylı yüklemeyle kesilmiş (ya da kuyruktaki) nihai fatura var. O zaman proformaya sonradan
 *   görünen tahsilat KENDİLİĞİNDEN avans sayılmaz (faturalanmış malın ödemesi olabilir): avans düğmesi çıkmaz, muhasebe
 *   kararı beklenir (payment_after_invoice) — kural ürün sahibine soruldu; yanlış belge kesilmez.
 *   wait: cancelled | batch | done (eski sipariş düzeyi kapanış faturası var) | pending | no_offer | final_from_loading |
 *         advance_required (onaylı yüklemesi var + avansı kesilmemiş tahsilat: önce avans faturası) | payment_after_invoice
 * @param {{ status: string, loaded: boolean, docs: { kind: string, seq?: number | null, paid?: unknown, total?: unknown, advanced?: unknown }[], pending?: string[], hasOffer: boolean, inBatch?: boolean, payments?: { ron: unknown, voidedAt?: unknown }[] }} p
 * @returns {{ actions: ('proforma' | 'advance')[], wait: string | null, paid: number, manualRon: number, advanced: number, advanceRequired: number, basis: string, match: string }}
 */
export function billingState({ status, loaded, docs, pending = [], hasOffer, inBatch = false, payments = [], invoiced = false }) {
  const c = orderChain(docs, payments);
  const res = (actions, wait = null) => ({ actions, wait, paid: c.paid, manualRon: c.manualRon, advanced: c.advanced, advanceRequired: c.advanceRequired, basis: c.basis, match: c.match });
  if (status === 'IPTAL') return res([], 'cancelled');
  if (inBatch && !c.proforma) return res([], 'batch');
  if (c.invoice) return res([], 'done');
  if (pending.length) return res([], 'pending');
  if (!hasOffer) return res([], 'no_offer');
  // FGO'da / elle kaydedilmiş, avansı kesilmemiş tahsilat: avans faturası (tutar = tahsilat − avansı kesilen; uydurma yok)
  // Nihai fatura kesildikten sonra proformada görünen tahsilat: otomatik avans yok (muhasebe kararı)
  if (c.advanceRequired > 0 && invoiced) return res([], 'payment_after_invoice');
  // Onaylı yüklemesi varsa: avans kesilmeden nihai fatura (yükleme günü Faturalama kartı) da kesilemez — açık uyarı
  if (c.advanceRequired > 0) return res(['advance'], loaded ? 'advance_required' : 'final_from_loading');
  if (!c.proforma) return res(loaded ? [] : ['proforma'], loaded ? 'final_from_loading' : null);
  return res([], 'final_from_loading');
}

/**
 * Belgeyi kuyruğa alır (yönetici). Aynı anda iki istek ya da tekrar kesim engellenir (kilit + durum + benzersiz kayıt).
 * Avans (karar 207–208): tutar = max(FGO tahsilatı, elle kayıtlar) − avansı kesilen; aynı müşteride aynı tutarlı avans /
 * başka siparişte aynı tutarlı elle kayıt varsa DUPLICATE_RISK (eşleşmeler + onay anahtarı) — yönetici gördüğü eşleşmeleri
 * onaylamadan (ack) kuyruğa yazılmaz; onaylanan risk "Önemli kararlar"a düşer.
 * @param {any} db
 * @param {{ orderId: string, kind: string, actor: any, now?: Date, manualRate?: string | number | null, ack?: string | null }} o
 * @returns {Promise<{ ok: true } | { ok: false, code: string, matches?: any[], ackKey?: string }>}
 */
export async function requestGlassDocument(db, { orderId, kind, actor, now = new Date(), manualRate = null, ack = null }) {
  if (!actor || !can(actor.role, 'OFFER_SEND')) return { ok: false, code: 'FORBIDDEN' };
  // Elle kur (isteğe bağlı): yalnızca kurun bu belgeyle belirleneceği durumda anlamlıdır; belgede MANUAL diye saklanır
  const manual = manualRate == null || manualRate === '' ? null : parseManualRate(manualRate);
  if (manualRate != null && manualRate !== '' && manual == null) return { ok: false, code: 'BAD_RATE' };
  const settings = await getFgoSettings(db);
  if (!fgoReady(settings)) return { ok: false, code: 'FGO_DISABLED' };
  const tz = getEnv().APP_TIMEZONE;
  if (await dailyLimitReached(db, settings, localDayStart(now, tz))) return { ok: false, code: 'FGO_DAILY_LIMIT' };
  const head = await db.order.findUnique({ where: { id: String(orderId ?? '') }, select: { customerId: true } });
  if (!head) return { ok: false, code: 'NOT_FOUND' };
  return db.$transaction(async (tx) => {
    // Kilit sırası: müşteri finans kilidi (elle ödeme kaydıyla sıralanır) → sipariş belge kilidi
    await financeLock(tx, head.customerId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`glass-billing:${orderId}`}, 0))`;
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: {
        offers: { orderBy: { createdAt: 'desc' }, select: { id: true, status: true } }, fgoDocuments: true, glassBilling: true,
        // Yalnızca müşteri PROFORMA partisi sipariş başına belgeyi dışlar (onaylı yüklemeden kesilen müşteri faturası değil)
        billingBatchOrders: { where: { activeKey: { not: null }, batch: { kind: 'PROFORMA' } }, select: { id: true } },
        manualPayments: { where: { batchId: null } },
      },
    });
    if (!order || order.orderTypeCode !== 'GLASS_ORDER') return { ok: false, code: 'NOT_FOUND' };
    const pending = await tx.notificationOutbox.findMany({ where: { orderId, type: GLASS_FGO, status: 'PENDING' } });
    const st = billingState({
      status: order.status, loaded: await hasConfirmedLoading(tx, orderId), docs: order.fgoDocuments, invoiced: await hasChainInvoice(tx, orderId),
      pending: pending.map((p) => p.payload?.kind), hasOffer: order.offers.some((o) => o.status === 'GONDERILDI'),
      inBatch: order.billingBatchOrders.length > 0, payments: order.manualPayments,
    });
    // Sipariş düzeyinde nihai fatura yok (karar 239): INVOICE hiçbir durumda istenemez
    const action = { PROFORMA: 'proforma', ADVANCE: 'advance' }[kind];
    if (!action || !st.actions.includes(action)) return { ok: false, code: 'NOT_ALLOWED' };
    // Kur zaten belirlenmişse (proformanın kuru) elle kur yok sayılmaz, reddedilir: saklanan kur değişmez
    const useManual = manual != null && kind !== 'ADVANCE';
    if (useManual && order.glassBilling?.fxRate != null) return { ok: false, code: 'RATE_LOCKED' };
    // Avans: sıra ve tutar istek anında, kilit altında belirlenir ve işte saklanır (tutar = max(FGO tahsilatı, elle
    // kayıtlar) − avansı kesilen; tutar formdan gelmez). İşçi yalnızca bu kaydı keser; çift tıklama / ikinci istek kuyruk
    // denetimine takılır.
    const chain = orderChain(order.fgoDocuments, order.manualPayments);
    const advance = kind === 'ADVANCE'
      ? { seq: chain.nextSeq, amount: st.advanceRequired, basis: chain.basis, fgoPaid: chain.paid, manualRon: chain.manualRon, advancedBefore: chain.advanced }
      : {};
    const risk = kind === 'ADVANCE' ? await advanceRisk(tx, { customerId: order.customerId, ron: st.advanceRequired, chainKey: `order:${orderId}`, now }) : { matches: [], ackKey: '' };
    if (risk.matches.length && ack !== risk.ackKey) return { ok: false, code: 'DUPLICATE_RISK', matches: risk.matches, ackKey: risk.ackKey };
    const job = await tx.notificationOutbox.create({ data: { type: GLASS_FGO, orderId, payload: { kind, orderNo: order.orderNo, ...advance, ...(useManual ? { manualRate: manual } : {}) } } });
    await writeHistory(tx, { orderId, event: 'FGO_DOC_REQUESTED', from: order.status, to: order.status, actorId: actor.id, note: kind });
    await writeAudit(tx, {
      action: 'FGO_DOC_REQUEST', entityType: 'Order', entityId: orderId, userId: actor.id,
      details: {
        kind, ...(kind === 'ADVANCE' ? { seq: advance.seq, basis: advance.basis, fgoPaid: chain.paid, manualRon: chain.manualRon, advancedBefore: chain.advanced, amountRon: advance.amount } : {}),
        ...(useManual ? { manualRate: manual } : {}), ...(risk.matches.length ? { duplicateAck: risk.matches.map((m) => m.key) } : {}),
      },
    }, actor);
    if (risk.matches.length) await recordDuplicateAck(tx, { orderId, subject: 'ADVANCE', matches: risk.matches, amountRon: st.advanceRequired, actor, key: `job:${job.id}` });
    return { ok: true };
  });
}

// ---------- işçi ----------
export const MAX_ATTEMPTS = 8;
const backoffMinutes = (attempt) => [1, 5, 15, 30, 60, 120, 240, 480][Math.min(attempt, 7)];
class Permanent extends Error {}

/**
 * Kuyruktaki cam belgelerini keser. onlyOrderId: düğmeye basılınca o siparişin işi hemen denenir.
 * @param {import('@prisma/client').PrismaClient} db
 * @param {{ now?: Date, fetchImpl?: typeof fetch, bnrImpl?: typeof bnrRate, secret?: string, appUrl?: string, timeZone?: string, onlyOrderId?: string | null, log?: Function }} [ctx]
 */
export async function dispatchGlassJobs(db, { now = new Date(), fetchImpl = fetch, bnrImpl = bnrRate, secret, appUrl, timeZone, onlyOrderId = null, log = () => {} } = {}) {
  const env = getEnv();
  secret ??= env.AUTH_SECRET;
  appUrl ??= env.APP_URL ?? '';
  timeZone ??= env.APP_TIMEZONE ?? 'Europe/Bucharest';
  const rows = await db.notificationOutbox.findMany({
    where: { type: GLASS_FGO, status: 'PENDING', availableAt: { lte: now }, ...(onlyOrderId ? { orderId: onlyOrderId } : {}) },
    orderBy: { createdAt: 'asc' },
    take: 10,
  });
  if (rows.length === 0) return { done: 0, failed: 0 };
  const settings = await getFgoSettings(db);
  let done = 0, failed = 0;
  for (const row of rows) {
    // Atomik sahiplenme + işlem kirası: FGO'ya yalnızca sahiplenen işçi gider (server/integrations/fgo-claim.js)
    if (!(await claimFgoJob(db, row, { now }))) continue;
    const attempt = row.attempts + 1;
    const kind = row.payload?.kind;
    /** Kesimden önce hazırlanan kayıt (belirsiz sonuçta işte saklanır; yönetici doğrulayınca aynı kayıt yazılır) */
    let prepared = null;
    let form = null;
    let lineList = [];
    let vatRate = 0;
    let order = null;
    try {
      if (!fgoReady(settings)) throw new Permanent('FGO kapalı');
      if (!KINDS.includes(kind)) throw new Permanent('bilinmeyen belge türü');
      // Sipariş düzeyi kapanış faturası kaldırıldı (karar 239): kuyrukta kalmış eski bir istek FGO'ya GİTMEDEN reddedilir —
      // nihai fatura yalnızca onaylı yüklemeden (yüklenen miktar) kesilir
      if (kind === 'INVOICE') throw new Permanent('Sipariş düzeyinde kapanış faturası kesilmez: nihai fatura onaylı yüklemeden, yükleme gününün Faturalama kartında kesilir');
      order = await db.order.findUnique({
        where: { id: row.orderId ?? '' },
        include: {
          customer: true, price: true, glassBilling: true, fgoDocuments: true, manualPayments: { where: { batchId: null } },
          offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } },
        },
      });
      if (!order || order.status === 'IPTAL') throw new Permanent('sipariş yok ya da iptal');
      // İş kuyruktayken sipariş bir müşteri partisine girmiş olamaz (parti bekleyen isteği dışlar); yine de kesimden önce bakılır
      if (await db.billingBatchOrder.count({ where: { orderId: order.id, activeKey: { not: null }, batch: { kind: 'PROFORMA' } } })) throw new Permanent('Sipariş bir müşteri proformasında; sipariş başına belge kesilmez');
      // Onaylı yüklemesi olan siparişe sipariş düzeyi proforma kesilmez (istek anında da denetlenir)
      if (kind === 'PROFORMA' && await hasConfirmedLoading(db, order.id)) throw new Permanent('Siparişin onaylı yüklemesi var; sipariş düzeyi proforma kesilmez');
      // Zincirden nihai fatura kesildikten sonra avans faturası kesilmez (tahsilat faturalanmış malın ödemesi olabilir)
      if (kind === 'ADVANCE' && await hasChainInvoice(db, order.id)) throw new Permanent('Siparişin zincirinden nihai fatura kesildi; sonradan gelen tahsilat için avans faturası kesilmez (muhasebe kararı)');
      // Sipariş başına zincir: proforma ve kapanış faturası tektir; avans faturası sırayla (seq) birden çok olabilir.
      // Ödeme: FGO tahsilatı ve elle kayıtlar (karar 207)
      const chain = orderChain(order.fgoDocuments, order.manualPayments);
      const seq = kind === 'ADVANCE' ? Math.trunc(Number(row.payload?.seq)) || chain.nextSeq : 1;
      if (order.fgoDocuments.some((d) => d.kind === kind && (d.seq ?? 1) === seq)) {
        await db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SKIPPED', lastError: 'belge zaten var' } });
        continue;
      }
      const missing = missingBilling(order.customer);
      if (missing.length) throw new Permanent(`Müşterinin fatura bilgisi eksik: ${missing.join(', ')}`);
      const key = fgoKey(settings, secret);
      if (!key) throw new Permanent('FGO anahtarı açılamadı; Entegrasyonlar ekranında yeniden girin');
      if (await dailyLimitReached(db, settings, localDayStart(now, timeZone))) throw new Error(`Günlük FGO belge sınırı (${settings.dailyLimit}) doldu`);
      const offer = sentOffer(order);
      if (!offer) throw new Permanent('Müşteriye gönderilmiş teklif yok');
      if (offer.currency !== 'EUR' && offer.currency !== 'RON') throw new Permanent(`Desteklenmeyen para birimi: ${offer.currency}`);

      // Kur: proforma günün kuru; avans ve kapanış faturası proformanın kuru; proforma yoksa bugünün kuru. RON teklifte kur 1.
      const b = order.glassBilling;
      const today = localDay(now, timeZone);
      let rate, rateDay, source, fx = null;
      if (offer.currency === 'RON') {
        rate = 1; rateDay = dayDate(today); source = 'RON';
      } else if (b?.fxRate != null) {
        rate = Number(b.fxRate); rateDay = b.fxDate ?? dayDate(today); source = b.fxSource ?? 'MANUAL';
      } else {
        if (kind === 'ADVANCE') throw new Permanent('Proformanın kuru yok');
        // Tek çözücü (karar 95): müşterinin kur politikası; yönetici elle kur girdiyse o.
        // Kur alınamadıysa (BNR'ye ulaşılamadı, günün BT kuru girilmedi) iş bekler ve yeniden denenir; bozuk politika / kur beklemez
        try {
          fx = await resolveExchangeRate(db, { customer: order.customer, currency: offer.currency, day: today, now, manualRate: row.payload?.manualRate ?? null, bnrImpl });
        } catch (e) {
          if (e instanceof FxUnavailable && ['BAD_POLICY', 'BAD_MANUAL', 'CURRENCY'].includes(e.code)) throw new Permanent(e.message);
          throw e;
        }
        rate = fx.rate; rateDay = dayDate(today); source = fx.source;
      }
      const proforma = chain.proforma;
      // İş kuyruğa girdikten sonra proformaya tahsilat gelmiş olabilir (FGO eşitlemesi ya da elle kayıt): kesim anında
      // yeniden bakılır. Avansı kesilmemiş tahsilat varken kapanış faturası kesilmez (karar 104, 207) — önce avans faturası.
      if (kind === 'INVOICE' && chain.advanceRequired > 0) {
        throw new Permanent(`Proforma ${proforma.series}${proforma.number}: avansı kesilmemiş ${chain.advanceRequired.toFixed(2)} RON tahsilat var (FGO ya da elle kayıt); kapanış faturası kesilmedi. Önce avans faturası kesin.`);
      }
      let lines;
      /** @type {number | null} */
      let advanceGross = null;
      if (kind === 'ADVANCE') {
        if (!proforma) throw new Permanent('Proforma yok');
        // Tutar: istek anında saklanan (max(FGO tahsilatı, elle kayıtlar) − avansı kesilen). Kaynak bu arada azaldıysa kesilmez.
        advanceGross = row.payload?.amount != null ? round2(Number(row.payload.amount)) : chain.advanceRequired;
        if (!(advanceGross > 0)) throw new Permanent('Avansı kesilecek tahsilat yok');
        if (advanceGross - chain.advanceRequired > EPS) throw new Permanent(`Ödemedeki tahsilat değişti: avansı kesilecek tutar ${chain.advanceRequired.toFixed(2)} RON, istenen ${advanceGross.toFixed(2)} RON`);
        lines = [{ code: '', name: `Avans marfă conform proformă ${proforma.series}${proforma.number}`, unit: FGO_UM.adet, qty: 1, ron: netOf(advanceGross, settings.vatRate) }];
      } else {
        // Romence ad: satırda yoksa katalogdaki camın Romence adı ve rengi
        const ids = offer.lines.filter((l) => !l.descriptionRo && l.glassProductId).map((l) => l.glassProductId);
        if (ids.length) {
          const glasses = new Map((await db.glassProduct.findMany({ where: { id: { in: ids } } })).map((x) => [x.id, glassLabel(x, 'ro')]));
          for (const l of offer.lines) if (!l.descriptionRo && glasses.has(l.glassProductId)) l.descriptionRo = glasses.get(l.glassProductId);
        }
        // Proforma ayrıntılı (CNC ve delik ayrı satır); fatura yalnızca cam (işlemler cama eklenir)
        lines = kind === 'PROFORMA' ? proformaLines(offer) : invoiceLines(offer, rate, settings.vatRate);
        if (lines.length === 0) throw new Permanent('Teklifte fiyatlı cam satırı yok');
        if (kind === 'INVOICE') {
          // Avans düşümü: kesilmiş her avans faturasının TVA hariç tutarı eksi satır olarak (sırasıyla)
          for (const advance of chain.advances) {
            const gross = Number(advance.total ?? advance.advanced ?? 0);
            lines.push({ code: '', name: `Stornare avans conform factură ${advance.series}${advance.number}`, unit: FGO_UM.adet, qty: -1, ron: netOf(gross, settings.vatRate) });
          }
        }
      }
      // Her kalemin FGO açıklaması (Continut[Descriere]): kaynak TAKİP siparişi — "Comanda UMI7" (karar 111)
      lines = lines.map((l) => ({ ...l, detail: orderDetail(order.orderNo, l.detail) }));
      lineList = lines;
      vatRate = settings.vatRate;
      // Numarayı FGO verir (karar 87); yalnızca yönetici elle numara girdiyse o numara gönderilir. Proforma hep FGO'dan.
      const sentNo = kind === 'PROFORMA' ? null : await reserveInvoiceNumber(db, settings, { key, appUrl, fetchImpl });
      form = emitereForm({
        settings, key, kind: kind === 'PROFORMA' ? 'proforma' : 'invoice', orderNo: order.orderNo, appUrl, customer: order.customer, lines,
        // IdExtern: sipariş + tür (+ ikinci ve sonraki avans faturasında sıra) — aynı iş yeniden denense de aynı kalır
        rate, extern: `${order.orderNo}-${SUFFIX[kind]}${seq > 1 ? seq : ''}`,
        // Açıklama (Paket C — karar 235): sipariş başlığı DEĞİL, belgenin kuru — kayıtlı kur (proforma zincirinin kaydı) ya da bu
        // belge için şimdi çözülen kur; RON belgede ve kur bilinmiyorsa boş (uydurulmaz)
        text: glassDocText(offer.currency, b?.fxRate != null ? b : fx ? fxSnapshot(fx, rateDay) : null), rateNote: false,
        number: sentNo,
      });
      prepared = {
        kind, seq, rate, rateDay: rateDay instanceof Date ? rateDay.toISOString() : rateDay, source, amount: ronTotal(lines, rate),
        // Kur kaydı kurla birlikte bir kez yazılır (karar 96); sonraki belgeler bu kaydı kullanır, yeniden çözmez
        fx: b?.fxRate == null && kind !== 'ADVANCE' ? (fx ? fxSnapshot(fx, rateDay) : { fxRate: rate.toFixed(4), fxDate: rateDay, fxSource: source }) : null,
        fxAudit: fx ? { fxPolicy: fx.policy, fxBaseRate: fx.baseRate, fxMarkupPercent: fx.markupPercent, fxSourceDate: fx.sourceDate, fxManual: fx.manual } : null,
        ...(advanceGross != null ? { advanceGross, basis: row.payload?.basis ?? chain.basis, fgoPaid: chain.paid, manualRon: chain.manualRon, advancedBefore: chain.advanced } : {}),
      };
      const doc = await fgoEmit(settings, form, fetchImpl);
      // Elle numara FGO'da kullanıldı: alan belge kaydından ÖNCE boşaltılır — kayıt yazılamasa bile aynı numara sonraki
      // faturaya bir daha gönderilmez (tek seferlik; karar 87)
      if (kind !== 'PROFORMA') await afterInvoiceIssued(db, { sent: sentNo, issued: doc.number, orderId: order.id }).catch((e) => log('fatura numarası ayarı güncellenemedi', e?.message));
      await recordGlassIssued(db, { orderId: order.id, rowId: row.id, prepared, doc, now });
      done++;
      try {
        const st = await fgoStatus(settings, key, { series: doc.series, number: doc.number, appUrl }, fetchImpl);
        await db.fgoDocument.update({
          where: { series_number: { series: doc.series, number: doc.number } },
          data: { total: st.total == null ? null : st.total.toFixed(2), paid: st.paid == null ? null : st.paid.toFixed(2), checkedAt: new Date() },
        });
      } catch {
        // Muhasebe ekranından yeniden okunur
      }
    } catch (e) {
      failed++;
      const msg = String(e?.message ?? e).slice(0, 500);
      // Belge FGO'da kesilmiş olabilir (karar 209): körlemesine yeniden denenmez — iş bekletilir, yönetici FGO'ya bakıp karar verir
      if (uncertainEmit(e) && prepared && form) {
        await parkUncertain(db, row, {
          target: 'GLASS', kind, orderIds: [order.id], orderNo: order.orderNo, prepared, expected: expectedGross(lineList, { rate: prepared.rate, vatRate }),
          series: form.Serie, idExtern: form.IdExtern, error: msg, now,
        });
        log('cam FGO belgesi: sonuç belirsiz — yönetici incelemesine gönderildi', kind, row.orderId);
        continue;
      }
      const final = e instanceof Permanent || (e instanceof FgoError && !e.retry) || attempt >= MAX_ATTEMPTS;
      await db.notificationOutbox.update({
        where: { id: row.id },
        data: { lastError: msg, ...(final ? { status: 'FAILED' } : { availableAt: new Date(now.getTime() + backoffMinutes(attempt) * 60_000) }) },
      });
      if (final && row.orderId) {
        await db.$transaction(async (tx) => {
          await writeHistory(tx, { orderId: row.orderId, event: 'FGO_FAILED', actorId: null, note: `${kind}: ${msg}`.slice(0, 200) });
          await tx.adminAlert.create({ data: { type: 'FGO_FAILED', orderId: row.orderId, details: { code: kind, error: msg.slice(0, 300), attempts: attempt } } });
        });
        // Aynı olay uygulama içi bildirim olarak muhasebe yetkisine (işin kimliğiyle: yeniden denemede ikinci kez yazılmaz)
        const { notifyFgoFailed } = await import('../notifications/inapp.js');
        await notifyFgoFailed(db, { key: `fgo-failed:${row.id}`, orderId: row.orderId, error: msg });
      }
      log('cam FGO belgesi kesilemedi', kind, row.orderId, msg);
    }
  }
  return { done, failed };
}

/**
 * Kesilen cam belgesini kaydeder — işçinin başarı yolu; sonucu belirsiz kalan ve yöneticinin FGO'dan doğruladığı belge de
 * aynı yolla yazılır (server/finance/uncertain.js, karar 209). İş satırı koşullu olarak SENT olur: yalnızca hâlâ bekleyen
 * iş kaydedilir (iki yol aynı işi iki kez kaydedemez; FgoDocument seri + numara ve [sipariş, tür, sıra] benzersiz).
 * Avans faturasında karşıladığı elle ödeme kayıtları bu belgeye bağlanır (izlenebilirlik, karar 207).
 * @param {any} db
 * @param {{ orderId: string, rowId: string, prepared: any, doc: { series: string, number: string, link?: string | null }, now?: Date }} p
 */
export async function recordGlassIssued(db, { orderId, rowId, prepared: p, doc, now = new Date() }) {
  return db.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, status: true, glassBilling: { select: { fxRate: true } } } });
    if (!order) throw new Error('JOB_STATE');
    const job = await tx.notificationOutbox.updateMany({ where: { id: rowId, status: 'PENDING' }, data: { status: 'SENT', sentAt: new Date(), lastError: null } });
    if (job.count !== 1) throw new Error('JOB_STATE');
    const advance = p.kind === 'ADVANCE';
    const created = await tx.fgoDocument.create({
      data: {
        orderId, kind: p.kind, seq: p.seq, series: doc.series, number: doc.number, issuedAt: now, link: doc.link ?? null,
        ...(advance ? { advanced: Number(p.advanceGross).toFixed(2), basis: p.basis ?? 'FGO' } : {}),
      },
    });
    if (!advance && p.fx && order.glassBilling?.fxRate == null) {
      // Kur kaydı kurla birlikte bir kez yazılır (karar 96); sonraki belgeler bu kaydı kullanır, yeniden çözmez
      await tx.glassBilling.upsert({ where: { orderId }, create: { orderId, ...p.fx }, update: p.fx });
    }
    const proformaRef = advance ? await orderProformaRef(tx, orderId) : null;
    const linked = advance && proformaRef
      ? await linkCoveredPayments(tx, { where: { orderId, batchId: null, proformaRef }, link: { advanceDocId: created.id }, advancedTotal: centsText(toCents(p.advancedBefore) + toCents(p.advanceGross)) })
      : [];
    // Müşteri e-postası: belge kaydı yazıldıktan sonra, aynı işlemde, belge başına bir kez (kesilemeyen belgede yok)
    await queueDocEmail(tx, { docId: created.id, orderId });
    await writeHistory(tx, { orderId, event: 'FGO_DOC_ISSUED', from: order.status, to: order.status, actorId: null, note: `${p.kind}:${doc.series}${doc.number}` });
    await writeAudit(tx, {
      action: 'FGO_DOC_ISSUED', entityType: 'Order', entityId: orderId, userId: null,
      details: {
        kind: p.kind, seq: p.seq, series: doc.series, number: doc.number,
        ...(advance ? { basis: p.basis ?? 'FGO', fgoPaid: p.fgoPaid, manualRon: p.manualRon, advancedBefore: p.advancedBefore, advanceRon: p.advanceGross, payments: linked } : {}),
        fxRate: p.rate, fxSource: p.source, ...(p.fxAudit ?? {}), amountRonNet: p.amount,
      },
    }, { role: 'SYSTEM' });
    return created;
  });
}
