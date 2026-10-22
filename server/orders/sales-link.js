// Geçmiş verinin açık hedef hesaba bağlanması (4.3.0, karar 300 — bölüm 7). Sunucu komutu (scripts/sales-link.mjs)
// tarafından çağrılır; HTTP yolu yoktur.
//
// Hedef hesap (satışçı) ve varsayılan çizimci KULLANICI TARAFINDAN AÇIKÇA verilir — kullanıcı sayısından ya da son işlemden
// tahmin edilmez. Önce kontrol / önizleme (previewLink: hiçbir şey yazmaz), sonra uygulama (applyLink). Bağlama:
//   - sorumlu satışçısı boş CAM siparişleri → hedef (salesAssignedVia = MIGRATION; salesAssignedAt yazılmaz — tarihsel kayıt);
//     çizimcisi boş olanlara hedefin çizimcisi (yalnızca çizim hattı açık / çalışan siparişlerde; YOK olanlara da — eski
//     siparişlerde alan bilgi amaçlıdır);
//   - satışçısı boş sandıklar (Crate) → hedef;
//   - hesabı boş fabrika ödemeleri (FactoryPayment) → hedef;
//   - hedefin varsayılan çizimcisi boşsa verilen çizimci;
//   - bağlama işareti (IntegrationSetting 'sales-routing'.linkedAt) + varsayılan otomatik yönlendirme kuralı (AUTO → hedef,
//     başlangıç = şimdi): ilk etkinleştirmede mevcut kullanım korunur (yeni siparişler mevcut satışçıya).
// Üretmez: görev, bildirim (outbox), durum değişikliği, SLA değişikliği, dış servis çağrısı. Tek denetim kaydı
// (SALES_LINK_APPLIED) + bir audit satırı sayımlarla.
// Toplam koruması: para birimi başına maliyet / ödeme / bakiye ve kayıt sayıları bağlamadan önce ve sonra aynı olmalı
// (checkTotals) — değişirse işlem geri alınır (hata). Belirsiz / çelişkili kayıtlar raporlanır (ambiguities), yazılmaz.
import { LINK_SETTING, validDrawer, validSales } from './sales-routing.js';
import { writeAudit } from './journal.js';
import { supplierData } from '../accounting/supplier.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

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

/**
 * Ön kontrol / önizleme — hiçbir şey yazmaz.
 * @param {any} db  @param {{ targetEmail: string, drawerEmail?: string | null }} p
 */
export async function previewLink(db, { targetEmail, drawerEmail = null }) {
  const problems = [];
  const ambiguities = [];
  const target = await userByEmail(db, targetEmail, { include: { defaultDrawer: true } });
  if (!validSales(target)) problems.push('TARGET_NOT_SALES');
  let drawer = null;
  if (drawerEmail) {
    drawer = await userByEmail(db, drawerEmail);
    if (!validDrawer(drawer)) problems.push('DRAWER_NOT_DRAWER');
  } else if (target && !validDrawer(target.defaultDrawer)) {
    problems.push('NO_DRAWER');
  }
  const linked = await db.integrationSetting.findUnique({ where: { key: LINK_SETTING } });
  if (linked?.value?.linkedAt) problems.push('ALREADY_LINKED');
  const [orders, owned, crates, payments, otherSales, otherDrawers] = await Promise.all([
    db.order.count({ where: { orderTypeCode: 'GLASS_ORDER', salesUserId: null } }),
    db.order.count({ where: { orderTypeCode: 'GLASS_ORDER', salesUserId: { not: null } } }),
    db.crate.count({ where: { salesUserId: null } }),
    db.factoryPayment.count({ where: { salesUserId: null } }),
    db.user.findMany({ where: { appRole: 'SATIS', type: 'INTERNAL', deletedAt: null, ...(target ? { id: { not: target.id } } : {}) }, select: { email: true, isActive: true } }),
    db.user.findMany({ where: { appRole: 'CIZIM', type: 'INTERNAL', deletedAt: null, isActive: true }, select: { id: true, email: true } }),
  ]);
  // Belirsizlikler: başka satışçı hesapları (hangisinin geçmişi? — kullanıcı hedefi zaten açıkça verdi, ama raporlanır),
  // sahibi olan ama çizimcisi hedefin çizimcisinden farklı siparişler, birden çok çizimci
  if (otherSales.length) ambiguities.push({ code: 'OTHER_SALES_ACCOUNTS', detail: otherSales.map((u) => `${u.email}${u.isActive ? '' : ' (pasif)'}`) });
  if (owned) ambiguities.push({ code: 'ALREADY_OWNED_ORDERS', detail: [String(owned)] });
  const drawerId = drawer?.id ?? target?.defaultDrawer?.id ?? null;
  if (otherDrawers.length > 1) ambiguities.push({ code: 'MULTIPLE_DRAWERS', detail: otherDrawers.map((u) => u.email) });
  if (drawerId) {
    const foreign = await db.order.count({ where: { orderTypeCode: 'GLASS_ORDER', salesUserId: null, assignedDrawerId: { not: null, notIn: [drawerId] } } });
    if (foreign) ambiguities.push({ code: 'ORDERS_WITH_OTHER_DRAWER', detail: [String(foreign)] });
  }
  const before = await totalsSnapshot(db);
  return {
    ok: problems.length === 0, problems, ambiguities,
    target: target ? { id: target.id, email: target.email, name: target.name } : null,
    drawer: drawerId ? { id: drawerId, email: drawer?.email ?? target?.defaultDrawer?.email ?? '' } : null,
    plan: { orders, crates, payments, setDefaultDrawer: !!target && !target.defaultDrawerId && !!drawerId },
    before,
  };
}

