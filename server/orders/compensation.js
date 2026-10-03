// Telafi / kırık cam (Aşama 9, karar 108–109): var olan bir siparişin bir camının YENİDEN üretilmesi.
//
//   Yüklenmeyen camdan (NOT_LOADED — fiziksel yükleme sonucu) AYRI bir kavramdır: telafi yüklemeden önce de, yüklemeden
//   sonra da, teslimden haftalar sonra da açılabilir; kaynağın yüklenmemiş olması gerekmez. İkisi yalnızca istenirse
//   birbirine bağlanır (aşağıda "yüklenmeyen camla ilişki").
//
//   Kaynak: müşteriye GÖNDERİLMİŞ teklifin bir fiziksel cam satırı (m², ölçülü). Kaynak satır ve sipariş DEĞİŞMEZ.
//   Telafi camı kaynağın kayıtlı bilgisinden kopyalanır (cam, ölçü, ağırlık, liste fiyatı, ona ait CNC / delik
//   satırları adetle orantılı) — güncel fiyat tablosu okunmaz.
//
//   Fiyat kararı (iki kademeli fiyat, karar 4 — satış müşteri fiyatını GÖRMEZ):
//     NORMAL — kaynağın kayıtlı fiyatları aynen (satış fiyatı ve müşteri fiyatı)
//     FREE   — Bedelsiz: müşteri fiyatı 0; fabrika maliyeti (satış fiyatı) DURUR → kârlılıkta maliyetiyle görünür
//     CUSTOM — yönetici MÜŞTERİ fiyatını değiştirir (maliyet durur); satış kendi SATIŞ fiyatını değiştirir (müşteri
//              fiyatını yönetici girer). Normalden farklı her karar "Önemli kararlar"a ve denetim kaydına yazılır.
//
//   Hedef — iki seçenek her zaman vardır:
//     EXISTING — aynı müşterinin ileri tarihli bir siparişine TELAFİ satırı olarak eklenir
//                · teklifi henüz müşteriye gitmemişse satırlar o taslağa eklenir (sonrası olağan akış)
//                · teklifi müşterideyse: yönetici → teklifin yeni sürümü (müşteriye gider); satış → karar yöneticinin
//                  onayını bekler (PENDING) — müşteriye giden teklifi yalnızca yönetici değiştirir (kritik teklif kuralı)
//     NEW      — yeni telafi siparişi: kök siparişin numarası + "-T" (ABC124-T, sonra -T2, -T3 …), seçilen ileri yükleme
//                günüyle. Teklifi yöneticinin fiyat onayı sırasına düşer; sonrası olağan akış.
//   Eklendikten sonra AYRI bir telafi akışı YOKTUR: satırlar olağan teklif satırıdır (yalnızca compensationId işaretli),
//   sipariş olağan cam siparişidir — çizim, yükleme, sandık, onay, fatura, kârlılık, bildirim aynı kurallarla işler.
//
//   Tekrar engeli: firma kilidi (sipariş numarasıyla aynı kilit), formun tek kullanımlık anahtarı (requestKey benzersiz),
//   telafi siparişi numarasında veritabanı tekilliği. Aynı satır için ikinci telafi ENGELLENMEZ (meşru olabilir);
//   önceki telafiler ekranda gösterilir.
import { can } from '../auth/permissions.js';
import { atOfferPrice, offerProblems, parseDateOnly } from './rules.js';
import { dayKey } from './loading.js';
import { enqueueOutbox, writeAudit, writeHistory } from './journal.js';
import { amounts, lineData, refreshSla } from './transitions.js';
import { effectiveItems, isGlassLine, itemKey, shipDayDate } from '../loading/confirmation.js';
import { compensatedByScope } from '../loading/compensated.js';
import { coverageOf } from '../glass/batch.js';

export const COMP_MODES = ['NORMAL', 'FREE', 'CUSTOM'];
const OPEN_STATUSES = ['YENI', 'HAZIRLANIYOR', 'URETIMDE'];
const GLASS_FGO = 'FGO_GLASS';
const MAX_PRICE = 1_000_000;

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const int = (v) => Math.max(0, Math.trunc(Number(v) || 0));
const numOrNull = (v) => (v == null ? null : Number(v));
const dmy = (day) => String(day).slice(0, 10).split('-').reverse().join('.');
const isSub = (l) => l.kind === 'CNC' || l.kind === 'DELIK';
const fail = (code, extra = {}) => ({ ok: false, code, ...extra });

/** Telafi siparişi numarası: kök sipariş + "-T" (ilk), "-T2", "-T3" … */
export const compOrderNo = (rootNo, seq) => `${rootNo}-T${seq > 1 ? seq : ''}`;

/** Müşteriye gönderilmiş son teklif (yoksa null) */
export const sentOfferOf = (order) => order.offers.find((o) => o.status === 'GONDERILDI') ?? null;

/**
 * Telafi edilebilir satırlar: fiziksel cam satırı (tür CAM, birim m², ölçülü) ve ONA ait işlem satırları (altındaki
 * CNC / delik). Sandık parası, adetle fiyatlanan diğer satırlar ve tek başına CNC / delik satırı telafi edilemez.
 * @param {any[]} lines  teklif satırları, sıralı
 * @returns {{ line: any, subs: any[] }[]}
 */
