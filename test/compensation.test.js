// Kırık / telafi camı (Aşama 9, karar 108) — veritabanı gerektirmeyen kurallar: telafi edilebilir satırlar, işlem
// sahipliği (karar 113), fiyat kararı (karar 112, 157), telafi satırları, kaynak adedinin düşmesi (karar 157), hedef
// denetimi, numara ve sunucu tarafı yetki.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import tr from '../server/i18n/tr/index.js';
import ro from '../server/i18n/ro/index.js';
import {
  COMP_MODES, COMP_NOTICE, ambiguousOps, compOrderNo, compensableLines, compensationLines, createCompensation, decideCompensation, destinationCheck, priceDecision,
  reducedSourceLines, sourceReducible,
} from '../server/orders/compensation.js';
import { removeOrder, restoreOrder } from '../server/orders/removal.js';
import { EVENTS, atOfferPrice, maskName, offerTotals } from '../server/orders/rules.js';
import { invoiceLines, proformaLines } from '../server/glass/billing.js';
import { renderInApp } from '../server/notifications/inapp.js';

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

test('fiyat kararı — yönetici (müşteri fiyatı): aynı fiyat / bedelsiz / farklı fiyat; fabrika maliyeti hiç değişmez', () => {
  const line = glass();
  // direct: müşteri fiyatı kesin — teklif yöneticinin yeniden fiyatlandırmasına uğramadan müşteriye gidebilir
  assert.deepEqual(priceDecision({ admin: true, mode: 'NORMAL', line }), { ok: true, tier: 'CUSTOMER', normalCost: 30, normalPrice: 66.96, mode: 'NORMAL', free: false, unitCost: 30, offerPrice: 66.96, changed: false, direct: true });
  const free = priceDecision({ admin: true, mode: 'FREE', line });
  assert.deepEqual([free.free, free.offerPrice, free.unitCost, free.changed, free.direct], [true, 0, 30, true, true], 'bedelsiz: müşteri fiyatı 0, maliyet durur');
  // Yöneticinin farklı fiyatı MÜŞTERİ fiyatıdır ve kesindir (karar 251: ek onay yok)
  const custom = priceDecision({ admin: true, mode: 'CUSTOM', price: '50,00', line });
  assert.deepEqual([custom.mode, custom.offerPrice, custom.unitCost, custom.changed, custom.tier, custom.direct], ['CUSTOM', 50, 30, true, 'CUSTOMER', true]);
  // Normal fiyatla aynı "farklı fiyat" değişiklik sayılmaz
  assert.equal(priceDecision({ admin: true, mode: 'CUSTOM', price: '66.96', line }).mode, 'NORMAL');
});

