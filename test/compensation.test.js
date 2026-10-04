// Kırık / telafi camı (Aşama 9, karar 108) — veritabanı gerektirmeyen kurallar: telafi edilebilir satırlar, işlem
// sahipliği (karar 113), fiyat kararı (karar 112), telafi satırları, hedef denetimi, numara ve sunucu tarafı yetki.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import tr from '../server/i18n/tr/index.js';
import {
  COMP_MODES, ambiguousOps, compOrderNo, compensableLines, compensationLines, createCompensation, decideCompensation, destinationCheck, priceDecision,
} from '../server/orders/compensation.js';
import { removeOrder, restoreOrder } from '../server/orders/removal.js';
import { EVENTS } from '../server/orders/rules.js';

const glass = (extra = {}) => ({ id: 'g1', kind: 'CAM', unit: 'm2', description: 'Temper Lamine 44.2', descriptionRo: 'Sticlă laminată 44.2', enMm: 1000, boyMm: 2000, adet: 10, unitPrice: '30', offerPrice: '66.96', listPrice: '30', weightKgM2: '20.8', glassProductId: 'p1', free: false, sortOrder: 0, ...extra });
const cnc = (extra = {}) => ({ id: 'c1', kind: 'CNC', unit: 'adet', description: 'CNC', adet: 10, unitPrice: '5', offerPrice: '8', free: false, sortOrder: 1, ...extra });
const hole = (extra = {}) => ({ id: 'h1', kind: 'DELIK', unit: 'adet', description: 'Delik', adet: 20, unitPrice: '2', offerPrice: '3', free: false, sortOrder: 2, ...extra });
const crateFee = () => ({ id: 'k1', kind: 'CAM', unit: 'adet', description: 'Sandık parası', adet: 1, unitPrice: '25', offerPrice: '30', free: false, sortOrder: 9 });

test('telafi siparişi numarası: kök sipariş + -T, sonra -T2, -T3', () => {
  assert.deepEqual([1, 2, 3, 11].map((n) => compOrderNo('ABC124', n)), ['ABC124-T', 'ABC124-T2', 'ABC124-T3', 'ABC124-T11']);
});

test('telafi edilebilir satır: yalnızca ölçülü cam (m²); CNC / delik ona aittir; sandık parası ve tek başına işlem satırı değildir', () => {
  const lines = [cnc({ id: 'c0' }), glass(), cnc(), hole(), crateFee(), hole({ id: 'h9' }), glass({ id: 'g2', enMm: 500, boyMm: 500, adet: 4 }), glass({ id: 'g3', enMm: null })];
  const groups = compensableLines(lines);
  assert.deepEqual(groups.map((g) => [g.line.id, g.subs.map((s) => s.id)]), [['g1', ['c1', 'h1']], ['g2', []]]);
  // Cam olmayan satırın altındaki işlem satırı (h9: sandık parasının altında) hiçbir cama eklenmez
  assert.ok(!groups.some((g) => g.subs.some((s) => s.id === 'h9' || s.id === 'c0')));
});

test('işlemler tek bir cama aittir: adedi 1\'den büyük satıra bağlı işlem belirsizdir; oran / yuvarlama işlevi yoktur', async () => {
  assert.equal(ambiguousOps({ line: glass({ adet: 1 }), subs: [cnc({ adet: 1 }), hole({ adet: 2 })] }), false, 'işlemli tek cam');
  assert.equal(ambiguousOps({ line: glass({ adet: 4 }), subs: [] }), false, 'işlemsiz camlar adetle');
  assert.equal(ambiguousOps({ line: glass({ adet: 5 }), subs: [hole({ adet: 3 })] }), true, '5 cam + 3 delik: hangi camda?');
  const mod = await import('../server/orders/compensation.js');
  assert.equal(mod.scaleOps, undefined, 'orantılı işlem adedi kaldırıldı');
  const src = (await import('node:fs')).readFileSync(new URL('../server/orders/compensation.js', import.meta.url), 'utf8');
  assert.ok(!/Math\.ceil|scaleOps/.test(src), 'telafide yukarı yuvarlama / oran yok');
});

