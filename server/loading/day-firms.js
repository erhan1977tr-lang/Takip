// Yükleme gününün FİRMA tablosu — tek atıf kuralı (Paket 7, karar 186). Saf: veritabanı yok, birim testli. Yükleme sayfası
// (ana tablo, alt siparişler, takvim, liste), "Yükleme Özeti" Excel'i, firma PDF / Excel'i ve firma özeti AYNI işlevi kullanır;
// başka bir yerde firma toplamı / misafir sayısı / sandık ataması hesaplanmaz.
//
// Ticari değerler siparişin SAHİBİ firmada sayılır: sipariş adedi (ayrı sipariş sayısı), cam adedi, CNC, delik, m², fabrika
// satış tutarı ve teklif tutarı (para birimi başına — farklı para birimleri toplanmaz). Misafir sipariş kendi firmasının
// satırında kalır.
// Fiziksel değerler camı TAŞIYAN firmada sayılır: sandık adedi, net ve brüt ağırlık. Taşıyan:
//   1. sipariş o gün başka firmanın sandığına konduysa (CrateOrder — misafir yük) → o sandığın firması;
//   2. yönetici ev sahibi firmayı seçtiyse (Order.guestHostId), sandık henüz seçilmediyse ve ev sahibi o gün yüklüyorsa → ev sahibi
//      (camı ev sahibinin sandıklarıyla gidecek; sahibine tahmini sandık açılmaz);
//   3. diğer her durumda siparişin kendi firması.
// Her sandık yalnızca kendi firmasında (ev sahibinde) sayılır; misafir camın ağırlığı ev sahibinin sandıklarına yazılır
// (girilmiş gerçek ağırlık önce gelir — server/loading/crates.js → groupLoad, mevcut kural). Böylece aynı sandık iki firmanın
// toplamında iki kez sayılmaz ve brüt ağırlık iki kez hesaplanmaz; gün toplamı firmaların toplamıdır.
// Misafir yük (takvimin kırmızı göstergesi, sandık formunun kilidi): 1 ya da 2'deki sipariş; ayrıca ev sahibi firması seçilmiş
// ama ev sahibi o gün yüklemeyen sipariş (bayat ilişki — yönetici güncellemeli; ağırlığı kendi firmasında kalır). Aktarılmış
// kalan (replan satırı), ev sahibi o gün yüklemiyorsa misafir değildir: kendi firmasıyla gider (karar 124).
import { groupLoad } from './crates.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
// m² toplamı groupLoad ile aynı yuvarlamayla (sayfadaki eski toplamlarla birebir aynı sonuç)
const addM2 = (a, b) => Math.round((a + b) * 100) / 100;

/**
 * @typedef {{ metraj: number, camAdet: number, cnc?: number, delik?: number, netKg: number }} EntryLoad
 * @typedef {{ currency: string, sales: number | null, offer: number | null }} EntryMoney
 *   sales: fabrika satış tutarı (görmeyen rolde null) · offer: müşteri teklif tutarı (görmeyen rolde / gönderilmemiş teklifte null)
 * @typedef {{ orderId: string, orderNo: string, customerId: string, customerName: string, guestHostId?: string | null, replan?: boolean,
 *   load: EntryLoad, money?: EntryMoney | null }} DayEntry
 * @typedef {{ id: string, crateNo: number, customerId: string | null, customerName?: string, netAgirlik?: unknown, brutAgirlik?: unknown, daraKg?: unknown, orderIds?: string[] }} DayCrate
 * @typedef {{ orderId: string, crateId: string, crateNo: number, hostId: string, hostName?: string, byHost?: boolean }} DayLink
 *   başka firmanın sandığına konmuş sipariş (CrateOrder; sandığın firması ≠ siparişin firması)
 * @typedef {{ sales: number, offer: number, hasSales: boolean, hasOffer: boolean }} MoneyTotal
 * @typedef {{ hostId: string, hostName: string, crateId: string | null, crateNo: number | null, waiting: boolean, hostHere: boolean, byHost: boolean }} GuestOut
 *   waiting: ev sahibi seçildi, sandık seçilmedi · hostHere: ev sahibinin o gün yüklemesi var
 * @typedef {{ orderId: string, orderNo: string, ownerId: string, ownerName: string, crateId: string | null, crateNo: number | null, waiting: boolean, byHost: boolean }} GuestIn
 * @typedef {{ orders: number, camAdet: number, cnc: number, delik: number, metraj: number, netKg: number, grossKg: number, crates: number,
 *   realCrates: boolean, estimatedCrates: number, estimatedNetKg: number, money: Record<string, MoneyTotal> }} FirmTotal
 */

