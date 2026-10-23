// Geçmiş verinin satışçılara bağlanması (4.3.0, karar 300 — bölüm 7; 4.3.17 D-1, karar 302). Sunucu komutu
// (scripts/sales-link.mjs) tarafından çağrılır; HTTP yolu yoktur.
//
// 4.3.17 (D-1): geçmiş TEK bir hedef hesaba bağlanmaz. Sorumlusu boş her CAM siparişinin TARİHSEL satışçısı kendi kaydından
// bulunur: siparişi çizime gönderen / çizimsiz devam ettiren ya da teklifini yöneticiye gönderen satış kullanıcısı (OrderEvent
// SENT_TO_DRAWING / NO_DRAWING / OFFER_SUBMITTED) ve teklifi hazırlayan satış kullanıcısı (Offer.createdBy). Bu kaynaklar TEK
// bir satışçıyı gösteriyorsa ve o satışçı etkinse sipariş ona bağlanır. Belirlenemeyen (iz yok), çelişkili (birden çok
// satışçı) ya da sahibi pasif / silinmiş siparişler OTOMATİK olarak kimseye verilmez: yönetici kararı gerekir — komutta açık
// karar (--ata SIPARIS=E-POSTA) ya da bağlamadan sonra panelde "Satışçıya ata". Bir siparişin ticari sahipliğini değiştiren
// bağlama yalnızca kullanıcının ONAYLADIĞI dağılımla çalışır: önizleme dağılımın parmak izini (onay kodu) verir; uygulama aynı
// kodu ister ve işlemin içinde dağılımı yeniden hesaplar — bir sipariş, sandık, ödeme ya da karar değiştiyse hiçbir şey yazılmaz.
//   - sipariş → tarihsel (ya da yöneticinin karar verdiği) satışçı (salesAssignedVia = MIGRATION; salesAssignedAt yazılmaz);
//     çizimcisi boş olanlara o satışçının geçerli varsayılan çizimcisi (var olan çizimci DEĞİŞMEZ);
//   - satışçısı boş sandık → içindeki siparişlerin hepsi aynı satışçıya bağlanıyorsa o satışçı; karışık / belirsiz / boş sandık
//     değişmez (raporlanır — eski kayıt olarak kalır);
//   - hesabı boş fabrika ödemesi → yalnızca açık kararla (--odeme E-POSTA); varsa ve karar yoksa bağlama yapılmaz;
//   - bağlama işareti (IntegrationSetting 'sales-routing'.linkedAt). Otomatik yönlendirme kuralı YAZILMAZ: ilk durum
//     "yönetici seçer" (MANUAL — kural yok; karar 302); yönetici kuralı Ayarlar → Satış Yönlendirme'den yazar.
// Üretmez: görev, bildirim (outbox), durum değişikliği, SLA değişikliği, dış servis çağrısı. Tek denetim kaydı
// (SALES_LINK_APPLIED) sayımlar, dağılım ve onay koduyla.
// Toplam koruması: para birimi başına maliyet / ödeme / bakiye ve kayıt sayıları bağlamadan önce ve sonra aynı olmalı
// (checkTotals) — değişirse işlem geri alınır (hata).
// 4.3.15:
//   - İşlem süresi (K-1): YALNIZCA bu işlem için Prisma etkileşimli işlem sınırı LINK_TX (120 sn). PostgreSQL tarafı işlemin
//     içinde SET LOCAL ile ondan KISA tutulur (statement_timeout 110 sn, lock_timeout 15 sn). Süre aşılırsa işlem bütünüyle
//     geri alınır (kısmi yazım yok). Diğer işlemlerin sınırları değişmez.
//   - Güncelleme tarihleri (K-2): sipariş ve sandık bağlaması updatedAt'e DOKUNMAZ — düz SQL UPDATE.
//   - Süre ölçümü: sonuç ve denetim kaydı timing { previewMs, applyMs, totalMs } taşır; komut çıktısında yazılır.
import crypto from 'node:crypto';
import { LINK_SETTING, validDrawer, validSales } from './sales-routing.js';
import { writeAudit } from './journal.js';
import { supplierData } from '../accounting/supplier.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Bağlama işleminin Prisma etkileşimli işlem sınırları (yalnızca applyLink — K-1) */
export const LINK_TX = Object.freeze({ timeout: 120_000, maxWait: 10_000 });
/** PostgreSQL işlem içi sınırlar: istemci sınırından KISA (sunucu, işlem bırakıldıktan sonra çalışmaz) */
export const LINK_PG = Object.freeze({ statementTimeoutMs: 110_000, lockTimeoutMs: 15_000 });

