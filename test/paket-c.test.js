// Paket C — saf kurallar ve yapı denetimleri (kararlar 230–237). Veritabanı / ağ yok.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { glassDocText, invoiceProductName, invoiceLines } from '../server/glass/billing.js';
import { snapshotLine } from '../server/loading/confirmation.js';
import { orderLine } from '../server/accounting/supplier.js';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('nihai fatura ürün adı (karar 236): "Sticla" + teknik kısım; securizată / laminată atılır; başka ad değişmez', () => {
  assert.equal(invoiceProductName('STICLĂ SECURIZATĂ LAMINATĂ 4.2.4., PVB OPAQUE (GRI+GRI)'), 'Sticla 4.2.4., PVB OPAQUE (GRI+GRI)');
  assert.equal(invoiceProductName('Sticlă securizată 10 mm'), 'Sticla 10 mm');
  assert.equal(invoiceProductName('Sticlă laminată 44.2'), 'Sticla 44.2');
  assert.equal(invoiceProductName('Sticla securizata, 8 mm extraclar'), 'Sticla 8 mm extraclar');
  assert.equal(invoiceProductName('Sticlă 10 mm - diagonală (transparentă)'), 'Sticla 10 mm - diagonală (transparentă)');
  assert.equal(invoiceProductName('Sticlă securizată'), 'Sticla');
  assert.equal(invoiceProductName('Oglindă 4 mm'), 'Oglindă 4 mm');
  assert.equal(invoiceProductName('6.2.6., Sticla, Gri-Transparent, securizata'), '6.2.6., Sticla, Gri-Transparent, securizata');
  assert.equal(invoiceProductName('Sticlarie'), 'Sticlarie', 'kelime sınırı');
  assert.equal(invoiceProductName(null), '');
});

test('fatura satırı: gruplama özgün adla, yazılan ad kısalır; tutar ve miktar değişmez', () => {
  const line = (descriptionRo, extra = {}) => ({ kind: 'CAM', unit: 'm2', enMm: 1000, boyMm: 1000, adet: 1, offerPrice: '50', descriptionRo, ...extra });
  const lines = invoiceLines({ lines: [line('Sticlă securizată 10 mm'), line('Sticlă securizată 10 mm', { adet: 2 }), line('Oglindă 4 mm')] }, 5, 21);
  assert.deepEqual(lines.map((l) => [l.name, l.qty, l.net]), [['Sticla 10 mm', 3, 750], ['Oglindă 4 mm', 1, 250]]);
});

test('FGO açıklaması (karar 235): EUR belgede kayıtlı kurun cümlesi; RON ya da kur yoksa boş (uydurulmaz)', () => {
  assert.equal(glassDocText('EUR', { fxRate: '4.9765', fxPolicy: 'BT_UNIT_SELL', fxSource: 'MANUAL_DAY' }), 'Curs de vânzare BT: 4.9765 RON/EUR.');
  assert.equal(glassDocText('EUR', { fxRate: '5', fxPolicy: 'BNR', fxSource: 'BNR', fxSourceDate: new Date('2026-10-02T00:00:00Z') }), 'Curs BNR: 5.0000 RON/EUR (data 02.10.2026).');
  assert.equal(glassDocText('EUR', { fxRate: '5.202', fxPolicy: 'BNR_PLUS_PERCENT', fxSource: 'BNR', fxMarkupPercent: '2' }), 'Curs de schimb aplicat: 5.2020 RON/EUR.');
  assert.doesNotMatch(glassDocText('EUR', { fxRate: '5.202', fxPolicy: 'BNR_PLUS_PERCENT', fxSource: 'BNR', fxMarkupPercent: '2' }), /%|BNR/);
  assert.equal(glassDocText('EUR', { fxRate: '5.25', fxPolicy: 'BNR', fxSource: 'MANUAL' }), 'Curs de schimb aplicat: 5.2500 RON/EUR.');
  assert.equal(glassDocText('RON', { fxRate: '1' }), '');
  assert.equal(glassDocText('EUR', null), '');
  assert.equal(glassDocText('EUR', { fxRate: null }), '');
  assert.equal(glassDocText('EUR', { fxRate: '0' }), '');
});