test('fiyat kararı — yönetici (müşteri fiyatı): normal / bedelsiz / değiştirilmiş; fabrika maliyeti hiç değişmez', () => {
  const line = glass();
  assert.deepEqual(priceDecision({ admin: true, mode: 'NORMAL', line }), { ok: true, tier: 'CUSTOMER', normalCost: 30, normalPrice: 66.96, mode: 'NORMAL', free: false, unitCost: 30, offerPrice: 66.96, changed: false });
  const free = priceDecision({ admin: true, mode: 'FREE', line });
  assert.deepEqual([free.free, free.offerPrice, free.unitCost, free.changed], [true, 0, 30, true], 'bedelsiz: müşteri fiyatı 0, maliyet durur');
  const custom = priceDecision({ admin: true, mode: 'CUSTOM', price: '50,00', line });
  assert.deepEqual([custom.mode, custom.offerPrice, custom.unitCost, custom.changed, custom.tier], ['CUSTOM', 50, 30, true, 'CUSTOMER']);
  // Normal fiyatla aynı "başka fiyat" değişiklik sayılmaz
  assert.equal(priceDecision({ admin: true, mode: 'CUSTOM', price: '66.96', line }).mode, 'NORMAL');
});

test('fiyat kararı — satış (karar 112): yalnızca "aynı fiyat" ya da "bedelsiz"; yeni müşteri fiyatı belirleyemez', () => {
  const line = glass();
  // Aynı fiyat: yöneticinin kaynak teklifteki müşteri fiyatı AYNEN (sunucuda kopyalanır); fiyat değişmedi → uyarı yok
  const same = priceDecision({ admin: false, mode: 'NORMAL', line });
  assert.deepEqual(same, { ok: true, tier: 'CUSTOMER', normalCost: 30, normalPrice: 66.96, mode: 'NORMAL', free: false, unitCost: 30, offerPrice: 66.96, changed: false });
  assert.deepEqual(same, priceDecision({ admin: true, mode: 'NORMAL', line }), 'satış ve yönetici için aynı sonuç');
  // Bedelsiz: müşteri fiyatı 0, fabrika maliyeti durur; önemli karar
  const free = priceDecision({ admin: false, mode: 'FREE', line });
  assert.deepEqual([free.free, free.unitCost, free.offerPrice, free.normalPrice, free.changed, free.tier], [true, 30, 0, 66.96, true, 'CUSTOMER']);
  // Başka fiyat: satışa kapalı — tutar ne olursa olsun (önceki fiyatın aynısı ya da maliyet dahil)
  for (const price of ['25', '30', '66.96', '100', '', null]) assert.deepEqual(priceDecision({ admin: false, mode: 'CUSTOM', price, line }), { ok: false, code: 'PRICE_FORBIDDEN' }, String(price));
});

test('fiyat kararı: geçersiz seçenek / fiyat reddedilir; kaynağı bedelsiz satırın normali bedelsizdir', () => {
  const line = glass();
  assert.deepEqual(priceDecision({ admin: true, mode: 'HEDIYE', line }), { ok: false, code: 'BAD_MODE' });
  for (const price of ['', null, '0', '-5', 'abc', '2000000']) assert.deepEqual(priceDecision({ admin: true, mode: 'CUSTOM', price, line }), { ok: false, code: 'BAD_PRICE' }, String(price));
  const src = priceDecision({ admin: true, mode: 'NORMAL', line: glass({ free: true }) });
  assert.deepEqual([src.free, src.normalPrice, src.changed], [true, 0, false]);
  assert.deepEqual(COMP_MODES, ['NORMAL', 'FREE', 'CUSTOM']);
});

