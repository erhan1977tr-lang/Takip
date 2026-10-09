// "Fatura bekliyor" (karar 126) ve sipariş seçimi / özel durum kurallarının veritabanı gerektirmeyen kısımları:
// ayar doğrulaması (varsayılan 6, 0–60), uyarı günü hesabı, fatura kapsamı kararı (invoiceScope — faturalama ekranıyla
// aynı işlev), bildirim metinleri. FGO'ya hiçbir istek yapılmaz: bu test sırasında ağa çıkılırsa test başarısız olur.
import test from 'node:test';
import assert from 'node:assert/strict';
import { UNINVOICED_DEFAULT_DAYS, UNINVOICED_MAX_DAYS, daysBetween, dueDayOf, parseUninvoicedDays } from '../server/accounting/uninvoiced.js';
import { invoiceOrderKey, invoiceScope } from '../server/glass/invoice-batch.js';
import { AUDIENCE_ROLES, renderInApp } from '../server/notifications/inapp.js';
import { can, ROLE_PERMISSIONS } from '../server/auth/permissions.js';

const realFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = async (url) => { throw new Error(`testte ağ isteği yapılmamalı: ${url}`); }; });
test.after(() => { globalThis.fetch = realFetch; });

test('ayar: varsayılan 6 gün; 0–60 arası tam sayı; geçersiz giriş reddedilir', () => {
  assert.deepEqual([UNINVOICED_DEFAULT_DAYS, UNINVOICED_MAX_DAYS], [6, 60]);
  for (const [raw, value] of [['', 6], [null, 6], [undefined, 6], ['0', 0], ['6', 6], [' 14 ', 14], ['60', 60], [7, 7]]) assert.deepEqual(parseUninvoicedDays(raw), { ok: true, value }, String(raw));
  for (const raw of ['61', '-1', '6.5', '6,5', 'abc', '1e1', '0x10', '1000', '6 gün']) assert.deepEqual(parseUninvoicedDays(raw), { ok: false }, raw);
});

test('uyarı günü = onaylı yükleme günü + takvim günü (ay / yıl sonu dahil)', () => {
  assert.equal(dueDayOf('2026-10-09', 6), '2026-10-15'); // ürün sahibinin örneği
  assert.equal(dueDayOf('2026-10-09', 0), '2026-10-09');
  assert.equal(dueDayOf('2026-10-28', 6), '2026-11-03');
  assert.equal(dueDayOf('2026-12-29', 6), '2027-01-04');
  assert.equal(daysBetween('2026-10-09', '2026-10-15'), 6);
  assert.equal(daysBetween('2026-10-24', '2026-10-26'), 2, 'yaz saati bitişi gün sayısını bozmaz');
});

test('fatura kapsamı kararı (invoiceScope): faturada / sipariş zinciri / muhasebe işlemi / kalemsiz / proforma bekliyor / faturalanabilir', () => {
  const item = (extra = {}) => ({ orderId: 'o1', currency: 'EUR', kind: 'CAM', unit: 'm2', description: 'Temper', descriptionRo: 'Sticlă', enMm: 1000, boyMm: 1000, quantity: 2, m2: 2, unitSale: 50, unitCost: 30, free: false, sortOrder: 0, replanId: null, ...extra });
  const order = (extra = {}) => ({ id: 'o1', fgoDocuments: [], billingBatchOrders: [], ...extra });
  const scope = (o, items = [item()], extra = {}) => invoiceScope({ confirmationId: 'c1', order: o, items, pendingJob: false, held: new Map(), ...extra });
  assert.deepEqual(scope(order()), { state: 'OPEN', currency: 'EUR', chainId: null, offerId: null });
  // Bu onaydan fatura partisinde (durumu ne olursa olsun yeniden faturalanmaz; uyarıyı yalnızca KESİLMİŞ olan kapatır)
  const inBatch = (status) => order({ billingBatchOrders: [{ activeKey: invoiceOrderKey('c1', 'o1'), offerId: null, batch: { id: 'b1', kind: 'INVOICE', status, document: null } }] });
  for (const status of ['PENDING', 'FAILED', 'ISSUED']) assert.deepEqual([scope(inBatch(status)).state, scope(inBatch(status)).batch.status], ['IN_INVOICE', status]);
  // Başka onayın faturası bu onayın kapsamını kapatmaz
  assert.equal(scope(order({ billingBatchOrders: [{ activeKey: invoiceOrderKey('c2', 'o1'), offerId: null, batch: { id: 'b2', kind: 'INVOICE', status: 'ISSUED', document: null } }] })).state, 'OPEN');
  // Sipariş başına belge zinciri (proforma / avans): müşteri faturasına girmez — fatura sipariş sayfasından
  assert.deepEqual(scope(order({ fgoDocuments: [{ kind: 'PROFORMA', series: 'PRF', number: '7' }] })), { state: 'EXCLUDED', reason: 'ORDER_CHAIN', ref: 'PRF7' });
  assert.deepEqual(scope(order(), [item()], { pendingJob: true }), { state: 'EXCLUDED', reason: 'ORDER_CHAIN', ref: null });
  // Muhasebe işlemi bekleyen dondurma, bedelsiz / fiyatsız kalem, desteklenmeyen para birimi: faturalanamaz
  assert.deepEqual(scope(order(), [item({ replanId: 'r1' })], { held: new Map([['r1', 'GKH12']]) }), { state: 'EXCLUDED', reason: 'ACCOUNTING_ACTION', ref: 'GKH12' });
  assert.deepEqual(scope(order(), [item({ free: true })]), { state: 'EXCLUDED', reason: 'NO_LINES', ref: null });
  assert.deepEqual(scope(order(), [item({ currency: 'USD' })]), { state: 'EXCLUDED', reason: 'CURRENCY', ref: null });
  // Müşteri proforması zinciri: kesilmişse faturalanabilir (kur zinciri = o parti); kesilmemişse bekler
  const pro = (status) => order({ billingBatchOrders: [{ activeKey: 'PROFORMA:o1', offerId: 'of1', batch: { id: 'p1', kind: 'PROFORMA', status, document: null } }] });
  assert.deepEqual(scope(pro('ISSUED')), { state: 'OPEN', currency: 'EUR', chainId: 'p1', offerId: 'of1' });
  assert.deepEqual(scope(pro('FAILED')), { state: 'EXCLUDED', reason: 'PROFORMA_NOT_ISSUED', ref: null });
});