/**
 * @template {DayEntry} E
 * @typedef {{ entry: E, carrierId: string, guest: GuestOut | null, crateNos: number[] }} FirmRow
 *   carrierId: camı taşıyan firma · guest: misafir yük bilgisi (yoksa null) · crateNos: siparişin kendi firmasındaki sandık numaraları
 */

/**
 * @template {DayEntry} E
 * @template {DayCrate} C
 * @typedef {FirmTotal & { id: string, name: string, rows: FirmRow<E>[], crateList: C[], guestsIn: GuestIn[], guestOrders: number }} DayFirm
 *   rows: firmanın KENDİ siparişleri (ticari) · crateList: firmanın KENDİ sandık kayıtları (fiziksel; crates = sandık ADEDİ) · guestsIn: bu firmanın sandıklarıyla giden
 *   başka firma siparişleri · guestOrders: bu firmanın misafir yük olarak giden sipariş sayısı
 */

/** Para birimi başına tutarları ekler (null = görünmüyor / yok; toplama girmez) */
function addMoney(/** @type {Record<string, MoneyTotal>} */ acc, /** @type {EntryMoney | null | undefined} */ m) {
  if (!m) return;
  const t = (acc[m.currency] ??= { sales: 0, offer: 0, hasSales: false, hasOffer: false });
  if (m.sales != null && Number.isFinite(m.sales)) { t.sales = round2(t.sales + m.sales); t.hasSales = true; }
  if (m.offer != null && Number.isFinite(m.offer)) { t.offer = round2(t.offer + m.offer); t.hasOffer = true; }
}

/** @param {Record<string, MoneyTotal>} acc @param {Record<string, MoneyTotal>} add */
function mergeMoney(acc, add) {
  for (const [cur, v] of Object.entries(add)) {
    const t = (acc[cur] ??= { sales: 0, offer: 0, hasSales: false, hasOffer: false });
    t.sales = round2(t.sales + v.sales);
    t.offer = round2(t.offer + v.offer);
    t.hasSales ||= v.hasSales;
    t.hasOffer ||= v.hasOffer;
  }
}

/**
 * Bir yükleme gününün firma tablosu.
 * @template {DayEntry} E
 * @template {DayCrate} C
 * @param {{ entries: E[], crates?: C[], links?: DayLink[], hostNames?: Map<string, string> }} p
 *   entries: o günün sipariş satırları (planlı siparişler + o güne aktarılmış kalanlar) · crates: o günün sandıkları ·
 *   links: o gün başka firmanın sandığındaki siparişler · hostNames: ev sahibi firma adları (sandığı seçilmemiş misafir için)
 * @returns {{ firms: DayFirm<E, C>[], total: FirmTotal, guestOrders: number }}
 *   guestOrders: o gün misafir yük olarak giden (ayrı) sipariş sayısı — takvimin kırmızı göstergesi
 */