/**
 * Para birimi başına toplam maliyet / ödeme / bakiye (genel özet) ve kayıt sayıları — bağlama öncesi / sonrası karşılaştırma.
 * Hesap bazlı toplamların genel toplamı da özetle aynı olmalı (accountSummary).
 */
export async function totalsSnapshot(db) {
  const data = await supplierData(db, new Date(Date.now() + 86_400_000));
  const perCur = {};
  for (const [c, s] of Object.entries(data.summary)) perCur[c] = { cost: s.cost, paid: s.paid, balance: s.balance };
  const perAcc = {};
  for (const [c, o] of Object.entries(data.accounts.overview)) perAcc[c] = { cost: o.cost, paid: o.paid, balance: o.balance };
  const [orders, crates, payments] = await Promise.all([
    db.order.count({ where: { orderTypeCode: 'GLASS_ORDER' } }), db.crate.count(), db.factoryPayment.count(),
  ]);
  return { perCur, perAcc, counts: { orders, crates, payments } };
}

/** Saf: iki anlık görüntü aynı mı (para birimi başına, kuruş hassasiyetinde) */
export function sameTotals(a, b) {
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const curs = new Set([...Object.keys(a.perCur), ...Object.keys(b.perCur)]);
  for (const c of curs) {
    const x = a.perCur[c] ?? { cost: 0, paid: 0, balance: 0 };
    const y = b.perCur[c] ?? { cost: 0, paid: 0, balance: 0 };
    if (round2(x.cost) !== round2(y.cost) || round2(x.paid) !== round2(y.paid) || round2(x.balance) !== round2(y.balance)) return false;
  }
  return same(a.counts, b.counts);
}

/** Saf: genel özet ile hesap bazlı toplamlar her para biriminde eşit mi */
export function accountsMatchSummary(snap) {
  for (const [c, s] of Object.entries(snap.perCur)) {
    const a = snap.perAcc[c] ?? { cost: 0, paid: 0, balance: 0 };
    if (round2(a.cost) !== round2(s.cost) || round2(a.paid) !== round2(s.paid) || round2(a.balance) !== round2(s.balance)) return false;
  }
  return true;
}

/**
 * E-postayla hesap: büyük / küçük harf farkı gözetilmez; aynı adresin iki yazımı varsa (belirsiz) hesap seçilmez.
 * @param {any} db  @param {unknown} email  @param {{ include?: object }} [o]
 */
async function userByEmail(db, email, { include } = {}) {
  const e = String(email ?? '').trim();
  if (!e) return null;
  const rows = await db.user.findMany({ where: { email: { equals: e, mode: 'insensitive' } }, ...(include ? { include } : {}), take: 2 });
  return rows.length === 1 ? rows[0] : null;
}

/** Tarihsel satışçının kaynakları: satış kullanıcısının yazdığı inceleme / gönderim olayları ve teklif kaydı */
export const OWNER_EVENTS = Object.freeze(['SENT_TO_DRAWING', 'NO_DRAWING', 'OFFER_SUBMITTED']);

/**
 * Saf: bir siparişin tarihsel satışçısı. Kaynaklar TEK bir satış kullanıcısını gösteriyorsa ve o kullanıcı etkin bir satışçıysa
 * o; aksi hâlde sahip YOK (yönetici kararı): UNKNOWN (iz yok), CONFLICT (birden çok satışçı), INACTIVE_OWNER (pasif / silinmiş).
 * @param {{ userId: string, source: string }[]} candidates  @param {Map<string, any>} salesById
 * @returns {{ ownerId: string | null, reason: 'HISTORY' | 'UNKNOWN' | 'CONFLICT' | 'INACTIVE_OWNER', candidates: string[], sources: string[] }}
 */
