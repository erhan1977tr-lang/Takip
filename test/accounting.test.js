// Muhasebe (tahsilat durumu, yükleme kârı, fabrika bakiyesi) — saf hesaplar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentStatus, receivables, refreshDocuments, remaining, syncFgoDocuments } from '../server/accounting/receivables.js';
import { loadingProfits, orderLine, parseAmount, supplierSummary } from '../server/accounting/supplier.js';
import { glassTotals } from '../server/glass/billing.js';
import { sealSecret } from '../server/crypto/secret.js';

test('tahsilat durumu: ödenmedi / kısmi / ödendi; kalan', () => {
  assert.equal(paymentStatus(null, null), 'UNKNOWN');
  assert.equal(paymentStatus('100', '0'), 'UNPAID');
  assert.equal(paymentStatus('100', null), 'UNPAID');
  assert.equal(paymentStatus('100', '40'), 'PARTIAL');
  assert.equal(paymentStatus('100', '100'), 'PAID');
  assert.equal(paymentStatus('100', '120'), 'PAID');
  assert.equal(remaining('100', '40'), 60);
  assert.equal(remaining('100', '120'), 0);
  assert.equal(remaining(null, '1'), null);
});

// Karar 88: aynı ticari borç iki kez sayılmaz. Belgeler listede durur; yalnızca toplama giren pay değişir.
const doc = (id, orderId, kind, total, paid, currency = 'RON') => ({ id, orderId, kind, total, paid, currency });
const shareOf = (r, id) => r.shares.get(id);

test('alacak: yalnızca proforma → proforma alacağı temsil eder', () => {
  const r = receivables([doc('p', 'o1', 'PROFORMA', '1210.00', '0')]);
  assert.deepEqual(shareOf(r, 'p'), { debt: 1210, rest: 1210, replaced: false });
  assert.deepEqual(r.sums, { RON: { total: 1210, paid: 0, rest: 1210 } });
  // FGO proformada tahsilat gösterirse düşülür
  assert.deepEqual(receivables([doc('p', 'o1', 'PROFORMA', '1210.00', '210.00')]).sums.RON, { total: 1210, paid: 210, rest: 1000 });
});

test('alacak: fatura kesilince alacağın kaynağı faturadır; aynı tutar proformadan ikinci kez eklenmez', () => {
  const docs = [doc('p', 'o1', 'PROFORMA', '1210.00', '0'), doc('f', 'o1', 'INVOICE', '1210.00', '0')];
  const r = receivables(docs);
  assert.deepEqual(shareOf(r, 'p'), { debt: 0, rest: 0, replaced: true }, 'proforma listede kalır ama toplama girmez');
  assert.deepEqual(shareOf(r, 'f'), { debt: 1210, rest: 1210, replaced: false });
  assert.deepEqual(r.sums.RON, { total: 1210, paid: 0, rest: 1210 }, 'eski hesap 2420 kalan gösteriyordu');
});

test('alacak: ödenmemiş / kısmi ödenmiş / ödenmiş fatura', () => {
  const sums = (paid) => receivables([doc('p', 'o1', 'PROFORMA', '500.00', '0'), doc('f', 'o1', 'INVOICE', '500.00', paid)]).sums.RON;
  assert.deepEqual(sums('0'), { total: 500, paid: 0, rest: 500 });
  assert.deepEqual(sums('120.50'), { total: 500, paid: 120.5, rest: 379.5 });
  assert.deepEqual(sums('500.00'), { total: 500, paid: 500, rest: 0 });
  assert.deepEqual(sums('650.00'), { total: 500, paid: 500, rest: 0 }, 'fazla ödeme kalanı eksiye düşürmez');
});

