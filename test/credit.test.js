// DÜZELTME 10 Aşama 2C (karar 295): müşteri fazla ödemesi ve TAKİP içi mahsup — saf kurallar ve yapı denetimi.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { creditLedger, offsetCheck, parseClose, parseOffset } from '../server/finance/credit.js';
import { paymentState, toCents } from '../server/finance/payments.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** Zincir girdisi paymentState'ten (tek hesap): fazla ödeme yeniden hesaplanmaz */
const chain = (key, { total, fgo = 0, manual = 0, advanced = 0, cancelled = false, ref = key.toUpperCase() }) => {
  const st = paymentState({ fgoPaid: String(fgo), proformaTotal: total == null ? null : String(total), payments: manual ? [{ ron: String(manual) }] : [], advanced: String(advanced) });
  return { key, ref, orderIds: [key], orderNos: [key], cancelled, total: total == null ? null : String(total), fgoPaid: st.fgoPaid, manualRon: st.manualRon, basis: st.basis, advanced: st.advanced, overpaid: st.overpaid };
};
const off = (id, sourceChain, targetChain, amountRon, status = 'ACTIVE') => ({ id, sourceChain, targetChain, amountRon, status });

test('defter: fazla ödeme zincir başına paymentState\'ten; kullanılabilir = Σ max(0, fazla − çıkan); iptal zinciri bakiyeye girmez', () => {
  const chains = [
    chain('order:a', { total: 1000, fgo: 1300 }), // fazla 300
    chain('order:b', { total: 500, manual: 450 }), // açık 50
    chain('batch:c', { total: 800, fgo: 900, manual: 950 }), // fazla 150 (büyük olan esas)
    chain('order:d', { total: 200, fgo: 200, cancelled: true }), // iptal: incelemede
  ];
  const l = creditLedger(chains, []);
  assert.deepEqual(l.totals, { paid: 2900, overpaid: 450, offset: 0, available: 450, cancelledPaid: 200 });
  assert.deepEqual(l.review, [{ code: 'CANCELLED_PAID', chain: 'order:d' }]);
  const b = l.rows.find((r) => r.key === 'order:b');
  assert.deepEqual([b.open, b.canTarget, b.canSource], [50, true, false]);
  assert.deepEqual(l.rows.find((r) => r.key === 'order:d').canTarget, false);
});

test('mahsup: yalnızca ACTIVE sayılır; REVERSED hiç, FGO_RECORDED artık FGO rakamlarında (iki kez sayılmaz)', () => {
  const chains = [chain('order:a', { total: 1000, fgo: 1300 }), chain('order:b', { total: 500, manual: 300 })];
  let l = creditLedger(chains, [off('1', 'order:a', 'order:b', '120')]);
  assert.deepEqual([l.totals.available, l.totals.offset], [180, 120]);
  assert.deepEqual(l.rows.map((r) => [r.key, r.offsetOut, r.offsetIn, r.remaining, r.open]), [['order:a', 120, 0, 180, -300], ['order:b', 0, 120, 0, 80]]);
  // Mahsup avans dayanağını değiştirmez: zincirin tahsilatı (basis) aynı kalır
  assert.deepEqual(l.rows.map((r) => r.basis), [1300, 300]);
  l = creditLedger(chains, [off('1', 'order:a', 'order:b', '120', 'REVERSED')]);
  assert.deepEqual([l.totals.available, l.totals.offset], [300, 0]);
  // Muhasebeci FGO'ya işledi: FGO kaynağı 120 azalttı, hedefi 120 artırdı; kapalı kayıt artık sayılmaz → toplam bakiye aynı
  const after = [chain('order:a', { total: 1000, fgo: 1180 }), chain('order:b', { total: 500, manual: 300, fgo: 420 })];
  l = creditLedger(after, [off('1', 'order:a', 'order:b', '120', 'FGO_RECORDED')]);
  assert.deepEqual([l.totals.available, l.totals.offset, l.review], [180, 0, []]);
  // Kapatılmadan bırakılsaydı aynı 120 iki kez düşerdi: hedefin açığı eksiye düşer → inceleme uyarır
  l = creditLedger(after, [off('1', 'order:a', 'order:b', '120')]);
  assert.deepEqual([l.totals.available, l.review.map((r) => r.code)], [60, ['OFFSET_EXCEEDS_TARGET']]);
});