export function resolveOwner(candidates, salesById) {
  const ids = [...new Set(candidates.map((c) => c.userId))].sort();
  const sources = [...new Set(candidates.map((c) => c.source))].sort();
  if (ids.length === 0) return { ownerId: null, reason: 'UNKNOWN', candidates: [], sources };
  if (ids.length > 1) return { ownerId: null, reason: 'CONFLICT', candidates: ids, sources };
  if (!validSales(salesById.get(ids[0]))) return { ownerId: null, reason: 'INACTIVE_OWNER', candidates: ids, sources };
  return { ownerId: ids[0], reason: 'HISTORY', candidates: ids, sources };
}

/**
 * Saf: komut satırındaki yönetici kararları ("GLA68=satis@firma.com"). Biçim hatası → null.
 * @param {string[]} list  @returns {{ orderNo: string, email: string }[] | null}
 */
export function parseDecisions(list = []) {
  const out = [];
  for (const raw of list) {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9-]{0,40})\s*=\s*([^\s=]{3,254})\s*$/.exec(String(raw ?? ''));
    if (!m) return null;
    out.push({ orderNo: m[1].toUpperCase(), email: m[2] });
  }
  return out;
}

/**
 * Saf: dağılımın onay kodu (parmak izi). Sipariş → sahip / atanacak çizimci, sandık → sahip, ödeme → hesap, sahipsiz kalanlar.
 * Aynı veride aynı kod; tek bir kayıt değişirse farklı kod.
 */
export function approvalCode(plan) {
  const body = JSON.stringify({
    o: plan.orders.map((o) => [o.id, o.ownerId ?? '', o.drawerToSet ?? '', o.via ?? '']).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    c: plan.crates.map((c) => [c.id, c.ownerId ?? '']).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    p: [plan.payments.count, plan.payments.ownerId ?? ''],
  });
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 12).toUpperCase();
}

/**
 * Dağılım planı — hiçbir şey yazmaz (işlemin içinde de aynı fonksiyon çalışır).
 * @param {any} db  @param {{ decisions?: { orderNo: string, email: string }[], paymentEmail?: string | null }} p
 */