test('alacak: cam — proforma + avans faturası + kapanış faturası aynı borcu bir kez sayar', () => {
  // Sipariş 1210 RON. 605 tahsil edildi → avans faturası 605. Yüklenince kapanış faturası 1210 − 605 = 605 (avans düşülmüş).
  const p = doc('p', 'o1', 'PROFORMA', '1210.00', '0');
  const a = doc('a', 'o1', 'ADVANCE', '605.00', '605.00');
  const f = doc('f', 'o1', 'INVOICE', '605.00', '0');
  // Avans kesildi, henüz yüklenmedi: proformadan yalnızca avans faturasına dönmeyen kısım sayılır
  let r = receivables([p, a]);
  assert.deepEqual(shareOf(r, 'p'), { debt: 605, rest: 605, replaced: false });
  assert.deepEqual(shareOf(r, 'a'), { debt: 605, rest: 0, replaced: false });
  assert.deepEqual(r.sums.RON, { total: 1210, paid: 605, rest: 605 }, 'körlemesine toplam 1815 olurdu');
  // Kapanış faturası kesildi: proforma sayılmaz; avans + kapanış = siparişin tamamı
  r = receivables([p, a, f]);
  assert.equal(shareOf(r, 'p').replaced, true);
  assert.deepEqual(r.sums.RON, { total: 1210, paid: 605, rest: 605 }, 'körlemesine toplam 2420, kalan 1815 olurdu');
  // Avans faturası FGO'da henüz ödenmiş görünmüyorsa kendi kalanı sayılır; yine de proformayla çift sayılmaz
  r = receivables([p, { ...a, paid: '0' }]);
  assert.deepEqual(r.sums.RON, { total: 1210, paid: 0, rest: 1210 });
  // FGO proformada avanstan fazla tahsilat gösteriyorsa o esas alınır (aynı para iki kez düşülmez)
  r = receivables([{ ...p, paid: '800.00' }, a]);
  assert.deepEqual(shareOf(r, 'p'), { debt: 605, rest: 410, replaced: false });
});

test('alacak: siparişler ayrı, para birimleri ayrı; tutarı okunmamış belge toplama girmez', () => {
  const r = receivables([
    doc('p1', 'o1', 'PROFORMA', '100.00', '0'), doc('f1', 'o1', 'INVOICE', '100.00', '40.00'),
    doc('p2', 'o2', 'PROFORMA', '300.00', '0'),
    doc('f3', 'o3', 'INVOICE', '50.00', '0', 'EUR'),
    doc('p4', 'o4', 'PROFORMA', null, null),
  ]);
  assert.deepEqual(r.sums, { RON: { total: 400, paid: 40, rest: 360 }, EUR: { total: 50, paid: 0, rest: 50 } });
  assert.deepEqual(shareOf(r, 'p4'), { debt: null, rest: null, replaced: false });
});

// ---------- FGO ödeme durumu eşitlemesi (elle + işçi) ----------
function syncDb(docs, { settings = { enabled: true, cui: '1', keySealed: null }, sync = null } = {}) {
  const rows = { fgo: { value: settings, updatedAt: new Date(1) }, ...(sync ? { 'fgo-sync': { value: sync, updatedAt: new Date(1) } } : {}) };
  const removed = [];
  let tick = 2;
  return {
    rows, removed,
    integrationSetting: {
      findUnique: async ({ where }) => rows[where.key] ?? null,
      create: async ({ data }) => { rows[data.key] = { value: data.value, updatedAt: new Date(tick++) }; },
      update: async ({ where, data }) => { rows[where.key] = { value: data.value, updatedAt: new Date(tick++) }; },
      updateMany: async ({ where, data }) => {
        const row = rows[where.key];
        if (!row || row.updatedAt.getTime() !== where.updatedAt.getTime()) return { count: 0 };
        rows[where.key] = { value: data.value, updatedAt: new Date(tick++) };
        return { count: 1 };
      },
    },
    fgoDocument: {
      findMany: async () => docs.filter((d) => !removed.includes(d.id)),
      update: async ({ where, data }) => Object.assign(docs.find((d) => d.id === where.id), data),
    },
  };
}
const SECRET = 's'.repeat(40);
const sealed = sealSecret('KEY', SECRET, 'fgo-key');
const fgoSettings = { enabled: true, cui: '1', keySealed: sealed };
const statusFetch = (answers) => {
  const asked = [];
  return {
    asked,
    fetchImpl: async (url, init) => {
      const form = Object.fromEntries(new URLSearchParams(init.body));
      asked.push(`${form.Serie}${form.Numar}`);
      const a = answers[`${form.Serie}${form.Numar}`] ?? { Valoare: '100.00', ValoareAchitata: '0' };
      if (a === 'gone') return new Response(JSON.stringify({ Success: false, Message: 'Factura nu exista' }));
      if (a === 'down') throw new Error('ECONNRESET');
      return new Response(JSON.stringify({ Success: true, Factura: a }));
    },
  };
};
const fdoc = (id, orderId, kind, series, number, total = null, paid = null) => ({ id, orderId, kind, series, number, currency: 'RON', total, paid, checkedAt: null, checkError: null });

