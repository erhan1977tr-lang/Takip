// DÜZELTME 10 M8 (3.99.0) — profil iadesi saf kuralları ve yapı: iade edilebilir miktar, form, depo teslimi, mali karşılık
// yalnızca niyet, iade kaydı stok yazmaz (stok yalnızca depo teslimiyle, receiveReturnStock), FGO çağrısı yok, yalnızca yönetici.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { customerPaid, parseReturnReceipt, parseReturnRequest, returnableLines } from '../server/profile/returns-rules.js';
import { can, ROLES } from '../server/auth/permissions.js';
import { renderProfileReturnEmail } from '../server/mail/templates/profile-return.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const OFFER = [
  { id: 'l1', kind: 'PROFIL', profileProductId: 'p1', adet: 10, offerPrice: '12.5', unitCode: 'CUTII' },
  { id: 'l2', kind: 'PROFIL', profileProductId: 'p2', adet: 3, offerPrice: '7', unitCode: 'BARA' },
  { id: 'l3', kind: 'CAM', profileProductId: null, adet: 1, offerPrice: '1' },
];

test('iade edilebilir miktar: teslim edilen − iptal edilmemiş önceki iadeler; profil olmayan satır yok', () => {
  const lines = returnableLines(OFFER, [{ offerLineId: 'l1', qty: 4 }, { offerLineId: 'l1', qty: 3 }]);
  assert.deepEqual(lines.map((l) => [l.offerLineId, l.delivered, l.returned, l.remaining, l.unitPrice]), [['l1', 10, 7, 3, '12.5'], ['l2', 3, 0, 3, '7']]);
  assert.equal(returnableLines(OFFER, [{ offerLineId: 'l2', qty: 9 }])[1].remaining, 0);
});

test('iade formu: gerekçe zorunlu, miktar ≤ kalan, en az bir satır, bilinmeyen satır yok; tutar = adet × satış fiyatı', () => {
  const lines = returnableLines(OFFER, []);
  const ok = parseReturnRequest({ reason: ' kırık ', quantities: { l1: '3', l2: '' } }, lines, { paid: false });
  assert.deepEqual([ok.ok, ok.value.reason, ok.value.amount, ok.value.lines.map((l) => [l.offerLineId, l.qty, l.lineTotal]), ok.value.financeAction], [true, 'kırık', '37.50', [['l1', 3, '37.50']], null]);
  assert.deepEqual(parseReturnRequest({ reason: '', quantities: { l1: '1' } }, lines, { paid: false }), { ok: false, code: 'REASON' });
  assert.deepEqual(parseReturnRequest({ reason: 'x', quantities: { l1: '11' } }, lines, { paid: false }), { ok: false, code: 'OVER_RETURNABLE', index: 0 });
  assert.deepEqual(parseReturnRequest({ reason: 'x', quantities: { l1: '-1' } }, lines, { paid: false }), { ok: false, code: 'QTY', index: 0 });
  assert.deepEqual(parseReturnRequest({ reason: 'x', quantities: {} }, lines, { paid: false }), { ok: false, code: 'EMPTY' });
  assert.deepEqual(parseReturnRequest({ reason: 'x', quantities: { l1: '1', zzz: '1' } }, lines, { paid: false }), { ok: false, code: 'QTY' });
  // Ödeme varsa mali karşılık zorunlu; yoksa yok sayılır
  assert.deepEqual(parseReturnRequest({ reason: 'x', quantities: { l1: '1' } }, lines, { paid: true }), { ok: false, code: 'FINANCE_ACTION' });
  assert.equal(parseReturnRequest({ reason: 'x', quantities: { l1: '1' }, financeAction: 'offset' }, lines, { paid: true }).value.financeAction, 'OFFSET');
  assert.equal(parseReturnRequest({ reason: 'x', quantities: { l1: '1' }, financeAction: 'REFUND' }, lines, { paid: false }).value.financeAction, null);
  assert.equal(customerPaid({ paidAt: null, fgoPaid: 0, manualPayments: 0 }), false);
  assert.equal(customerPaid({ paidAt: null, fgoPaid: '10', manualPayments: 0 }), true);
});

