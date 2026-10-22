// Nakliye listesi (Yüklemeler → "Nakliye Listesi", yönetici / satış / denetimci): bir yükleme gününün sandıkları,
// FİZİKSEL SANDIK ETİKETİNE göre gruplu (karar 253; müşteri adına göre değil). Yalnızca mevcut kayıtlardan okunur — Crate (Yüklemeler sekmesinde girilen sandıklar)
// ve o gün yüklenecek CAM siparişleri (gün = Order.actualShipDate ?? estimatedShipDate; satış/yönetici tarihi
// değiştirdiyse yeni gün). Ayrı nakliye kaydı tutulmaz. Fiyat bilgisi yoktur.
// Satış ekipleri (4.3.0, karar 300): liste SATIŞÇIYA göre bölümlüdür — satışçı → sandık etiketi grupları ve sandıklar →
// satışçının sandık adedi / ağırlık ara toplamı; en altta genel toplam. Satış yalnızca kendi bölümünü alır (veri süzülür).
import { CRATE_TARE_KG, dayKey } from '../orders/loading.js';
import { dayDate } from './crates.js';
import { sortByOrderNo } from '../orders/order-number.js';

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
 * Sandığın fiziksel etiketi (karar 253): sandıktaki KENDİ siparişlerinin sandık etiketi (sipariş etiketi, boşsa firmanın
 * varsayılanı — Order.sandikEtiket ?? Customer.sandikEtiket); kendi siparişi bağlı değilse firmanın varsayılan etiketi.
 * Etiket hiç girilmemişse firma kodu, o da yoksa firma adı (görene göre — satışa maskeli). Sandıktaki siparişlerin
 * etiketleri farklıysa hepsi (" / " ile) yazılır — tahmin edilmez.
 * @param {{ customerId: string | null, customer?: { prefix?: string | null, name?: string, sandikEtiket?: string | null } | null,
 *   orders?: { order: { customerId: string, sandikEtiket?: string | null } }[] }} c
 * @param {(name: string) => string} [label]
 * @param {{ fallback?: boolean }} [o]  fallback: false → girilmiş etiket yoksa boş (firma kodu / adı yazılmaz)
 */
