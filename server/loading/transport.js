// Nakliye listesi (Yüklemeler → "Nakliye Listesi", yönetici / satış / denetimci): bir yükleme gününün sandıkları,
// müşteri koduna göre gruplu. Yalnızca mevcut kayıtlardan okunur — Crate (Yüklemeler sekmesinde girilen sandıklar)
// ve o gün yüklenecek CAM siparişleri (gün = Order.actualShipDate ?? estimatedShipDate; satış/yönetici tarihi
// değiştirdiyse yeni gün). Ayrı nakliye kaydı tutulmaz. Fiyat bilgisi yoktur.
import { CRATE_TARE_KG, dayKey } from '../orders/loading.js';
import { dayDate } from './crates.js';

const kg = (v) => (v == null || v === '' ? null : Number(v));

/**
 * Sandığın ağırlığı: girilen brüt; brüt boşsa sistemin kuralı (net + dara, Crate.daraKg); ikisi de yoksa null.
 * @param {{ brutAgirlik?: unknown, netAgirlik?: unknown, daraKg?: unknown }} c
 */
export function crateWeight(c) {
  const gross = kg(c.brutAgirlik);
  if (gross != null) return gross;
  const net = kg(c.netAgirlik);
  return net == null ? null : net + (kg(c.daraKg) ?? CRATE_TARE_KG);
}

/**
 * Saf: sandıklar ve siparişlerden liste. Grup = müşteri kodu (yoksa adı); sandıklar numaraya göre.
 * Sandığı girilmemiş müşterilerin siparişleri "sandık ölçüsü girilmemiş" olarak ayrıca listelenir.
 * Sandıkta başka müşterinin siparişi varsa (fiziksel yerleşim, karar 103) sandığın notuna "+ SİPARİŞ (KOD)" yazılır; sandık
 * ev sahibinin grubunda kalır. Başka müşterinin sandığına konmuş sipariş "sandığı girilmemiş" sayılmaz.
 * @param {{ crateNo: number, lengthMm: number | null, widthMm: number | null, heightMm: number | null, dimensions?: string | null,
 *   netAgirlik?: unknown, brutAgirlik?: unknown, daraKg?: unknown, note: string | null, customerId: string | null,
 *   customer: { prefix: string | null, name: string } | null,
 *   orders?: { order: { id?: string, orderNo: string, customerId: string, customer?: { prefix: string | null, name: string } | null } }[] }[]} crates
 * @param {{ id?: string, orderNo: string, customerId: string }[]} orders
 */
export function buildTransportList(crates, orders) {
  const groups = new Map();
  const placed = new Set(); // başka müşterinin sandığına konmuş siparişler
  for (const c of crates) {
    if (!c.customerId) continue;
    const g = groups.get(c.customerId) ?? { code: c.customer?.prefix || c.customer?.name || '', crates: [], totalKg: 0 };
    const weight = crateWeight(c);
    const dims = [c.lengthMm, c.widthMm, c.heightMm];
    const guests = (c.orders ?? []).map((x) => x.order).filter((o) => o.customerId !== c.customerId);
    for (const o of guests) placed.add(o.orderNo);
    const guestNote = guests.length ? `+ ${guests.map((o) => `${o.orderNo} (${o.customer?.prefix || o.customer?.name || '—'})`).join(', ')}` : '';
    g.crates.push({
      crateNo: c.crateNo,
      dims: dims.some((d) => d != null) ? dims.map((d) => (d == null ? '—' : String(d))).join(' × ') : (c.dimensions ?? ''),
      weight, note: [c.note ?? '', guestNote].filter(Boolean).join(' · '),
    });
    if (weight != null) g.totalKg = Math.round((g.totalKg + weight) * 100) / 100;
    groups.set(c.customerId, g);
  }
  const list = [...groups.values()].sort((a, b) => a.code.localeCompare(b.code));
  for (const g of list) g.crates.sort((a, b) => a.crateNo - b.crateNo);
  const missing = [...new Set(orders.filter((o) => !groups.has(o.customerId) && !placed.has(o.orderNo)).map((o) => o.orderNo))];
  return {
    groups: list,
    crateCount: list.reduce((s, g) => s + g.crates.length, 0),
    totalKg: Math.round(list.reduce((s, g) => s + g.totalKg, 0) * 100) / 100,
    missing,
  };
}

/**
 * Veritabanından: günün sandıkları (firması olan) ve o gün yüklenecek CAM siparişleri (iptal ve beklemedekiler hariç —
 * Yüklemeler sayfasıyla aynı kural).
 * @param {string} day "YYYY-MM-DD"
 */
export async function transportList(db, day) {
  const d = dayDate(day);
  const window = { gte: new Date(d.getTime() - 86_400_000), lt: new Date(d.getTime() + 2 * 86_400_000) };
  const [crates, orders, replanned] = await Promise.all([
    db.crate.findMany({
      where: { shipDay: d, customerId: { not: null } },
      include: {
        customer: { select: { prefix: true, name: true } },
        orders: { select: { order: { select: { orderNo: true, customerId: true, customer: { select: { prefix: true, name: true } } } } } },
      },
    }),
    db.order.findMany({
      where: {
        orderTypeCode: 'GLASS_ORDER', onHold: false, status: { not: 'IPTAL' },
        OR: [{ actualShipDate: window }, { actualShipDate: null, estimatedShipDate: window }],
      },
      select: { orderNo: true, customerId: true, actualShipDate: true, estimatedShipDate: true },
      orderBy: [{ customerId: 'asc' }, { customerOrderNo: 'asc' }],
    }),
    // Yüklenmeyen kalanı bu güne aktarılmış siparişler de o günün yükündedir (karar 102)
    db.order.findMany({
      where: { orderTypeCode: 'GLASS_ORDER', onHold: false, status: { not: 'IPTAL' }, replans: { some: { shipDay: d, status: { not: 'CANCELLED' } } } },
      select: { orderNo: true, customerId: true },
    }),
  ]);
  return buildTransportList(crates, [...orders.filter((o) => dayKey(o.actualShipDate ?? o.estimatedShipDate) === day), ...replanned]);
}
