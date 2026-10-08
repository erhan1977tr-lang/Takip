// Otomatik arşiv (karar 158 — 3.51.1; 3.51.0'daki tarihe bakan otomatik "Yüklendi"nin [karar 156] yerine).
//
//   Yükleme gününden AUTO_ARCHIVE_DAYS (45) gün sonra, FİZİKSEL YÜKLEMESİ KANITLI cam siparişi mevcut arşiv durumuna
//   (ARSIVLENDI — "Yüklenen ve arşiv" sekmesi) geçer. Yeni bir durum ya da işaret yoktur; geçiş iş akışı servisinden geçer
//   (runOrderAction → geçmiş + denetim kaydı, iyimser kilit: aynı sipariş iki kez arşivlenmez).
//
//   Kanıt — tek kural: loadingProof (iş akışı işlemi kayıttan önce aynı kuralı, aynı veritabanı işleminde yeniden uygular):
//     SHIPPED   durum YUKLENDI ve onu bir KİŞİ verdi (satışın "Yüklendi" düğmesi). Yükleme günü: fiili (yoksa planlanan) gün.
//     CONFIRMED durum URETIMDE ve onaylı yükleme(ler) siparişin camını EKSİKSİZ kapsıyor — kanıt yükleme onayıdır, planlanan
//               tarih değil (karar 92): geçerli kalemlerde (effectiveItems) yüklenen cam var; yüklenmeyen her adet ileri bir
//               güne aktarılmış ya da yerine uygulanmış bir telafi açılmış; siparişe onaydan sonra cam eklenmemiş (müşterideki
//               teklifte onaylardakinden fazla cam adedi yok). Yükleme günü: camın yüklendiği SON onaylı gün.
//     Her iki yolda: etkin aktarım (ileri güne planlı, henüz yüklenmemiş cam), açık kalan (aktarılmamış / telafisi uygulanmamış
//     yüklenmemiş cam), bekleme ya da silinmiş sipariş → kanıt YOK; sipariş olduğu gibi kalır.
//   Planlanan tarih kanıt değildir: yükleme onayı olmayan ve bir kişinin "Yüklendi" demediği sipariş hiçbir koşulda
//   kendiliğinden kapanmaz. "Yüklendi" durumu otomatik YAZILMAZ; fiili yükleme günü, sandıklar, yükleme onayı, fatura / FGO
//   belgesi ve teslim kayıtlarına dokunulmaz; bildirim yoktur (ORDER_AUTO_ARCHIVED hiçbir bildirim kuralında değildir).
//
//   Onarım (3.51.0 → 3.51.1): 3.51.0'ın tarihe bakarak "Yüklendi" yaptığı ve hâlâ öyle duran sipariş (son yükleme olayı
//   AUTO_SHIPPED) önce mevcut üretim durumuna geri alınır — kayıtlı, denetimli, tekrarsız (repairAutoShipped); sonra yukarıdaki
//   kural ona da olağan biçimde uygulanır. Bir kişinin sonradan değiştirdiği sipariş (arşivleme, iptal…) olduğu gibi kalır.
import { dayKey } from './loading.js';
import { runOrderAction, WorkflowError } from './transitions.js';
import { effectiveItems, isGlassLine, itemKey, scopeOf } from '../loading/confirmation.js';

export const AUTO_ARCHIVE_DAYS = 45;
/** İşçi bu kuralı saatte bir çalıştırır */
export const AUTO_ARCHIVE_EVERY_MS = 3_600_000;
/** İşçinin kimliği. Kullanıcı isteğinin işlemi yapan bilgisi (lib/actor.ts) bu işaretleri hiçbir zaman taşımaz. */
export const ARCHIVE_ACTOR = Object.freeze({ id: null, role: 'SYSTEM', system: true, autoArchive: true, ip: null });
/** Siparişi "Yüklendi" yapan olaylar: kişinin düğmesi (SHIPPED) ve 3.51.0'ın tarih kuralı (AUTO_SHIPPED) */
export const SHIP_EVENTS = ['SHIPPED', 'AUTO_SHIPPED'];
const ARCHIVABLE = ['YUKLENDI', 'URETIMDE'];
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