test('fiyat kararı — satış (karar 251): farklı fiyat SATIŞ fiyatıdır; müşteri fiyatı kaynaktaki gibi kalır ve yönetici onayı beklenmez', () => {
  const line = glass();
  // AYNI FİYAT: kaynağın iki fiyatı AYNEN (sunucuda kopyalanır) — satışın yazdığı tutar yok sayılır
  const same = priceDecision({ admin: false, mode: 'NORMAL', line });
  assert.deepEqual(same, { ok: true, tier: 'CUSTOMER', normalCost: 30, normalPrice: 66.96, mode: 'NORMAL', free: false, unitCost: 30, offerPrice: 66.96, changed: false, direct: true });
  assert.deepEqual(same, priceDecision({ admin: true, mode: 'NORMAL', line }), 'satış ve yönetici için aynı sonuç');
  assert.deepEqual(priceDecision({ admin: false, mode: 'NORMAL', price: '1', line }), same, '"aynı fiyat"ta istekle gelen tutar kullanılmaz');
  // BEDELSİZ: müşteri fiyatı 0, fabrika maliyeti durur; doğrudan müşteriye
  const free = priceDecision({ admin: false, mode: 'FREE', line });
  assert.deepEqual([free.free, free.unitCost, free.offerPrice, free.normalPrice, free.changed, free.tier, free.direct], [true, 30, 0, 66.96, true, 'CUSTOMER', true]);
  assert.deepEqual(priceDecision({ admin: false, mode: 'FREE', price: '99', line }), free, 'bedelsizde istekle gelen tutar kullanılmaz');
  // FARKLI FİYAT: satışın girdiği fiyat SATIŞ fiyatıdır; müşteri fiyatı kaynağınki (satış onu görmez / yazamaz); kesin → doğrudan
  const custom = priceDecision({ admin: false, mode: 'CUSTOM', price: '35,50', line });
  assert.deepEqual(custom, { ok: true, tier: 'SALES', normalCost: 30, normalPrice: 66.96, mode: 'CUSTOM', free: false, unitCost: 35.5, offerPrice: 66.96, changed: true, direct: true });
  // Satış hiçbir girdiyle müşteri fiyatını değiştiremez
  for (const price of ['1', '66.96', '100', '999']) assert.equal(priceDecision({ admin: false, mode: 'CUSTOM', price, line }).offerPrice, 66.96, String(price));
  // Fiyat zorunlu ve pozitif; kaynağın satış fiyatının aynısı "aynı fiyat"tır
  for (const price of ['', '   ', null, undefined, '0', '-5', 'abc', '2000000']) assert.deepEqual(priceDecision({ admin: false, mode: 'CUSTOM', price, line }), { ok: false, code: 'BAD_PRICE' }, `fiyat: ${String(price)}`);
  assert.deepEqual(priceDecision({ admin: false, mode: 'CUSTOM', price: '30', line }), same);
  // Kaynağın müşteri fiyatı kayıtlı değilse (eski kayıt) kesin müşteri fiyatı yoktur: yöneticinin fiyatlandırmasına gider
  const legacy = priceDecision({ admin: false, mode: 'NORMAL', line: glass({ offerPrice: null }) });
  assert.deepEqual([legacy.offerPrice, legacy.direct], [null, false]);
  const legacyCustom = priceDecision({ admin: false, mode: 'CUSTOM', price: '40', line: glass({ offerPrice: null }) });
  assert.deepEqual([legacyCustom.unitCost, legacyCustom.offerPrice, legacyCustom.direct], [40, null, false]);
});

test('fiyat kararı: geçersiz seçenek / fiyat reddedilir; kaynağı bedelsiz satırın normali bedelsizdir', () => {
  const line = glass();
  assert.deepEqual(priceDecision({ admin: true, mode: 'HEDIYE', line }), { ok: false, code: 'BAD_MODE' });
  for (const price of ['', null, '0', '-5', 'abc', '2000000']) assert.deepEqual(priceDecision({ admin: true, mode: 'CUSTOM', price, line }), { ok: false, code: 'BAD_PRICE' }, String(price));
  const src = priceDecision({ admin: true, mode: 'NORMAL', line: glass({ free: true }) });
  assert.deepEqual([src.free, src.normalPrice, src.changed], [true, 0, false]);
  assert.deepEqual(COMP_MODES, ['NORMAL', 'FREE', 'CUSTOM']);
});