export function crateLabel(c, label = (name) => name, { fallback = true } = {}) {
  const firm = String(c.customer?.sandikEtiket ?? '').trim();
  const own = (c.orders ?? []).map((x) => x.order).filter((o) => o.customerId === c.customerId);
  const labels = [...new Set(own.map((o) => String(o.sandikEtiket ?? '').trim() || firm).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (labels.length) return labels.join(' / ');
  // fallback: false — yalnızca girilmiş etiket (müşteri ekranı: ev sahibi firmanın kodu / adı yazılmaz)
  if (!fallback) return firm;
  return firm || c.customer?.prefix || label(c.customer?.name ?? '');
}

/**
 * Saf: sandıklar ve siparişlerden liste. Grup = FİZİKSEL SANDIK ETİKETİ (crateLabel; karar 253) — aynı etiketli sandıklar
 * (farklı firmalardan olsalar da) tek grupta; grup başına sandık adedi ve ara toplam ağırlık; sandıklar numaraya göre.
 * Her fiziksel sandık bir satırdır ve bir kez sayılır (birden çok siparişle ilişkili olsa da).
 * Sandığı girilmemiş müşterilerin siparişleri "sandık ölçüsü girilmemiş" olarak ayrıca listelenir.
 * Sandıkta başka müşterinin siparişi varsa (fiziksel yerleşim, karar 103, 124) sandığın NOTUNDA "misafir yük" olarak
 * gösterilir (guests: firma + sipariş no); sandık ev sahibinin grubunda kalır, ağırlığı sandığın ağırlığıdır. Gerçek bir
 * ev sahibi sandığına bağlı misafir sipariş "sandığı girilmemiş" sayılmaz; bağı olmayan (sandığı henüz seçilmemiş ya da
 * kaydı eksik) sipariş uyarıda KALIR. Ev sahibi firması seçilmiş ama sandığı henüz seçilmemiş siparişler `waiting`te
 * de döner. Misafir için sandık uydurulmaz. Firma adı görene göre yazılır (label: satışa maskeli).
 * @param {{ crateNo: number, lengthMm: number | null, widthMm: number | null, heightMm: number | null, dimensions?: string | null,
 *   netAgirlik?: unknown, brutAgirlik?: unknown, daraKg?: unknown, note: string | null, customerId: string | null,
 *   customer: { prefix: string | null, name: string } | null,
 *   orders?: { order: { id?: string, orderNo: string, customerId: string, customer?: { prefix: string | null, name: string } | null } }[] }[]} crates
 * @param {{ id?: string, orderNo: string, customerId: string, guestHostId?: string | null, guestHost?: { prefix: string | null, name: string } | null, replan?: boolean }[]} orders
 * @param {{ label?: (name: string) => string }} [o]  label: firma adının görene göre yazımı (varsayılan: olduğu gibi)
 */
export function buildTransportList(crates, orders, { label = (name) => name } = {}) {
  const groups = new Map();
  const withCrates = new Set(); // o gün sandığı girilmiş firmalar
  const placed = new Set(); // başka müşterinin sandığına konmuş siparişler
  for (const c of crates) {
    if (!c.customerId) continue;
    withCrates.add(c.customerId);
    const code = crateLabel(c, label);
    const g = groups.get(code) ?? { code, crates: [], totalKg: 0 };
    const weight = crateWeight(c);
    const dims = [c.lengthMm, c.widthMm, c.heightMm];
    const guests = (c.orders ?? []).map((x) => x.order).filter((o) => o.customerId !== c.customerId);
    for (const o of guests) placed.add(o.orderNo);
    g.crates.push({
      crateNo: c.crateNo,
      dims: dims.some((d) => d != null) ? dims.map((d) => (d == null ? '—' : String(d))).join(' × ') : (c.dimensions ?? ''),
      weight, note: c.note ?? '',
      // Misafir yük: bu sandıkta giden başka firma camı (yalnızca fiziksel bilgi — firma, sipariş no)
      guests: guests.map((o) => ({ orderNo: o.orderNo, code: o.customer?.prefix || '', firm: label(o.customer?.name ?? '') })).sort((a, b) => a.orderNo.localeCompare(b.orderNo)),
    });
    if (weight != null) g.totalKg = Math.round((g.totalKg + weight) * 100) / 100;
    groups.set(code, g);
  }
  const list = [...groups.values()].sort((a, b) => a.code.localeCompare(b.code));
  for (const g of list) g.crates.sort((a, b) => a.crateNo - b.crateNo);
  const missing = [...new Set(orders.filter((o) => !withCrates.has(o.customerId) && !placed.has(o.orderNo)).map((o) => o.orderNo))];
  // Özel durum: ev sahibi firma seçilmiş, sandık henüz seçilmemiş (sipariş başına bir kez). Aktarılan kalan (replan) yalnızca
  // ev sahibi firmanın o gün de yüklemesi varsa bekleyen sayılır — yoksa kalan kendi firmasının yüküyle gider.
  const hostHere = (id) => withCrates.has(id) || orders.some((o) => o.customerId === id);
  const waiting = [...new Map(orders.filter((o) => o.guestHost && !placed.has(o.orderNo) && (!o.replan || hostHere(o.guestHostId)))
    .map((o) => [o.orderNo, { orderNo: o.orderNo, host: o.guestHost.prefix || label(o.guestHost.name) }])).values()];
  return {
    groups: list, waiting,
    crateCount: list.reduce((s, g) => s + g.crates.length, 0),
    totalKg: Math.round(list.reduce((s, g) => s + g.totalKg, 0) * 100) / 100,
    missing,
  };
}

/**
 * Saf: satışçı bölümleri (karar 300). Sandık ve sipariş, satışçısına (salesUserId; boş = sorumlusu olmayan / eski kayıt)
 * göre ayrılır; her bölüm kendi içinde buildTransportList kuralıyla (etiket grupları, eksik sandık, bekleyen misafir yük).
 * Sandık aynı satışçının siparişlerini taşıdığından bölümler kesişmez; her sandık bir kez sayılır. Bölümler satışçı adına
 * göre (sorumlusuz en sonda); genel toplam bütün bölümlerin toplamıdır (tek liste üzerinden — aynı kural).
 * @param {Parameters<typeof buildTransportList>[0]} crates  @param {Parameters<typeof buildTransportList>[1]} orders
 * @param {{ label?: (name: string) => string, teamName?: (id: string | null) => string }} [o]
 */
export function buildTransportSections(crates, orders, { label = (name) => name, teamName = (id) => id ?? '' } = {}) {
  const teamOf = (x) => x.salesUserId ?? null;
  const ids = [...new Set([...crates.filter((c) => c.customerId).map(teamOf), ...orders.map(teamOf)])];
  const sections = ids.map((id) => ({
    team: id, name: teamName(id),
    ...buildTransportList(crates.filter((c) => teamOf(c) === id), orders.filter((o) => teamOf(o) === id), { label }),
  })).sort((a, b) => (a.team == null) - (b.team == null) || a.name.localeCompare(b.name));
  const all = buildTransportList(crates, orders, { label });
  return { ...all, sections, crateCount: sections.reduce((n, x) => n + x.crateCount, 0), totalKg: Math.round(sections.reduce((n, x) => n + x.totalKg, 0) * 100) / 100 };
}

/**
 * Veritabanından: günün sandıkları (firması olan) ve o gün yüklenecek CAM siparişleri (iptal ve beklemedekiler hariç —
 * Yüklemeler sayfasıyla aynı kural).
 * @param {any} db
 * @param {string} day "YYYY-MM-DD"
 * @param {{ label?: (name: string) => string, salesUserId?: string, teamName?: (id: string | null) => string }} [o]
 *   label: firma adının görene göre yazımı (satışa maskeli) · salesUserId: yalnızca bu satışçının sandık ve siparişleri ·
 *   teamName: verilirse liste satışçı bölümleriyle döner (buildTransportSections)
 */
export async function transportList(db, day, { label = (name) => name, salesUserId, teamName } = {}) {
  const d = dayDate(day);
  // Satış (karar 300): yalnızca kendi sandıkları ve siparişleri
  const team = salesUserId === undefined ? {} : { salesUserId: salesUserId || '__none__' };
  const window = { gte: new Date(d.getTime() - 86_400_000), lt: new Date(d.getTime() + 2 * 86_400_000) };
  const [crates, orders, replanned] = await Promise.all([
    db.crate.findMany({
      where: { shipDay: d, customerId: { not: null }, ...team },
      include: {
        customer: { select: { prefix: true, name: true, sandikEtiket: true } },
        // İptal edilmiş / kaldırılmış siparişin sandık bağı listeye girmez (AUD-15, P7)
        orders: { where: { order: { status: { not: 'IPTAL' }, removedAt: null } }, select: { order: { select: { orderNo: true, customerId: true, sandikEtiket: true, customer: { select: { prefix: true, name: true } } } } } },
      },
    }),
    db.order.findMany({
      where: {
        orderTypeCode: 'GLASS_ORDER', onHold: false, status: { not: 'IPTAL' }, removedAt: null, ...team,
        OR: [{ actualShipDate: window }, { actualShipDate: null, estimatedShipDate: window }],
      },
      select: { orderNo: true, customerId: true, salesUserId: true, actualShipDate: true, estimatedShipDate: true, guestHostId: true, guestHost: { select: { prefix: true, name: true } } },
      orderBy: [{ customerId: 'asc' }, { orderNo: 'asc' }],
    }).then((rows) => sortByOrderNo(rows, (o) => o.orderNo, (o) => o.customerId)),
    // Yüklenmeyen kalanı bu güne aktarılmış siparişler de o günün yükündedir (karar 102)
    db.order.findMany({
      where: { orderTypeCode: 'GLASS_ORDER', onHold: false, status: { not: 'IPTAL' }, removedAt: null, ...team, replans: { some: { shipDay: d, status: { not: 'CANCELLED' } } } },
      select: { orderNo: true, customerId: true, salesUserId: true, guestHostId: true, guestHost: { select: { prefix: true, name: true } } },
    }),
  ]);
  const own = orders.filter((o) => dayKey(o.actualShipDate ?? o.estimatedShipDate) === day);
  const list = [...own, ...replanned.filter((o) => !own.some((x) => x.orderNo === o.orderNo)).map((o) => ({ ...o, replan: true }))];
  if (!teamName) return buildTransportList(crates, list, { label });
  return buildTransportSections(crates, list, { label, teamName });
}