test('otomatik FGO eşitlemesi: saatte bir; yalnızca açık belgeler; sınırlı tur; sipariş ve kayıt değişmez', async () => {
  const docs = [
    fdoc('p1', 'o1', 'PROFORMA', 'PRF', '1', '100.00', '0'), // yerine fatura kesilmiş: sorulmaz
    fdoc('f1', 'o1', 'INVOICE', 'GKH', '10', '100.00', '0'),
    fdoc('f2', 'o2', 'INVOICE', 'GKH', '11', '100.00', '100.00'), // ödenmiş: sorulmaz
    fdoc('p3', 'o3', 'PROFORMA', 'PRF', '2'), // tutarı hiç okunmamış
    fdoc('f4', 'o4', 'INVOICE', 'GKH', '12', '50.00', '0'), // FGO "belge yok" der
    fdoc('f5', 'o5', 'INVOICE', 'GKH', '13', '50.00', '0'), // ağ hatası
  ];
  const db = syncDb(docs, { settings: fgoSettings });
  const f = statusFetch({ GKH10: { Valoare: '100.00', ValoareAchitata: '40.00' }, PRF2: { Valoare: '300.00', ValoareAchitata: '0' }, GKH12: 'gone', GKH13: 'down' });
  const ctx = { secret: SECRET, fetchImpl: f.fetchImpl, sleep: async () => {} };
  const t0 = new Date('2026-10-02T10:00:00Z');
  assert.deepEqual(await syncFgoDocuments(db, { ...ctx, now: t0 }), { ran: true, checked: 2, failed: 2 });
  assert.deepEqual(f.asked.sort(), ['GKH10', 'GKH12', 'GKH13', 'PRF2']);
  assert.equal(docs[1].paid, '40.00');
  assert.equal(docs[3].total, '300.00');
  // Otomatik turda "belge yok" kaydı SİLMEZ ve siparişi geri almaz: hata belgeye yazılır
  assert.equal(db.removed.length, 0);
  assert.match(docs[4].checkError, /nu exista/);
  assert.match(docs[5].checkError, /ulaşılamadı/);
  assert.equal(db.rows['fgo-sync'].value.leaseUntil, null, 'tur bitince kilit bırakılır');
  assert.equal(db.rows['fgo-sync'].value.lastAuto, t0.toISOString());
  // Bir saat dolmadan yeniden çalışmaz
  f.asked.length = 0;
  assert.deepEqual(await syncFgoDocuments(db, { ...ctx, now: new Date(t0.getTime() + 59 * 60_000) }), { ran: false });
  assert.deepEqual(f.asked, []);
  // Bir saat sonra: sınırlı tur (en çok 2 belge), en uzun süredir sorulmamış olanlar
  const r = await syncFgoDocuments(db, { ...ctx, now: new Date(t0.getTime() + 61 * 60_000), limit: 2 });
  assert.equal(r.ran, true);
  assert.equal(f.asked.length, 2);
});