test('telafi satırları (karar 251): işlemler aynen taşınır; yalnızca BEDELSİZDE işlem fiyatları 0, aynı / farklı fiyatta kaynaktaki gibi', () => {
  // İşlemli kaynak TEK bir camdır: işlemleri aynen (tür, açıklama, adet) taşınır — oran / yuvarlama yok
  const line = glass({ adet: 1 });
  const subs = [cnc({ adet: 1, description: 'Kulp yuvası' }), hole({ adet: 2 })];
  const rows = (lines) => lines.map((l) => [l.kind, l.description, l.adet, l.unitPrice, l.offerPrice, l.free]);
  const freeOps = [['CNC', 'Kulp yuvası', 1, 5, 0, true], ['DELIK', 'Delik', 2, 2, 0, true]];
  const keptOps = [['CNC', 'Kulp yuvası', 1, 5, 8, false], ['DELIK', 'Delik', 2, 2, 3, false]];
  // BEDELSİZ: cam ve işlemlerin müşteri fiyatı 0 (maliyet durur)
  const free = compensationLines({ line, subs, quantity: 1, decision: priceDecision({ admin: false, mode: 'FREE', line }) });
  assert.deepEqual(rows(free), [['CAM', 'Temper Lamine 44.2', 1, 30, 0, true], ...freeOps]);
  // AYNI FİYAT (işlemli cam): cam ve işlemlerin İKİ fiyatı kaynaktaki gibi — hiçbiri 0'a düşmez
  const same = compensationLines({ line, subs, quantity: 1, decision: priceDecision({ admin: false, mode: 'NORMAL', line }) });
  assert.deepEqual(rows(same), [['CAM', 'Temper Lamine 44.2', 1, 30, 66.96, false], ...keptOps]);
  // FARKLI FİYAT — satış: camın satış fiyatı girilen, müşteri fiyatı kaynağınki; işlem fiyatları SIFIRLANMAZ
  const sales = compensationLines({ line, subs, quantity: 1, decision: priceDecision({ admin: false, mode: 'CUSTOM', price: '35', line }) });
  assert.deepEqual(rows(sales), [['CAM', 'Temper Lamine 44.2', 1, 35, 66.96, false], ...keptOps]);
  // FARKLI FİYAT — yönetici: camın müşteri fiyatı girilen; işlem fiyatları kaynaktaki gibi
  const custom = compensationLines({ line, subs, quantity: 1, decision: priceDecision({ admin: true, mode: 'CUSTOM', price: 50, line }) });
  assert.deepEqual(rows(custom), [['CAM', 'Temper Lamine 44.2', 1, 30, 50, false], ...keptOps]);
  // İşlem-cam ilişkisi korunur; tutar = birim fiyat × miktar (müşteri: 2 m² × 66.96 + 8 + 2 × 3)
  for (const lines of [free, same, sales, custom]) assert.deepEqual(lines.map((l) => l.kind), ['CAM', 'CNC', 'DELIK']);
  assert.equal(offerTotals(atOfferPrice(same)).amount, Math.round((2 * 66.96 + 8 + 6) * 100) / 100);
  assert.equal(offerTotals(atOfferPrice(free)).amount, 0, 'bedelsiz: müşteri tutarı 0');
  assert.equal(offerTotals(atOfferPrice(sales)).amount, offerTotals(atOfferPrice(same)).amount, 'satışın farklı fiyatı müşteri tutarını değiştirmez');
  assert.equal(offerTotals(sales).amount, Math.round((2 * 35 + 5 + 4) * 100) / 100, 'satış tutarı girilen fiyatla');
  // Kaynakta bedelsiz işlem aynı fiyatta bedelsiz kalır
  const freeSub = compensationLines({ line, subs: [cnc({ adet: 1, free: true, offerPrice: '0' })], quantity: 1, decision: priceDecision({ admin: false, mode: 'NORMAL', line }) });
  assert.deepEqual(rows(freeSub).slice(1), [['CNC', 'CNC', 1, 5, 0, true]]);
  // İşlemsiz (standart) kardeş cam: aynı ölçü, adetle — telafisi işlem TAŞIMAZ
  const std = compensationLines({ line: glass({ id: 'g0', adet: 4 }), subs: [], quantity: 3, decision: priceDecision({ admin: false, mode: 'NORMAL', line: glass({ adet: 4 }) }) });
  assert.deepEqual(std.map((l) => [l.kind, l.adet, l.offerPrice]), [['CAM', 3, 66.96]]);
  assert.deepEqual([free[0].description, free[0].descriptionRo, free[0].enMm, free[0].boyMm, free[0].unit, free[0].glassProductId, free[0].weightKgM2, free[0].listPrice], ['Temper Lamine 44.2', 'Sticlă laminată 44.2', 1000, 2000, 'm2', 'p1', 20.8, 30]);
});