/**
 * Uygular — tek işlemde; toplamlar değişirse geri alınır. Önce previewLink çağrılmış ve ok olmalı.
 * @param {any} db  @param {{ targetEmail: string, drawerEmail?: string | null, operator?: string, now?: Date }} p
 */
export async function applyLink(db, { targetEmail, drawerEmail = null, operator = 'ssh', now = new Date() }) {
  const pre = await previewLink(db, { targetEmail, drawerEmail });
  if (!pre.ok) return { ok: false, code: pre.problems[0], preview: pre };
  const actor = { id: null, role: 'SYSTEM', ip: null };
  const result = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'glass-routing'}, 0))`;
    if ((await tx.integrationSetting.findUnique({ where: { key: LINK_SETTING } }))?.value?.linkedAt) return { ok: false, code: 'ALREADY_LINKED' };
    const target = pre.target.id;
    const drawer = pre.drawer?.id ?? null;
    const orders = await tx.order.updateMany({
      where: { orderTypeCode: 'GLASS_ORDER', salesUserId: null },
      data: { salesUserId: target, salesAssignedVia: 'MIGRATION' },
    });
    const drawers = drawer
      ? await tx.order.updateMany({ where: { orderTypeCode: 'GLASS_ORDER', salesUserId: target, assignedDrawerId: null }, data: { assignedDrawerId: drawer } })
      : { count: 0 };
    const crates = await tx.crate.updateMany({ where: { salesUserId: null }, data: { salesUserId: target } });
    const payments = await tx.factoryPayment.updateMany({ where: { salesUserId: null }, data: { salesUserId: target } });
    if (pre.plan.setDefaultDrawer && drawer) await tx.user.update({ where: { id: target }, data: { defaultDrawerId: drawer } });
    // Varsayılan yönlendirme: mevcut kullanım korunur — yeni siparişler mevcut (hedef) satışçıya
    const rule = await tx.glassRoutingRule.create({ data: { mode: 'AUTO', targetUserId: target, startsAt: now, note: 'MIGRATION', createdById: target } });
    await tx.integrationSetting.upsert({
      where: { key: LINK_SETTING },
      create: { key: LINK_SETTING, value: { linkedAt: now.toISOString(), via: 'SCRIPT', targetUserId: target, operator } },
      update: { value: { linkedAt: now.toISOString(), via: 'SCRIPT', targetUserId: target, operator } },
    });
    const counts = { orders: orders.count, drawers: drawers.count, crates: crates.count, payments: payments.count, rule: rule.id };
    await writeAudit(tx, {
      action: 'SALES_LINK_APPLIED', entityType: 'User', entityId: target, userId: null,
      details: { targetUserId: target, drawerId: drawer, operator, counts, before: pre.before.perCur },
    }, actor);
    const after = await totalsSnapshot(tx);
    if (!sameTotals(pre.before, after)) throw new Error('TOTALS_CHANGED');
    if (!accountsMatchSummary(after)) throw new Error('ACCOUNTS_MISMATCH');
    return { ok: true, counts, before: pre.before, after };
  });
  return result;
}
