// Yüklenmeyen camın ileri güne aktarılması (karar 102) ve başka müşterinin sandığına fiziksel yerleşim (karar 103) —
// saf kurallar: satırın yüklenen / yüklenmeyen olarak bölünmesi, aktarılan kalanın plana girişi, kârlılıkta tek sayım,
// yükleme dökümü ve nakliye listesinde fiziksel sandık.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyNotLoaded, itemKey, planItems, planKey, snapshotLine, snapshotOfItem, NOT_LOADED_REASONS } from '../server/loading/confirmation.js';
import { mergeConfirmed } from '../server/accounting/supplier.js';
import { groupLoad } from '../server/loading/crates.js';
import { buildLoadingSummary, loadingSummaryXlsx } from '../server/loading/summary.js';
import { buildTransportList } from '../server/loading/transport.js';
import { transportListPdf } from '../server/pdf/transport-list.js';
import { readXlsx } from '../server/files/xlsx.js';

const glass = (extra = {}) => ({ id: 'L1', sortOrder: 0, kind: 'CAM', unit: 'm2', description: 'Temper', descriptionRo: 'Securizat', enMm: 1000, boyMm: 1000, adet: 10, unitPrice: '30', offerPrice: '50', ...extra });
const cnc = { id: 'L2', sortOrder: 1, kind: 'CNC', unit: 'adet', description: 'CNC', adet: 2, unitPrice: '5', offerPrice: '10' };
const order = (id, lines, extra = {}) => ({ id, orderNo: id.toUpperCase(), title: null, customerId: 'cA', customer: { id: 'cA', name: 'A SRL' }, offers: [{ id: `of-${id}`, status: 'GONDERILDI', currency: 'EUR', offerAmount: '0', lines }], ...extra });