async function buildPlan(db, { decisions = [], paymentEmail = null }) {
  const problems = [];
  const orders = await db.order.findMany({
    where: { orderTypeCode: 'GLASS_ORDER', salesUserId: null },
    select: { id: true, orderNo: true, status: true, removedAt: true, assignedDrawerId: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const ids = orders.map((o) => o.id);
  const [events, offers] = ids.length ? await Promise.all([
    db.orderEvent.findMany({ where: { orderId: { in: ids }, event: { in: [...OWNER_EVENTS] }, user: { appRole: 'SATIS', type: 'INTERNAL' } }, select: { orderId: true, userId: true, event: true } }),
    db.offer.findMany({ where: { orderId: { in: ids }, createdBy: { appRole: 'SATIS', type: 'INTERNAL' } }, select: { orderId: true, createdById: true } }),
  ]) : [[], []];
  const sales = await db.user.findMany({
    where: { appRole: 'SATIS', type: 'INTERNAL' },
    select: { id: true, email: true, name: true, appRole: true, type: true, isActive: true, deletedAt: true, defaultDrawer: { select: { id: true, email: true, appRole: true, type: true, isActive: true, deletedAt: true } } },
  });
  const salesById = new Map(sales.map((u) => [u.id, u]));
  const cand = new Map(ids.map((id) => [id, []]));
  for (const e of events) if (e.userId) cand.get(e.orderId).push({ userId: e.userId, source: e.event });
  for (const f of offers) if (f.createdById) cand.get(f.orderId).push({ userId: f.createdById, source: 'OFFER_CREATED' });

  // Yönetici kararları: yalnızca bu bağlamaya giren (sorumlusu boş) siparişler; hedef etkin satışçı olmalı
  const byNo = new Map();
  for (const o of orders) byNo.set(o.orderNo.toUpperCase(), [...(byNo.get(o.orderNo.toUpperCase()) ?? []), o]);
  const decided = new Map();
  for (const d of decisions) {
    const hits = byNo.get(d.orderNo) ?? [];
    const u = await userByEmail(db, d.email);
    if (hits.length === 0) problems.push({ code: 'DECISION_UNKNOWN_ORDER', detail: d.orderNo });
    else if (hits.length > 1) problems.push({ code: 'DECISION_AMBIGUOUS_ORDER', detail: d.orderNo });
    else if (!validSales(u)) problems.push({ code: 'DECISION_NOT_SALES', detail: `${d.orderNo}=${d.email}` });
    else if (decided.has(hits[0].id) && decided.get(hits[0].id) !== u.id) problems.push({ code: 'DECISION_TWICE', detail: d.orderNo });
    else decided.set(hits[0].id, u.id);
  }

  const drawerOf = (ownerId) => {
    const d = salesById.get(ownerId)?.defaultDrawer;
    return validDrawer(d) ? d.id : null;
  };
  const planned = orders.map((o) => {
    const r = resolveOwner(cand.get(o.id), salesById);
    const decision = decided.get(o.id) ?? null;
    const ownerId = decision ?? r.ownerId;
    const via = decision ? (r.ownerId && r.ownerId !== decision ? 'DECISION_OVERRIDE' : 'DECISION') : r.ownerId ? 'HISTORY' : null;
    return {
      id: o.id, orderNo: o.orderNo, status: o.status, removed: !!o.removedAt, reason: r.reason, candidates: r.candidates, sources: r.sources,
      ownerId, via, drawerToSet: ownerId && !o.assignedDrawerId ? drawerOf(ownerId) : null,
      keepsDrawer: !!o.assignedDrawerId, noDrawer: !!ownerId && !o.assignedDrawerId && !drawerOf(ownerId),
    };
  });
  const finalOwner = new Map(planned.map((o) => [o.id, o.ownerId]));

  // Sandıklar: yalnızca içindeki BÜTÜN siparişler aynı satışçıya bağlanıyorsa (zaten sahibi olan siparişler kendi sahibiyle)
  const crates = await db.crate.findMany({
    where: { salesUserId: null },
    select: { id: true, crateNo: true, shipDay: true, orders: { select: { order: { select: { id: true, salesUserId: true } } } } },
    orderBy: [{ shipDay: 'asc' }, { crateNo: 'asc' }],
  });
  const plannedCrates = crates.map((c) => {
    const owners = c.orders.map((x) => (finalOwner.has(x.order.id) ? finalOwner.get(x.order.id) : x.order.salesUserId));
    const set = [...new Set(owners)];
    const reason = owners.length === 0 ? 'EMPTY' : owners.some((x) => !x) ? 'UNRESOLVED' : set.length > 1 ? 'MIXED' : 'SINGLE';
    return { id: c.id, crateNo: c.crateNo, day: c.shipDay ? c.shipDay.toISOString().slice(0, 10) : null, ownerId: reason === 'SINGLE' ? set[0] : null, reason };
  });

  // Fabrika ödemeleri: yalnızca açık kararla
  const paymentCount = await db.factoryPayment.count({ where: { salesUserId: null } });
  let paymentOwner = null;
  if (paymentEmail) {
    const u = await userByEmail(db, paymentEmail);
    if (!validSales(u)) problems.push({ code: 'PAYMENT_OWNER_NOT_SALES', detail: paymentEmail });
    else paymentOwner = u.id;
  }
  if (paymentCount > 0 && !paymentOwner && !problems.some((x) => x.code === 'PAYMENT_OWNER_NOT_SALES')) problems.push({ code: 'PAYMENTS_NEED_DECISION', detail: String(paymentCount) });

  const plan = { orders: planned, crates: plannedCrates, payments: { count: paymentCount, ownerId: paymentCount > 0 ? paymentOwner : null } };
  const label = (id) => { const u = salesById.get(id); return u ? `${u.email}${validSales(u) ? '' : ' (pasif)'}` : id; };
  const byOwner = {};
  for (const o of planned) if (o.ownerId) byOwner[o.ownerId] = (byOwner[o.ownerId] ?? 0) + 1;
  return {
    problems, plan, approval: approvalCode(plan),
    summary: {
      orders: planned.length,
      byOwner: Object.entries(byOwner).map(([id, n]) => ({ id, email: label(id), orders: n, drawer: salesById.get(id)?.defaultDrawer && validDrawer(salesById.get(id).defaultDrawer) ? salesById.get(id).defaultDrawer.email : null })),
      unresolved: planned.filter((o) => !o.ownerId).map((o) => ({ orderNo: o.orderNo, status: o.status, removed: o.removed, reason: o.reason, candidates: o.candidates.map(label) })),
      decisions: planned.filter((o) => o.via === 'DECISION' || o.via === 'DECISION_OVERRIDE').map((o) => ({ orderNo: o.orderNo, owner: label(o.ownerId), override: o.via === 'DECISION_OVERRIDE' })),
      drawersToSet: planned.filter((o) => o.drawerToSet).length,
      ownersWithoutDrawer: [...new Set(planned.filter((o) => o.noDrawer).map((o) => label(o.ownerId)))],
      crates: { total: plannedCrates.length, linked: plannedCrates.filter((c) => c.ownerId).length, kept: plannedCrates.filter((c) => !c.ownerId).map((c) => ({ crateNo: c.crateNo, day: c.day, reason: c.reason })) },
      payments: { count: paymentCount, owner: plan.payments.ownerId ? label(plan.payments.ownerId) : null },
    },
  };
}

/**
 * Ön kontrol / önizleme — hiçbir şey yazmaz. Dağılımı ve onay kodunu döndürür.
 * @param {any} db  @param {{ decisions?: { orderNo: string, email: string }[], paymentEmail?: string | null }} [p]
 */
export async function previewLink(db, { decisions = [], paymentEmail = null } = {}) {
  const linked = await db.integrationSetting.findUnique({ where: { key: LINK_SETTING } });
  const built = await buildPlan(db, { decisions, paymentEmail });
  const problems = [...(linked?.value?.linkedAt ? [{ code: 'ALREADY_LINKED', detail: '' }] : []), ...built.problems];
  const before = await totalsSnapshot(db);
  return { ok: problems.length === 0, problems, approval: built.approval, plan: built.plan, summary: built.summary, before };
}

/**
 * Uygular — yalnızca ONAYLANMIŞ dağılımla (approval = önizlemenin onay kodu), tek işlemde; toplamlar değişirse geri alınır.
 * @param {any} db
 * @param {{ approval: string, decisions?: { orderNo: string, email: string }[], paymentEmail?: string | null, operator?: string, now?: Date,
 *   clock?: () => number, txOptions?: object, pg?: object, hooks?: { afterWrites?: (tx: any) => Promise<void> } }} p
 */
export async function applyLink(db, { approval, decisions = [], paymentEmail = null, operator = 'ssh', now = new Date(), clock = () => Date.now(), txOptions = LINK_TX, pg = LINK_PG, hooks = {} }) {
  const t0 = clock();
  const code = String(approval ?? '').trim().toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(code)) return { ok: false, code: 'APPROVAL_REQUIRED', timing: { previewMs: 0, applyMs: 0, totalMs: 0 } };
  const pre = await previewLink(db, { decisions, paymentEmail });
  const t1 = clock();
  const early = (c) => ({ ok: false, code: c, preview: pre, timing: { previewMs: t1 - t0, applyMs: 0, totalMs: t1 - t0 } });
  if (!pre.ok) return early(pre.problems[0].code);
  if (pre.approval !== code) return early('APPROVAL_MISMATCH');
  const actor = { id: null, role: 'SYSTEM', ip: null };
  const result = await db.$transaction(async (tx) => {
    // PostgreSQL sınırları yalnızca bu işlemde (SET LOCAL) — sayı tamsayıya zorlanır, metin girmez
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${Math.max(1, Math.trunc(Number(pg.statementTimeoutMs)))}`);
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${Math.max(1, Math.trunc(Number(pg.lockTimeoutMs)))}`);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'glass-routing'}, 0))`;
    if ((await tx.integrationSetting.findUnique({ where: { key: LINK_SETTING } }))?.value?.linkedAt) return { ok: false, code: 'ALREADY_LINKED' };
    // Onaylanan dağılım işlemin içinde yeniden hesaplanır: önizlemeden sonra değişen kayıt varsa hiçbir şey yazılmaz
    const built = await buildPlan(tx, { decisions, paymentEmail });
    if (built.problems.length) return { ok: false, code: built.problems[0].code };
    if (built.approval !== code) return { ok: false, code: 'APPROVAL_MISMATCH' };
    const { plan } = built;
    const group = (rows, key) => {
      const m = new Map();
      for (const r of rows) if (r[key]) m.set(r[key], [...(m.get(r[key]) ?? []), r.id]);
      return m;
    };
    // Düz SQL: updatedAt korunur (K-2). Her grup tam sayıda satır güncellemeli (aksi hâlde geri alınır).
    let orders = 0;
    for (const [owner, ids] of group(plan.orders, 'ownerId')) {
      const n = await tx.$executeRaw`UPDATE "Order" SET "salesUserId" = ${owner}, "salesAssignedVia" = 'MIGRATION'
        WHERE id = ANY(${ids}) AND "orderTypeCode" = 'GLASS_ORDER' AND "salesUserId" IS NULL`;
      if (n !== ids.length) throw new Error('ORDERS_CHANGED');
      orders += n;
    }
    let drawers = 0;
    for (const [drawer, ids] of group(plan.orders, 'drawerToSet')) {
      const n = await tx.$executeRaw`UPDATE "Order" SET "assignedDrawerId" = ${drawer} WHERE id = ANY(${ids}) AND "assignedDrawerId" IS NULL`;
      if (n !== ids.length) throw new Error('ORDERS_CHANGED');
      drawers += n;
    }
    let crates = 0;
    for (const [owner, ids] of group(plan.crates, 'ownerId')) {
      const n = await tx.$executeRaw`UPDATE "Crate" SET "salesUserId" = ${owner} WHERE id = ANY(${ids}) AND "salesUserId" IS NULL`;
      if (n !== ids.length) throw new Error('CRATES_CHANGED');
      crates += n;
    }
    const payments = plan.payments.count > 0
      ? (await tx.factoryPayment.updateMany({ where: { salesUserId: null }, data: { salesUserId: plan.payments.ownerId } })).count
      : 0;
    if (payments !== plan.payments.count) throw new Error('PAYMENTS_CHANGED');
    if (hooks.afterWrites) await hooks.afterWrites(tx);
    const byOwner = Object.fromEntries([...group(plan.orders, 'ownerId')].map(([id, ids]) => [id, ids.length]));
    const unresolved = plan.orders.filter((o) => !o.ownerId).length;
    // Otomatik yönlendirme kuralı YAZILMAZ: ilk durum "yönetici seçer" (karar 302)
    await tx.integrationSetting.upsert({
      where: { key: LINK_SETTING },
      create: { key: LINK_SETTING, value: { linkedAt: now.toISOString(), via: 'SCRIPT', operator, approval: code, byOwner, unresolved } },
      update: { value: { linkedAt: now.toISOString(), via: 'SCRIPT', operator, approval: code, byOwner, unresolved } },
    });
    const counts = { orders, drawers, crates, payments, unresolved, cratesKept: plan.crates.length - crates, decisions: plan.orders.filter((o) => o.via?.startsWith('DECISION')).length };
    const after = await totalsSnapshot(tx);
    if (!sameTotals(pre.before, after)) throw new Error('TOTALS_CHANGED');
    if (!accountsMatchSummary(after)) throw new Error('ACCOUNTS_MISMATCH');
    // Denetim kaydı en sonda: süre işlemin bu noktasına kadar ölçülür (işlemin kendisiyle birlikte yazılır ya da hiç yazılmaz)
    const inTxMs = clock() - t1;
    await writeAudit(tx, {
      action: 'SALES_LINK_APPLIED', entityType: 'IntegrationSetting', entityId: LINK_SETTING, userId: null,
      details: {
        operator, approval: code, counts, byOwner, paymentOwner: plan.payments.ownerId,
        decisions: plan.orders.filter((o) => o.via?.startsWith('DECISION')).map((o) => ({ orderId: o.id, ownerId: o.ownerId, override: o.via === 'DECISION_OVERRIDE' })),
        before: pre.before.perCur, timing: { previewMs: t1 - t0, inTxMs },
      },
    }, actor);
    return { ok: true, counts, byOwner, before: pre.before, after };
  }, txOptions);
  const t2 = clock();
  result.timing = { previewMs: t1 - t0, applyMs: t2 - t1, totalMs: t2 - t0, limitMs: txOptions.timeout };
  return result;
}