test('inceleme: kaynağın fazlası sonradan azaldı / hedefe sonradan ödeme geldi / zinciri kayboldu', () => {
  const l = creditLedger(
    [chain('order:a', { total: 1000, fgo: 1050 }), chain('order:b', { total: 500, fgo: 480 })],
    [off('1', 'order:a', 'order:b', '100'), off('2', 'order:x', 'order:b', '1')],
  );
  assert.deepEqual(l.review.map((r) => r.code).sort(), ['OFFSET_CHAIN_GONE', 'OFFSET_EXCEEDS_SOURCE', 'OFFSET_EXCEEDS_TARGET']);
  assert.equal(l.totals.available, 0, 'eksi kalan bakiyeyi artırmaz');
});

test('mahsup sınırları: aynı zincir, iptal, kaynak kalanı, hedef açığı, proformasız hedef', () => {
  const l = creditLedger([
    chain('order:a', { total: 1000, fgo: 1300 }), chain('order:b', { total: 500, manual: 400 }),
    chain('order:c', { total: 100, fgo: 100, cancelled: true }), chain('order:n', { total: null, fgo: 0 }),
  ], []);
  const c = (s, t, ron) => offsetCheck(l, { sourceChain: s, targetChain: t, cents: toCents(ron) }).code ?? 'OK';
  assert.equal(c('order:a', 'order:a', '1'), 'SAME_CHAIN');
  assert.equal(c('order:z', 'order:b', '1'), 'SOURCE_GONE');
  assert.equal(c('order:c', 'order:b', '1'), 'SOURCE_CANCELLED');
  assert.equal(c('order:a', 'order:c', '1'), 'TARGET_CANCELLED');
  assert.equal(c('order:a', 'order:n', '1'), 'TARGET_NO_PROFORMA');
  assert.equal(c('order:a', 'order:q', '1'), 'TARGET_NO_PROFORMA');
  assert.equal(c('order:a', 'order:b', '100.01'), 'OVER_TARGET');
  assert.equal(c('order:a', 'order:b', '100'), 'OK');
  const l2 = creditLedger([chain('order:a', { total: 1000, fgo: 1050 }), chain('order:b', { total: 500 })], []);
  assert.equal(offsetCheck(l2, { sourceChain: 'order:a', targetChain: 'order:b', cents: toCents('50.01') }).code, 'OVER_SOURCE');
  assert.equal(offsetCheck(l2, { sourceChain: 'order:a', targetChain: 'order:b', cents: toCents('50') }).ok, true);
});

test('form: açık onay zorunlu, tutar > 0 en çok 2 ondalık, gerekçe zorunlu', () => {
  assert.equal(parseOffset({ amount: '10', note: 'x' }).code, 'CONFIRM_REQUIRED');
  assert.equal(parseOffset({ amount: '10', note: 'x', confirm: 'off' }).code, 'CONFIRM_REQUIRED');
  for (const a of ['0', '-1', '1.234', 'abc', '', '100000000.00']) assert.equal(parseOffset({ amount: a, note: 'x', confirm: 'on' }).code, 'AMOUNT', a);
  assert.equal(parseOffset({ amount: '1,5', note: '  ', confirm: 'on' }).code, 'NOTE');
  assert.equal(parseOffset({ amount: '1', note: 'x'.repeat(501), confirm: 'on' }).code, 'TOO_LONG');
  const ok = parseOffset({ amount: ' 1 234,50 ', note: ' GLA68 fazlası\nGLA70e ', confirm: 'on' });
  assert.deepEqual(ok, { ok: true, value: { cents: 123450n, note: 'GLA68 fazlası GLA70e' } });
  assert.equal(parseClose({ reason: 'x' }).code, 'CONFIRM_REQUIRED');
  assert.equal(parseClose({ reason: ' ', confirm: 'on' }).code, 'REASON');
  assert.deepEqual(parseClose({ reason: 'yanlış hedef', confirm: 'on' }), { ok: true, value: { reason: 'yanlış hedef', fgoRef: null } });
  assert.deepEqual(parseClose({ reason: 'r', confirm: 'on', fgoRef: 'PRF9' }, 'REVERSED'), { ok: true, value: { reason: 'r', fgoRef: null } }, 'geri almada referans alınmaz');
  // FGO'ya işlendi = manuel beyan: referans zorunlu ve sade
  for (const bad of [undefined, '', '  ', '<b>x</b>', 'a'.repeat(61), '-PRF']) assert.equal(parseClose({ reason: 'r', confirm: 'on', fgoRef: bad }, 'FGO_RECORDED').code, 'FGO_REF', String(bad));
  assert.deepEqual(parseClose({ reason: 'r', confirm: 'on', fgoRef: ' PRF 512 / incasare 7 ' }, 'FGO_RECORDED'), { ok: true, value: { reason: 'r', fgoRef: 'PRF 512 / incasare 7' } });
});