/** "YYYY-AA-GG" gününden `days` gün öncesi (takvim günü) */
export function cutoffDay(today, days = AUTO_ARCHIVE_DAYS) {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * @typedef {{ description: string, enMm: number | null, boyMm: number | null, kind: string, unit: string }} GlassKeyed
 * @typedef {{
 *   items: (GlassKeyed & { confirmationId: string, offerLineId: string | null, replanId: string | null, revision: number, status: string, quantity: number, confirmation: { shipDay: Date } })[],
 *   replans: { status: string, quantity: number, sourceItem: { confirmationId: string, offerLineId: string | null, replanId: string | null } }[],
 *   compensated: Map<string, number>,
 *   sent: (GlassKeyed & { adet: number })[] | null,
 *   lastShip: string | null,
 * }} Evidence
 *   items: siparişin bütün onay kalemleri (bütün sıralar) · replans: siparişin bütün aktarımları · compensated: kapsam
 *   ("<onay>|<kapsam>") → yerine UYGULANMIŞ telafi adedi · sent: müşterideki son teklifin satırları (yoksa null) ·
 *   lastShip: siparişi "Yüklendi" yapan son olay (SHIPPED | AUTO_SHIPPED | null)
 * @typedef {{ ok: true, via: 'SHIPPED' | 'CONFIRMED', day: string } | { ok: false, reason: 'NOT_GLASS' | 'REMOVED' | 'ON_HOLD' | 'STATUS' | 'REPLAN_ACTIVE' | 'NOT_LOADED_OPEN' | 'AUTO_SHIPPED' | 'NO_DATE' | 'NOT_CONFIRMED' | 'NOT_IN_LOADING' }} Proof
 */

/** Cam (m²) satırlarının adedi, cam + ölçüye göre (onay kalemi ve teklif satırı aynı anlık kopya alanlarını taşır) */
function glassPieces(rows, qty) {
  const out = new Map();
  for (const r of rows) {
    if (!isGlassLine(r)) continue;
    const k = `${r.description}|${r.enMm ?? ''}|${r.boyMm ?? ''}`;
    out.set(k, (out.get(k) ?? 0) + qty(r));
  }
  return out;
}

/**
 * Fiziksel yükleme kanıtı (saf) — siparişin kendiliğinden arşive geçebilmesinin TEK koşulu.
 * @param {{ orderTypeCode: string, status: string, onHold: boolean, removedAt?: Date | null, actualShipDate?: Date | null, estimatedShipDate?: Date | null }} order
 * @param {Evidence} ev
 * @returns {Proof}
 */
export function loadingProof(order, ev) {
  const no = (reason) => ({ ok: false, reason });
  if (order.orderTypeCode !== 'GLASS_ORDER') return no('NOT_GLASS');
  if (order.removedAt) return no('REMOVED');
  if (order.onHold) return no('ON_HOLD');
  if (!ARCHIVABLE.includes(order.status)) return no('STATUS');
  // İleri güne aktarılmış, henüz yüklenmemiş cam: yükleme bitmedi
  if (ev.replans.some((r) => r.status === 'ACTIVE')) return no('REPLAN_ACTIVE');
  const eff = effectiveItems(ev.items);
  // Açık kalan: kapsamın geçerli yüklenmeyen adedi − vazgeçilmemiş aktarımlar − yerine uygulanmış telafiler. Aktarımla yeniden
  // yüklenen kalan kendi onayında kendi kalemleriyle yer alır (zincir: kalem → aktarım → kalem …) ve aynı kuralla denetlenir.
  const open = new Map();
  for (const i of eff) if (i.status === 'NOT_LOADED' && i.quantity > 0) open.set(scopeOf(i), (open.get(scopeOf(i)) ?? 0) + i.quantity);
  for (const r of ev.replans) {
    const k = `${r.sourceItem.confirmationId}|${itemKey(r.sourceItem)}`;
    if (r.status !== 'CANCELLED' && open.has(k)) open.set(k, open.get(k) - r.quantity);
  }
  for (const [k, q] of ev.compensated) if (open.has(k)) open.set(k, open.get(k) - q);
  if ([...open.values()].some((q) => q > 0)) return no('NOT_LOADED_OPEN');
  if (order.status === 'YUKLENDI') {
    // "Yüklendi"yi bir kişi vermiş olmalı; 3.51.0'ın tarih kuralıyla verilmiş durum kanıt değildir (önce geri alınır)
    if (ev.lastShip === 'AUTO_SHIPPED') return no('AUTO_SHIPPED');
    const d = order.actualShipDate ?? order.estimatedShipDate;
    return d ? { ok: true, via: 'SHIPPED', day: dayKey(d) } : no('NO_DATE');
  }
  const loaded = eff.filter((i) => i.status === 'LOADED' && i.quantity > 0);
  if (loaded.length === 0) return no('NOT_CONFIRMED');
  // Onaydan sonra siparişe eklenen cam hiçbir onayda yoktur (sipariş tarihinden yeniden plana girmez): yüklenmiş sayılmaz.
  // Müşterideki teklifin her camı (cam + ölçü) onaylardaki ilk kalemlerde (aktarım değil) en az aynı adetle bulunmalı.
  if (!ev.sent) return no('NOT_IN_LOADING');
  const confirmed = glassPieces(eff.filter((i) => !i.replanId), (i) => i.quantity);
  for (const [k, n] of glassPieces(ev.sent, (l) => l.adet)) if (n > (confirmed.get(k) ?? 0)) return no('NOT_IN_LOADING');
  return { ok: true, via: 'CONFIRMED', day: loaded.map((i) => isoDay(i.confirmation.shipDay)).sort().at(-1) };
}

/** Kanıtlı sipariş bugün arşive geçer mi: yükleme günü bugünden en az `days` gün önce */
export function autoArchiveDue(proof, today, days = AUTO_ARCHIVE_DAYS) {
  return !!proof?.ok && proof.day <= cutoffDay(today, days);
}

/**
 * Siparişleri "Yüklendi" yapan son olay (kişinin düğmesi ya da 3.51.0'ın tarih kuralı).
 * @param {any} db  veritabanı ya da işlem  @param {string[]} ids
 * @returns {Promise<Map<string, { id: string, event: string, createdAt: Date }>>}
 */
export async function lastShipEvents(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = await db.orderEvent.findMany({
    where: { orderId: { in: ids }, event: { in: SHIP_EVENTS } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, orderId: true, event: true, createdAt: true },
  });
  for (const r of rows) if (!out.has(r.orderId)) out.set(r.orderId, r);
  return out;
}

/**
 * Siparişlerin yükleme kanıtı için kayıtları — işçi ve iş akışı işlemi aynısını kullanır.
 * @param {any} db  veritabanı ya da işlem (tx)  @param {string[]} ids
 * @returns {Promise<Map<string, Evidence>>}
 */
export async function loadingEvidence(db, ids) {
  /** @type {Map<string, Evidence>} */
  const out = new Map(ids.map((id) => [id, { items: [], replans: [], compensated: new Map(), sent: null, lastShip: null }]));
  if (!ids.length) return out;
  const glass = { description: true, enMm: true, boyMm: true, kind: true, unit: true };
  const [items, replans, comps, offers, ships] = await Promise.all([
    db.loadingConfirmationItem.findMany({
      where: { orderId: { in: ids } },
      select: { orderId: true, confirmationId: true, offerLineId: true, replanId: true, revision: true, status: true, quantity: true, ...glass, confirmation: { select: { shipDay: true } } },
    }),
    db.loadingReplan.findMany({
      where: { orderId: { in: ids } },
      select: { orderId: true, status: true, quantity: true, sourceItem: { select: { confirmationId: true, offerLineId: true, replanId: true } } },
    }),
    // Yalnızca UYGULANMIŞ telafi kalanı kapatır (bekleyen karar reddedilebilir)
    db.compensation.findMany({ where: { sourceOrderId: { in: ids }, status: 'APPLIED', notLoadedScope: { not: null } }, select: { sourceOrderId: true, notLoadedScope: true, quantity: true } }),
    db.offer.findMany({
      where: { orderId: { in: ids }, status: 'GONDERILDI' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { orderId: true, lines: { select: { ...glass, adet: true } } },
    }),
    lastShipEvents(db, ids),
  ]);
  for (const i of items) out.get(i.orderId)?.items.push(i);
  for (const r of replans) out.get(r.orderId)?.replans.push(r);
  for (const c of comps) {
    const m = out.get(c.sourceOrderId)?.compensated;
    if (m) m.set(c.notLoadedScope, (m.get(c.notLoadedScope) ?? 0) + c.quantity);
  }
  // Müşterideki SON teklif (en yeni gönderilmiş sürüm)
  for (const o of offers) {
    const e = out.get(o.orderId);
    if (e && e.sent == null) e.sent = o.lines;
  }
  for (const [id, s] of ships) {
    const e = out.get(id);
    if (e) e.lastShip = s.event;
  }
  return out;
}

/**
 * İş akışı işleminin (auto_archive) kayıttan önceki denetimi: aynı veritabanı işleminde kanıt + 45 gün. `today` işçinin
 * gününü taşır; bugünden ileri bir gün verilemez (sipariş erken arşivlenemez).
 * @param {any} tx  @param {any} order  iş akışının yüklediği sipariş
 * @param {{ today?: unknown, now: Date }} p
 * @returns {Promise<{ ok: true, proof: { via: string, day: string }, today: string } | { ok: false, code: 'NOT_LOADED' | 'NOT_DUE' }>}
 */
export async function archiveCheck(tx, order, { today, now }) {
  const real = dayKey(now);
  const day = typeof today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(today) && today <= real ? today : real;
  const proof = loadingProof(order, (await loadingEvidence(tx, [order.id])).get(order.id));
  if (!proof.ok) return { ok: false, code: 'NOT_LOADED' };
  if (!autoArchiveDue(proof, day)) return { ok: false, code: 'NOT_DUE' };
  return { ok: true, proof, today: day };
}

/**
 * 3.51.0 onarımı (işçi): tarihe bakılarak "Yüklendi" yapılmış ve hâlâ öyle duran siparişler (son yükleme olayı AUTO_SHIPPED)
 * mevcut üretim durumuna geri alınır. Her sipariş kendi işleminde, iş akışı servisinden geçer (geçmiş + denetim kaydı);
 * geri alınan sipariş bir sonraki turda aday olmaz (tekrarsız). Bir kişi sonradan "Yüklendi" dediyse dokunulmaz.
 * @param {any} db
 * @param {{ batch?: number, log?: (...a: unknown[]) => void }} [o]
 * @returns {Promise<{ reverted: number, skipped: number }>}
 */
export async function repairAutoShipped(db, { batch = 200, log = () => {} } = {}) {
  let reverted = 0, skipped = 0, after = '';
  for (;;) {
    const rows = await db.order.findMany({
      where: { orderTypeCode: 'GLASS_ORDER', status: 'YUKLENDI', id: { gt: after }, events: { some: { event: 'AUTO_SHIPPED' } } },
      select: { id: true, orderNo: true },
      orderBy: { id: 'asc' },
      take: batch,
    });
    if (rows.length === 0) break;
    after = rows[rows.length - 1].id;
    const last = await lastShipEvents(db, rows.map((o) => o.id));
    for (const o of rows) {
      if (last.get(o.id)?.event !== 'AUTO_SHIPPED') continue;
      try {
        await runOrderAction(db, { orderId: o.id, action: 'auto_ship_revert', actor: ARCHIVE_ACTOR });
        reverted++;
      } catch (e) {
        if (!(e instanceof WorkflowError)) throw e;
        skipped++;
        log('otomatik "Yüklendi" geri alınamadı:', o.orderNo, e.code);
      }
    }
    if (rows.length < batch) break;
  }
  return { reverted, skipped };
}

const ORDER_SELECT = { id: true, orderNo: true, orderTypeCode: true, status: true, onHold: true, removedAt: true, actualShipDate: true, estimatedShipDate: true };

/**
 * Kanıtlı ve süresi dolmuş siparişleri arşive geçirir (işçi). Adaylar sayfa sayfa taranır (kanıtı olmayan aday sıradakileri
 * bekletmez); her sipariş kendi veritabanı işleminde, iş akışı servisinden geçer. Biri geçemezse (aynı anda değişti,
 * kanıtı artık yok) atlanır, ötekiler etkilenmez.
 * @param {any} db
 * @param {{ now?: Date, batch?: number, max?: number, log?: (...a: unknown[]) => void }} [o]
 * @returns {Promise<{ archived: number, skipped: number }>}
 */
export async function autoArchiveOrders(db, { now = new Date(), batch = 100, max = 2000, log = () => {} } = {}) {
  const today = dayKey(now);
  // Sorgu geniş tutulur (saat dilimi payı: +2 gün); kesin karar kanıttadır (loadingProof + autoArchiveDue)
  const before = new Date(`${cutoffDay(today)}T00:00:00Z`);
  before.setUTCDate(before.getUTCDate() + 2);
  let archived = 0, skipped = 0, seen = 0, after = '';
  while (seen < max) {
    const rows = await db.order.findMany({
      where: {
        orderTypeCode: 'GLASS_ORDER', onHold: false, removedAt: null, id: { gt: after },
        replans: { none: { status: 'ACTIVE' } },
        OR: [
          { status: 'YUKLENDI', OR: [{ actualShipDate: { lt: before } }, { actualShipDate: null, estimatedShipDate: { lt: before } }] },
          { status: 'URETIMDE', loadedItems: { some: { status: 'LOADED', confirmation: { shipDay: { lt: before } } } } },
        ],
      },
      select: ORDER_SELECT,
      orderBy: { id: 'asc' },
      take: batch,
    });
    if (rows.length === 0) break;
    after = rows[rows.length - 1].id;
    seen += rows.length;
    const evidence = await loadingEvidence(db, rows.map((o) => o.id));
    for (const o of rows) {
      if (!autoArchiveDue(loadingProof(o, evidence.get(o.id)), today)) continue;
      try {
        await runOrderAction(db, { orderId: o.id, action: 'auto_archive', actor: ARCHIVE_ACTOR, payload: { today } });
        archived++;
      } catch (e) {
        if (!(e instanceof WorkflowError)) throw e;
        skipped++;
        log('otomatik arşiv atlandı:', o.orderNo, e.code);
      }
    }
    if (rows.length < batch) break;
  }
  return { archived, skipped };
}