export function compensableLines(lines) {
  const out = [];
  let cur = null;
  for (const l of lines) {
    if (isSub(l)) {
      if (cur) cur.subs.push(l);
      continue;
    }
    cur = isGlassLine(l) && int(l.enMm) > 0 && int(l.boyMm) > 0 && int(l.adet) > 0 ? { line: l, subs: [] } : null;
    if (cur) out.push(cur);
  }
  return out;
}

/**
 * İşlem satırının (CNC / delik) telafi adedi: cam adediyle orantılı. Tam bölünmüyorsa yukarı yuvarlanır (üretim eksik
 * işlem görmesin); adet teklifte olağan yolla düzeltilebilir.
 */
export function scaleOps(adet, sourceQty, quantity) {
  const total = int(adet) * int(quantity);
  const base = int(sourceQty);
  if (!(total > 0) || !(base > 0)) return 0;
  return total % base === 0 ? total / base : Math.ceil(total / base);
}

function parsePrice(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) ? round2(n) : NaN;
}

/**
 * Fiyat kararı. admin: müşteri fiyatına karar verir (tier CUSTOMER); satış: satış fiyatına (tier SALES).
 *   unitCost   — telafi satırının satış fiyatı (= fabrika maliyeti). Bedelsizde ve yöneticinin kararında kaynağınkiyle aynı.
 *   offerPrice — telafi satırının müşteri fiyatı; satış fiyatı değiştirdiyse null (yönetici girer).
 *   changed    — normal fiyattan farklı (Bedelsiz ya da değiştirilmiş): "Önemli kararlar"a düşer.
 * @param {{ admin: boolean, mode: string, price?: unknown, line: { unitPrice: unknown, offerPrice?: unknown, free?: boolean } }} p
 * @returns {{ ok: true, mode: 'NORMAL' | 'FREE' | 'CUSTOM', tier: 'CUSTOMER' | 'SALES', free: boolean, unitCost: number, offerPrice: number | null, normalCost: number, normalPrice: number | null, changed: boolean } | { ok: false, code: 'BAD_MODE' | 'BAD_PRICE' }}
 */
export function priceDecision({ admin, mode, price = null, line }) {
  if (!COMP_MODES.includes(mode)) return fail('BAD_MODE');
  const srcFree = !!line.free;
  const normalCost = round2(Number(line.unitPrice ?? 0));
  const normalPrice = srcFree ? 0 : line.offerPrice == null ? null : round2(Number(line.offerPrice));
  const tier = admin ? 'CUSTOMER' : 'SALES';
  const base = { ok: true, tier, normalCost, normalPrice };
  const normal = { ...base, mode: 'NORMAL', free: srcFree, unitCost: normalCost, offerPrice: normalPrice, changed: false };
  if (mode === 'NORMAL') return normal;
  if (mode === 'FREE') return { ...base, mode: 'FREE', free: true, unitCost: normalCost, offerPrice: 0, changed: !srcFree };
  const p = parsePrice(price);
  // 0 fiyat "Bedelsiz" seçeneğiyle verilir; burada pozitif fiyat beklenir
  if (p == null || Number.isNaN(p) || !(p > 0) || p > MAX_PRICE) return fail('BAD_PRICE');
  const same = (a, b) => a != null && b != null && Math.abs(a - b) < 0.005;
  if (admin) return !srcFree && same(p, normalPrice) ? normal : { ...base, mode: 'CUSTOM', free: false, unitCost: normalCost, offerPrice: p, changed: true };
  return !srcFree && same(p, normalCost) ? normal : { ...base, mode: 'CUSTOM', free: false, unitCost: p, offerPrice: null, changed: true };
}

const COPY = ['description', 'descriptionRo', 'poz', 'enMm', 'boyMm', 'unit', 'kind', 'glassProductId', 'listPrice'];
const copyOf = (l) => ({ ...Object.fromEntries(COPY.map((k) => [k, l[k] ?? null])), weightKgM2: l.weightKgM2 == null ? null : Number(l.weightKgM2), listPrice: numOrNull(l.listPrice) });

/**
 * Telafi satırları: cam satırı (adet = telafi adedi, kararın fiyatlarıyla) + ona ait işlem satırları (adet orantılı;
 * kendi kayıtlı fiyatlarıyla, bedelsiz telafide bedelsiz). Üretim bilgisi kaynaktan kopyalanır; hiçbir şey yeniden
 * hesaplanmaz / fiyat tablosundan okunmaz.
 * @returns {object[]}  teklif satırı verisi (sıra numarası ve teklif kimliği yazılırken eklenir)
 */
export function compensationLines({ line, subs = [], quantity, decision }) {
  const glass = { ...copyOf(line), adet: quantity, unitPrice: decision.unitCost, offerPrice: decision.free ? 0 : decision.offerPrice, free: decision.free };
  const freeAll = decision.mode === 'FREE';
  const ops = subs.map((s) => ({
    ...copyOf(s), adet: scaleOps(s.adet, line.adet, quantity), unitPrice: round2(Number(s.unitPrice ?? 0)),
    offerPrice: freeAll ? 0 : numOrNull(s.offerPrice), free: freeAll || !!s.free,
  })).filter((s) => s.adet > 0);
  return [glass, ...ops];
}

