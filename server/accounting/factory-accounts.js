// Cam Fabrika Hesap Durumu — satışçı hesapları (4.3.0, karar 300).
//
// Formül değişmedi (server/accounting/supplier.js): bakiye = maliyet − ödeme, para birimi başına; pozitif = GKH'nin
// fabrikaya borcu, negatif = fazla ödeme / avans. Yeni olan yalnızca gruplama:
//   - maliyet, siparişin SORUMLU SATIŞÇISINA (Order.salesUserId) yazılır — yükleme kârlılığıyla aynı satırlardan (planlanan
//     gün ya da onaylı yüklemenin geçerli kalemleri; kısmi yükleme, düzeltme ve telafi aynı kuralla gelir);
//   - ödeme, girişte seçilen satışçı hesabına (FactoryPayment.salesUserId) yazılır.
// Hesapların toplamı her para biriminde genel toplama EŞİTTİR (her satır ve ödeme tek hesaptadır). Satışçısı olmayan
// (geçiş öncesi / atanmamış) kayıtlar ayrı "hesapsız" satırda görünür — tahmin edilmez, gizlenmez.
// Ortak nakliye (LoadingCost) hesaplara dağıtılmaz: yükleme kârlılığında gün başına kalır.
// Para birimleri asla birbirine eklenmez.
import { can } from '../auth/permissions.js';
import { writeAudit } from '../orders/journal.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const FORBIDDEN = Object.freeze({ ok: false, code: 'FORBIDDEN' });

/**
 * Hesap bazında maliyet, ödeme, bakiye (saf). Genel görünüm: para birimi başına borçlu hesapların toplamı (bakiye > 0) ve
 * avanslı hesapların toplamı (bakiye < 0) AYRI; net = ikisinin farkı = genel bakiye.
 * @param {{ salesUserId?: string | null, currency: string, cost: number }[]} lines  muhasebe satırları (orderLine / confirmedLine)
 * @param {{ salesUserId?: string | null, currency: string, amount: unknown }[]} payments
 * @returns {{ accounts: { account: string | null, byCur: Record<string, { cost: number, paid: number, balance: number, orders: number, payments: number }> }[],
 *   overview: Record<string, { cost: number, paid: number, balance: number, debt: number, advance: number }> }}
 */
export function accountSummary(lines, payments) {
  const acc = new Map();
  const cell = (account, cur) => {
    const key = account ?? null;
    if (!acc.has(key)) acc.set(key, { account: key, byCur: {} });
    return (acc.get(key).byCur[cur] ??= { cost: 0, paid: 0, balance: 0, orders: 0, payments: 0 });
  };
  for (const l of lines) {
    if (!l) continue;
    const c = cell(l.salesUserId, l.currency);
    c.cost = round2(c.cost + l.cost);
    c.orders += 1;
  }
  for (const p of payments) {
    const c = cell(p.salesUserId, p.currency);
    c.paid = round2(c.paid + Number(p.amount));
    c.payments += 1;
  }
  const overview = {};
  for (const a of acc.values()) {
    for (const [cur, v] of Object.entries(a.byCur)) {
      v.balance = round2(v.cost - v.paid);
      const o = (overview[cur] ??= { cost: 0, paid: 0, balance: 0, debt: 0, advance: 0 });
      o.cost = round2(o.cost + v.cost);
      o.paid = round2(o.paid + v.paid);
      if (v.balance > 0) o.debt = round2(o.debt + v.balance);
      else if (v.balance < 0) o.advance = round2(o.advance - v.balance);
    }
  }
  for (const o of Object.values(overview)) o.balance = round2(o.cost - o.paid);
  // Hesaplı olanlar önce, hesapsız en sonda (sıralama ekranda ada göre yapılır)
  const accounts = [...acc.values()].sort((a, b) => (a.account == null) - (b.account == null));
  return { accounts, overview };
}

/** Ödeme hesabı olabilecek kullanıcı: silinmemiş iç ekip satışçısı (pasif hesap da — hesap kalıcıdır) */
export const validAccount = (u) => !!u && u.type === 'INTERNAL' && u.appRole === 'SATIS' && !u.deletedAt;