test('bildirim alıcıları ve metinleri: fatura bekliyor yalnızca muhasebe yetkisine; misafir yük bildirimi ev sahibine yalnızca firma, sipariş no, sandık no, gün', () => {
  // Muhasebe kümesi yetkiden türetilir: yalnızca ACCOUNTING_MANAGE olan roller (satış, çizim, denetimci, müşteri değil)
  assert.deepEqual(AUDIENCE_ROLES.accounting, Object.keys(ROLE_PERMISSIONS).filter((r) => can(r, 'ACCOUNTING_MANAGE')));
  for (const role of ['SATIS', 'CIZIM', 'DENETIMCI', 'MUSTERI']) assert.ok(!AUDIENCE_ROLES.accounting.includes(role), role);
  assert.ok(AUDIENCE_ROLES.accounting.includes('ADMIN'));
  // Yetki: ev sahibi FİRMAYI yalnızca yönetici (LOADING_CONFIRM) seçer; sandığı satış da seçebilir (CRATE_EDIT)
  assert.deepEqual(Object.keys(ROLE_PERMISSIONS).filter((r) => can(r, 'LOADING_CONFIRM')), ['ADMIN', 'YONETICI_YARDIMCISI']);
  assert.deepEqual(Object.keys(ROLE_PERMISSIONS).filter((r) => can(r, 'CRATE_EDIT')).sort(), ['ADMIN', 'SATIS', 'YONETICI_YARDIMCISI']);

  const overdue = { type: 'INVOICE_OVERDUE', params: { aud: 'staff', orderNo: 'ALE53', firm: 'ALEGRAD', day: '2026-10-09', qty: 6 } };
  assert.deepEqual(renderInApp('tr', overdue), { title: 'Fatura bekliyor: yüklenen cam fatura edilmedi', body: 'ALE53 · ALEGRAD · yükleme 09.10.2026 · 6 gündür fatura edilmedi' });
  assert.deepEqual(renderInApp('ro', overdue), { title: 'Factură în așteptare: sticla încărcată nu a fost facturată', body: 'ALE53 · ALEGRAD · încărcare 09.10.2026 · nefacturată de 6 zile' });

  const hosted = { type: 'GUEST_CRATE_HOSTED', params: { aud: 'customer', day: '2026-10-09', crate: 12, guest: 'Miru Glass', guestOrder: 'MIR4' } };
  assert.deepEqual(renderInApp('ro', hosted), { title: 'Încărcătură suplimentară în lada dvs.', body: 'sticla firmei Miru Glass (comanda MIR4) a fost încărcată în lada dvs. nr. 12 · încărcare 09.10.2026' });
  assert.equal(renderInApp('tr', hosted).body, 'Miru Glass firmasının camı (MIR4) 12 numaralı sandığınıza yüklendi · yükleme 09.10.2026');
  // Sipariş sahibi firma: kendi sipariş numarası + sandık no + gün; ev sahibi firmanın adı metinde yok
  const placed = { type: 'GUEST_CRATE_PLACED', params: { aud: 'customer', orderNo: 'MIR4', day: '2026-10-09', crate: 12 } };
  assert.deepEqual(renderInApp('ro', placed), { title: 'Sticla comenzii dvs. a fost încărcată în lada altei firme', body: 'Comanda MIR4 · lada nr. 12 · încărcare 09.10.2026' });
  assert.match(renderInApp('ro', { type: 'GUEST_CRATE_CANCELLED', params: placed.params }).title, /anulată/);
  assert.match(renderInApp('ro', { type: 'GUEST_CRATE_UNHOSTED', params: hosted.params }).body, /^sticla firmei Miru Glass \(comanda MIR4\) · lada nr\. 12/);
});