test('fiyat gizliliği (karar 237): müşteri fiyatı yoksa satış / fabrika fiyatına düşülmez', () => {
  // Teklif görünümü (lib/orders.ts → offerPrices): eski teklifte de müşteri fiyatı = offerPrice; tutar = offerAmount
  const orders = read('lib/orders.ts');
  const fn = orders.slice(orders.indexOf('function offerPrices'), orders.indexOf('export function sanitizeRows'));
  assert.ok(fn.includes('amount: o.offerAmount ?? null,'));
  assert.ok(fn.includes('unitPrice: l.offerPrice ?? (legacy ? null : ZERO)'));
  assert.ok(!/legacy \? (o\.amount|l\.unitPrice)/.test(fn), 'satış fiyatına geri düşüş yok');
  // Yükleme tutarı: Price ya da offerAmount — satış tutarı (amount) değil
  const loading = read('lib/loading.ts');
  assert.ok(!loading.includes('sent.offerAmount ?? sent.amount'));
  // Yükleme onayı kopyası: eski teklifte satış fiyatı boş, maliyet satış sayılmaz
  const line = { id: 'l1', kind: 'CAM', unit: 'm2', enMm: 1000, boyMm: 1000, adet: 2, unitPrice: '30', offerPrice: null };
  const o = { id: 'o1', customerId: 'c1' };
  const snap = snapshotLine(o, { currency: 'EUR', offerAmount: null }, line);
  assert.deepEqual([snap.unitCost, snap.unitSale], [30, null]);
  // Kârlılık: eski teklifte maliyet satış tutarı olarak yazılmaz
  const row = orderLine({ id: 'o1', orderNo: 'ABC1', actualShipDate: new Date('2026-10-01T10:00:00Z'), estimatedShipDate: null, offers: [{ status: 'GONDERILDI', currency: 'EUR', offerAmount: null, lines: [line] }] });
  assert.equal(row.cost, 60);
  assert.notEqual(row.sale, 60);
});

test('tahmini yükleme tarihi (karar 230): Yönetici, Yönetici Yardımcısı, Satış; Yüklendi / Arşiv / İptal kilitli; müşteri, çizim, denetimci yok', async () => {
  const { availableActions } = await import('../server/orders/rules.js');
  const acts = (role, status = 'URETIMDE') => availableActions({ role, status, onHold: false, canApprove: true, drawing: 'YOK', offer: 'GONDERILDI', orderType: 'GLASS_ORDER' });
  for (const role of ['ADMIN', 'YONETICI_YARDIMCISI', 'SATIS']) {
    assert.ok(acts(role).includes('set_ship_date'), role);
    for (const status of ['YUKLENDI', 'ARSIVLENDI', 'IPTAL']) assert.ok(!acts(role, status).includes('set_ship_date'), `${role} ${status}`);
  }
  for (const role of ['MUSTERI', 'CIZIM', 'DENETIMCI']) assert.ok(!acts(role).includes('set_ship_date'), role);
  // Sunucu işlemi onaylı yükleme kilidini ve aynı günü kendisi denetler; eski ayrı form kaldırıldı
  const tr = read('server/orders/transitions.js');
  const fn = tr.slice(tr.indexOf('async set_ship_date(h)'), tr.indexOf('async mark_shipped(h)'));
  assert.ok(fn.includes("if (await shipDateLocked(h.tx, h.order.id)) throw new WorkflowError('SHIP_DATE_LOCKED');"));
  assert.ok(fn.includes("h.audit = { fromDate: before ? dayKey(before) : null, toDate: dayKey(d) };"));
  const page = read('app/(panel)/siparisler/[id]/page.tsx');
  assert.ok(!page.includes("t('order.shipDate.submit')"), 'işlemler kartındaki eski form yok');
  assert.ok(page.includes('<ShipDateEdit'));
  const action = read('app/(panel)/siparisler/[id]/actions.ts');
  assert.ok(action.includes("await act(user, id, 'set_ship_date', { date: d, expectedVersion: expectedVersion(formData) });"));
});

test('m² gösterimi (karar 232): ekran, PDF ve Excel üç ondalık; hesap değişmez', () => {
  const fmt = read('lib/format.ts');
  assert.ok(fmt.includes('export function fmtM2(') && fmt.includes('return fmtNum(n, 3);'));
  assert.ok(read('server/files/xlsx-report.js').includes(`case 'm2': return { code: '#,##0.000" m²"' };`));
  assert.ok(read('server/pdf/firm-loading.js').includes('minimumFractionDigits: 3, maximumFractionDigits: 3'));
  assert.ok(read('server/pdf/offer.js').includes("cell('m2', r.m2 == null ? '—' : area(r.m2));"));
  assert.ok(read('app/(panel)/siparisler/[id]/OfferEditor.tsx').includes('fmtArea(totals.metraj)'));
  // m² hücreleri fmtNum(…metraj) ile 2 ondalık yazılmaz
  for (const f of ['app/(panel)/yuklemeler/page.tsx', 'app/(panel)/yuklemeler/ozet/page.tsx', 'app/(panel)/yuklemeler/LoadingConfirm.tsx', 'app/(panel)/yuklemeler/LoadingBilling.tsx', 'app/(panel)/siparisler/[id]/page.tsx']) {
    assert.ok(!/fmtNum\([^,()]*(metraj|\.m2)\)/.test(read(f)), f);
  }
});

