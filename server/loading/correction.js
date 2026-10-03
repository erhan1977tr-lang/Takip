// Onaylı yüklemenin düzeltilmesi (Aşama 7F-1, karar 105) — YALNIZCA KAYIT EKLENEREK.
//
//   Onay (LoadingConfirmation) ve kalemleri hiçbir zaman güncellenmez / silinmez. Yanlış onaylanan yüklenen / yüklenmeyen
//   dağılımı bir düzeltme kaydıyla (LoadingCorrection: onay, sıra, zorunlu neden, yönetici, zaman) düzeltilir; düzeltilen
//   her kapsamın (onay + teklif satırı / aktarım) yeni LOADED / NOT_LOADED kalemleri revision = n ile EKLENİR. Geçerli
//   durum tek yerde okunur: effectiveItems() (server/loading/confirmation.js).
//
//   Kapsam: VAR OLAN bir kapsamın dağılımı (10 yüklendi → 8 + 2 yüklenmedi; 8 + 2 → 10; tamamı yüklenmedi). Değişmez
//   kural: yüklenen + yüklenmeyen = kapsamın onaylanan adedi. Onayda hiç olmayan sipariş / satır eklenmez (7F-2).
//   Yalnızca cam (m²) satırları; işlem satırları (CNC, delik, sandık) siparişin ilk yüklemesinde kalır (karar 102).
//
//   Aktarımlar (aynı kilit, aynı işlem): yüklenmeyen adet artarsa yeni aktarım kapasitesi açılır; azalırsa artık
//   sığmayan ETKİN aktarımlar kapatılır (CANCELLED, CORRECTION). Kalanı ileri bir onayda zaten onaylanmış (CONFIRMED)
//   aktarımın altına düşüren düzeltme REDDEDİLİR (DOWNSTREAM_CONFLICT): sonraki onayın tarihçesi yeniden yazılmaz.
//
//   Fatura (yalnızca saptama — server/glass/invoice-batch.js → orderImpacts): kuyruktaki ya da kesilemeyen fatura varken
//   düzeltme yapılmaz (QUEUED_BILLING / FAILED_BILLING). Kesilmiş faturada fark çıkarsa düzeltme yapılır ama hiçbir belge
//   otomatik kesilmez / değişmez: sonuç "muhasebe işlemi gerekli"dir (UNDER_INVOICED / OVER_INVOICED) ve o kapsam
//   yeniden faturalanmaz (onayın siparişi fatura partisinde kalır; fazla faturalanan camın aktarımı dondurulur).
//
//   Yalnızca yönetici (LOADING_CONFIRM); kontrol burada, sunucuda yapılır. Önizleme ve kayıt aynı hesabı kullanır
//   (planCorrection); kayıt, yöneticinin gördüğü önizlemenin parmak iziyle yapılır (STALE_PREVIEW).
import crypto from 'node:crypto';
import { can } from '../auth/permissions.js';
import { parseDateOnly } from '../orders/rules.js';
import { writeAudit, writeHistory } from '../orders/journal.js';
import { ACTION_REQUIRED, orderImpacts } from '../glass/invoice-batch.js';
import { NOT_LOADED_REASONS, effectiveItems, isGlassLine, itemKey, shipDayDate, snapshotOfItem } from './confirmation.js';

const LOCK = 'loading-confirmation'; // yükleme onayı ve aktarımla aynı kilit
const dayOf = (d) => new Date(d).toISOString().slice(0, 10);
const dmy = (day) => day.split('-').reverse().join('.');
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Düzeltmeyi engelleyen fatura durumları (kesilmiş faturadaki fark engellemez: muhasebe işlemi gerekli diye bildirilir) */
export const BLOCKING_IMPACTS = ['QUEUED_BILLING', 'FAILED_BILLING'];

/**
 * @typedef {{ key: string, quantity: unknown, reason?: unknown, note?: unknown }} CorrectionInput  quantity: kapsamın YENİ yüklenmeyen adedi (boş = değişmez)
 * @typedef {{ loaded: number, notLoaded: number, reason: string | null, note: string | null }} Split
 * @typedef {{ key: string, orderId: string, orderNo: string, customerId: string, customerName: string, description: string, descriptionRo: string | null,
 *   enMm: number | null, boyMm: number | null, total: number, before: Split, after: Split }} ScopeChange
 * @typedef {{ id: string, orderId: string, orderNo: string, day: string, quantity: number }} ClosingReplan
 * @typedef {import('../glass/invoice-batch.js').OrderImpact & { before: string }} ImpactChange
 * @typedef {{ ok: true, confirmationId: string, day: string, revision: number, changes: ScopeChange[], closing: ClosingReplan[],
 *   conflicts: { key: string, orderNo: string, days: string[], confirmed: number }[], impacts: ImpactChange[],
 *   blocked: 'DOWNSTREAM_CONFLICT' | 'QUEUED_BILLING' | 'FAILED_BILLING' | null, actionRequired: boolean, key: string, rows: any[], customerIds: string[] }} CorrectionPlan
 */