test('kaynak adedi (karar 157): 20 cam → 3 telafi → ana siparişte 17; adet, m² ve tutar iki kez sayılmaz', () => {
  const src = [glass({ adet: 20 }), glass({ id: 'g2', description: 'Temper 8mm', enMm: 500, boyMm: 500, adet: 4, unitPrice: '20', offerPrice: '40' }), crateFee()];
  const line = src[0];
  const r = reducedSourceLines(src, 'g1', 3);
  assert.deepEqual([r.before, r.after, r.empty], [20, 17, false]);
  assert.deepEqual(r.lines.map((l) => [l.id, l.adet]), [['g1', 17], ['g2', 4], ['k1', 1]], 'yalnızca seçilen cam satırı değişir');
  assert.equal(line.adet, 20, 'kaynak satır nesnesi değiştirilmez (eski teklif sürümü aynen kalır)');
  // Toplamlar: kaynak (sonra) + telafi = kaynak (önce) — adet, m² ve aynı fiyatta müşteri / satış tutarı
  const sum = (lines) => ({ adet: offerTotals(lines).adet, m2: offerTotals(lines).metraj, cost: offerTotals(lines).amount, sale: offerTotals(atOfferPrice(lines)).amount });
  const before = sum(src);
  for (const mode of ['NORMAL', 'FREE']) {
    const telafi = compensationLines({ line, subs: [], quantity: 3, decision: priceDecision({ admin: false, mode, line }) });
    const [a, t] = [sum(r.lines), sum(telafi)];
    assert.equal(a.adet + t.adet, before.adet, `${mode}: adet`);
    assert.equal(Math.round((a.m2 + t.m2) * 100) / 100, before.m2, `${mode}: m²`);
    // Aynı fiyat: müşteri toplam aynı tutarı öder (17 + 3 = 20 cam) · Bedelsiz: yalnızca kalan 17 camı öder (telafi 0)
    assert.equal(Math.round((a.sale + t.sale) * 100) / 100, mode === 'NORMAL' ? before.sale : a.sale, `${mode}: müşteri tutarı`);
    assert.equal(t.sale, mode === 'NORMAL' ? 401.76 : 0);
  }
  // Cam adedi sandık satırını saymaz (karar 211: sandık cam değildir — offerTotals.crate)
  assert.deepEqual([before.adet, before.m2, sum(r.lines).adet, sum(r.lines).m2], [24, 41, 21, 35]);

  // Satırın tamamı telafi edilirse satır kalkar; İŞLEMLİ tek camda işlem satırları da kalkar (telafiye taşındılar)
  const withOps = [glass({ adet: 9 }), glass({ id: 'g9', adet: 1 }), cnc({ adet: 1 }), hole({ adet: 2 }), glass({ id: 'g2', enMm: 500, boyMm: 500, adet: 4 })];
  const all = reducedSourceLines(withOps, 'g9', 1);
  assert.deepEqual([all.before, all.after, all.empty, all.lines.map((l) => l.id)], [1, 0, false, ['g1', 'g2']]);
  // İşlemsiz satırdan düşünce komşu camın işlemleri yerinde kalır (işlem-cam ilişkisi bozulmaz)
  assert.deepEqual(reducedSourceLines(withOps, 'g1', 9).lines.map((l) => l.id), ['g9', 'c1', 'h1', 'g2']);
  assert.deepEqual(reducedSourceLines(withOps, 'g1', 2).lines.map((l) => [l.id, l.adet]), [['g1', 7], ['g9', 1], ['c1', 1], ['h1', 2], ['g2', 4]]);

  // Kaynakta ölçülü cam kalmıyorsa (empty) telafi açılmaz — sandık parası cam sayılmaz
  assert.equal(reducedSourceLines([glass({ adet: 3 }), crateFee()], 'g1', 3).empty, true);
  assert.equal(reducedSourceLines([glass({ adet: 3 }), crateFee()], 'g1', 2).empty, false);
  // Geçersiz istek: olmayan satır, işlem satırı, satırdan fazla adet, tam sayı olmayan / sıfır adet
  for (const [id, q] of [['yok', 1], ['c1', 1], ['g1', 10], ['g1', 0], ['g1', -1], ['g1', 1.5]]) assert.equal(reducedSourceLines(withOps, id, q), null, `${id} / ${q}`);

  // Ayrılmış cam grubu (karar 114): kalan satırların sırası (pieceBase) yeniden hesaplanır — m² kalan toplam adetten
  const split = [glass({ adet: 4, splitGroup: 'grp1', pieceBase: 0 }), glass({ id: 'g9', adet: 1, splitGroup: 'grp1', pieceBase: 4 }), hole({ adet: 2 })];
  const s2 = reducedSourceLines(split, 'g1', 2);
  assert.deepEqual(s2.lines.map((l) => [l.id, l.adet, l.splitGroup, l.pieceBase]), [['g1', 2, 'grp1', 0], ['g9', 1, 'grp1', 2], ['h1', 2, null, 0]]);
  assert.equal(offerTotals(s2.lines).metraj, 6, '3 cam × 2 m²');
  // Grubun tek satırı kalınca olağan satıra döner
  assert.deepEqual(reducedSourceLines(split, 'g9', 1).lines.map((l) => [l.id, l.adet, l.splitGroup, l.pieceBase]), [['g1', 4, null, 0]]);
});