export function dayFirms({ entries, crates = [], links = [], hostNames = new Map() }) {
  /** @type {Map<string, string>} */
  const names = new Map();
  for (const e of entries) names.set(e.customerId, e.customerName);
  for (const c of crates) if (c.customerId && !names.has(c.customerId)) names.set(c.customerId, c.customerName ?? '');
  const present = new Set(names.keys());
  // Sipariş başına ilk misafir sandığı (karar 124: sipariş o gün en çok bir misafir sandıkta durur; eski kayıtta birden çok olabilir)
  /** @type {Map<string, DayLink>} */
  const linkOf = new Map();
  for (const l of [...links].sort((a, b) => a.crateNo - b.crateNo)) if (!linkOf.has(l.orderId)) linkOf.set(l.orderId, l);
  const hostName = (id) => names.get(id) ?? hostNames.get(id) ?? '';

  /** @type {FirmRow<E>[]} */
  const rows = entries.map((e) => {
    const link = linkOf.get(e.orderId);
    const hostHere = e.guestHostId ? present.has(e.guestHostId) : false;
    const waiting = !link && !!e.guestHostId && (!e.replan || hostHere);
    const crateNos = crates.filter((c) => c.customerId === e.customerId && (c.orderIds ?? []).includes(e.orderId)).map((c) => c.crateNo).sort((a, b) => a - b);
    if (link) {
      return { entry: e, carrierId: link.hostId, crateNos, guest: { hostId: link.hostId, hostName: link.hostName ?? hostName(link.hostId), crateId: link.crateId, crateNo: link.crateNo, waiting: false, hostHere: true, byHost: !!link.byHost } };
    }
    if (waiting) {
      const host = /** @type {string} */ (e.guestHostId);
      return { entry: e, carrierId: hostHere ? host : e.customerId, crateNos, guest: { hostId: host, hostName: hostName(host), crateId: null, crateNo: null, waiting: true, hostHere, byHost: true } };
    }
    return { entry: e, carrierId: e.customerId, crateNos, guest: null };
  });

  const firms = [...names.keys()].map((id) => {
    const own = rows.filter((r) => r.entry.customerId === id);
    const carried = rows.filter((r) => r.carrierId === id && r.entry.customerId !== id);
    const firmCrates = crates.filter((c) => c.customerId === id);
    // Fiziksel: kendi siparişlerinden yalnızca bu firmanın taşıdıkları (başkasının sandığıyla gidenin ağırlığı 0) + taşınan misafir cam
    const physical = groupLoad(
      own.map((r) => (r.carrierId === id ? r.entry.load : { ...r.entry.load, netKg: 0 })),
      firmCrates,
      { guestKg: carried.reduce((s, r) => s + r.entry.load.netKg, 0) },
    );
    // Ticari: firmanın kendi siparişlerinin toplamı — alt sipariş tablosunun toplamıyla AYNI işlev (rowsTotal)
    const commercial = rowsTotal(own);
    /** @type {GuestIn[]} */
    const guestsIn = rows.filter((r) => r.guest && r.guest.hostId === id && r.entry.customerId !== id && (r.guest.crateId || r.guest.hostHere)).map((r) => ({
      orderId: r.entry.orderId, orderNo: r.entry.orderNo, ownerId: r.entry.customerId, ownerName: r.entry.customerName,
      crateId: r.guest?.crateId ?? null, crateNo: r.guest?.crateNo ?? null, waiting: !!r.guest?.waiting, byHost: !!r.guest?.byHost,
    }));
    return {
      id, name: names.get(id) ?? '', rows: own, crateList: firmCrates, guestsIn,
      guestOrders: new Set(own.filter((r) => r.guest).map((r) => r.entry.orderId)).size,
      orders: commercial.orders, camAdet: commercial.camAdet, cnc: commercial.cnc, delik: commercial.delik, metraj: commercial.metraj,
      netKg: physical.netKg, grossKg: physical.grossKg, crates: physical.crates, realCrates: physical.realCrates,
      estimatedCrates: physical.estimatedCrates, estimatedNetKg: physical.estimatedNetKg, money: commercial.money,
    };
  }).sort((a, b) => b.metraj - a.metraj || a.name.localeCompare(b.name, 'tr'));

  /** @type {FirmTotal} */
  const total = { orders: 0, camAdet: 0, cnc: 0, delik: 0, metraj: 0, netKg: 0, grossKg: 0, crates: 0, realCrates: false, estimatedCrates: 0, estimatedNetKg: 0, money: {} };
  for (const f of firms) {
    total.orders += f.orders;
    total.camAdet += f.camAdet;
    total.cnc += f.cnc;
    total.delik += f.delik;
    total.metraj = addM2(total.metraj, f.metraj);
    total.netKg += f.netKg;
    total.grossKg += f.grossKg;
    total.crates += f.crates;
    total.realCrates ||= f.realCrates;
    total.estimatedCrates += f.estimatedCrates;
    total.estimatedNetKg += f.estimatedNetKg;
    mergeMoney(total.money, f.money);
  }
  return { firms, total, guestOrders: new Set(rows.filter((r) => r.guest).map((r) => r.entry.orderId)).size };
}

/**
 * Alt siparişlerin toplamı: sipariş adedi (ayrı sipariş), cam, CNC, delik, m² ve para birimi başına tutarlar. Firma satırının
 * ticari değerleri bu işlevden gelir; alt tablonun toplam satırı da aynı işlevi kullanır — ana ve alt toplam her zaman eşittir.
 * @param {{ entry: DayEntry }[]} rows
 * @returns {{ orders: number, camAdet: number, cnc: number, delik: number, metraj: number, money: Record<string, MoneyTotal> }}
 */
export function rowsTotal(rows) {
  /** @type {Record<string, MoneyTotal>} */
  const money = {};
  let camAdet = 0, cnc = 0, delik = 0, metraj = 0;
  for (const { entry } of rows) {
    camAdet += entry.load.camAdet;
    cnc += entry.load.cnc ?? 0;
    delik += entry.load.delik ?? 0;
    metraj = addM2(metraj, entry.load.metraj);
    addMoney(money, entry.money);
  }
  return { orders: new Set(rows.map((r) => r.entry.orderId)).size, camAdet, cnc, delik, metraj, money };
}