test('telafi satırları: cam ve üretim bilgisi kaynaktan; bedelsizde işlem satırları da bedelsiz, maliyetler durur', () => {
  // İşlemli kaynak TEK bir camdır: işlemleri aynen (tür, açıklama, adet) kopyalanır — oran / yuvarlama yok
  const line = glass({ adet: 1 });
  const free = compensationLines({ line, subs: [cnc({ adet: 1, description: 'Kulp yuvası' }), hole({ adet: 2 })], quantity: 1, decision: priceDecision({ admin: false, mode: 'FREE', line }) });
  assert.deepEqual(free.map((l) => [l.kind, l.description, l.adet, l.unitPrice, l.offerPrice, l.free]), [['CAM', 'Temper Lamine 44.2', 1, 30, 0, true], ['CNC', 'Kulp yuvası', 1, 5, 0, true], ['DELIK', 'Delik', 2, 2, 0, true]]);
  // Aynı fiyat (satış): müşteri fiyatı kaynağınkiyle aynı; işlem satırları kendi kayıtlı fiyatlarıyla
  const same = compensationLines({ line, subs: [hole({ adet: 2 })], quantity: 1, decision: priceDecision({ admin: false, mode: 'NORMAL', line }) });
  assert.deepEqual(same.map((l) => [l.kind, l.adet, l.unitPrice, l.offerPrice, l.free]), [['CAM', 1, 30, 66.96, false], ['DELIK', 2, 2, 3, false]]);
  // İşlemsiz (standart) kardeş cam: aynı ölçü, adetle — telafisi işlem TAŞIMAZ
  const std = compensationLines({ line: glass({ id: 'g0', adet: 4 }), subs: [], quantity: 3, decision: priceDecision({ admin: false, mode: 'NORMAL', line: glass({ adet: 4 }) }) });
  assert.deepEqual(std.map((l) => [l.kind, l.adet, l.offerPrice]), [['CAM', 3, 66.96]]);
  assert.deepEqual([free[0].description, free[0].descriptionRo, free[0].enMm, free[0].boyMm, free[0].unit, free[0].glassProductId, free[0].weightKgM2, free[0].listPrice], ['Temper Lamine 44.2', 'Sticlă laminată 44.2', 1000, 2000, 'm2', 'p1', 20.8, 30]);
  // Değiştirilmiş fiyat yalnızca cam satırını etkiler; işlem satırları kendi kayıtlı fiyatlarıyla
  const custom = compensationLines({ line, subs: [cnc({ adet: 1 })], quantity: 1, decision: priceDecision({ admin: true, mode: 'CUSTOM', price: 50, line }) });
  assert.deepEqual(custom.map((l) => [l.kind, l.adet, l.unitPrice, l.offerPrice, l.free]), [['CAM', 1, 30, 50, false], ['CNC', 1, 5, 8, false]]);
});

test('hedef denetimi: aynı müşterinin ileri tarihli, açık, teklifli cam siparişi; taslak / müşterideki teklif ayrımı', () => {
  const base = { sourceOrderId: 's', customerId: 'c', currency: 'EUR', today: '2026-10-10', day: '2026-10-30', locked: false, coverage: null };
  const order = (extra = {}) => ({ id: 'd', customerId: 'c', orderTypeCode: 'GLASS_ORDER', status: 'URETIMDE', onHold: false, removedAt: null, offers: [{ status: 'GONDERILDI', currency: 'EUR', offerAmount: '100' }], ...extra });
  assert.deepEqual(destinationCheck(order(), base), { ok: true, via: 'SENT' });
  assert.deepEqual(destinationCheck(order({ status: 'HAZIRLANIYOR', offers: [{ status: 'YONETIMDE', currency: 'EUR' }] }), base), { ok: true, via: 'DRAFT' });
  const reason = (o, ctx = {}) => destinationCheck(o, { ...base, ...ctx }).reason;
  assert.equal(reason(order({ id: 's' })), 'SAME_ORDER');
  assert.equal(reason(order({ customerId: 'x' })), 'OTHER_CUSTOMER', 'başka müşterinin siparişi asla hedef olamaz');
  assert.equal(reason(order({ orderTypeCode: 'PROFILE_ORDER' })), 'NOT_GLASS');
  for (const status of ['YUKLENDI', 'ARSIVLENDI', 'IPTAL']) assert.equal(reason(order({ status })), 'CLOSED', status);
  assert.equal(reason(order({ removedAt: new Date() })), 'CLOSED', 'silinmiş sipariş');
  assert.equal(reason(order({ onHold: true })), 'ON_HOLD');
  assert.equal(reason(order(), { day: '2026-10-10' }), 'NOT_FUTURE', 'bugün ileri tarih değildir');
  assert.equal(reason(order(), { day: null }), 'NOT_FUTURE');
  assert.equal(reason(order(), { locked: true }), 'LOADED');
  assert.equal(reason(order({ status: 'YENI', offers: [] })), 'NO_OFFER');
  assert.equal(reason(order({ offers: [{ status: 'GONDERILDI', currency: 'RON', offerAmount: '1' }] })), 'CURRENCY');
  assert.equal(reason(order(), { coverage: { reason: 'ORDER_DOCUMENT', ref: 'PRF1' } }), 'BILLING');
});