test('yüklenmeyen adet: cam satırı yüklenen + yüklenmeyen olarak bölünür; tutarlar adede göre, birim fiyatlar aynı', () => {
  const plan = planItems([order('o1', [glass(), cnc])]);
  assert.deepEqual(plan.items.map((i) => [itemKey(i), i.quantity, i.status]), [['l:L1', 10, 'LOADED'], ['l:L2', 2, 'LOADED']]);
  const r = applyNotLoaded(plan.orders, [{ key: 'l:L1', quantity: '2', reason: 'BROKEN' }, { key: 'l:L2', quantity: '', reason: '' }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.items.map((i) => [i.offerLineId, i.status, i.quantity, i.m2, i.unitCost, i.unitSale, i.costAmount, i.saleAmount, i.notLoadedReason]), [
    ['L1', 'LOADED', 8, 8, 30, 50, 240, 400, null],
    ['L1', 'NOT_LOADED', 2, 2, 30, 50, 60, 100, 'BROKEN'],
    ['L2', 'LOADED', 2, 0, 5, 10, 10, 20, null],
  ]);
  assert.deepEqual(r.notLoaded, [{ orderId: 'o1', quantity: 2, reason: 'BROKEN' }]);
  // Hiç yüklenmeyen satır: yalnızca NOT_LOADED kaydı
  const all = applyNotLoaded(plan.orders, [{ key: 'l:L1', quantity: 10, reason: 'OTHER', note: '  kamyona sığmadı ' }]);
  assert.deepEqual(all.items.filter((i) => i.offerLineId === 'L1').map((i) => [i.status, i.quantity, i.notLoadedReason, i.notLoadedNote]), [['NOT_LOADED', 10, 'OTHER', 'kamyona sığmadı']]);
  // Giriş yoksa plan aynen (eksiksiz yüklendi)
  assert.deepEqual(applyNotLoaded(plan.orders, []).items, plan.items);
});

test('yüklenmeyen adet sunucuda doğrulanır: fazla adet, neden, açıklama, cam olmayan satır, bilinmeyen / çift kalem', () => {
  const { orders } = planItems([order('o1', [glass(), cnc])]);
  const bad = (input) => applyNotLoaded(orders, input);
  assert.deepEqual(bad([{ key: 'l:L1', quantity: 11, reason: 'BROKEN' }]), { ok: false, code: 'BAD_QUANTITY' }, 'planlanandan fazlası yüklenmemiş olamaz');
  assert.deepEqual(bad([{ key: 'l:L1', quantity: -1, reason: 'BROKEN' }]), { ok: false, code: 'BAD_QUANTITY' });
  assert.deepEqual(bad([{ key: 'l:L1', quantity: '1.5', reason: 'BROKEN' }]), { ok: false, code: 'BAD_QUANTITY' });
  assert.deepEqual(bad([{ key: 'l:L1', quantity: 2, reason: '' }]), { ok: false, code: 'BAD_REASON' });
  assert.deepEqual(bad([{ key: 'l:L1', quantity: 2, reason: 'STOLEN' }]), { ok: false, code: 'BAD_REASON' });
  assert.deepEqual(bad([{ key: 'l:L1', quantity: 2, reason: 'OTHER', note: '   ' }]), { ok: false, code: 'NOTE_REQUIRED' });
  assert.deepEqual(bad([{ key: 'l:L2', quantity: 1, reason: 'BROKEN' }]), { ok: false, code: 'BAD_EXCEPTION' }, 'yalnızca cam satırı bölünür');
  assert.deepEqual(bad([{ key: 'l:YOK', quantity: 1, reason: 'BROKEN' }]), { ok: false, code: 'BAD_EXCEPTION' });
  assert.deepEqual(bad([{ key: 'l:L1', quantity: 1, reason: 'BROKEN' }, { key: 'l:L1', quantity: 1, reason: 'MISSING' }]), { ok: false, code: 'BAD_EXCEPTION' });
  assert.deepEqual(NOT_LOADED_REASONS, ['BROKEN', 'MISSING', 'NOT_READY', 'OTHER']);
});

test('aktarılan kalan plana yalnızca kendi adediyle ve kaynağın ticari kopyasıyla girer; sipariş tarihinden yeniden plana girmez', () => {
  // 16.10 onayı: 8 yüklendi, 2 yüklenmedi (kaynak kalem — onay anındaki fiyatlarla)
  const first = planItems([order('o1', [glass(), cnc])]);
  const split = applyNotLoaded(first.orders, [{ key: 'l:L1', quantity: 2, reason: 'BROKEN' }]);
  const source = { ...split.items.find((i) => i.status === 'NOT_LOADED'), id: 'item-1' };
  const replan = { id: 'rp1', quantity: 2, fromDay: new Date('2026-10-16T00:00:00Z'), sourceItem: source, order: { id: 'o1', orderNo: 'O1', title: 'Proje', customerId: 'cA', status: 'URETIMDE', onHold: false, customer: { id: 'cA', name: 'A SRL' } } };
  // Sipariş bu arada o güne alınmış ve teklifi değişmiş olsa da: tarihinden plana girmez (başka onayda kalemi var), kalan kaynaktan gelir
  const changed = order('o1', [glass({ adet: 10, offerPrice: '99', unitPrice: '77' }), cnc]);
  const plan = planItems([changed], new Map([['o1', '2026-10-16']]), [replan]);
  assert.deepEqual(plan.orders.map((o) => [o.orderNo, o.replanFrom, o.items.length]), [['O1', ['2026-10-16'], 1]]);
  assert.deepEqual(plan.items.map((i) => [itemKey(i), i.offerLineId, i.quantity, i.m2, i.unitCost, i.unitSale, i.saleAmount, i.status]), [['r:rp1', 'L1', 2, 2, 30, 50, 100, 'LOADED']], 'tam 2 adet; 10 adet yeniden gelmez; fiyat kaynağın kopyası');
  assert.deepEqual(plan.skipped, [], 'kalanıyla plandaki sipariş ayrıca "başka yüklemede onaylandı" diye listelenmez');
  // Aktarım yoksa: sipariş yalnızca "başka yüklemede onaylandı" olarak listelenir, hiçbir kalemi plana girmez
  const none = planItems([changed], new Map([['o1', '2026-10-16']]));
  assert.deepEqual([none.items.length, none.skipped.map((s) => [s.reason, s.day])], [0, [['ALREADY_CONFIRMED', '2026-10-16']]]);
  // Parmak izi aktarımı da kapsar (aktarım değişirse önizleme eskir)
  assert.notEqual(planKey('2026-10-23', plan.items), planKey('2026-10-23', plan.items.map((i) => ({ ...i, replanId: 'rp2' }))));

  // İkinci deneme: 2'nin 1'i yüklendi, 1'i yine yüklenmedi — zincir replanId ile sürer
  const again = applyNotLoaded(plan.orders, [{ key: 'r:rp1', quantity: 1, reason: 'MISSING' }]);
  assert.deepEqual(again.items.map((i) => [i.replanId, i.status, i.quantity, i.saleAmount, i.notLoadedReason]), [['rp1', 'LOADED', 1, 50, null], ['rp1', 'NOT_LOADED', 1, 50, 'MISSING']]);
  assert.deepEqual(applyNotLoaded(plan.orders, [{ key: 'r:rp1', quantity: 3, reason: 'MISSING' }]), { ok: false, code: 'BAD_QUANTITY' }, 'kalandan fazlası yüklenemez / yüklenmemiş sayılamaz');

  // İptal / beklemedeki siparişin aktarılan kalanı onaya girmez
  for (const [patch, reason] of [[{ status: 'IPTAL' }, 'ORDER_CANCELLED'], [{ onHold: true }, 'ORDER_ON_HOLD']]) {
    const p = planItems([], new Map(), [{ ...replan, order: { ...replan.order, ...patch } }]);
    assert.deepEqual([p.items.length, p.skipped.map((s) => s.reason)], [0, [reason]]);
  }
});

test('kalemin yeniden kopyası (snapshotOfItem) teklif satırından kopyayla aynı hesabı verir', () => {
  const o = order('o1', [glass({ enMm: 1250, boyMm: 800, adet: 3 })]);
  const fromLine = snapshotLine(o, o.offers[0], o.offers[0].lines[0], { quantity: 2 });
  const fromItem = snapshotOfItem(snapshotLine(o, o.offers[0], o.offers[0].lines[0]), { quantity: 2 });
  assert.deepEqual(fromItem, fromLine);
});

test('kârlılık: yüklenmeyen kısım sayılmaz ve "onay dışı" da görünmez; kalan, fiilen yüklendiği günde bir kez sayılır', () => {
  const item = (status, quantity, extra = {}) => ({ orderId: 'o1', offerLineId: 'L1', sortOrder: 0, kind: 'CAM', unit: 'm2', description: 'Temper', enMm: 1000, boyMm: 1000, free: false, quantity, m2: quantity, currency: 'EUR', unitCost: 30, unitSale: 50, status, ...extra });
  const planned = [{ orderId: 'o1', orderNo: 'O1', day: '2026-10-16', currency: 'EUR', m2: 10, sale: 500, cost: 300, noCost: 0, noCostLines: [], confirmed: false }];
  const first = { day: '2026-10-16', orders: [{ orderId: 'o1', orderNo: 'O1', items: [item('LOADED', 8), item('NOT_LOADED', 2)] }] };
  const m1 = mergeConfirmed(planned, [first]);
  assert.deepEqual(m1.lines.map((l) => [l.day, l.m2, l.sale, l.cost]), [['2026-10-16', 8, 400, 240]]);
  // Kalan 23.10'da yüklendi: o günün satırı; toplam 10 adet — iki kez sayılan yok
  const second = { day: '2026-10-23', orders: [{ orderId: 'o1', orderNo: 'O1', items: [item('LOADED', 2, { replanId: 'rp1' })] }] };
  const m2 = mergeConfirmed(planned, [first, second]);
  assert.deepEqual(m2.lines.map((l) => [l.day, l.m2, l.sale, l.cost]), [['2026-10-16', 8, 400, 240], ['2026-10-23', 2, 100, 60]]);
  assert.equal(m2.lines.reduce((s, l) => s + l.sale, 0), 500);
  // Hiç yüklenmeyen sipariş (tamamı NOT_LOADED): gelir / maliyet yok; planlanan satırı da sayılmaz, "onay dışı" listesine de girmez
  const m3 = mergeConfirmed(planned, [{ day: '2026-10-16', orders: [{ orderId: 'o1', orderNo: 'O1', items: [item('NOT_LOADED', 10)] }] }]);
  assert.deepEqual([m3.lines, [...m3.outside.keys()]], [[], []]);
});

test('fiziksel sandık: başka müşterinin sandığındaki camın ağırlığı o sandığın müşterisine yazılır; metraj ve adet sahibinde kalır', () => {
  const load = (netKg) => ({ metraj: 2, camAdet: 2, cnc: 0, delik: 0, netKg });
  // A'nın camı (60 kg) B'nin sandığında: A'da tahmini sandık oluşmaz, B'nin net boş sandığına eklenir
  const a = groupLoad([{ ...load(60), netKg: 0 }], []);
  assert.deepEqual([a.orders, a.metraj, a.camAdet, a.netKg, a.crates], [1, 2, 2, 0, 0]);
  const b = groupLoad([load(100)], [{ netAgirlik: null, brutAgirlik: null, daraKg: 50 }], { guestKg: 60 });
  assert.deepEqual([b.orders, b.metraj, b.netKg, b.grossKg, b.crates], [1, 2, 160, 210, 1]);
  // Girilmiş (gerçek) ağırlık her zaman esas
  assert.equal(groupLoad([load(100)], [{ netAgirlik: 150, brutAgirlik: 205 }], { guestKg: 60 }).grossKg, 205);
  // Seçenek verilmezse eski hesap aynen
  assert.deepEqual(groupLoad([load(100)], []), groupLoad([load(100)], [], {}));
});

test('yükleme dökümü: fiziksel sandık sütunu; başka müşterinin sandığı açıkça yazılır, ticari gruplama ve tutar değişmez', () => {
  const g = (adet) => ({ kind: 'CAM', unit: 'm2', description: '10 MM TEMPER', descriptionRo: 'Securizat 10', enMm: 1000, boyMm: 1000, adet, offerPrice: '24', unitPrice: '20' });
  const hole = { kind: 'DELIK', unit: 'adet', description: 'Delik', adet: 2, offerPrice: '3', unitPrice: '1' };
  const orders = [
    { id: 'a1', orderNo: 'AAA001', title: 'Proje A', customer: { id: 'A', name: 'Customer A' }, offers: [{ status: 'GONDERILDI', currency: 'EUR', lines: [g(2), hole] }] },
    { id: 'b1', orderNo: 'BBB001', title: 'Proje B', customer: { id: 'B', name: 'Customer B' }, offers: [{ status: 'GONDERILDI', currency: 'EUR', lines: [g(3)] }] },
  ];
  const crateOf = (o) => (o.id === 'a1' ? ['#15 (Customer B)'] : ['#15', '#16']);
  const plain = buildLoadingSummary(orders, { priceOf: (l) => l.offerPrice });
  const s = buildLoadingSummary(orders, { priceOf: (l) => l.offerPrice, crateOf });
  // Ticari satırlar aynı: A'nın siparişi A'nın satırında (B'nin satırına eklenmez), delik camın tutarında
  const commercial = (x) => x.rows.map((r) => [r.customer, r.orders.join(','), r.adet, r.m2, r.total, r.unit]);
  assert.deepEqual(commercial(s), commercial(plain));
  assert.deepEqual(commercial(s), [['Customer A', 'AAA001', 2, 2, 54, 27], ['Customer B', 'BBB001', 3, 3, 72, 24]]);
  assert.deepEqual(s.rows.map((r) => r.crates), [['#15 (Customer B)'], ['#15', '#16']]);
  const text = { title: 'DÖKÜM', unit: 'm²', total: 'TOPLAM', cols: ['NO', 'MÜŞTERİ', 'PROJE', 'CAM', 'ADET', 'BİRİM', 'M2', 'FİYAT', 'TUTAR', 'SANDIK'] };
  const x = readXlsx(loadingSummaryXlsx(s, { day: '2026-10-16', stats: [], text })).rows;
  assert.deepEqual(x.find((r) => r[0] === 'AAA001'), ['AAA001', 'Customer A', 'Proje A', '10 MM TEMPER', 2, 'm²', 2, 27, 54, '#15 (Customer B)']);
  assert.deepEqual(x.find((r) => r[0] === 'BBB001').slice(8), [72, '#15, #16']);
  assert.equal(x[x.length - 1][10], 'EUR');
});

test('nakliye listesi: sandık ev sahibinin grubunda kalır, içindeki başka firma camı sandığın altında MİSAFİR YÜK olarak yazar; o sipariş "sandığı girilmemiş" sayılmaz', () => {
  const crate = {
    crateNo: 15, lengthMm: 2400, widthMm: 1600, heightMm: 900, netAgirlik: 190, brutAgirlik: 260, note: 'kırılacak', customerId: 'B', customer: { prefix: 'BBB', name: 'Customer B' },
    orders: [{ order: { orderNo: 'BBB001', customerId: 'B', customer: { prefix: 'BBB', name: 'Customer B' } } }, { order: { orderNo: 'AAA001', customerId: 'A', customer: { prefix: 'AAA', name: 'Customer A' } } }],
  };
  const host = { prefix: 'BBB', name: 'Customer B' };
  const orders = [{ orderNo: 'BBB001', customerId: 'B' }, { orderNo: 'AAA001', customerId: 'A', guestHost: host }, { orderNo: 'AAA002', customerId: 'A' }, { orderNo: 'AAA003', customerId: 'A', guestHost: host }];
  const list = buildTransportList([crate], orders);
  // Misafir yük sandığın altında (firma · sipariş no); sandığın kendi notu ve ağırlığı aynen (fiziksel ağırlık sandıkta)
  assert.deepEqual(list.groups.map((x) => [x.code, x.totalKg, x.crates.map((c) => [c.crateNo, c.note, c.weight, c.guests])]),
    [['BBB', 260, [[15, 'kırılacak', 260, [{ orderNo: 'AAA001', code: 'AAA', firm: 'Customer A' }]]]]]);
  assert.deepEqual(list.missing, ['AAA002', 'AAA003']);
  // Ev sahibi firması seçilmiş, sandığı henüz seçilmemiş sipariş ayrıca "sandık seçimi bekliyor" (kendiliğinden sandığa konmaz)
  assert.deepEqual(list.waiting, [{ orderNo: 'AAA003', host: 'BBB' }]);
  // Firma adı görene göre: satışa maskeli (ilk 3 harf + 10 yıldız)
  const masked = buildTransportList([crate], orders, { label: (n) => `${n.slice(0, 3)}**********` });
  assert.deepEqual(masked.groups[0].crates[0].guests, [{ orderNo: 'AAA001', code: 'AAA', firm: 'Cus**********' }]);
  // Başka müşteri siparişi yoksa misafir yük yok
  const plain = buildTransportList([{ ...crate, orders: [crate.orders[0]] }], []);
  assert.deepEqual([plain.groups[0].crates[0].note, plain.groups[0].crates[0].guests, plain.waiting], ['kırılacak', [], []]);
  // PDF: misafir yük satırı ve bekleyen özel durum yazılır (fiyat yok)
  const text = {
    title: 'NAKLİYE LİSTESİ', day: 'Yükleme günü', colNo: 'Sandık no', colDims: 'U × G × Y (mm)', colKg: 'Ağırlık (kg)', colNote: 'Not', subtotal: '{n} sandık', crateCount: 'Sandık adedi',
    totalKg: 'TOPLAM', missing: 'Sandığı girilmemiş', noPrice: 'Fiyat yok.', empty: 'Sandık yok.', guest: 'MISAFIR YUK', waiting: 'Sandik secimi bekliyor',
  };
  const pdf = transportListPdf({ day: '2026-10-16', company: 'GKH Trading', text, list });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});