test('kaynak adedi yalnızca TEMİZ siparişte düşer: açık, onaylı yüklemesi ve belgesi olmayan sipariş', () => {
  const clean = { inConfirmation: false, coverage: null };
  for (const status of ['HAZIRLANIYOR', 'URETIMDE']) assert.deepEqual(sourceReducible({ status }, clean), { ok: true }, status);
  for (const status of ['YENI', 'YUKLENDI', 'ARSIVLENDI', 'IPTAL']) assert.deepEqual(sourceReducible({ status }, clean), { ok: false, reason: 'CLOSED' }, status);
  assert.deepEqual(sourceReducible({ status: 'URETIMDE' }, { inConfirmation: true, coverage: null }), { ok: false, reason: 'LOADED' });
  assert.deepEqual(sourceReducible({ status: 'URETIMDE' }, { inConfirmation: false, coverage: { reason: 'ORDER_DOCUMENT', ref: 'PRF1' } }), { ok: false, reason: 'BILLING' });
  // Yükleme önce gelir: hem yüklenmiş hem belgeli siparişte neden "yüklendi"dir
  assert.deepEqual(sourceReducible({ status: 'URETIMDE' }, { inConfirmation: true, coverage: { reason: 'ORDER_PENDING' } }), { ok: false, reason: 'LOADED' });
});

test('belgeler: bedelsiz telafi belgeye girmez; aynı / farklı fiyatta işlemler kaynaktaki fiyatlarla belgeye girer (karar 251)', () => {
  const line = glass({ adet: 1 });
  const subs = [cnc({ adet: 1 }), hole({ adet: 2 })];
  const offerOf = (mode, admin = false, price = null) => ({ lines: compensationLines({ line, subs, quantity: 1, decision: priceDecision({ admin, mode, price, line }) }) });
  // BEDELSİZ: hiçbir satır yok — belgeye yazılacak bir şey kalmaz
  assert.deepEqual(proformaLines(offerOf('FREE')), []);
  assert.deepEqual(invoiceLines(offerOf('FREE'), 5, 21), []);
  // AYNI FİYAT / FARKLI FİYAT: kaynağın kendi satırları gibi — proformada cam + CNC + delik; faturada işlemler cam satırına eklenir
  for (const [o, eur] of [[offerOf('NORMAL'), 66.96], [offerOf('CUSTOM', false, '35'), 66.96], [offerOf('CUSTOM', true, '50'), 50]]) {
    assert.deepEqual(proformaLines(o).map((r) => [r.unit, r.qty, r.eur]), [['mp', 2, eur], ['buc', 1, 8], ['buc', 2, 3]]);
    const inv = invoiceLines(o, 5, 21);
    assert.deepEqual([inv.length, inv[0].qty], [1, 2]);
  }
  // Satışın farklı fiyatı müşterinin belgesini değiştirmez (müşteri fiyatı kaynağınki)
  assert.deepEqual(proformaLines(offerOf('CUSTOM', false, '35')), proformaLines(offerOf('NORMAL')));
  // Karşılaştırma — kaynağın kendi satırları: aynı fiyatlı telafinin belgesi kaynağınkiyle aynı
  assert.deepEqual(proformaLines({ lines: [line, ...subs] }), proformaLines(offerOf('NORMAL')));
  // Var olan siparişe eklenen bedelsiz telafi o siparişin belgesini değiştirmez
  const own = glass({ id: 'o1', adet: 5 });
  const free = offerOf('FREE').lines;
  assert.deepEqual(proformaLines({ lines: [own, ...free] }), proformaLines({ lines: [own] }));
  assert.deepEqual(invoiceLines({ lines: [own, ...free] }, 5, 21), invoiceLines({ lines: [own] }, 5, 21));
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
    assert.deepEqual(await removeOrder(null, { orderId: 'x', confirmNo: 'ABC1', actor: { id: 'u', role } }), { ok: false, code: 'FORBIDDEN' }, String(role));
    assert.deepEqual(await restoreOrder(null, { orderId: 'x', actor: { id: 'u', role } }), { ok: false, code: 'FORBIDDEN' }, String(role));
  }
  // Onaysız istek (ikinci adım atlanmış) yetkili kullanıcıda da reddedilir
  assert.deepEqual(await createCompensation(null, { orderId: 'x', lineId: 'y', quantity: 1, mode: 'FREE', dest: { type: 'NEW', day: '2099-01-01' }, requestKey: 'k'.repeat(20), confirm: false, actor: { id: 'u', role: 'SATIS' } }), { ok: false, code: 'CONFIRM_REQUIRED' });
  // Silme (Paket 4): ikinci adımın onayı = yöneticinin yazdığı sipariş numarası; boşsa veritabanına hiç gidilmez
  for (const confirmNo of [undefined, null, '', '   ']) {
    assert.deepEqual(await removeOrder(null, { orderId: 'x', confirmNo, actor: { id: 'u', role: 'ADMIN' } }), { ok: false, code: 'CONFIRM_REQUIRED' }, String(confirmNo));
  }
});