/**
 * Bir sipariş telafi HEDEFİ olabilir mi (aynı müşterinin ileri tarihli, açık cam siparişi)?
 *   via DRAFT: teklif henüz müşteriye gitmemiş — satırlar taslağa eklenir · via SENT: teklif müşteride — yeni sürüm gerekir.
 * @param {any} o  sipariş (offers en yeniden eskiye)
 * @param {{ sourceOrderId: string, customerId: string, currency: string, today: string, day: string | null, locked: boolean, coverage: unknown }} c
 *   locked: yükleme günü onaylanmış ya da siparişin bir onayda kalemi var · coverage: FGO belgesi / kuyrukta istek / etkin parti
 * @returns {{ ok: true, via: 'DRAFT' | 'SENT' } | { ok: false, reason: 'SAME_ORDER' | 'OTHER_CUSTOMER' | 'NOT_GLASS' | 'CLOSED' | 'ON_HOLD' | 'NOT_FUTURE' | 'LOADED' | 'NO_OFFER' | 'CURRENCY' | 'BILLING' }}
 */
export function destinationCheck(o, { sourceOrderId, customerId, currency, today, day, locked, coverage }) {
  const no = (reason) => ({ ok: false, reason });
  if (o.id === sourceOrderId) return no('SAME_ORDER');
  if (o.customerId !== customerId) return no('OTHER_CUSTOMER');
  if (o.orderTypeCode !== 'GLASS_ORDER') return no('NOT_GLASS');
  if (o.removedAt || !OPEN_STATUSES.includes(o.status)) return no('CLOSED');
  if (o.onHold) return no('ON_HOLD');
  if (!day || !(day > today)) return no('NOT_FUTURE');
  if (locked) return no('LOADED');
  const offer = o.offers[0] ?? null;
  // Teklifi olmayan (henüz incelenmemiş) siparişe eklenmez: taslak teklif siparişin kendi camlarıyla açılmalı.
  // İki fiyat sütunu olmayan eski teklif de hedef olamaz.
  if (!offer || (offer.status === 'GONDERILDI' && offer.offerAmount == null)) return no('NO_OFFER');
  if (offer.currency !== currency) return no('CURRENCY');
  if (coverage) return no('BILLING');
  return { ok: true, via: offer.status === 'GONDERILDI' ? 'SENT' : 'DRAFT' };
}

const DEST_INCLUDE = {
  offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } },
  fgoDocuments: { select: { kind: true, series: true, number: true }, orderBy: { issuedAt: 'asc' } },
  billingBatchOrders: { where: { activeKey: { not: null } }, select: { activeKey: true, batch: { select: { document: { select: { series: true, number: true } } } } } },
};
const loadingDay = (o) => {
  const d = o.actualShipDate ?? o.estimatedShipDate;
  return d ? dayKey(d) : null;
};

/** Aday siparişlerin hedef denetimi için gereken ortak bilgiler (onaylı günler, onayda kalemi olanlar, kuyruktaki belge istekleri) */
async function destFacts(db, orders) {
  const ids = orders.map((o) => o.id);
  const days = [...new Set(orders.map(loadingDay).filter(Boolean))];
  const [confirmed, items, jobs] = await Promise.all([
    days.length ? db.loadingConfirmation.findMany({ where: { shipDay: { in: days.map(shipDayDate) } }, select: { shipDay: true } }) : [],
    ids.length ? db.loadingConfirmationItem.findMany({ where: { orderId: { in: ids } }, select: { orderId: true }, distinct: ['orderId'] }) : [],
    ids.length ? db.notificationOutbox.findMany({ where: { orderId: { in: ids }, type: GLASS_FGO, status: 'PENDING' }, select: { orderId: true } }) : [],
  ]);
  return {
    confirmedDays: new Set(confirmed.map((c) => c.shipDay.toISOString().slice(0, 10))),
    inConfirmation: new Set(items.map((i) => i.orderId)),
    pendingJobs: new Set(jobs.map((j) => j.orderId)),
  };
}
const checkWith = (o, facts, src, today) => {
  const day = loadingDay(o);
  return destinationCheck(o, {
    sourceOrderId: src.id, customerId: src.customerId, currency: src.currency, today, day,
    locked: (day != null && facts.confirmedDays.has(day)) || facts.inConfirmation.has(o.id),
    coverage: coverageOf(o, facts.pendingJobs.has(o.id)),
  });
};

/**
 * Hedef seçimi için: aynı müşterinin İLERİ tarihli açık cam siparişleri, sipariş numarası ve yükleme günüyle.
 * Uygun olmayanlar nedeniyle birlikte döner (ekranda seçilemez gösterilir). via: SENT + satış → yönetici onayı bekler.
 * @param {any} db
 * @param {{ source: { id: string, customerId: string, currency: string }, now?: Date }} p
 * @returns {Promise<{ id: string, orderNo: string, day: string, via: 'DRAFT' | 'SENT' | null, reason: string | null }[]>}
 */