test('FGO eşitlemesi: iki tur üst üste binmez; FGO kapalıyken çalışmaz', async () => {
  const docs = [fdoc('f1', 'o1', 'INVOICE', 'GKH', '10', '100.00', '0')];
  const now = new Date('2026-10-02T10:00:00Z');
  const f = statusFetch({});
  const ctx = { secret: SECRET, fetchImpl: f.fetchImpl, sleep: async () => {}, now };
  // Başka bir tur sürüyor (kilit süresi dolmamış): elle güncelleme de otomatik tur da başlamaz
  const busy = syncDb(docs, { settings: fgoSettings, sync: { leaseUntil: new Date(now.getTime() + 60_000).toISOString() } });
  assert.deepEqual(await refreshDocuments(busy, { ...ctx, orderType: 'GLASS_ORDER' }), { ok: false, code: 'BUSY' });
  assert.deepEqual(await syncFgoDocuments(busy, ctx), { ran: false, code: 'BUSY' });
  assert.deepEqual(f.asked, []);
  // Süresi dolmuş kilit (yarıda kalmış tur) engel olmaz
  const stale = syncDb(docs, { settings: fgoSettings, sync: { leaseUntil: new Date(now.getTime() - 1000).toISOString() } });
  assert.deepEqual(await refreshDocuments(stale, { ...ctx, orderType: 'GLASS_ORDER' }), { ok: true, checked: 1, failed: 0 });
  // Tur sırasında ikinci istek: kilit alınmış olduğundan reddedilir
  const db = syncDb(docs, { settings: fgoSettings });
  let second = null;
  const slow = async (url, init) => {
    second = await refreshDocuments(db, { ...ctx, orderType: 'GLASS_ORDER' });
    return f.fetchImpl(url, init);
  };
  assert.deepEqual(await refreshDocuments(db, { ...ctx, fetchImpl: slow, orderType: 'GLASS_ORDER' }), { ok: true, checked: 1, failed: 0 });
  assert.deepEqual(second, { ok: false, code: 'BUSY' });
  // FGO kapalı: hiçbir istek, hiçbir kayıt
  const off = syncDb(docs, { settings: { ...fgoSettings, enabled: false } });
  assert.deepEqual(await syncFgoDocuments(off, ctx), { ran: false, code: 'FGO_DISABLED' });
  assert.equal(off.rows['fgo-sync'], undefined);
});

// ---------- Yükleme kârlılığı ----------
// Satış = yöneticinin müşteri fiyatı (offerPrice); maliyet = satış fiyatı (unitPrice, teklif hazırlanırken fabrika tablosundan).
const glassLine = (unitPrice, offerPrice, extra = {}) => ({ description: 'Cam', enMm: 1000, boyMm: 1000, adet: 3, unit: 'm2', kind: 'CAM', unitPrice, offerPrice, ...extra });
const offer = (cur, lines, extra = {}) => ({ status: 'GONDERILDI', currency: cur, amount: '0', offerAmount: '0', lines, ...extra });
const day = new Date('2026-09-15T00:00:00Z');
const order = (id, lines, extra = {}) => orderLine({ id, orderNo: `GLA${id}`, actualShipDate: day, estimatedShipDate: null, offers: [offer('EUR', lines)], ...extra });

test('yükleme kârı: satış − maliyet − nakliye, para birimi başına; ödemeler ayrı (dağıtılmaz)', () => {
  const lines = [
    order(1, [glassLine('200', '300')]),
    orderLine({ id: 'b', orderNo: 'GLA2', actualShipDate: null, estimatedShipDate: day, offers: [offer('EUR', [glassLine('100', '150')])] }),
    orderLine({ id: 'c', orderNo: 'GLA3', actualShipDate: day, estimatedShipDate: null, offers: [{ ...offer('EUR', [glassLine('1', '1')]), status: 'YONETIMDE' }] }),
  ];
  assert.equal(lines[2], null, 'gönderilmemiş teklif sayılmaz');
  const days = loadingProfits(lines, [{ shipDay: day, amount: '100', currency: 'EUR' }, { shipDay: new Date('2026-09-20'), amount: '50', currency: 'RON' }]);
  assert.equal(days.length, 2);
  assert.equal(days[0].day, '2026-09-20', 'en yeni önce');
  const d = days[1];
  assert.equal(d.orders, 2);
  assert.equal(d.m2, 6);
  assert.deepEqual(d.byCur.EUR, { sale: 1350, cost: 900, transport: 100, profit: 350 });
  assert.deepEqual(d.noCost, []);
  const s = supplierSummary(days, [{ amount: '700', currency: 'EUR' }, { amount: '10', currency: 'USD' }]);
  assert.deepEqual(s.EUR, { sale: 1350, cost: 900, transport: 100, profit: 350, paid: 700, balance: 200 }, 'fabrika ödemesi kârdan düşülmez');
  assert.deepEqual(s.RON, { sale: 0, cost: 0, transport: 50, profit: -50, paid: 0, balance: 0 });
  assert.deepEqual(s.USD, { sale: 0, cost: 0, transport: 0, profit: 0, paid: 10, balance: -10 });
});

