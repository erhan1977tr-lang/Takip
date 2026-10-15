// TAKİP Telegram asistanı — SALT OKUNUR sorgu araçları (3.84.0, karar 278).
//
// Yapay zekâ modeli veritabanına DOĞRUDAN erişemez ve SQL yazamaz: yalnızca buradaki sabit araçları, doğrulanmış
// parametrelerle çağırabilir. Her araç:
//   - parametrelerini kendi şemasıyla doğrular (bilinmeyen alan, uzun metin, geçersiz tarih / sayı → INVALID_ARGS);
//   - yalnızca okur (findMany / findFirst / count / groupBy / aggregate ve mevcut salt okunur servisler) ve bunu
//     PostgreSQL READ ONLY işleminin içinde yapar (server/assistant/readonly.js) — bir yazma denemesi veritabanında reddedilir;
//   - sonuç satır sayısını sınırlar (MAX_ROWS) ve kısa, düz JSON döner (modelin bağlamı ve maliyet sınırlı kalır).
// Hiçbir araç sipariş / teklif / fatura / FGO / stok / e-posta / bildirim yazmaz, dış servise gitmez (FGO, BNR, SMTP yok).
// Metraj ve yükleme miktarları TAKİP'in kendi kurallarıyla hesaplanır (offerLineTotals, loadingParts, effectiveItems,
// previewLoading / loadConfirmation — karar 279 sonrası 3.85.0); m² 3 ondalık. Ticari cam ile bedelsiz telafi camı ayrı sayılır.
import { listDocuments, receivables } from '../accounting/receivables.js';
import { uninvoicedLoadings } from '../accounting/uninvoiced.js';
import { reservedLevels, stockLevels } from '../profile/stock.js';
import { supplierAccounts } from '../suppliers/service.js';
import { localDay } from '../profile/dates.js';
import { effectiveItems, isGlassLine, loadConfirmation, previewLoading, shipDayDate } from '../loading/confirmation.js';
import { isCrateLine, offerLineTotals } from '../orders/rules.js';
import { loadedOffer } from '../orders/loading.js';
import { loadingParts } from '../orders/customer-offers.js';

export const MAX_ROWS = 20;
const ORDER_STATUSES = ['YENI', 'HAZIRLANIYOR', 'URETIMDE', 'YUKLENDI', 'ARSIVLENDI', 'IPTAL'];
const ORDER_TYPES = { cam: 'GLASS_ORDER', profil: 'PROFILE_ORDER' };
const ACTIVE = ['YENI', 'HAZIRLANIYOR', 'URETIMDE', 'YUKLENDI'];

export class ToolError extends Error {
  /** @param {string} code */
  constructor(code) { super(code); this.code = code; }
}

// ---------------------------------------------------------------- parametre doğrulama (küçük şema)
/**
 * @typedef {{ type: 'string', max: number, pattern?: RegExp } | { type: 'enum', values: string[] } | { type: 'int', min: number, max: number }
 *   | { type: 'day' } | { type: 'bool' }} Field
 */