test('yetki sunucuda: müşteri, çizim ve denetimci telafi açamaz; satış onaylayamaz; silme / geri yükleme yalnızca yöneticide', async () => {
  // Yetkisiz istek veritabanına hiç ulaşmaz (db verilmeden çağrılır)
  for (const role of ['MUSTERI', 'CIZIM', 'DENETIMCI', null, 'YOK']) {
    assert.deepEqual(await createCompensation(null, { orderId: 'x', lineId: 'y', quantity: 1, mode: 'FREE', dest: { type: 'NEW', day: '2099-01-01' }, requestKey: 'k'.repeat(20), confirm: true, actor: { id: 'u', role } }), { ok: false, code: 'FORBIDDEN' }, String(role));
  }
  for (const role of ['SATIS', 'MUSTERI', 'CIZIM', 'DENETIMCI', null]) {
    assert.deepEqual(await decideCompensation(null, { id: 'x', approve: true, actor: { id: 'u', role } }), { ok: false, code: 'FORBIDDEN' }, String(role));
    assert.deepEqual(await removeOrder(null, { orderId: 'x', confirm: true, actor: { id: 'u', role } }), { ok: false, code: 'FORBIDDEN' }, String(role));
    assert.deepEqual(await restoreOrder(null, { orderId: 'x', actor: { id: 'u', role } }), { ok: false, code: 'FORBIDDEN' }, String(role));
  }
  // Onaysız istek (ikinci adım atlanmış) yetkili kullanıcıda da reddedilir
  assert.deepEqual(await createCompensation(null, { orderId: 'x', lineId: 'y', quantity: 1, mode: 'FREE', dest: { type: 'NEW', day: '2099-01-01' }, requestKey: 'k'.repeat(20), confirm: false, actor: { id: 'u', role: 'SATIS' } }), { ok: false, code: 'CONFIRM_REQUIRED' });
  assert.deepEqual(await removeOrder(null, { orderId: 'x', confirm: false, actor: { id: 'u', role: 'ADMIN' } }), { ok: false, code: 'CONFIRM_REQUIRED' });
});

test('metinler: her hata kodunun ve yeni olayların metni var', () => {
  const m = tr.compensation;
  const reasons = ['SAME_ORDER', 'OTHER_CUSTOMER', 'NOT_GLASS', 'CLOSED', 'ON_HOLD', 'NOT_FUTURE', 'LOADED', 'NO_OFFER', 'CURRENCY', 'BILLING'];
  const codes = [
    'FORBIDDEN', 'CONFIRM_REQUIRED', 'BAD_REQUEST', 'BAD_QUANTITY', 'BAD_DEST', 'BAD_DAY', 'NOT_FUTURE', 'DAY_CONFIRMED', 'NOT_FOUND', 'ORDER_CANCELLED', 'NO_SENT_OFFER',
    'BAD_LINE', 'BAD_MODE', 'BAD_PRICE', 'BAD_LINK', 'NOT_LOADED_CAPACITY', 'PRICE_REQUIRED', 'CONFLICT', 'NOT_PENDING', 'DEST_NOT_FOUND', ...reasons.map((r) => `DEST_${r}`),
  ];
  for (const c of codes) assert.equal(typeof m.errors[c], 'string', c);
  for (const r of reasons) assert.equal(typeof m.form.destReason[r], 'string', r);
  for (const c of ['FORBIDDEN', 'CONFIRM_REQUIRED', 'NOT_FOUND', 'ALREADY_REMOVED', 'NOT_REMOVED', 'BUSY']) assert.equal(typeof m.remove.errors[c], 'string', c);
  for (const e of ['COMPENSATION', 'COMPENSATION_ADDED', 'COMPENSATION_PENDING', 'COMPENSATION_REJECTED', 'REMOVED', 'RESTORED']) {
    assert.deepEqual(EVENTS[e], { customer: false }, `${e}: yalnızca iç ekip görür`);
    assert.equal(typeof tr.events[e].label, 'string', e);
  }
  assert.equal(m.form.confirm.replace('{qty}', '3'), 'Yukarıdaki kararı onaylıyorum: 3 cam telafi olarak eklensin.');
  assert.equal(m.form.submit, 'Telafi camını ekle');
  assert.equal(m.remove.confirm, 'Bu siparişin sistemden kaldırılacağını onaylıyorum.');
});