test('maliyet ve satış ayrı değerlerdir: müşteri fiyatı değişince maliyet değişmez; tutar fatura kuralıyla (glassTotals)', () => {
  const base = [glassLine('30', '50'), { description: 'CNC', adet: 2, unit: 'adet', kind: 'CNC', unitPrice: '5', offerPrice: '10' }, { description: 'Sandık parası', adet: 1, unit: 'adet', kind: 'CAM', unitPrice: '40', offerPrice: '60' }];
  const a = order(1, base);
  // 3 m²: satış 150 + CNC 20 + sandık 60 = 230 · maliyet 90 + 10 + 40 = 140
  assert.deepEqual([a.sale, a.cost, a.noCost], [230, 140, 0]);
  // Faturadaki / yükleme dökümündeki tutarla aynı (aynı fonksiyon)
  assert.equal(a.sale, glassTotals(offer('EUR', base)).reduce((s, g) => s + g.total, 0));
  assert.equal(a.cost, glassTotals(offer('EUR', base), { priceOf: (l) => l.unitPrice }).reduce((s, g) => s + g.total, 0));
  // Yönetici müşteri fiyatını yükseltir: satış değişir, maliyet aynı kalır
  const b = order(2, base.map((l) => ({ ...l, offerPrice: String(Number(l.offerPrice) * 2) })));
  assert.deepEqual([b.sale, b.cost], [460, 140]);
});

test('bedelsiz satır: müşteriye satış 0, fabrika maliyeti kendiliğinden 0 olmaz', () => {
  // Yönetici müşteriye bedelsiz yaptı: satırdaki satış fiyatı (30) duruyor → maliyet 90, satış 0
  const adminFree = order(1, [glassLine('30', '50', { free: true })]);
  assert.deepEqual([adminFree.sale, adminFree.cost, adminFree.noCost], [0, 90, 0]);
  // Satış bedelsiz yaptı (satış fiyatı 0 kaydedilir): maliyet 0 — bu kayıtlı bir karardır, eksik veri değil
  const salesFree = order(2, [glassLine('0', '0', { free: true })]);
  assert.deepEqual([salesFree.sale, salesFree.cost, salesFree.noCost], [0, 0, 0]);
});

test('maliyeti eksik satır sessizce 0 sayılmaz: sipariş işaretlenir (ör. yöneticinin eklediği, fabrika fiyatı bulunamayan satır)', () => {
  const o = order(7, [glassLine('30', '50'), { description: 'Özel işlem', adet: 1, unit: 'adet', kind: 'CAM', unitPrice: '0', offerPrice: '25' }]);
  assert.deepEqual([o.sale, o.cost, o.noCost], [175, 90, 1]);
  const days = loadingProfits([o, order(8, [glassLine('30', '50')])], []);
  assert.deepEqual(days[0].noCost, [{ orderId: 7, orderNo: 'GLA7' }]);
});

test('tutar girişi', () => {
  assert.equal(parseAmount('1.234,56'), 1234.56);
  assert.equal(parseAmount('1234.5'), 1234.5);
  assert.equal(parseAmount('1,234.50'), 1234.5);
  assert.equal(parseAmount('0'), null);
  assert.equal(parseAmount('-5'), null);
  assert.equal(parseAmount('abc'), null);
});