export async function compensationDestinations(db, { source, now = new Date() }) {
  const today = dayKey(now);
  const from = new Date(`${today}T00:00:00Z`);
  const rows = await db.order.findMany({
    where: {
      customerId: source.customerId, orderTypeCode: 'GLASS_ORDER', removedAt: null, id: { not: source.id }, status: { in: OPEN_STATUSES },
      OR: [{ actualShipDate: { gte: from } }, { actualShipDate: null, estimatedShipDate: { gte: from } }],
    },
    include: DEST_INCLUDE,
    orderBy: [{ estimatedShipDate: 'asc' }, { customerOrderNo: 'asc' }, { compSeq: 'asc' }],
    take: 100,
  });
  const future = rows.filter((o) => (loadingDay(o) ?? '') > today);
  const facts = await destFacts(db, future);
  return future.map((o) => {
    const c = checkWith(o, facts, source, today);
    return { id: o.id, orderNo: o.orderNo, day: loadingDay(o), via: c.ok ? c.via : null, reason: c.ok ? null : c.reason };
  });
}

/**
 * Kaynak siparişin yüklenmeyen camları (satır başına): hangi onayda kaç adedi serbest (aktarılmamış, telafisi açılmamış).
 * Telafi bu kalemle ilişkilendirilirse o adet ayrıca ileri güne aktarılamaz.
 * @param {any} db  @param {string} orderId
 * @returns {Promise<{ itemId: string, lineId: string, day: string, free: number }[]>}
 */
export async function notLoadedLinks(db, orderId) {
  const all = await db.loadingConfirmationItem.findMany({
    where: { orderId, replanId: null, offerLineId: { not: null } },
    select: {
      id: true, confirmationId: true, offerLineId: true, replanId: true, revision: true, status: true, quantity: true,
      confirmation: { select: { shipDay: true } }, replans: { where: { status: { not: 'CANCELLED' } }, select: { quantity: true } },
    },
  });
  if (all.length === 0) return [];
  const comps = new Map();
  for (const id of new Set(all.map((x) => x.confirmationId))) comps.set(id, await compensatedByScope(db, id));
  const out = [];
  for (const it of effectiveItems(all)) {
    if (it.status !== 'NOT_LOADED' || !(it.quantity > 0)) continue;
    const key = itemKey(it);
    // Aktarımlar kapsamın bütün satırlarından sayılır (düzeltmeyle yerini yenisi alan satıra bağlı aktarım da kapsamındır)
    const replanned = all.filter((x) => x.confirmationId === it.confirmationId && itemKey(x) === key).flatMap((x) => x.replans).reduce((s, r) => s + r.quantity, 0);
    const free = it.quantity - replanned - (comps.get(it.confirmationId)?.get(key) ?? 0);
    if (free > 0) out.push({ itemId: it.id, lineId: it.offerLineId, day: it.confirmation.shipDay.toISOString().slice(0, 10), free });
  }
  return out;
}

// ---------- kayıt ----------

const lineText = (c) => `${c.quantity} × ${String(c.description).slice(0, 80)}${c.enMm && c.boyMm ? ` ${c.enMm}×${c.boyMm}` : ''}`;

/** Satırları taslak (müşteriye gitmemiş) teklife ekler; tutarlar yeniden hesaplanır. */
async function appendToDraft(tx, { dest, lines, compensationId }) {
  const offer = dest.offers[0];
  const base = offer.lines.reduce((m, l) => Math.max(m, l.sortOrder), -1) + 1;
  await tx.offerLine.createMany({ data: lines.map((l, i) => ({ ...lineData({ ...l, compensationId }, base + i), offerId: offer.id })) });
  const { amount, offerAmount } = amounts([...offer.lines, ...lines]);
  await tx.offer.update({ where: { id: offer.id }, data: { amount, ...(offer.offerAmount != null || offer.status === 'YONETIMDE' ? { offerAmount } : {}) } });
  return offer.id;
}

/**
 * Müşterideki teklifin YENİ sürümünü açar (yönetici): eski sürüm değişmez; yeni sürüm = eski satırlar + telafi satırları,
 * hemen müşteriye gönderilmiş sayılır (update_offer ile aynı kural). Her telafi satırının müşteri fiyatı olmalı.
 * @returns {Promise<{ ok: true, offerId: string } | { ok: false, code: 'PRICE_REQUIRED' }>}
 */
async function addSentVersion(tx, { dest, lines, compensationId, actor, now }) {
  const prev = dest.offers[0];
  if (offerProblems(atOfferPrice(lines)).some((p) => p.code === 'missing_prices')) return fail('PRICE_REQUIRED');
  const all = [...prev.lines, ...lines.map((l) => ({ ...l, compensationId }))];
  const { amount, offerAmount } = amounts(all);
  const created = await tx.offer.create({
    data: {
      orderId: dest.id, createdById: actor.id, currency: prev.currency, amount, offerAmount, priceTableId: prev.priceTableId ?? null,
      status: 'GONDERILDI', statusSince: now, sentAt: now,
      lines: { create: all.map((l, i) => lineData(l, i)) },
    },
  });
  await tx.price.upsert({
    where: { orderId: dest.id },
    create: { orderId: dest.id, amount: offerAmount, setById: actor.id },
    update: { amount: offerAmount, setById: actor.id, setAt: now },
  });
  // Müşteri teklifin güncellendiğini görür (olağan olay; notta tutar yok)
  await writeHistory(tx, { orderId: dest.id, event: 'OFFER_UPDATED', from: dest.status, to: dest.status, actorId: actor.id, note: null });
  await enqueueOutbox(tx, { type: 'ORDER_OFFER_UPDATED', orderId: dest.id, payload: { from: dest.status, to: dest.status, actorId: actor.id } });
  return { ok: true, offerId: created.id };
}