test('telafi etiketi (karar 231): yeni telafi siparişinin gerçek numarası; var olan siparişte kaynak numarasıyla; numara uydurulmaz', async () => {
  const { compensationTag, compensationTagText, physicalVsBillable } = await import('../server/orders/compensation-tag.js');
  const texts = { newText: 'Telafi {no}', existingText: '{source} telafisi' };
  assert.deepEqual(compensationTag({ destType: 'NEW', destOrder: { orderNo: 'ALE46-T2' }, sourceOrder: { orderNo: 'ALE46' } }), { kind: 'NEW', no: 'ALE46-T2' });
  assert.equal(compensationTagText(compensationTag({ destType: 'NEW', destOrder: { orderNo: 'ALE46-T2' }, sourceOrder: { orderNo: 'ALE46' } }), texts), 'Telafi ALE46-T2');
  assert.equal(compensationTagText(compensationTag({ destType: 'EXISTING', destOrder: { orderNo: 'ALE50' }, sourceOrder: { orderNo: 'ALE46' } }), texts), 'ALE46 telafisi');
  assert.equal(compensationTag(null), null);
  assert.equal(compensationTagText(null, texts), '');
  // Bedelsiz telafi: fizikselde sayılır, faturalanacakta sayılmaz; CNC / delik / adetli satır cam sayılmaz
  const g = (adet, extra = {}) => ({ kind: 'CAM', unit: 'm2', enMm: 1000, boyMm: 1000, adet, unitPrice: '30', offerPrice: '50', ...extra });
  const r = physicalVsBillable([g(5), g(2, { free: true, compensationId: 'c1' }), { kind: 'CNC', unit: 'adet', adet: 3 }, { kind: 'CAM', unit: 'adet', adet: 1, description: 'Sandık' }]);
  assert.deepEqual(r, { physical: { pieces: 7, m2: 7 }, billable: { pieces: 5, m2: 5 }, free: { pieces: 2, m2: 2 } });
  // Dışa aktarma: etiket cam satırında (işlem satırında değil); Excel'de açıklamanın üstünde
  const { offerExportData } = await import('../server/orders/offer-export.js');
  const data = offerExportData({ lines: [g(1, { id: 'a', description: 'Temper', compensationId: 'c1', free: true }), { kind: 'CNC', unit: 'adet', adet: 1, description: 'CNC', compensationId: 'c1' }], price: (l) => l.offerPrice, locale: 'tr', kindLabel: (k) => k, tagOf: () => 'Telafi ALE46-T2' });
  assert.deepEqual(data.rows.map((x) => [x.tag, x.amount]), [['Telafi ALE46-T2', 0], [null, 0]]);
  const page = read('app/(panel)/siparisler/[id]/page.tsx');
  assert.ok(page.includes('data-comp-tag'));
  assert.ok(read('server/orders/offer-export.js').includes('r.tag ? `${r.tag}\\n${r.desc}` : r.desc'));
});

test('yükleme özeti (karar 233): onaylı gün yalnızca etkin YÜKLENDİ kalemleri; fiyat role göre tek alanda; satışa yönetici sandık bedeli ve müşteri fiyatı gitmez; ad maskeli', () => {
  const lib = read('lib/loading.ts');
  const fn = lib.slice(lib.indexOf('export async function confirmedSummaryOrders'));
  assert.ok(fn.includes('for (const it of effectiveItems(items))') && fn.includes("if (it.status !== 'LOADED') continue;"));
  assert.ok(fn.includes("where: { confirmationId: conf.id, order: orderScope(user) }"), 'kapsam');
  assert.ok(fn.includes("const customerPrice = userCan(user, 'OFFER_SEND') || userCan(user, 'PRICE_FINAL_VIEW');"));
  assert.ok(fn.includes('const price = customerPrice ? (it.unitSale == null ? null : Number(it.unitSale)) : Number(it.unitCost);'));
  assert.ok(fn.includes('unitPrice: price, offerPrice: price,'), 'diğer fiyat hiç taşınmaz');
  assert.ok(fn.includes('if (!customerPrice && it.offerLine?.crateFee) continue;'));
  assert.ok(fn.includes('name: customerLabel(user, it.customer.name)'));
  const route = read('app/(panel)/yuklemeler/dokum/route.ts');
  assert.ok(route.includes('const confirmed = await confirmedSummaryOrders(user, day);'));
  assert.ok(route.includes("confirmed ? t('loading.summary.stateConfirmed') : t('loading.summary.statePlanned')"), 'planlanan açıkça etiketli');
  assert.ok(route.includes("priceOf: (l) => (confirmed || !userCan(user, 'OFFER_SEND') ? l.unitPrice : l.offerPrice)"));
});