test('depo teslimi: sağlam + hasarlı ≤ iade adedi, eksik kaydedilir, en az biri > 0', () => {
  const lines = [{ id: 'a', qty: 4 }, { id: 'b', qty: 2 }];
  assert.deepEqual(parseReturnReceipt(lines, { a: { good: '3', damaged: '1' }, b: { good: '0', damaged: '' } }), { ok: true, lines: [{ id: 'a', good: 3, damaged: 1, missing: 0 }, { id: 'b', good: 0, damaged: 0, missing: 2 }] });
  assert.deepEqual(parseReturnReceipt(lines, { a: { good: '4', damaged: '1' } }), { ok: false, code: 'OVER', index: 0 });
  assert.deepEqual(parseReturnReceipt(lines, {}), { ok: false, code: 'EMPTY' });
});

test('yapı: iade kaydı stok yazmaz (yalnızca depo teslimi → receiveReturnStock); FGO yok; yalnızca yönetici; her işlevin ilk satırı yetki', () => {
  for (const r of ROLES) assert.equal(can(r, 'PROFILE_RETURN_MANAGE'), r === 'ADMIN', r);
  const svc = strip(read('server/profile/returns.js'));
  assert.doesNotMatch(svc, /stockMovement\.(create|createMany)|blockedStockMovement\.(create|createMany)/, 'stok yalnızca stock.js üzerinden');
  assert.equal((svc.match(/receiveReturnStock\(/g) ?? []).length, 1);
  assert.doesNotMatch(svc + read('server/profile/returns-mail.js'), /integrations\/fgo\.js|factura\/|fgoDocument\.(create|update)/, 'FGO çağrısı yok');
  const exported = [...svc.matchAll(/export async function (\w+)\(db, [^)]*actor/g)].map((x) => x[1]).sort();
  assert.deepEqual(exported, ['cancelReturn', 'confirmReturnReceipt', 'createReturn', 'markRefundDone', 'returnOverview']);
  for (const name of exported) {
    const body = svc.slice(svc.indexOf(`export async function ${name}(`));
    assert.equal(body.slice(body.indexOf(') {\n') + 4).trim().split('\n')[0], 'if (!allowed(actor)) return FORBIDDEN;', name);
  }
  const actions = read('app/(panel)/siparisler/[id]/return-actions.ts');
  const fns = [...actions.matchAll(/export async function (\w+)\(fd: FormData\) \{\n\s*const user = await requirePermission\('PROFILE_RETURN_MANAGE'\);/g)].map((x) => x[1]);
  assert.equal(fns.length, [...actions.matchAll(/export async function /g)].length);
});

test('depo e-postası: Romence, ürün / miktar / gerekçe / durum; fiyat ve tutar YOK; bağlantı yalnızca açılış bildiriminde', () => {
  const lines = [{ code: 'GK15', name: 'Garnitura', qty: 2, unit: 'cutii', good: 1, damaged: 1 }];
  const o = renderProfileReturnEmail({ notice: 'OPENED', orderNo: 'IADP1', seq: 1, firmName: 'Firma', reason: 'kırık', lines, link: 'https://x.test/depo-iade/abc', validDays: 30 });
  assert.match(o.subject, /Retur deschis – IADP1 – retur nr\. 1/);
  assert.match(o.text, /https:\/\/x\.test\/depo-iade\/abc/);
  const r = renderProfileReturnEmail({ notice: 'RECEIVED', orderNo: 'IADP1', seq: 1, firmName: 'Firma', reason: 'kırık', lines });
  assert.match(r.text, /bună: 1, deteriorată: 1/);
  assert.doesNotMatch(r.text + r.html, /depo-iade|EUR|RON|preț/i);
});