test('yönetici bildirimi: karar başlıkta (bedelsiz / aynı fiyat / farklı fiyat), tutar yok; firma adı maskeleme kuralı değişmedi', () => {
  assert.deepEqual(COMP_NOTICE, { FREE: 'COMPENSATION_FREE', NORMAL: 'COMPENSATION_SAME', CUSTOM: 'COMPENSATION_CUSTOM' });
  for (const [locale, dict] of [['tr', tr], ['ro', ro]]) {
    for (const type of [...Object.values(COMP_NOTICE), 'COMPENSATION_PENDING']) {
      const n = renderInApp(locale, { type, params: { aud: 'staff', orderNo: 'ABC124-T', firm: 'ABC Glass SRL', qty: 3, ref: 'ABC124' } });
      assert.equal(n.title, dict.notifications.types[type].title, `${locale} ${type}`);
      assert.ok(n.body.includes('ABC124-T') && n.body.includes('ABC124') && n.body.includes('3'), `${locale} ${type}: ${n.body}`);
      assert.ok(!/\d+[.,]\d{2}/.test(`${n.title} ${n.body}`), 'bildirimde tutar yok');
    }
    for (const mode of COMP_MODES) {
      assert.equal(typeof dict.pricing.alerts.compModes[mode], 'string', `${locale} ${mode}`);
      assert.equal(typeof dict.compensation.decisions.flag[mode], 'string', `${locale} ${mode}`);
      assert.equal(typeof dict.compensation.decisions.mode[mode], 'string', `${locale} ${mode}`);
    }
  }
  // Maskeleme (bu paket dokunmadı): ilk 3 karakter + sabit sayıda yıldız — adın uzunluğu yıldız sayısından anlaşılmaz
  const masked = ['GLASSANDMORE', 'ALEGRAD', 'FOL Expert', 'ABC Glass SRL', 'AB'].map(maskName);
  assert.deepEqual(masked.slice(0, 4), ['GLA**********', 'ALE**********', 'FOL**********', 'ABC**********']);
  assert.equal(new Set(masked.slice(0, 4).map((x) => x.length)).size, 1, 'maskeli adların uzunluğu aynı');
  assert.ok(masked.every((x) => x.endsWith('*'.repeat(10))));
});

test('metinler: her hata kodunun ve yeni olayların metni var', () => {
  const m = tr.compensation;
  const reasons = ['SAME_ORDER', 'OTHER_CUSTOMER', 'NOT_GLASS', 'CLOSED', 'ON_HOLD', 'NOT_FUTURE', 'LOADED', 'NO_OFFER', 'CURRENCY', 'BILLING'];
  const codes = [
    'FORBIDDEN', 'CONFIRM_REQUIRED', 'BAD_REQUEST', 'BAD_QUANTITY', 'BAD_DEST', 'BAD_DAY', 'NOT_FUTURE', 'DAY_CONFIRMED', 'NOT_FOUND', 'ORDER_CANCELLED', 'NO_SENT_OFFER',
    'BAD_LINE', 'BAD_MODE', 'BAD_PRICE', 'BAD_LINK', 'NOT_LOADED_CAPACITY', 'PRICE_REQUIRED', 'CONFLICT', 'NOT_PENDING', 'DEST_NOT_FOUND', ...reasons.map((r) => `DEST_${r}`),
    'PRICE_FORBIDDEN', 'AMBIGUOUS_OPS', 'SOURCE_EMPTY',
  ];
  for (const c of codes) assert.equal(typeof m.errors[c], 'string', c);
  // Kaynak adedi (karar 157): kayıttan önceki uyarı ve kayıttan sonraki sonuç metinleri, sonuç iletileri
  for (const r of ['LOADED', 'BILLING', 'CLOSED']) assert.equal(typeof m.form.sourceKept[r], 'string', r);
  for (const r of ['LOADED', 'BILLING', 'CLOSED', 'CHANGED', 'PENDING']) assert.equal(typeof m.sourceResult.kept[r], 'string', r);
  for (const k of ['created', 'sent', 'updated', 'pricing', 'pending', 'duplicate', 'applied', 'rejected']) assert.equal(typeof m.ok[k], 'string', k);
  assert.equal(m.sourceResult.reduced.replace('{before}', '20').replace('{after}', '17'), 'Kaynak siparişte bu camın adedi 20 → 17 oldu; teklifin yeni sürümü müşteride.');
  for (const r of reasons) assert.equal(typeof m.form.destReason[r], 'string', r);
  for (const c of ['FORBIDDEN', 'CONFIRM_REQUIRED', 'NOT_FOUND', 'ALREADY_REMOVED', 'NOT_REMOVED', 'BUSY', 'LOCKED', 'STALE']) assert.equal(typeof m.remove.errors[c], 'string', c);
  for (const e of ['COMPENSATION', 'COMPENSATION_ADDED', 'COMPENSATION_PENDING', 'COMPENSATION_REJECTED', 'REMOVED', 'RESTORED']) {
    assert.deepEqual(EVENTS[e], { customer: false }, `${e}: yalnızca iç ekip görür`);
    assert.equal(typeof tr.events[e].label, 'string', e);
  }
  assert.equal(m.form.confirm.replace('{qty}', '3'), 'Yukarıdaki kararı onaylıyorum: 3 cam telafi olarak eklensin.');
  assert.equal(m.form.submit, 'Telafi camını ekle');
  // İki aşamalı silme (Paket 4): 1. adım sipariş no + sonuç, 2. adım sipariş numarası yazılarak ayrı onay
  assert.equal(m.remove.confirm.replace('{order}', 'ABC124'), 'Silmeyi onaylamak için sipariş numarasını yazın: ABC124');
  for (const k of ['step1', 'target', 'blockedTitle', 'blockedText', 'continue', 'step2', 'keptCounts']) assert.equal(typeof m.remove[k], 'string', k);
});