test('rastgele: kullanılabilir bakiye hiçbir zaman fazla ödemelerin toplamını aşmaz; geçerli mahsuplar sonrası her zincir ≥ 0', () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 1000; i++) {
    const chains = Array.from({ length: 1 + rnd(5) }, (_, k) => chain(`order:${k}`, { total: 1 + rnd(5000), fgo: rnd(8000), manual: rnd(8000), cancelled: rnd(6) === 0 }));
    const offsets = [];
    let ledger = creditLedger(chains, offsets);
    for (let j = 0; j < 4; j++) {
      const s = ledger.rows.filter((r) => r.canSource), tg = ledger.rows.filter((r) => r.canTarget);
      if (!s.length || !tg.length) break;
      const a = s[rnd(s.length)], b = tg[rnd(tg.length)];
      const cents = BigInt(1 + rnd(Math.max(1, Math.round(Math.min(a.remaining, b.open ?? 0) * 100))));
      if (offsetCheck(ledger, { sourceChain: a.key, targetChain: b.key, cents }).ok) offsets.push(off(String(j), a.key, b.key, (Number(cents) / 100).toFixed(2)));
      ledger = creditLedger(chains, offsets);
    }
    const over = ledger.rows.filter((r) => !r.cancelled).reduce((n, r) => n + Math.round(r.overpaid * 100), 0);
    assert.ok(Math.round(ledger.totals.available * 100) <= over, `tur ${i}`);
    assert.equal(Math.round(ledger.totals.available * 100) + Math.round(ledger.totals.offset * 100), over, `tur ${i}: bakiye + mahsup = fazla ödeme`);
    for (const r of ledger.rows) {
      assert.ok(r.remaining >= 0, `tur ${i} kaynak`);
      if (r.offsetIn > 0) assert.ok(r.open >= 0, `tur ${i} hedef`);
    }
    assert.deepEqual(ledger.review.filter((x) => x.code !== 'CANCELLED_PAID'), [], `tur ${i}`);
  }
});

test('yapı: servis yalnızca ACCOUNTING_MANAGE; FGO / ANAF / kuyruk / e-posta yok; yalnızca CreditOffset + denetim yazar', () => {
  const src = read('server/finance/credit-service.js');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');
  for (const fn of ['customerCredit', 'creditCustomers', 'createOffset', 'closeOffset', 'orderOffsets']) {
    const lines = src.slice(src.indexOf(`export async function ${fn}(`)).split('\n');
    const end = lines.findIndex((l) => /\{$/.test(l));
    assert.equal(lines[end + 1], '  if (!allowed(actor)) return FORBIDDEN;', `${fn}: ilk satır yetki`);
  }
  assert.match(src, /const PERMISSION = 'ACCOUNTING_MANAGE';/);
  for (const bad of [/integrations\/fgo/, /notificationOutbox/, /\bfetch\(/, /sendMail|sendBrandedMail|mail\//, /incasare/, /anaf/i, /\$executeRawUnsafe|\$queryRawUnsafe/]) assert.doesNotMatch(code, bad, String(bad));
  const writes = [...src.matchAll(/tx\.(\w+)\.(create|update|updateMany|delete|deleteMany|upsert|createMany)\(/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(writes)].sort(), ['creditOffset']);
  assert.doesNotMatch(src, /db\.\w+\.(create|update|updateMany|delete|deleteMany|upsert|createMany)\(/, 'işlem dışı yazma yok');
  // Mahsup avans hesabına girmez: ödeme / avans / fatura kodu creditOffset'i okumaz
  for (const f of ['server/finance/payments.js', 'server/finance/service.js', 'server/glass/billing.js', 'server/glass/invoice-batch.js', 'server/profile/fgo-jobs.js', 'server/accounting/receivables.js']) {
    assert.doesNotMatch(read(f), /creditOffset|CreditOffset/, f);
  }
  // Sayfa ve işlemler yetkiyi ayrıca denetler
  const page = read('app/(panel)/admin/muhasebe/bakiye/page.tsx');
  const actions = read('app/(panel)/admin/muhasebe/bakiye/actions.ts');
  assert.match(page, /requirePermission\('ACCOUNTING_MANAGE'\)/);
  for (const fn of ['createOffsetAction', 'closeOffsetAction']) {
    const body = actions.slice(actions.indexOf(`export async function ${fn}(`));
    assert.match(body.split('\n')[1], /requirePermission\('ACCOUNTING_MANAGE'\)/, fn);
  }
  // Sipariş finans kartı yalnızca ACCOUNTING_MANAGE ile çizilir (karar 210) ve mahsubu kendi yetkisiyle okur
  assert.match(read('app/(panel)/siparisler/[id]/OrderPayments.tsx'), /orderOffsets\(db, orderId, viewer\)/);
});
