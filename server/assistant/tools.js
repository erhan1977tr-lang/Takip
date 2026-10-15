// TAKİP Telegram asistanı — SALT OKUNUR sorgu araçları (3.84.0, karar 278).
//
// Yapay zekâ modeli veritabanına DOĞRUDAN erişemez ve SQL yazamaz: yalnızca buradaki sabit araçları, doğrulanmış
// parametrelerle çağırabilir. Her araç:
//   - parametrelerini kendi şemasıyla doğrular (bilinmeyen alan, uzun metin, geçersiz tarih / sayı → INVALID_ARGS);
//   - yalnızca okur (findMany / findFirst / count / groupBy / aggregate ve mevcut salt okunur servisler) ve bunu
//     PostgreSQL READ ONLY işleminin içinde yapar (server/assistant/readonly.js) — bir yazma denemesi veritabanında reddedilir;
//   - sonuç satır sayısını sınırlar (MAX_ROWS) ve kısa, düz JSON döner (modelin bağlamı ve maliyet sınırlı kalır).
// Hiçbir araç sipariş / teklif / fatura / FGO / stok / e-posta / bildirim yazmaz, dış servise gitmez (FGO, BNR, SMTP yok).
import { listDocuments, receivables } from '../accounting/receivables.js';
import { uninvoicedLoadings } from '../accounting/uninvoiced.js';
import { reservedLevels, stockLevels } from '../profile/stock.js';
import { supplierAccounts } from '../suppliers/service.js';
import { localDay } from '../profile/dates.js';
import { effectiveItems } from '../loading/confirmation.js';

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
        ...(a.metin ? { OR: ['orderNo', 'title', 'customerOrderNo'].map((f) => ({ [f]: { contains: a.metin, mode: 'insensitive' } })) } : {}),
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
    desc: 'Tek siparişin ayrıntısı: durum, firma, tarihler, teklif tutarları (müşteri ve fabrika), çizim durumu, yükleme onayları, FGO belgeleri, son notlar.',
    fields: { siparis_no: { type: 'string', max: 30, pattern: /^[A-Za-z0-9-]+$/, desc: 'Sipariş numarası (ör. GLA68, GLAP12, ABC124-T)' } },
    async run(tx, a, { tz }) {
      if (!a.siparis_no) throw new ToolError('INVALID_ARGS');
      const o = await tx.order.findFirst({
        where: { orderNo: { equals: a.siparis_no, mode: 'insensitive' }, removedAt: null },
        orderBy: { createdAt: 'desc' },
        select: {
          ...ORDER_LIST_SELECT, id: true, customerOrderNo: true, drawingTrack: true, actualShipDate: true, slaDeadline: true,
          offers: { select: { status: true, sentAt: true, createdAt: true, currency: true, amount: true, offerAmount: true } },
          profile: { select: { stage: true, pickupDate: true, proformaNo: true, invoiceNo: true, deliveredAt: true, paidAt: true } },
          fgoDocuments: { select: { kind: true, series: true, number: true, issuedAt: true, total: true, paid: true, currency: true }, orderBy: { issuedAt: 'asc' } },
          loadedItems: { select: { id: true, confirmationId: true, offerLineId: true, replanId: true, scopeKey: true, revision: true, status: true, quantity: true, confirmation: { select: { shipDay: true } } }, take: 500 },
          notes: { orderBy: { createdAt: 'desc' }, take: 5, select: { createdAt: true, text: true, internal: true, user: { select: { name: true } } } },
          _count: { select: { files: true, drawings: true } },
        },
      });
      if (!o) return { bulunamadi: a.siparis_no };
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
      siparis_no: { type: 'string', max: 30, pattern: /^[A-Za-z0-9-]+$/, desc: 'Sipariş numarası' },
      tur: { type: 'enum', values: ['PROFORMA', 'ADVANCE', 'INVOICE'], desc: 'Belge türü' },
      adet: { type: 'int', min: 1, max: MAX_ROWS, desc: 'En çok kaç belge' },
    },
    async run(tx, a, { tz }) {
      const where = {
        ...(a.tur ? { kind: a.tur } : {}),
        ...(a.siparis_no ? { order: { orderNo: { equals: a.siparis_no, mode: 'insensitive' } } } : {}),
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