// P2-A, karar 251: ekranın gösterdiği yol (compensationFlow) sunucunun izlediği yolla aynı. Bütün kombinasyonlar
// priceDecision().direct ve createCompensation'ın dallarıyla karşılaştırılır.
test('telafi akışı: ekran kuralı sunucu kuralıyla aynı; farklı fiyat yönetici onayı beklemez (kaynakta müşteri fiyatı varsa)', async () => {
  const { compensationFlow } = await import('../server/orders/compensation-flow.js');
  for (const mode of ['FREE', 'NORMAL', 'CUSTOM']) {
    for (const admin of [false, true]) {
      for (const sourceFree of [false, true]) {
        for (const sourcePriced of [false, true]) {
          const line = { free: sourceFree, unitPrice: '30', offerPrice: sourcePriced ? '66.96' : null };
          const d = priceDecision({ admin, mode, price: mode === 'CUSTOM' ? '70' : null, line });
          assert.equal(d.ok, true);
          for (const [destType, via] of [['NEW', null], ['EXISTING', 'DRAFT'], ['EXISTING', 'SENT']]) {
            const f = compensationFlow({ mode, admin, destType, via, sourceFree, sourcePriced });
            // Sunucu (createCompensation): taslak hedef → taslağa eklenir; kesin müşteri fiyatı → doğrudan; müşterideki hedefte
            // satış kesin olmayan kararla PENDING, yönetici fiyatsız satırla PRICE_REQUIRED; yeni sipariş → fiyat onayı
            const server = via === 'DRAFT' ? 'draft' : d.direct ? 'direct' : via === 'SENT' ? (!admin ? 'pending' : 'priceRequired') : 'pricing';
            assert.equal(f, server, JSON.stringify({ mode, admin, sourceFree, sourcePriced, destType, via }));
          }
        }
      }
    }
  }
  // Satışın farklı fiyatı: kaynakta müşteri fiyatı varsa her hedefte doğrudan (yönetici onayı yok)
  for (const [destType, via] of [['NEW', null], ['EXISTING', 'SENT']]) assert.equal(compensationFlow({ mode: 'CUSTOM', admin: false, destType, via, sourcePriced: true }), 'direct');
  assert.equal(compensationFlow({ mode: 'NORMAL', admin: false, destType: 'NEW', sourcePriced: false }), 'pricing');
  assert.equal(compensationFlow({ mode: 'NORMAL', admin: false, destType: 'NEW', sourcePriced: true }), 'direct');
  for (const lang of [tr, ro]) for (const k of ['keepWith', 'freeWith', 'customLabel', 'sumOpsFree']) assert.equal(typeof lang.compensation.form[k], 'string', k);
});