/** Hedef siparişi kilit altında yükler ve güncel durumuyla denetler. */
async function loadDestination(tx, destId, src, today) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`glass-billing:${destId}`}, 0))`;
  const dest = await tx.order.findUnique({ where: { id: destId }, include: DEST_INCLUDE });
  if (!dest) return fail('DEST_NOT_FOUND');
  const check = checkWith(dest, await destFacts(tx, [dest]), src, today);
  return check.ok ? { ok: true, dest, via: check.via } : fail(`DEST_${check.reason}`);
}

/**
 * Telafi camı oluşturur (satış ve yönetici — OFFER_PREPARE; yetki burada, sunucuda denetlenir).
 * @param {any} db
 * @param {{
 *   orderId: string, lineId: string, quantity: unknown, mode: string, price?: unknown,
 *   dest: { type: 'EXISTING', orderId: string } | { type: 'NEW', day: string },
 *   notLoadedItemId?: string | null, requestKey: string, confirm: boolean,
 *   actor: { id: string, role: string, ip?: string | null }, now?: Date,
 * }} p
 *   confirm: son özetteki açık onay ("Yukarıdaki kararı onaylıyorum") — onaysız istek reddedilir
 * @returns {Promise<
 *   { ok: true, compensationId: string, status: 'APPLIED' | 'PENDING', destOrderId: string, destOrderNo: string, created: boolean, duplicate: boolean }
 *   | { ok: false, code: string }>}
 */
export async function createCompensation(db, { orderId, lineId, quantity, mode, price = null, dest, notLoadedItemId = null, requestKey, confirm, actor, now = new Date() }) {
  if (!can(actor?.role, 'OFFER_PREPARE')) return fail('FORBIDDEN');
  const admin = can(actor.role, 'OFFER_SEND');
  if (!confirm) return fail('CONFIRM_REQUIRED');
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(String(requestKey ?? ''))) return fail('BAD_REQUEST');
  const qty = Number(String(quantity ?? '').trim());
  if (!Number.isInteger(qty) || qty <= 0) return fail('BAD_QUANTITY');
  const today = dayKey(now);
  const isNew = dest?.type === 'NEW';
  if (!isNew && dest?.type !== 'EXISTING') return fail('BAD_DEST');
  if (isNew && !parseDateOnly(dest.day)) return fail('BAD_DAY');
  // Yeni telafi siparişi yalnızca GELECEK bir yükleme gününe açılır
  if (isNew && !(dest.day > today)) return fail('NOT_FUTURE');
  const head = await db.order.findUnique({ where: { id: String(orderId ?? '') }, select: { id: true, customerId: true } });
  if (!head) return fail('NOT_FOUND');

  let pendingNotice = null;
  let result;
  try {
    result = await db.$transaction(async (tx) => {
      // Kilit sırası sabit: yükleme (aktarım kapasitesiyle ortak) → firma (sipariş numarası ve tekrar engeli) → hedef sipariş
      if (notLoadedItemId) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('loading-confirmation', 0))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`order-no:${head.customerId}`}, 0))`;
      // Çift tıklama / yinelenen istek: aynı anahtarın kaydı varsa yeni kayıt açılmaz, ilk sonuç döner
      const dup = await tx.compensation.findUnique({ where: { requestKey }, include: { destOrder: { select: { orderNo: true } } } });
      if (dup) return { ok: true, compensationId: dup.id, status: dup.status, destOrderId: dup.destOrderId, destOrderNo: dup.destOrder?.orderNo ?? '', created: false, duplicate: true };

      const src = await tx.order.findUnique({ where: { id: head.id }, include: { offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } } } });
      if (!src || src.orderTypeCode !== 'GLASS_ORDER' || src.removedAt) return fail('NOT_FOUND');
      if (src.status === 'IPTAL') return fail('ORDER_CANCELLED');
      const sent = sentOfferOf(src);
      // Fiyatların kaynağı müşteriye gönderilmiş teklif (iki fiyat sütunlu); yoksa telafi açılmaz
      if (!sent || sent.offerAmount == null) return fail('NO_SENT_OFFER');
      const group = compensableLines(sent.lines).find((g) => g.line.id === String(lineId ?? ''));
      if (!group) return fail('BAD_LINE');
      if (qty > group.line.adet) return fail('BAD_QUANTITY');
      const decision = priceDecision({ admin, mode, price, line: group.line });
      if (!decision.ok) return decision;
      const lines = compensationLines({ line: group.line, subs: group.subs, quantity: qty, decision });
      const source = { id: src.id, customerId: src.customerId, currency: sent.currency };

      // Yüklenmeyen camla ilişki (isteğe bağlı): kalem bu satırın GEÇERLİ yüklenmeyen kalemi olmalı; adet serbest kalanı aşamaz
      let notLoadedScope = null;
      let item = null;
      if (notLoadedItemId) {
        item = await tx.loadingConfirmationItem.findUnique({ where: { id: String(notLoadedItemId) } });
        if (!item || item.orderId !== src.id || item.status !== 'NOT_LOADED' || item.replanId || item.offerLineId !== group.line.id) return fail('BAD_LINK');
        const key = itemKey(item);
        const scope = effectiveItems((await tx.loadingConfirmationItem.findMany({ where: { confirmationId: item.confirmationId, orderId: item.orderId } })).filter((x) => itemKey(x) === key));
        if (!scope.some((x) => x.id === item.id)) return fail('BAD_LINK');
        const notLoaded = scope.filter((x) => x.status === 'NOT_LOADED').reduce((s, x) => s + x.quantity, 0);
        const replanned = await tx.loadingReplan.aggregate({
          where: { status: { not: 'CANCELLED' }, sourceItem: { confirmationId: item.confirmationId, offerLineId: item.offerLineId, replanId: null } }, _sum: { quantity: true },
        });
        const free = notLoaded - (replanned._sum.quantity ?? 0) - ((await compensatedByScope(tx, item.confirmationId)).get(key) ?? 0);
        if (qty > free) return fail('NOT_LOADED_CAPACITY');
        notLoadedScope = `${item.confirmationId}|${key}`;
      }

      const base = {
        requestKey, sourceOrderId: src.id, sourceOfferId: sent.id, sourceLineId: group.line.id, customerId: src.customerId,
        description: group.line.description, descriptionRo: group.line.descriptionRo ?? null, enMm: group.line.enMm ?? null, boyMm: group.line.boyMm ?? null,
        quantity: qty, currency: sent.currency,
        priceMode: decision.mode, priceTier: decision.tier, normalCost: decision.normalCost.toFixed(2),
        normalPrice: decision.normalPrice == null ? null : decision.normalPrice.toFixed(2),
        unitCost: decision.unitCost.toFixed(2), offerPrice: decision.offerPrice == null ? null : decision.offerPrice.toFixed(2), free: decision.free,
        sourceItemId: item?.id ?? null, notLoadedScope, createdById: actor.id, createdAt: now,
      };

      let comp, destOrder, via, status = 'APPLIED';
      if (isNew) {
        const shipDate = parseDateOnly(dest.day);
        if (await tx.loadingConfirmation.findUnique({ where: { shipDay: shipDayDate(dest.day) }, select: { id: true } })) return fail('DAY_CONFIRMED');
        // Numara KÖK siparişten türer (telafinin telafisi de kökün sırasını izler): ABC124-T, -T2, -T3 …
        const root = src.compOfId ? await tx.order.findUnique({ where: { id: src.compOfId } }) : src;
        if (!root) return fail('NOT_FOUND');
        const last = await tx.order.aggregate({ where: { customerId: src.customerId, orderTypeCode: 'GLASS_ORDER', customerOrderNo: root.customerOrderNo }, _max: { compSeq: true } });
        const seq = (last._max.compSeq ?? 0) + 1;
        destOrder = await tx.order.create({
          data: {
            orderNo: compOrderNo(root.orderNo, seq), customerOrderNo: root.customerOrderNo, compSeq: seq, compOfId: root.id, orderTypeCode: 'GLASS_ORDER',
            title: src.title, customerId: src.customerId, createdById: actor.id,
            // Çizim gerekmiyor (aynı cam yeniden üretilir; gerekirse satış / yönetici çizime gönderir); teklif yöneticinin fiyat onayında
            status: 'HAZIRLANIYOR', drawingTrack: 'YOK', estimatedShipDate: shipDate,
            camEtiket: src.camEtiket ?? null, sandikEtiket: src.sandikEtiket ?? null,
            items: { create: [{ glassProductId: group.line.glassProductId ?? null, glassName: group.line.description, glassNameRo: group.line.descriptionRo ?? null, glassWeightKgM2: group.line.weightKgM2 ?? null, camAdedi: qty }] },
          },
        });
        comp = await tx.compensation.create({ data: { ...base, status, destType: 'NEW', destOrderId: destOrder.id, loadingDay: shipDayDate(dest.day) } });
        const { amount, offerAmount } = amounts(lines);
        await tx.offer.create({
          data: {
            orderId: destOrder.id, createdById: actor.id, status: 'YONETIMDE', statusSince: now, currency: sent.currency, priceTableId: sent.priceTableId ?? null, amount, offerAmount,
            lines: { create: lines.map((l, i) => lineData({ ...l, compensationId: comp.id }, i)) },
          },
        });
        await writeHistory(tx, { orderId: destOrder.id, event: 'CREATED', from: null, to: 'HAZIRLANIYOR', actorId: actor.id });
        await refreshSla(tx, destOrder.id);
        // Yeni sipariş yöneticinin fiyat onayı sırasında: olağan "teklif yöneticide" olayı (ayrı bir bildirim türü yok)
        await enqueueOutbox(tx, { type: 'ORDER_OFFER_SUBMITTED', orderId: destOrder.id, payload: { from: null, to: 'HAZIRLANIYOR', actorId: actor.id } });
        via = 'NEW';
      } else {
        const d = await loadDestination(tx, String(dest.orderId ?? ''), source, today);
        if (!d.ok) return d;
        destOrder = d.dest;
        via = d.via;
        // Müşterideki teklifi yalnızca yönetici değiştirir: satışın kararı yöneticinin onayını bekler
        if (via === 'SENT' && !admin) status = 'PENDING';
        comp = await tx.compensation.create({ data: { ...base, status, destType: 'EXISTING', destOrderId: destOrder.id, loadingDay: shipDayDate(loadingDay(destOrder)) } });
        if (status === 'APPLIED') {
          if (via === 'DRAFT') await appendToDraft(tx, { dest: destOrder, lines, compensationId: comp.id });
          else {
            const r = await addSentVersion(tx, { dest: destOrder, lines, compensationId: comp.id, actor, now });
            if (!r.ok) throw Object.assign(new Error(r.code), { compCode: r.code });
          }
          // Sürüm artar: bu siparişin açık bir teklif formu varsa eski satırlarla kaydedemez (CONFLICT)
          await tx.order.update({ where: { id: destOrder.id }, data: { version: { increment: 1 } } });
        }
      }

      const day = isNew ? dest.day : loadingDay(destOrder);
      const text = lineText(base);
      await writeHistory(tx, { orderId: src.id, event: 'COMPENSATION', from: src.status, to: src.status, actorId: actor.id, note: `${text} → ${destOrder.orderNo} / ${dmy(day)}` });
      await writeHistory(tx, {
        orderId: destOrder.id, event: status === 'PENDING' ? 'COMPENSATION_PENDING' : 'COMPENSATION_ADDED', from: destOrder.status, to: destOrder.status, actorId: actor.id,
        note: `${text} ← ${src.orderNo}`,
      });
      const priceInfo = {
        priceMode: decision.mode, priceTier: decision.tier, free: decision.free, priceChanged: decision.changed,
        normalCost: decision.normalCost, normalPrice: decision.normalPrice, unitCost: decision.unitCost, offerPrice: decision.offerPrice,
      };
      await writeAudit(tx, {
        action: 'COMPENSATION_CREATED', entityType: 'Order', entityId: src.id, userId: actor.id,
        details: {
          compensationId: comp.id, status, sourceOrderNo: src.orderNo, sourceOfferId: sent.id, sourceLineId: group.line.id,
          glass: base.description, enMm: base.enMm, boyMm: base.boyMm, quantity: qty, currency: sent.currency, operations: lines.slice(1).map((l) => ({ kind: l.kind, adet: l.adet })),
          ...priceInfo, destType: isNew ? 'NEW' : 'EXISTING', destOrderId: destOrder.id, destOrderNo: destOrder.orderNo, loadingDay: day, via,
          notLoadedItemId: item?.id ?? null, notLoadedScope,
        },
      }, actor);
      // "Önemli kararlar": normalden farklı fiyat (Bedelsiz / değiştirilmiş) ve yöneticinin onayını bekleyen telafi
      const alert = { orderNo: src.orderNo, compensationId: comp.id, currency: sent.currency, glass: text, tier: decision.tier, mode: decision.mode, destOrderNo: destOrder.orderNo, day };
      if (decision.changed) {
        await tx.adminAlert.create({
          data: {
            type: 'COMPENSATION_PRICE', orderId: src.id, createdById: actor.id, createdAt: now,
            details: { ...alert, normal: decision.tier === 'CUSTOMER' ? decision.normalPrice : decision.normalCost, price: decision.free ? 0 : decision.tier === 'CUSTOMER' ? decision.offerPrice : decision.unitCost },
          },
        });
      }
      if (status === 'PENDING') {
        await tx.adminAlert.create({ data: { type: 'COMPENSATION_PENDING', orderId: destOrder.id, createdById: actor.id, createdAt: now, details: alert } });
        pendingNotice = { key: `comp-pending:${comp.id}`, orderId: destOrder.id, qty, ref: src.orderNo };
      }
      return { ok: true, compensationId: comp.id, status, destOrderId: destOrder.id, destOrderNo: destOrder.orderNo, created: isNew, duplicate: false };
    }, { timeout: 30_000, maxWait: 15_000 });
  } catch (e) {
    if (e?.compCode) return fail(e.compCode);
    // Aynı anahtar / aynı telafi numarası aynı anda (kilit dışı bir yoldan): veritabanı engeller
    if (e?.code === 'P2002') return fail('CONFLICT');
    throw e;
  }
  if (result.ok && pendingNotice) await notifyPending(db, pendingNotice);
  return result;
}