/** Düzeltme girdisinin adres çubuğunda taşınan kısa hâli (önizleme sayfası ↔ kayıt formu; yalnızca değişen kapsamlar) */
export const packCorrection = (rows) => Buffer.from(JSON.stringify(rows.map((r) => [r.key, r.quantity, r.reason ?? '', r.note ?? '']))).toString('base64url');

/** @param {unknown} text  @returns {CorrectionInput[]}  bozuk girdi → boş liste (sunucu her alanı yeniden doğrular) */
export function unpackCorrection(text) {
  try {
    const raw = JSON.parse(Buffer.from(String(text ?? ''), 'base64url').toString('utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 500).filter(Array.isArray).map((r) => ({ key: String(r[0] ?? ''), quantity: String(r[1] ?? ''), reason: String(r[2] ?? ''), note: String(r[3] ?? '') }));
  } catch {
    return [];
  }
}

/**
 * Düzeltmenin hesabı (önizleme ve kayıt aynı işlevi kullanır). Hiçbir şey yazmaz.
 * @param {any} db
 * @param {{ day: string, input: CorrectionInput[] }} p
 * @returns {Promise<CorrectionPlan | { ok: false, code: 'BAD_DAY' | 'NOT_CONFIRMED' | 'BAD_EXCEPTION' | 'BAD_QUANTITY' | 'BAD_REASON' | 'NOTE_REQUIRED' | 'NO_CHANGE' }>}
 */
export async function planCorrection(db, { day, input = [] }) {
  if (!parseDateOnly(day)) return { ok: false, code: 'BAD_DAY' };
  const conf = await db.loadingConfirmation.findUnique({
    where: { shipDay: shipDayDate(day) },
    include: {
      items: { orderBy: [{ orderId: 'asc' }, { sortOrder: 'asc' }, { revision: 'asc' }], include: { order: { select: { orderNo: true } }, customer: { select: { name: true } } } },
      corrections: { select: { revision: true } },
    },
  });
  if (!conf) return { ok: false, code: 'NOT_CONFIRMED' };
  const eff = effectiveItems(conf.items);
  const scopes = new Map();
  for (const it of eff) scopes.set(itemKey(it), [...(scopes.get(itemKey(it)) ?? []), it]);

  /** @type {(ScopeChange & { rows: any[] })[]} */
  const changes = [];
  const seen = new Set();
  for (const x of input ?? []) {
    const raw = String(x.quantity ?? '').trim();
    if (raw === '') continue; // boş: kapsam olduğu gibi kalır
    const key = String(x.key ?? '');
    const rows = scopes.get(key);
    // Onayda olmayan kapsam ya da cam olmayan satır (taklit istek) ve aynı kapsam için ikinci giriş
    if (!rows || !isGlassLine(rows[0]) || seen.has(key)) return { ok: false, code: 'BAD_EXCEPTION' };
    seen.add(key);
    const total = rows.reduce((n, r) => n + r.quantity, 0);
    const q = Number(raw);
    if (!Number.isInteger(q) || q < 0 || q > total) return { ok: false, code: 'BAD_QUANTITY' };
    const cur = rows.find((r) => r.status === 'NOT_LOADED') ?? null;
    const before = { loaded: total - (cur?.quantity ?? 0), notLoaded: cur?.quantity ?? 0, reason: cur?.notLoadedReason ?? null, note: cur?.notLoadedNote ?? null };
    let reason = null, note = null;
    if (q > 0) {
      reason = String(x.reason ?? '');
      if (!NOT_LOADED_REASONS.includes(reason)) return { ok: false, code: 'BAD_REASON' };
      note = clean(x.note, 200) || null;
      if (reason === 'OTHER' && !note) return { ok: false, code: 'NOTE_REQUIRED' };
    }
    const after = { loaded: total - q, notLoaded: q, reason, note };
    if (after.notLoaded === before.notLoaded && after.reason === before.reason && after.note === before.note) continue;
    const base = rows[0];
    changes.push({
      key, orderId: base.orderId, orderNo: base.order.orderNo, customerId: base.customerId, customerName: base.customer.name,
      description: base.description, descriptionRo: base.descriptionRo ?? null, enMm: base.enMm ?? null, boyMm: base.boyMm ?? null, total, before, after,
      // Yeni kalemler: ticari değerler kapsamın kendi kopyasından (güncel teklif / fiyat tablosu okunmaz)
      rows: [
        ...(after.loaded > 0 ? [snapshotOfItem(base, { quantity: after.loaded })] : []),
        ...(after.notLoaded > 0 ? [snapshotOfItem(base, { quantity: after.notLoaded, status: 'NOT_LOADED', reason, note })] : []),
      ],
    });
  }
  if (changes.length === 0) return { ok: false, code: 'NO_CHANGE' };

  // Aktarımlar: kapasite = yeni yüklenmeyen adet. Onaylanmış aktarımın altına düşülemez; sığmayan etkin aktarım kapanır.
  const replans = await db.loadingReplan.findMany({
    where: { sourceItem: { confirmationId: conf.id }, status: { not: 'CANCELLED' } },
    include: { sourceItem: { select: { offerLineId: true, replanId: true } }, order: { select: { orderNo: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  /** @type {ClosingReplan[]} */
  const closing = [];
  const conflicts = [];
  for (const ch of changes) {
    const list = replans.filter((r) => itemKey(r.sourceItem) === ch.key);
    const done = list.filter((r) => r.status === 'CONFIRMED');
    const confirmed = done.reduce((n, r) => n + r.quantity, 0);
    if (ch.after.notLoaded < confirmed) {
      conflicts.push({ key: ch.key, orderNo: ch.orderNo, days: done.map((r) => dayOf(r.shipDay)), confirmed });
      continue;
    }
    let used = confirmed;
    for (const r of list.filter((x) => x.status === 'ACTIVE')) {
      if (used + r.quantity <= ch.after.notLoaded) used += r.quantity;
      else closing.push({ id: r.id, orderId: r.orderId, orderNo: r.order.orderNo, day: dayOf(r.shipDay), quantity: r.quantity });
    }
  }

  // Finansal etki: düzeltmeden önce ve sonra, etkilenen siparişler için (yalnızca saptama)
  const orderIds = [...new Set(changes.map((c) => c.orderId))];
  const changed = new Set(changes.map((c) => c.key));
  const afterItems = [...eff.filter((i) => !changed.has(itemKey(i))), ...changes.flatMap((c) => c.rows)];
  const [was, will] = await Promise.all([
    orderImpacts(db, { confirmationId: conf.id, items: eff, orderIds }),
    orderImpacts(db, { confirmationId: conf.id, items: afterItems, orderIds }),
  ]);
  const impacts = orderIds.map((id) => ({ ...will.get(id), before: was.get(id)?.code ?? 'NO_BILLING' })).filter((x) => x.code);
  const blocked = conflicts.length ? 'DOWNSTREAM_CONFLICT' : impacts.find((x) => BLOCKING_IMPACTS.includes(x.code))?.code ?? null;
  const revision = conf.corrections.reduce((m, c) => Math.max(m, c.revision), 0) + 1;
  const view = changes.map(({ rows: _rows, ...c }) => c);
  const key = crypto.createHash('sha256').update(JSON.stringify([
    conf.id, revision, view.map((c) => [c.key, c.before, c.after]), closing.map((r) => r.id), impacts.map((x) => [x.orderId, x.code, x.diff]),
  ])).digest('hex').slice(0, 32);
  return {
    ok: true, confirmationId: conf.id, day, revision, changes: view, closing, conflicts, impacts, blocked,
    actionRequired: impacts.some((x) => ACTION_REQUIRED.includes(x.code)), key,
    rows: changes.flatMap((c) => c.rows), customerIds: [...new Set(changes.map((c) => c.customerId))].sort(),
  };
}

/**
 * Düzeltmeyi kaydeder (yönetici): LoadingCorrection + düzeltilen kapsamların yeni kalemleri EKLENİR; onay ve önceki
 * kalemler değişmez. Sığmayan etkin aktarımlar aynı işlemde kapanır. Hiçbir FGO belgesi kesilmez / değişmez.
 * @param {any} db
 * @param {{ day: string, input: CorrectionInput[], reason: string, key: string, actor: { id: string, role: string, ip?: string | null }, now?: Date }} p
 * @returns {Promise<{ ok: true, id: string, revision: number, scopes: number, closedReplans: number, actionRequired: boolean }
 *   | { ok: false, code: 'FORBIDDEN' | 'BAD_DAY' | 'REASON_REQUIRED' | 'NOT_CONFIRMED' | 'BAD_EXCEPTION' | 'BAD_QUANTITY' | 'BAD_REASON' | 'NOTE_REQUIRED' | 'NO_CHANGE' | 'DOWNSTREAM_CONFLICT' | 'QUEUED_BILLING' | 'FAILED_BILLING' | 'STALE_PREVIEW' }>}
 */
export async function correctLoading(db, { day, input, reason, key, actor, now = new Date() }) {
  if (!can(actor?.role, 'LOADING_CONFIRM')) return { ok: false, code: 'FORBIDDEN' };
  if (!parseDateOnly(day)) return { ok: false, code: 'BAD_DAY' };
  const text = clean(reason, 500);
  if (text.length < 3) return { ok: false, code: 'REASON_REQUIRED' };
  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${LOCK}, 0))`;
      const first = await planCorrection(tx, { day, input });
      if (!first.ok) return first;
      // Fatura oluşturmayla yarışmasın: etkilenen müşterilerin fatura kilidi (createInvoiceBatch ile aynı kilit) alınır,
      // hesap kilit altında yeniden yapılır — arada kesilen / kuyruğa giren fatura parmak izini değiştirir
      for (const id of first.customerIds) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-batch:${id}`}, 0))`;
      const plan = await planCorrection(tx, { day, input });
      if (!plan.ok) return plan;
      if (plan.blocked) return { ok: false, code: plan.blocked };
      if (plan.key !== key) return { ok: false, code: 'STALE_PREVIEW' };
      const c = await tx.loadingCorrection.create({ data: { confirmationId: plan.confirmationId, revision: plan.revision, reason: text, createdById: actor.id, createdAt: now } });
      await tx.loadingConfirmationItem.createMany({
        data: plan.rows.map((i) => ({
          ...i, confirmationId: plan.confirmationId, revision: plan.revision, correctionId: c.id, scopeKey: itemKey(i),
          m2: i.m2.toFixed(2), unitCost: i.unitCost.toFixed(2), unitSale: i.unitSale == null ? null : i.unitSale.toFixed(2),
          costAmount: i.costAmount.toFixed(4), saleAmount: i.saleAmount.toFixed(4),
        })),
      });
      // Yüklenmeyen adet azaldı: artık sığmayan etkin aktarımlar kapanır (kayıt silinmez)
      if (plan.closing.length) {
        const closed = await tx.loadingReplan.updateMany({
          where: { id: { in: plan.closing.map((r) => r.id) }, status: 'ACTIVE' },
          data: { status: 'CANCELLED', activeKey: null, closedAt: now, closedReason: 'CORRECTION', correctionId: c.id },
        });
        if (closed.count !== plan.closing.length) throw new Error('aktarım durumu değişti');
      }
      const orderIds = [...new Set([...plan.changes.map((x) => x.orderId), ...plan.closing.map((r) => r.orderId)])];
      const statuses = new Map((await tx.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, status: true } })).map((o) => [o.id, o.status]));
      const dateText = dmy(day);
      for (const id of new Set(plan.changes.map((x) => x.orderId))) {
        await writeHistory(tx, { orderId: id, event: 'LOADING_CORRECTED', from: statuses.get(id) ?? null, to: statuses.get(id) ?? null, actorId: actor.id, note: `${dateText} · #${plan.revision}` });
      }
      for (const r of plan.closing) {
        await writeHistory(tx, { orderId: r.orderId, event: 'REPLAN_CANCELLED', from: statuses.get(r.orderId) ?? null, to: statuses.get(r.orderId) ?? null, actorId: actor.id, note: `${r.quantity} · ${dmy(r.day)}` });
        await writeAudit(tx, {
          action: 'REPLAN_CANCELLED', entityType: 'Order', entityId: r.orderId, userId: actor.id,
          details: { orderNo: r.orderNo, replanId: r.id, quantity: r.quantity, fromLoading: day, cancelledLoading: r.day, closedReason: 'CORRECTION', correctionId: c.id },
        }, actor);
      }
      await writeAudit(tx, {
        action: 'LOADING_CORRECTED', entityType: 'LoadingConfirmation', entityId: plan.confirmationId, userId: actor.id,
        details: {
          shipDay: day, correctionId: c.id, revision: plan.revision, reason: text, correctedAt: now.toISOString(),
          scopes: plan.changes.map((x) => ({ scope: x.key, orderId: x.orderId, orderNo: x.orderNo, customerId: x.customerId, quantity: x.total, before: x.before, after: x.after })),
          closedReplans: plan.closing.map((r) => ({ id: r.id, orderNo: r.orderNo, quantity: r.quantity, day: r.day })),
          financialImpact: plan.impacts.map((x) => ({ orderNo: x.orderNo, before: x.before, after: x.code, invoice: x.ref, invoiced: x.invoiced, effective: x.effective, diff: x.diff, currency: x.currency, invoicePaid: x.invoicePaid, advanceDeducted: x.advanceDeducted })),
          documentsCreated: 0,
        },
      }, actor);
      return { ok: true, id: c.id, revision: plan.revision, scopes: plan.changes.length, closedReplans: plan.closing.length, actionRequired: plan.actionRequired };
    }, { timeout: 30_000 });
  } catch (e) {
    // Aynı anda ikinci düzeltme: sıra benzersizdir (veritabanı) — yönetici güncel durumu yeniden kontrol eder
    if (e?.code === 'P2002') return { ok: false, code: 'STALE_PREVIEW' };
    throw e;
  }
}