/** Model şemasından gelen argümanları doğrular; bilinmeyen alan reddedilir. */
export function validateArgs(fields, raw) {
  const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!args) throw new ToolError('INVALID_ARGS');
  for (const k of Object.keys(args)) if (!Object.hasOwn(fields, k)) throw new ToolError('INVALID_ARGS');
  const out = {};
  for (const [k, f] of Object.entries(fields)) {
    const v = args[k];
    if (v === undefined || v === null || v === '') continue;
    if (f.type === 'string') {
      if (typeof v !== 'string') throw new ToolError('INVALID_ARGS');
      const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
      if (!s || s.length > f.max || (f.pattern && !f.pattern.test(s))) throw new ToolError('INVALID_ARGS');
      out[k] = s;
    } else if (f.type === 'enum') {
      if (typeof v !== 'string' || !f.values.includes(v)) throw new ToolError('INVALID_ARGS');
      out[k] = v;
    } else if (f.type === 'int') {
      const n = typeof v === 'string' && /^\d{1,6}$/.test(v) ? Number(v) : v;
      if (!Number.isInteger(n) || n < f.min || n > f.max) throw new ToolError('INVALID_ARGS');
      out[k] = n;
    } else if (f.type === 'day') {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T12:00:00Z`))) throw new ToolError('INVALID_ARGS');
      if (new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) !== v) throw new ToolError('INVALID_ARGS');
      out[k] = v;
    } else if (f.type === 'bool') {
      if (typeof v !== 'boolean') throw new ToolError('INVALID_ARGS');
      out[k] = v;
    }
  }
  return out;
}
/** Doğrulama şeması → modelin gördüğü JSON şeması */
function jsonSchema(fields) {
  const properties = {};
  for (const [k, f] of Object.entries(fields)) {
    const p = { description: f.desc };
    if (f.type === 'string') Object.assign(p, { type: 'string', maxLength: f.max });
    else if (f.type === 'enum') Object.assign(p, { type: 'string', enum: f.values });
    else if (f.type === 'int') Object.assign(p, { type: 'integer', minimum: f.min, maximum: f.max });
    else if (f.type === 'day') Object.assign(p, { type: 'string', description: `${f.desc} (YYYY-AA-GG)` });
    else if (f.type === 'bool') Object.assign(p, { type: 'boolean' });
    properties[k] = p;
  }
  return { type: 'object', properties, additionalProperties: false };
}

// ---------------------------------------------------------------- yardımcılar
const money = (v) => (v == null ? null : Number(Number(v).toFixed(2)));
const dayOf = (d, tz) => (d ? localDay(new Date(d), tz) : null);
const addDays = (key, n) => new Date(Date.parse(`${key}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Firma araması: ad içinde (büyük / küçük harf fark etmeden) ya da 3 harfli firma kodu */
const customerWhere = (q) => ({
  type: 'CUSTOMER',
  OR: [{ name: { contains: q, mode: /** @type {const} */ ('insensitive') } }, ...(/^[A-Za-z]{3}$/.test(q) ? [{ prefix: q.toUpperCase() }] : [])],
});
const orderRow = (o, tz) => ({
  no: o.orderNo, firma: o.customer?.name ?? null, tur: o.orderTypeCode === 'PROFILE_ORDER' ? 'profil' : 'cam', baslik: o.title ?? null,
  durum: o.status, beklemede: o.onHold || undefined, profilAsama: o.profile?.stage ?? undefined, tahminiYukleme: dayOf(o.estimatedShipDate, tz),
  olusturma: dayOf(o.createdAt, tz),
});
const ORDER_LIST_SELECT = {
  orderNo: true, title: true, status: true, onHold: true, orderTypeCode: true, estimatedShipDate: true, createdAt: true,
  customer: { select: { name: true } }, profile: { select: { stage: true } },
};
/** Son gönderilmiş teklif (müşteri fiyatı) ve güncel teklif durumu */
function offerSummary(offers) {
  const sent = offers.filter((o) => o.status === 'GONDERILDI').sort((a, b) => +new Date(b.sentAt ?? 0) - +new Date(a.sentAt ?? 0))[0] ?? null;
  const latest = [...offers].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0] ?? null;
  return {
    teklifDurumu: latest?.status ?? null,
    musteriTeklifi: sent ? { tutar: money(sent.offerAmount), paraBirimi: sent.currency, gonderim: sent.sentAt } : null,
    fabrikaTutari: sent ? money(sent.amount) : null,
  };
}


// ---------------------------------------------------------------- sipariş numarası (3.85.0)
const ORDER_NO = { type: 'string', max: 30, pattern: /^[A-Za-zİıŞşĞğÜüÖöÇç0-9 -]+$/, desc: 'Sipariş numarası (ör. GLA68, ALE40, GLAP12, ABC124-T)' };
/** "ale 40", "Ale-40", "GLA68" → "ALE40" biçimi (Türkçe İ / ı dahil); boşluk atılır */
export function normalizeOrderNo(raw) {
  return String(raw ?? '').replace(/[İı]/g, 'I').toUpperCase().replace(/\s+/g, '');
}
/**
 * Siparişi numarasıyla bulur: önce tam sipariş no (büyük / küçük harf fark etmez; "ALE-40" → "ALE40" da denenir), sonra
 * firma kodu + müşterinin sipariş no (etkin numara). Bulunamazsa { miss }: kaldırılmış mı, benzer numaralar (en çok 5).
 * Bulunamadı ile veri eksik ayrıdır: bulunan siparişin eksik verisi araçta `veriEksik` olarak döner.
 */
export async function findOrder(tx, raw, select) {
  const no = normalizeOrderNo(raw);
  const tries = [no];
  const m = /^([A-Z]{3})-(\d.*)$/.exec(no);
  if (m) tries.push(`${m[1]}${m[2]}`);
  for (const t of tries) {
    const o = await tx.order.findFirst({ where: { orderNo: { equals: t, mode: 'insensitive' }, removedAt: null }, orderBy: { createdAt: 'desc' }, select });
    if (o) return { order: o };
  }
  const parts = /^([A-Z]{3})-?(\d[\d-]*)$/.exec(no);
  if (parts) {
    const o = await tx.order.findFirst({
      where: { removedAt: null, numberActive: true, orderTypeCode: 'GLASS_ORDER', customerOrderNo: parts[2], customer: { prefix: parts[1] } },
      orderBy: { createdAt: 'desc' }, select,
    });
    if (o) return { order: o };
  }
  const removed = await tx.order.count({ where: { orderNo: { in: tries, mode: 'insensitive' }, removedAt: { not: null } } });
  const key = parts ? parts[2] : no.replace(/[^A-Z0-9]/g, '');
  const similar = key.length >= 2
    ? await tx.order.findMany({ where: { removedAt: null, orderNo: { contains: key, mode: 'insensitive' } }, orderBy: { createdAt: 'desc' }, take: 5, select: { orderNo: true } })
    : [];
  return { miss: { bulunamadi: no, ...(removed ? { kaldirilmis: true } : {}), ...(similar.length ? { benzerler: similar.map((x) => x.orderNo) } : {}) } };
}

// ---------------------------------------------------------------- metraj (TAKİP kuralı; 3 ondalık)
const milli = (v) => Math.round(Number(v ?? 0) * 1000);
const m3 = (mm) => mm / 1000;
/** Cam satırının m²'si — teklifteki kural (offerLineTotals: kayıtlı parça m², ayrılmış cam), fiyat yok */
const lineM2 = (l) => offerLineTotals({ ...l, unit: 'm2', unitPrice: 0, free: false }).metraj;
const isGlass = (l) => isGlassLine(l) && !l.crateFee && !isCrateLine(l);
/** Ticari / bedelsiz telafi ayrı toplam: { ticari: {adet, m2}, bedelsizTelafi: {adet, m2}, toplam: {adet, m2} } */
function glassSum(rows, m2Of = lineM2, qtyOf = (l) => Math.max(0, Math.trunc(Number(l.adet ?? l.quantity ?? 0)))) {
  const t = { ticari: [0, 0], bedelsiz: [0, 0] };
  for (const l of rows) {
    if (!isGlass(l)) continue;
    const k = l.free ? 'bedelsiz' : 'ticari';
    t[k][0] += qtyOf(l);
    t[k][1] += milli(m2Of(l));
  }
  const out = (x) => ({ adet: x[0], m2: m3(x[1]) });
  return { ticari: out(t.ticari), bedelsizTelafi: out(t.bedelsiz), toplam: out([t.ticari[0] + t.bedelsiz[0], t.ticari[1] + t.bedelsiz[1]]) };
}

// ---------------------------------------------------------------- araçlar
/** @type {Record<string, { desc: string, fields: Record<string, Field & { desc?: string }>, run: (tx: any, a: any, ctx: { tz: string, now: Date }) => Promise<any> }>} */
export const TOOLS = {
  genel_ozet: {
    desc: 'Genel durum özeti: aktif cam siparişleri (duruma göre), profil siparişleri (aşamaya göre), yönetici fiyat onayı bekleyen teklifler, açık önemli kararlar, bugün ve yarın planlanan yükleme sayısı.',
    fields: {},
    async run(tx, _a, { tz, now }) {
      const today = localDay(now, tz);
      const [byStatus, byStage, pricing, alerts, near] = await Promise.all([
        tx.order.groupBy({ by: ['status'], where: { removedAt: null, orderTypeCode: 'GLASS_ORDER', status: { in: ACTIVE } }, _count: { _all: true } }),
        tx.profileOrder.groupBy({ by: ['stage'], where: { order: { removedAt: null, status: { not: 'IPTAL' } }, stage: { not: 'FATURALANDI' } }, _count: { _all: true } }),
        tx.offer.count({ where: { status: 'YONETIMDE', order: { removedAt: null, status: { not: 'IPTAL' } } } }),
        tx.adminAlert.count({ where: { resolvedAt: null } }),
        tx.order.findMany({
          where: { removedAt: null, onHold: false, status: { in: ['HAZIRLANIYOR', 'URETIMDE'] }, estimatedShipDate: { gte: new Date(`${addDays(today, -1)}T00:00:00Z`), lt: new Date(`${addDays(today, 3)}T00:00:00Z`) } },
          select: { estimatedShipDate: true },
        }),
      ]);
      const tomorrow = addDays(today, 1);
      return {
        bugun: today,
        camSiparisleri: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
        profilSiparisleri: Object.fromEntries(byStage.map((r) => [r.stage, r._count._all])),
        yoneticiFiyatOnayiBekleyen: pricing,
        acikOnemliKararlar: alerts,
        bugunPlanlananYukleme: near.filter((o) => dayOf(o.estimatedShipDate, tz) === today).length,
        yarinPlanlananYukleme: near.filter((o) => dayOf(o.estimatedShipDate, tz) === tomorrow).length,
      };
    },
  },

  siparis_ara: {
    desc: 'Sipariş arar (en yeniler önce, en çok 20). Metin: sipariş no, başlık ya da müşterinin sipariş no; firma: firma adı ya da 3 harfli kod.',
    fields: {
      metin: { type: 'string', max: 40, desc: 'Sipariş no / başlık / müşteri sipariş no içinde arama' },
      firma: { type: 'string', max: 60, desc: 'Firma adı (parçası) ya da 3 harfli firma kodu' },
      durum: { type: 'enum', values: ORDER_STATUSES, desc: 'Sipariş durumu' },
      tur: { type: 'enum', values: ['cam', 'profil'], desc: 'Sipariş türü' },
      sadece_aktif: { type: 'bool', desc: 'true: yalnızca açık siparişler (yeni, hazırlanıyor, üretimde, yüklendi)' },
      adet: { type: 'int', min: 1, max: MAX_ROWS, desc: 'En çok kaç sonuç' },
    },
    async run(tx, a, { tz }) {
      const where = {
        removedAt: null,
        ...(a.durum ? { status: a.durum } : a.sadece_aktif ? { status: { in: ACTIVE } } : {}),
        ...(a.tur ? { orderTypeCode: ORDER_TYPES[a.tur] } : {}),
        ...(a.firma ? { customer: customerWhere(a.firma) } : {}),
        ...(a.metin ? { OR: [
          ...['orderNo', 'title', 'customerOrderNo'].map((f) => ({ [f]: { contains: a.metin, mode: 'insensitive' } })),
          // "ale 40" / "ALE-40" gibi yazımlar: boşluksuz biçim sipariş numarasında da aranır
          ...(normalizeOrderNo(a.metin) !== a.metin ? [{ orderNo: { contains: normalizeOrderNo(a.metin).replace(/^([A-Z]{3})-(\d)/, '$1$2'), mode: 'insensitive' } }] : []),
        ] } : {}),
      };
      const take = a.adet ?? 10;
      const [rows, total] = await Promise.all([
        tx.order.findMany({ where, orderBy: { createdAt: 'desc' }, take, select: ORDER_LIST_SELECT }),
        tx.order.count({ where }),
      ]);
      return { toplam: total, gosterilen: rows.length, siparisler: rows.map((o) => orderRow(o, tz)) };
    },
  },

  siparis_detay: {
    desc: 'Tek siparişin ayrıntısı: durum, firma, tarihler, teklif tutarları (müşteri ve fabrika), çizim durumu, yükleme onayları, FGO belgeleri, son notlar. Camlar / ölçüler / m² için siparis_camlari, yüklenen / kalan miktar için yukleme_durumu, sandıklar için sandiklar.',
    fields: { siparis_no: ORDER_NO },
    async run(tx, a, { tz }) {
      if (!a.siparis_no) throw new ToolError('INVALID_ARGS');
      const found = await findOrder(tx, a.siparis_no, {
          ...ORDER_LIST_SELECT, id: true, customerOrderNo: true, drawingTrack: true, actualShipDate: true, slaDeadline: true,
          offers: { select: { status: true, sentAt: true, createdAt: true, currency: true, amount: true, offerAmount: true } },
          profile: { select: { stage: true, pickupDate: true, proformaNo: true, invoiceNo: true, deliveredAt: true, paidAt: true } },
          fgoDocuments: { select: { kind: true, series: true, number: true, issuedAt: true, total: true, paid: true, currency: true }, orderBy: { issuedAt: 'asc' } },
          loadedItems: { select: { id: true, confirmationId: true, offerLineId: true, replanId: true, scopeKey: true, revision: true, status: true, quantity: true, confirmation: { select: { shipDay: true } } }, take: 500 },
          notes: { orderBy: { createdAt: 'desc' }, take: 5, select: { createdAt: true, text: true, internal: true, user: { select: { name: true } } } },
          _count: { select: { files: true, drawings: true } },
      });
      if (!found.order) return found.miss;
      const o = found.order;
      const days = {};
      // Onaylı yüklemelerin GEÇERLİ hâli (düzeltmeler dahil — tek okuyucu effectiveItems, karar 105)
      for (const it of effectiveItems(o.loadedItems)) {
        const d = dayOf(it.confirmation.shipDay, 'UTC');
        (days[d] ??= { yuklenen: 0, yuklenmeyen: 0 })[it.status === 'LOADED' ? 'yuklenen' : 'yuklenmeyen'] += Number(it.quantity ?? 0);
      }
      return {
        ...orderRow(o, tz),
        musteriSiparisNo: o.customerOrderNo,
        cizim: o.drawingTrack,
        fiiliYukleme: dayOf(o.actualShipDate, tz),
        ...offerSummary(o.offers),
        profil: o.profile ? { asama: o.profile.stage, alisGunu: dayOf(o.profile.pickupDate, 'UTC'), proforma: o.profile.proformaNo, fatura: o.profile.invoiceNo, odeme: dayOf(o.profile.paidAt, 'UTC'), teslim: dayOf(o.profile.deliveredAt, tz) } : undefined,
        onayliYuklemeler: Object.entries(days).map(([gun, v]) => ({ gun, ...v })),
        fgoBelgeleri: o.fgoDocuments.map((d) => ({ tur: d.kind, no: `${d.series}${d.number}`, tarih: dayOf(d.issuedAt, tz), toplam: money(d.total), odenen: money(d.paid), paraBirimi: d.currency })),
        dosyaSayisi: o._count.files, cizimSurumSayisi: o._count.drawings,
        sonNotlar: o.notes.map((n) => ({ tarih: dayOf(n.createdAt, tz), yazan: n.user?.name ?? null, ic: n.internal || undefined, metin: String(n.text ?? '').slice(0, 300) })),
      };
    },
  },

  siparis_camlari: {
    desc: 'Siparişin camları ve metrajı (TAKİP kuralıyla): her teklif satırı için cam türü, en × boy (mm), adet, satır m² (3 ondalık), şekilli / bedelsiz telafi işareti ve CNC / delik işlemleri; toplam cam adedi ve m² — ticari camlar ile bedelsiz telafi camları ayrı. Teklif yoksa müşterinin istediği cam türü ve veriEksik.',
    fields: { siparis_no: ORDER_NO },
    async run(tx, a) {
      if (!a.siparis_no) throw new ToolError('INVALID_ARGS');
      const found = await findOrder(tx, a.siparis_no, {
        orderNo: true, status: true, orderTypeCode: true, customer: { select: { name: true } },
        items: { select: { glassName: true, glassNameRo: true, camAdedi: true } },
        offers: { orderBy: { createdAt: 'desc' }, select: { status: true, currency: true, lines: { orderBy: { sortOrder: 'asc' }, select: { id: true, description: true, descriptionRo: true, enMm: true, boyMm: true, adet: true, unit: true, kind: true, free: true, pieceBase: true, pieceM2: true, compensationId: true, crateFee: true, shaped: true } } } },
      });
      if (!found.order) return found.miss;
      const o = found.order;
      const head = { no: o.orderNo, firma: o.customer?.name ?? null, durum: o.status };
      if (o.orderTypeCode === 'PROFILE_ORDER') return { ...head, tur: 'profil', veriEksik: ['CAM_SIPARISI_DEGIL'] };
      const offer = loadedOffer(o.offers, false);
      const istenen = [...new Set(o.items.map((i) => i.glassName).filter(Boolean))];
      if (!offer || !offer.lines.length) return { ...head, istenenCamlar: istenen, veriEksik: ['TEKLIF_TABLOSU_YOK'] };
      let no = 0;
      const lines = offer.lines.map((l) => {
        const sub = l.kind === 'CNC' || l.kind === 'DELIK';
        const glass = isGlass(l);
        return {
          sira: sub ? undefined : ++no, tur: sub ? l.kind : glass ? 'CAM' : isCrateLine(l) || l.crateFee ? 'SANDIK' : 'DIGER',
          cam: l.description, camRo: l.descriptionRo ?? undefined, en: l.enMm ?? undefined, boy: l.boyMm ?? undefined, adet: l.adet,
          m2: glass ? lineM2(l) : undefined, sekilli: l.shaped || undefined, bedelsizTelafi: l.free && glass ? true : undefined,
          telafi: l.compensationId ? true : undefined, bedelsiz: l.free && !glass ? true : undefined,
        };
      });
      const shown = lines.slice(0, 80);
      return {
        ...head, teklifDurumu: offer.status, teklifGonderildi: offer.status === 'GONDERILDI', istenenCamlar: istenen,
        satirlar: shown, kisaltildi: lines.length > shown.length ? lines.length - shown.length : undefined,
        islemler: { cnc: offer.lines.filter((l) => l.kind === 'CNC').reduce((n, l) => n + l.adet, 0), delik: offer.lines.filter((l) => l.kind === 'DELIK').reduce((n, l) => n + l.adet, 0) },
        camToplami: glassSum(offer.lines),
      };
    },
  },

  yukleme_durumu: {
    desc: 'Bir siparişin yükleme miktarları (TAKİP kuralıyla, cam adedi ve m² 3 ondalık): toplam sipariş, onaylı yüklemelerde fiilen yüklenen (gün gün), ileri güne planlanan / aktarılan ve henüz planlanmamış kalan. Ticari cam ve bedelsiz telafi camı ayrı; düzeltilmiş onaylar geçerli hâliyle.',
    fields: { siparis_no: ORDER_NO },
    async run(tx, a, { tz }) {
      if (!a.siparis_no) throw new ToolError('INVALID_ARGS');
      const found = await findOrder(tx, a.siparis_no, {
        orderNo: true, status: true, onHold: true, orderTypeCode: true, estimatedShipDate: true, actualShipDate: true, customer: { select: { name: true } },
        offers: { orderBy: { createdAt: 'desc' }, select: { status: true, lines: { orderBy: { sortOrder: 'asc' }, select: { id: true, description: true, enMm: true, boyMm: true, adet: true, unit: true, kind: true, free: true, pieceBase: true, pieceM2: true, crateFee: true } } } },
        loadedItems: { select: { confirmationId: true, offerLineId: true, replanId: true, revision: true, status: true, quantity: true, notLoadedReason: true, confirmation: { select: { shipDay: true } } }, take: 2000 },
        replans: { where: { status: 'ACTIVE' }, select: { status: true, quantity: true, shipDay: true, sourceItem: { select: { offerLineId: true } } } },
      });
      if (!found.order) return found.miss;
      const o = found.order;
      const head = { no: o.orderNo, firma: o.customer?.name ?? null, durum: o.status, beklemede: o.onHold || undefined };
      if (o.orderTypeCode === 'PROFILE_ORDER') return { ...head, tur: 'profil', veriEksik: ['CAM_SIPARISI_DEGIL'] };
      const offer = loadedOffer(o.offers, false);
      if (!offer || !offer.lines.length) return { ...head, veriEksik: ['TEKLIF_TABLOSU_YOK'], planlananGun: dayOf(o.actualShipDate ?? o.estimatedShipDate, tz) };
      const items = effectiveItems(o.loadedItems);
      const loadedDaySet = new Set(items.filter((i) => i.status === 'LOADED' && i.quantity > 0).map((i) => dayOf(i.confirmation.shipDay, 'UTC')));
      const parts = loadingParts(o, offer);
      const buckets = { yuklenen: [], planlanan: [], kalanPlansiz: [] };
      for (const p of parts) {
        const k = p.day == null ? 'kalanPlansiz' : items.length && loadedDaySet.has(p.day) ? 'yuklenen' : 'planlanan';
        buckets[k].push(p);
      }
      const sumOf = (ps) => ({ ...glassSum(ps.flatMap((p) => p.lines)), gunler: ps.filter((p) => p.day).map((p) => ({ gun: p.day, ...glassSum(p.lines) })) });
      const notLoaded = items.filter((i) => i.status === 'NOT_LOADED' && i.quantity > 0);
      return {
        ...head, teklifDurumu: offer.status,
        siparisToplami: glassSum(offer.lines),
        yuklenen: sumOf(buckets.yuklenen),
        planlanan: sumOf(buckets.planlanan),
        kalanPlansiz: glassSum(buckets.kalanPlansiz.flatMap((p) => p.lines)),
        onayliYuklemeVar: items.length > 0,
        yuklenmeyenKayitlari: notLoaded.length ? notLoaded.map((i) => ({ gun: dayOf(i.confirmation.shipDay, 'UTC'), adet: i.quantity, neden: i.notLoadedReason })).slice(0, 20) : undefined,
        not: 'Planlanan: onaylı yükleme yoksa siparişin yükleme günü, varsa ileri güne aktarılan kalan.',
      };
    },
  },

  yukleme_gunu: {
    desc: 'Tek yükleme gününün miktarları (TAKİP kuralıyla): gün onaylandıysa fiilen YÜKLENEN (ve yüklenmeyen), onaylanmadıysa PLANLANAN; firma → sipariş: cam adedi ve m² (3 ondalık), ticari ve bedelsiz telafi ayrı; plana girmeyen siparişler ve nedeni; o günün sandık sayısı (her sandık bir kez).',
    fields: { gun: { type: 'day', desc: 'Yükleme günü' } },
    async run(tx, a, { tz, now }) {
      const day = a.gun ?? localDay(now, tz);
      const confirmed = await loadConfirmation(tx, day);
      const plan = confirmed ? null : await previewLoading(tx, day);
      const orders = confirmed ? confirmed.orders : plan.orders;
      const itemM2 = (i) => Number(i.m2 ?? 0);
      const firms = new Map();
      const all = [];
      for (const o of orders) {
        const done = o.items.filter((i) => i.status === 'LOADED');
        const missing = o.items.filter((i) => i.status === 'NOT_LOADED');
        all.push(...done);
        const row = { no: o.orderNo, ...glassSum(done, itemM2), ...(missing.length ? { yuklenmeyen: glassSum(missing, itemM2).toplam } : {}), ...(o.replanFrom?.length ? { aktarilanKalan: o.replanFrom } : {}) };
        const f = firms.get(o.customerName) ?? [];
        f.push(row);
        firms.set(o.customerName, f);
      }
      const crates = await tx.crate.findMany({ where: { shipDay: shipDayDate(day) }, select: { id: true, netAgirlik: true, brutAgirlik: true, daraKg: true } });
      const ids = new Set(crates.map((c) => c.id));
      return {
        gun: day, durum: confirmed ? 'ONAYLANDI' : 'PLANLANDI', anlam: confirmed ? 'Miktarlar fiilen yüklenen' : 'Miktarlar planlanan (yükleme henüz onaylanmadı)',
        toplam: glassSum(all, itemM2),
        firmalar: [...firms].map(([firma, siparisler]) => ({ firma, siparisler: siparisler.slice(0, 40) })).slice(0, 40),
        planaGirmeyen: plan?.skipped?.length ? plan.skipped.slice(0, 30).map((s) => ({ no: s.orderNo, neden: s.reason, gun: s.day ?? undefined })) : undefined,
        sandik: { sayi: ids.size, girilenNetKg: crates.some((c) => c.netAgirlik != null) ? Math.round(crates.reduce((t, c) => t + Number(c.netAgirlik ?? 0), 0)) : null },
      };
    },
  },

  sandiklar: {
    desc: 'Sandıklar: bir siparişin ya da bir yükleme gününün (isteğe bağlı firma) sandıkları — sandık no, gün, sandığın sahibi firma, ölçü (mm), net / brüt kg, not ve içindeki siparişler (başka firmanın misafir yükü işaretli). Her sandık bir kez sayılır.',
    fields: {
      siparis_no: ORDER_NO,
      gun: { type: 'day', desc: 'Yükleme günü' },
      firma: { type: 'string', max: 60, desc: 'Firma adı (parçası) ya da 3 harfli kod (gün ile)' },
    },
    async run(tx, a, { tz }) {
      if (!a.siparis_no && !a.gun) throw new ToolError('INVALID_ARGS');
      let order = null;
      if (a.siparis_no) {
        const found = await findOrder(tx, a.siparis_no, { id: true, orderNo: true, estimatedShipDate: true, customer: { select: { name: true } } });
        if (!found.order) return found.miss;
        order = found.order;
      }
      const and = [];
      if (order) and.push({ OR: [{ orders: { some: { orderId: order.id } } }, { orderId: order.id }] });
      if (a.gun) and.push({ shipDay: shipDayDate(a.gun) });
      if (a.firma) and.push({ OR: [{ customer: customerWhere(a.firma) }, { orders: { some: { order: { customer: customerWhere(a.firma) } } } }] });
      const rows = await tx.crate.findMany({
        where: { AND: and }, orderBy: [{ shipDay: 'asc' }, { crateNo: 'asc' }], take: 200,
        select: {
          id: true, crateNo: true, shipDay: true, lengthMm: true, widthMm: true, heightMm: true, dimensions: true, netAgirlik: true, brutAgirlik: true, daraKg: true, note: true, customerId: true,
          customer: { select: { name: true } },
          order: { select: { orderNo: true, customerId: true, customer: { select: { name: true } } } },
          orders: { select: { order: { select: { orderNo: true, status: true, customerId: true, customer: { select: { name: true } } } } } },
        },
      });
      const seen = new Map();
      for (const c of rows) if (!seen.has(c.id)) seen.set(c.id, c);
      const crates = [...seen.values()].map((c) => {
        const links = new Map();
        for (const x of [...c.orders.map((co) => co.order), ...(c.order ? [c.order] : [])]) {
          if (!links.has(x.orderNo)) links.set(x.orderNo, { no: x.orderNo, firma: x.customer?.name ?? null, misafir: c.customerId && x.customerId !== c.customerId ? true : undefined, iptal: x.status === 'IPTAL' || undefined });
        }
        const net = c.netAgirlik == null ? null : Number(c.netAgirlik);
        const brut = c.brutAgirlik != null ? Number(c.brutAgirlik) : net != null ? net + Number(c.daraKg ?? 0) : null;
        return {
          sandikNo: c.crateNo, gun: dayOf(c.shipDay, 'UTC'), sahibiFirma: c.customer?.name ?? c.order?.customer?.name ?? null,
          olcuMm: c.lengthMm || c.widthMm || c.heightMm ? `${c.lengthMm ?? '?'}×${c.widthMm ?? '?'}×${c.heightMm ?? '?'}` : c.dimensions ?? null,
          netKg: net, brutKg: brut, not: c.note ? String(c.note).slice(0, 200) : undefined, siparisler: [...links.values()],
        };
      });
      const weighed = crates.filter((c) => c.netKg != null);
      return {
        ...(order ? { siparis: order.orderNo, firma: order.customer?.name ?? null, planlananGun: dayOf(order.estimatedShipDate, tz) } : {}),
        ...(a.gun ? { gun: a.gun } : {}),
        sandikSayisi: crates.length,
        girilenNetKg: weighed.length ? Math.round(weighed.reduce((t, c) => t + c.netKg, 0)) : null,
        brutKg: weighed.length ? Math.round(weighed.reduce((t, c) => t + (c.brutKg ?? 0), 0)) : null,
        agirligiGirilmemis: crates.length - weighed.length,
        sandiklar: crates.slice(0, 60),
        ...(crates.length === 0 ? { veriEksik: ['SANDIK_GIRILMEMIS'] } : {}),
      };
    },
  },

  musteri_bilgi: {
    desc: 'Firma bilgisi: kodu, iletişim, açık sipariş sayıları ve FGO belgelerine göre açık alacak (para birimine göre).',
    fields: { firma: { type: 'string', max: 60, desc: 'Firma adı (parçası) ya da 3 harfli firma kodu' } },
    async run(tx, a) {
      if (!a.firma) throw new ToolError('INVALID_ARGS');
      const list = await tx.customer.findMany({ where: customerWhere(a.firma), take: 5, orderBy: { name: 'asc' }, select: { id: true, name: true, prefix: true, contactPerson: true, phone: true, email: true, city: true } });
      if (!list.length) return { bulunamadi: a.firma };
      const out = [];
      for (const c of list) {
        const [byStatus, docs] = await Promise.all([
          tx.order.groupBy({ by: ['status'], where: { customerId: c.id, removedAt: null }, _count: { _all: true } }),
          tx.fgoDocument.findMany({
            where: { OR: [{ order: { customerId: c.id } }, { batch: { customerId: c.id } }] },
            select: { id: true, orderId: true, batchId: true, kind: true, currency: true, total: true, paid: true, batch: { select: { parentId: true, chainOrderId: true, lines: { select: { ronGross: true, refBatchId: true, refDocId: true } } } } },
            take: 1000,
          }),
        ]);
        out.push({
          ad: c.name, kod: c.prefix, yetkili: c.contactPerson, telefon: c.phone, eposta: c.email, sehir: c.city,
          siparisler: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
          alacak: receivables(docs).sums,
        });
      }
      return { firmalar: out };
    },
  },

  yukleme_plani: {
    desc: 'Tarih aralığındaki (en çok 31 gün) planlanan yüklemeler: gün → firma → siparişler; günün yüklemesi onaylandı mı.',
    fields: {
      baslangic: { type: 'day', desc: 'Başlangıç günü' },
      bitis: { type: 'day', desc: 'Bitiş günü (boşsa başlangıçla aynı)' },
    },
    async run(tx, a, { tz, now }) {
      const from = a.baslangic ?? localDay(now, tz);
      const to = a.bitis ?? from;
      if (to < from || Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 31 * 86_400_000) throw new ToolError('RANGE');
      const [orders, confirmations] = await Promise.all([
        tx.order.findMany({
          where: { removedAt: null, onHold: false, status: { not: 'IPTAL' }, orderTypeCode: 'GLASS_ORDER', estimatedShipDate: { gte: new Date(`${addDays(from, -1)}T00:00:00Z`), lt: new Date(`${addDays(to, 2)}T00:00:00Z`) } },
          select: { orderNo: true, status: true, title: true, estimatedShipDate: true, customer: { select: { name: true } } },
          orderBy: { orderNo: 'asc' }, take: 1000,
        }),
        tx.loadingConfirmation.findMany({ where: { shipDay: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } }, select: { shipDay: true } }),
      ]);
      const confirmed = new Set(confirmations.map((c) => dayOf(c.shipDay, 'UTC')));
      const days = new Map();
      for (const o of orders) {
        const d = dayOf(o.estimatedShipDate, tz);
        if (d < from || d > to) continue;
        if (!days.has(d)) days.set(d, new Map());
        const firms = days.get(d);
        const f = o.customer?.name ?? '?';
        if (!firms.has(f)) firms.set(f, []);
        firms.get(f).push({ no: o.orderNo, durum: o.status, baslik: o.title ?? undefined });
      }
      return {
        aralik: { from, to },
        gunler: [...days.keys()].sort().map((d) => ({
          gun: d, onaylandi: confirmed.has(d), siparisSayisi: [...days.get(d).values()].reduce((s, l) => s + l.length, 0),
          firmalar: [...days.get(d)].map(([firma, siparisler]) => ({ firma, siparisler: siparisler.slice(0, 30) })),
        })),
      };
    },
  },

  stok_durumu: {
    desc: 'Profil / aksesuar stoğu: mevcut, rezerve (onaylı ama depoya gitmemiş siparişler), kritik eşik. Ürün kodu verilmezse kritik ya da eksik ürünler.',
    fields: {
      urun_kodu: { type: 'string', max: 30, pattern: /^[A-Za-z0-9._-]+$/, desc: 'Ürün kodu (parçası), ör. FBL115, GK15' },
      sadece_kritik: { type: 'bool', desc: 'true: yalnızca kritik eşikte / altında ya da rezerveyi karşılamayan ürünler' },
    },
    async run(tx, a) {
      const products = await tx.profileProduct.findMany({
        where: { isActive: true, ...(a.urun_kodu ? { code: { contains: a.urun_kodu, mode: 'insensitive' } } : {}) },
        select: { id: true, code: true, nameTr: true, unitCode: true, criticalStock: true }, orderBy: { code: 'asc' }, take: 500,
      });
      const ids = products.map((p) => p.id);
      const [levels, reserved] = await Promise.all([stockLevels(tx, ids), reservedLevels(tx, ids)]);
      let rows = products.map((p) => {
        const stok = levels.get(p.id) ?? 0;
        const rez = reserved.get(p.id) ?? 0;
        return { kod: p.code, ad: p.nameTr, birim: p.unitCode, stok, rezerve: rez, kritikEsik: p.criticalStock, kritik: p.criticalStock != null && stok <= p.criticalStock, eksik: stok < rez ? rez - stok : 0 };
      });
      if (a.sadece_kritik || !a.urun_kodu) rows = rows.filter((r) => r.kritik || r.eksik > 0 || r.stok < 0);
      return { toplam: rows.length, urunler: rows.slice(0, 40) };
    },
  },

  alacaklar: {
    desc: 'Müşteri alacakları (FGO belgelerinden; proforma / avans / fatura zinciri tek borç sayılır): para birimine göre toplam, ödenen, kalan ve en çok kalanı olan firmalar.',
    fields: { tur: { type: 'enum', values: ['cam', 'profil'], desc: 'Cam ya da profil (boşsa ikisi)' } },
    async run(tx, a) {
      const kinds = a.tur ? [ORDER_TYPES[a.tur]] : ['GLASS_ORDER', 'PROFILE_ORDER'];
      const out = {};
      for (const k of kinds) {
        const docs = await listDocuments(tx, k);
        const { shares, sums } = receivables(docs);
        const byFirm = new Map();
        for (const d of docs) {
          const s = shares.get(d.id);
          if (!s?.rest) continue;
          const firm = d.order?.customer?.name ?? d.batch?.customer?.name ?? '?';
          const key = `${firm}|${d.currency}`;
          byFirm.set(key, (byFirm.get(key) ?? 0) + s.rest);
        }
        out[k === 'GLASS_ORDER' ? 'cam' : 'profil'] = {
          toplamlar: sums,
          enCokKalan: [...byFirm].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([key, kalan]) => ({ firma: key.split('|')[0], paraBirimi: key.split('|')[1], kalan: money(kalan) })),
          not: docs.length >= 500 ? 'Yalnızca son 500 belge sayıldı' : undefined,
        };
      }
      return out;
    },
  },

  fatura_belgeleri: {
    desc: 'FGO belgeleri (proforma, avans faturası, fatura): en yeniler önce, en çok 20. Firma ya da sipariş no ile süzülebilir.',
    fields: {
      firma: { type: 'string', max: 60, desc: 'Firma adı (parçası) ya da 3 harfli kod' },
      siparis_no: ORDER_NO,
      tur: { type: 'enum', values: ['PROFORMA', 'ADVANCE', 'INVOICE'], desc: 'Belge türü' },
      adet: { type: 'int', min: 1, max: MAX_ROWS, desc: 'En çok kaç belge' },
    },
    async run(tx, a, { tz }) {
      const where = {
        ...(a.tur ? { kind: a.tur } : {}),
        ...(a.siparis_no ? { order: { orderNo: { equals: normalizeOrderNo(a.siparis_no), mode: 'insensitive' } } } : {}),
        ...(a.firma ? { OR: [{ order: { customer: customerWhere(a.firma) } }, { batch: { customer: customerWhere(a.firma) } }] } : {}),
      };
      const rows = await tx.fgoDocument.findMany({
        where, orderBy: { issuedAt: 'desc' }, take: a.adet ?? 10,
        select: { kind: true, series: true, number: true, issuedAt: true, total: true, paid: true, currency: true, order: { select: { orderNo: true, customer: { select: { name: true } } } }, batch: { select: { customer: { select: { name: true } } } } },
      });
      return {
        belgeler: rows.map((d) => ({
          tur: d.kind, no: `${d.series}${d.number}`, tarih: dayOf(d.issuedAt, tz), firma: d.order?.customer?.name ?? d.batch?.customer?.name ?? null,
          siparis: d.order?.orderNo ?? null, toplam: money(d.total), odenen: money(d.paid), paraBirimi: d.currency,
        })),
      };
    },
  },

  faturalanmamis_yuklemeler: {
    desc: 'Yüklemesi onaylanmış ama nihai faturası kesilmemiş (hatırlatma günü gelmiş) siparişler.',
    fields: {},
    async run(tx, _a, { now }) {
      const rows = await uninvoicedLoadings(tx, { now });
      return {
        toplam: rows.length,
        siparisler: rows.slice(0, 30).map((r) => ({ siparis: r.orderNo, firma: r.customerName ?? r.customer?.name ?? null, yuklemeGunu: r.day, gecenGun: r.daysSince, not: r.note ?? undefined })),
      };
    },
  },

  tedarikci_hesaplari: {
    desc: 'Tedarikçi hesapları: para birimine göre borç (kesin siparişler), ödenen ve kalan; fiyatı eksik sipariş sayısı.',
    fields: {},
    async run(tx) {
      const rows = await supplierAccounts(tx);
      return { tedarikciler: rows.slice(0, 30) };
    },
  },
};

/** Modele verilen araç tanımları (OpenAI uyumlu "tools") */
export function toolDefinitions() {
  return Object.entries(TOOLS).map(([name, t]) => ({ type: 'function', function: { name, description: t.desc, parameters: jsonSchema(t.fields) } }));
}

/**
 * Bir araç çağrısı: ad ve argüman doğrulanır, araç salt okunur işlemin içinde çalışır. Hata → sabit kod (ham hata metni
 * modele / kullanıcıya gitmez).
 * @param {(fn: (tx: any) => Promise<any>) => Promise<any>} readOnly  server/assistant/readonly.js → readOnly(db)
 */
export async function runTool(readOnly, name, rawArgs, ctx) {
  if (!Object.hasOwn(TOOLS, name)) return { hata: 'UNKNOWN_TOOL' };
  let args;
  try {
    args = validateArgs(TOOLS[name].fields, typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs ?? {});
  } catch {
    return { hata: 'INVALID_ARGS' };
  }
  try {
    return await readOnly((tx) => TOOLS[name].run(tx, args, ctx));
  } catch (e) {
    return { hata: e instanceof ToolError ? e.code : 'QUERY_FAILED' };
  }
}