/** Yöneticiye: satışın telafi kararı onay bekliyor (uygulama içi bildirim; ayrı bir bildirim sistemi değil — karar 107) */
async function notifyPending(db, { key, orderId, qty, ref }) {
  try {
    const { notifyStaff } = await import('../notifications/inapp.js');
    await notifyStaff(db, { audience: 'admin', key, type: 'COMPENSATION_PENDING', orderId, params: { qty, ref }, link: `/siparisler/${orderId}#kararlar` });
  } catch {
    // Bildirim yazılamaması telafi kaydını düşürmez; karar "Önemli kararlar"da da görünür
  }
}

/**
 * Yönetici, satışın onay bekleyen telafisine karar verir (OFFER_SEND).
 *   approve: satırlar hedef siparişin teklifinin yeni sürümüne eklenir ve müşteriye gider. Müşteri fiyatı kayıtlı
 *            değilse (satış fiyatı değiştirdiyse) yönetici girer; isterse bedelsiz yapar.
 *   reject : telafi reddedilir (kayıt durur); hiçbir teklif değişmez.
 * @param {any} db
 * @param {{ id: string, approve: boolean, price?: unknown, free?: boolean, note?: string | null, actor: { id: string, role: string, ip?: string | null }, now?: Date }} p
 * @returns {Promise<{ ok: true, status: 'APPLIED' | 'REJECTED', destOrderId: string } | { ok: false, code: string }>}
 */