/**
 * Fabrikaya ödeme kaydı (yüklemeye / siparişe bağlı değil), seçilen satışçı hesabına. Yetki: ACCOUNTING_MANAGE — ilk deyim.
 * @param {any} db
 * @param {{ paidOn: Date, amount: number, currency: string, note: string | null, salesUserId: string, actor: { id: string, role: string, ip?: string | null } }} p
 * @returns {Promise<{ ok: true, id: string } | { ok: false, code: 'FORBIDDEN' | 'ACCOUNT' }>}
 */
export async function addFactoryPayment(db, { paidOn, amount, currency, note, salesUserId, actor }) {
  if (!actor?.id || !can(actor.role, 'ACCOUNTING_MANAGE')) return FORBIDDEN;
  return db.$transaction(async (tx) => {
    const account = salesUserId ? await tx.user.findUnique({ where: { id: String(salesUserId) }, select: { id: true, type: true, appRole: true, deletedAt: true } }) : null;
    if (!validAccount(account)) return { ok: false, code: 'ACCOUNT' };
    const p = await tx.factoryPayment.create({ data: { paidOn, amount: amount.toFixed(2), currency, note, salesUserId: account.id, createdById: actor.id } });
    await writeAudit(tx, {
      action: 'FACTORY_PAYMENT_ADD', entityType: 'FactoryPayment', entityId: p.id, userId: actor.id,
      details: { paidOn: paidOn.toISOString().slice(0, 10), amount, currency, salesUserId: account.id },
    }, actor);
    return { ok: true, id: p.id };
  });
}

/**
 * Yanlış hesaba girilmiş ödemenin hesabını değiştirir (karar 300). AYNI kayıt korunur (tutar, tarih, para birimi, not
 * değişmez): ödeme A hesabından düşer, B hesabına eklenir; genel toplam değişmez. Atomik: satır kilitlenir, ekrandaki
 * hesap (expected) hâlâ geçerliyse yazılır (değilse STALE). Denetim: önce / sonra. Yetki: ACCOUNTING_MANAGE — ilk deyim.
 * @param {any} db
 * @param {{ paymentId: string, salesUserId: string, expected: string | null, actor: { id: string, role: string, ip?: string | null } }} p
 * @returns {Promise<{ ok: true, changed: boolean } | { ok: false, code: 'FORBIDDEN' | 'NOT_FOUND' | 'ACCOUNT' | 'STALE' }>}
 */
export async function changePaymentAccount(db, { paymentId, salesUserId, expected, actor }) {
  if (!actor?.id || !can(actor.role, 'ACCOUNTING_MANAGE')) return FORBIDDEN;
  return db.$transaction(async (tx) => {
    const id = String(paymentId ?? '');
    const rows = await tx.$queryRaw`SELECT "id", "salesUserId" FROM "FactoryPayment" WHERE "id" = ${id} FOR UPDATE`;
    if (!rows.length) return { ok: false, code: 'NOT_FOUND' };
    const current = rows[0].salesUserId ?? null;
    if ((expected ?? null) !== current) return { ok: false, code: 'STALE' };
    const target = salesUserId ? await tx.user.findUnique({ where: { id: String(salesUserId) }, select: { id: true, type: true, appRole: true, deletedAt: true } }) : null;
    if (!validAccount(target)) return { ok: false, code: 'ACCOUNT' };
    if (target.id === current) return { ok: true, changed: false };
    const p = await tx.factoryPayment.update({ where: { id }, data: { salesUserId: target.id } });
    await writeAudit(tx, {
      action: 'FACTORY_PAYMENT_ACCOUNT_CHANGED', entityType: 'FactoryPayment', entityId: id, userId: actor.id,
      details: { from: current, to: target.id, paidOn: p.paidOn.toISOString().slice(0, 10), amount: p.amount.toString(), currency: p.currency },
    }, actor);
    return { ok: true, changed: true };
  });
}