export async function decideCompensation(db, { id, approve, price = null, free = false, note = null, actor, now = new Date() }) {
  if (!can(actor?.role, 'OFFER_SEND')) return fail('FORBIDDEN');
  const head = await db.compensation.findUnique({ where: { id: String(id ?? '') }, select: { id: true, customerId: true } });
  if (!head) return fail('NOT_FOUND');
  const today = dayKey(now);
  const text = String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || null;
  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`order-no:${head.customerId}`}, 0))`;
      const comp = await tx.compensation.findUnique({ where: { id: head.id }, include: { sourceOrder: { select: { id: true, orderNo: true, status: true } } } });
      if (!comp || comp.status !== 'PENDING' || !comp.destOrderId) return fail('NOT_PENDING');
      const close = { decidedById: actor.id, decidedAt: now, decisionNote: text };
      const closeAlerts = () => tx.adminAlert.updateMany({
        where: { type: 'COMPENSATION_PENDING', resolvedAt: null, details: { path: ['compensationId'], equals: comp.id } }, data: { resolvedAt: now, resolvedById: actor.id },
      });
      const label = lineText(comp);
      if (!approve) {
        const dest = await tx.order.findUnique({ where: { id: comp.destOrderId }, select: { id: true, status: true } });
        await tx.compensation.update({ where: { id: comp.id }, data: { status: 'REJECTED', ...close } });
        await closeAlerts();
        for (const o of [comp.sourceOrder, dest]) {
          if (o) await writeHistory(tx, { orderId: o.id, event: 'COMPENSATION_REJECTED', from: o.status, to: o.status, actorId: actor.id, note: text ? `${label} — ${text}` : label });
        }
        await writeAudit(tx, { action: 'COMPENSATION_REJECTED', entityType: 'Order', entityId: comp.sourceOrderId, userId: actor.id, details: { compensationId: comp.id, destOrderId: comp.destOrderId, note: text } }, actor);
        return { ok: true, status: 'REJECTED', destOrderId: comp.destOrderId };
      }
      // Kaynak satır ve ona ait işlem satırları kayıtlı teklif sürümünden (karar anındaki kaynak)
      const offer = await tx.offer.findUnique({ where: { id: comp.sourceOfferId }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
      const group = offer ? compensableLines(offer.lines).find((g) => g.line.id === comp.sourceLineId) : null;
      if (!group) return fail('BAD_LINE');
      const d = await loadDestination(tx, comp.destOrderId, { id: comp.sourceOrderId, customerId: comp.customerId, currency: comp.currency }, today);
      if (!d.ok) return d;
      if (d.via !== 'SENT') return fail('DEST_NO_OFFER');
      // Müşteri fiyatı: yönetici girdiyse o; yoksa kayıtlı karar (satışın "normal" kararında kaynağın müşteri fiyatı)
      const isFree = !!free || comp.free;
      const entered = parsePrice(price);
      if (entered != null && (Number.isNaN(entered) || entered < 0 || entered > MAX_PRICE)) return fail('BAD_PRICE');
      const offerPrice = isFree ? 0 : entered != null ? entered : comp.offerPrice == null ? null : Number(comp.offerPrice);
      if (!isFree && !(offerPrice > 0)) return fail('PRICE_REQUIRED');
      const decision = { mode: isFree ? 'FREE' : 'CUSTOM', free: isFree, unitCost: Number(comp.unitCost), offerPrice };
      const lines = compensationLines({ line: group.line, subs: group.subs, quantity: comp.quantity, decision });
      const r = await addSentVersion(tx, { dest: d.dest, lines, compensationId: comp.id, actor, now });
      if (!r.ok) return r;
      await tx.order.update({ where: { id: d.dest.id }, data: { version: { increment: 1 } } });
      await tx.compensation.update({ where: { id: comp.id }, data: { status: 'APPLIED', free: isFree, offerPrice: offerPrice.toFixed(2), ...close } });
      await closeAlerts();
      await writeHistory(tx, { orderId: d.dest.id, event: 'COMPENSATION_ADDED', from: d.dest.status, to: d.dest.status, actorId: actor.id, note: `${label} ← ${comp.sourceOrder.orderNo}` });
      await writeAudit(tx, {
        action: 'COMPENSATION_APPLIED', entityType: 'Order', entityId: comp.sourceOrderId, userId: actor.id,
        details: { compensationId: comp.id, destOrderId: d.dest.id, destOrderNo: d.dest.orderNo, free: isFree, offerPrice, unitCost: Number(comp.unitCost), normalPrice: numOrNull(comp.normalPrice), note: text },
      }, actor);
      return { ok: true, status: 'APPLIED', destOrderId: d.dest.id };
    }, { timeout: 30_000, maxWait: 15_000 });
  } catch (e) {
    if (e?.code === 'P2002') return fail('CONFLICT');
    throw e;
  }
}
