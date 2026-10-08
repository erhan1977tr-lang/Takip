// Yükleme günü firma tablosu — tek atıf kuralı (Paket 7, karar 186): firma başına tek satır, alt sipariş toplamı = ana satır,
// sipariş sayısı ≠ cam sayısı, misafir yük ticari sahibinde / fiziksel olarak ev sahibinde, aynı sandık bir kez, brüt iki kez
// hesaplanmaz, misafir sayısı gerçek ilişkilerden, görünmeyen tutar toplanmaz, farklı para birimi toplanmaz.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dayFirms, rowsTotal } from '../server/loading/day-firms.js';
import { CRATE_MAX_KG, CRATE_TARE_KG } from '../server/orders/loading.js';

const load = (o = {}) => ({ metraj: 2, camAdet: 2, cnc: 0, delik: 0, netKg: 40, ...o });
const entry = (orderId, customerId, o = {}) => ({
  orderId, orderNo: orderId.toUpperCase(), customerId, customerName: `Firma ${customerId}`, guestHostId: null, replan: false,
  load: load(o.load), money: { currency: 'EUR', sales: 10, offer: 20, ...o.money }, ...o.extra,
});
const crate = (id, customerId, crateNo, o = {}) => ({ id, crateNo, customerId, customerName: `Firma ${customerId}`, netAgirlik: null, brutAgirlik: null, daraKg: 50, orderIds: [], ...o });
const firm = (r, id) => r.firms.find((f) => f.id === id);

test('firma başına tek satır: aynı firmanın bütün siparişleri toplanır; sipariş adedi ve cam adedi ayrı hesaplanır', () => {
  const r = dayFirms({
    entries: [
      entry('a1', 'A', { load: { camAdet: 3, metraj: 3.5, cnc: 2, delik: 4, netKg: 70 } }),
      entry('a2', 'A', { load: { camAdet: 5, metraj: 6.25, cnc: 0, delik: 1, netKg: 125 } }),
      entry('b1', 'B', { load: { camAdet: 1, metraj: 1, netKg: 20 } }),
    ],
  });
  assert.deepEqual(r.firms.map((f) => f.id), ['A', 'B'], 'm² çok olan önce');
  const a = firm(r, 'A');
  assert.deepEqual([a.orders, a.camAdet, a.cnc, a.delik, a.metraj], [2, 8, 2, 5, 9.75], 'sipariş adedi 2, cam adedi 8');
  assert.deepEqual([a.netKg, a.crates, a.grossKg, a.realCrates], [195, 1, 195 + CRATE_TARE_KG, false]);
  assert.deepEqual(a.money, { EUR: { sales: 20, offer: 40, hasSales: true, hasOffer: true } });
  assert.deepEqual([r.total.orders, r.total.camAdet, r.total.metraj, r.total.crates], [3, 9, 10.75, 2]);
  // Aynı siparişin iki satırı (kendi günü + aynı güne aktarılmış kalan) sipariş adedinde bir kez sayılır, cam adedi toplanır
  const twice = dayFirms({ entries: [entry('a1', 'A'), entry('a1', 'A', { extra: { replan: true } })] });
  assert.deepEqual([firm(twice, 'A').orders, firm(twice, 'A').camAdet], [1, 4]);
});

test('ana satır = alt siparişlerin toplamı (cam, CNC, delik, m², fabrika satış, teklif) — her firmada', () => {
  const r = dayFirms({
    entries: [
      entry('a1', 'A', { load: { camAdet: 3, metraj: 3.333, cnc: 1, delik: 2 }, money: { sales: 101.11, offer: 150.55 } }),
      entry('a2', 'A', { load: { camAdet: 2, metraj: 1.117, cnc: 0, delik: 3 }, money: { sales: 0.01, offer: 0.02 } }),
      entry('b1', 'B', { money: { offer: null } }),
    ],
  });
  for (const f of r.firms) {
    const sub = rowsTotal(f.rows);
    assert.deepEqual([sub.orders, sub.camAdet, sub.cnc, sub.delik, sub.metraj, sub.money], [f.orders, f.camAdet, f.cnc, f.delik, f.metraj, f.money], f.id);
  }
  assert.deepEqual(firm(r, 'A').money.EUR, { sales: 101.12, offer: 150.57, hasSales: true, hasOffer: true });
  // Teklif gönderilmemiş (null) tutar toplanmaz ve "var" sayılmaz
  assert.deepEqual(firm(r, 'B').money.EUR, { sales: 10, offer: 0, hasSales: true, hasOffer: false });
});

test('görünmeyen tutar firma tablosuna hiç girmez; farklı para birimleri toplanmaz', () => {
  const sales = dayFirms({ entries: [entry('a1', 'A', { money: { offer: null } }), entry('a2', 'A', { money: { currency: 'RON', sales: 50, offer: null } })] });
  assert.deepEqual(firm(sales, 'A').money, { EUR: { sales: 10, offer: 0, hasSales: true, hasOffer: false }, RON: { sales: 50, offer: 0, hasSales: true, hasOffer: false } });
  const none = dayFirms({ entries: [entry('a1', 'A', { extra: { money: null } })] });
  assert.deepEqual(firm(none, 'A').money, {});
  assert.deepEqual(none.total.money, {});
});

test('misafir yük (sandık seçildi): ticari değerler sahibinde, sandık ve ağırlık ev sahibinde; aynı sandık bir kez, brüt iki kez değil', () => {
  // A'nın siparişi (200 kg) B'nin 15 numaralı sandığında; B'nin kendi camı 60 kg; sandığa ağırlık girilmemiş
  const entries = [entry('u1', 'A', { load: { camAdet: 10, metraj: 10, netKg: 200 }, extra: { guestHostId: 'B' } }), entry('b1', 'B', { load: { camAdet: 3, metraj: 3, netKg: 60 } })];
  const crates = [crate('c15', 'B', 15, { orderIds: ['b1', 'u1'] })];
  const links = [{ orderId: 'u1', crateId: 'c15', crateNo: 15, hostId: 'B', hostName: 'Firma B', byHost: true }];
  const r = dayFirms({ entries, crates, links });
  const a = firm(r, 'A');
  const b = firm(r, 'B');
  assert.deepEqual([a.orders, a.camAdet, a.metraj, a.netKg, a.crates, a.grossKg], [1, 10, 10, 0, 0, 0], 'A: kendi satırında, yeni sandık yok');
  assert.deepEqual([b.orders, b.camAdet, b.metraj, b.netKg, b.crates, b.grossKg, b.realCrates], [1, 3, 3, 260, 1, 310, true], 'B: sandık camı taşır');
  assert.deepEqual([r.total.crates, r.total.netKg, r.total.grossKg], [1, 260, 310], 'gün toplamı: tek sandık, cam bir kez');
  assert.deepEqual(a.rows[0].guest, { hostId: 'B', hostName: 'Firma B', crateId: 'c15', crateNo: 15, waiting: false, hostHere: true, byHost: true });
  assert.deepEqual(b.guestsIn, [{ orderId: 'u1', orderNo: 'U1', ownerId: 'A', ownerName: 'Firma A', crateId: 'c15', crateNo: 15, waiting: false, byHost: true }]);
  assert.deepEqual([a.guestOrders, b.guestOrders, r.guestOrders], [1, 0, 1]);
  assert.deepEqual(b.crateList.map((c) => c.crateNo), [15], 'sandık ev sahibinin listesinde');
  assert.deepEqual(a.crateList, []);
  // Girilmiş gerçek ağırlık her zaman esas: misafir cam ayrıca eklenmez (iki kez sayılmaz)
  const real = dayFirms({ entries, crates: [crate('c15', 'B', 15, { netAgirlik: '255', brutAgirlik: '305', orderIds: ['b1', 'u1'] })], links });
  assert.deepEqual([firm(real, 'B').netKg, firm(real, 'B').grossKg, firm(real, 'A').grossKg, real.total.grossKg], [255, 305, 0, 305]);
});

test('misafir yük (ev sahibi seçildi, sandık bekliyor): ağırlık ev sahibine, sahibine tahmini sandık açılmaz; ev sahibi yüklemiyorsa kendi firmasında', () => {
  const entries = [entry('u1', 'A', { load: { netKg: 200 }, extra: { guestHostId: 'B' } }), entry('b1', 'B', { load: { netKg: 60 } })];
  const r = dayFirms({ entries });
  assert.deepEqual([firm(r, 'A').crates, firm(r, 'A').netKg, firm(r, 'A').grossKg], [0, 0, 0]);
  assert.deepEqual([firm(r, 'B').netKg, firm(r, 'B').crates, firm(r, 'B').grossKg], [260, 1, 260 + CRATE_TARE_KG]);
  assert.deepEqual(firm(r, 'A').rows[0].guest, { hostId: 'B', hostName: 'Firma B', crateId: null, crateNo: null, waiting: true, hostHere: true, byHost: true });
  assert.equal(firm(r, 'B').guestsIn[0].waiting, true);
  assert.equal(r.guestOrders, 1);
  // Bayat ilişki: ev sahibi o gün yüklemiyor → hâlâ misafir (uyarı) ama ağırlığı kendi firmasında; ev sahibinde görünmez
  const stale = dayFirms({ entries: [entry('u1', 'A', { load: { netKg: 200 }, extra: { guestHostId: 'Z' } })], hostNames: new Map([['Z', 'Firma Z']]) });
  assert.deepEqual([firm(stale, 'A').netKg, firm(stale, 'A').crates, stale.guestOrders], [200, 1, 1]);
  assert.deepEqual(firm(stale, 'A').rows[0].guest, { hostId: 'Z', hostName: 'Firma Z', crateId: null, crateNo: null, waiting: true, hostHere: false, byHost: true });
  // Aktarılan kalan: ev sahibi o gün de yüklemiyorsa misafir değildir (kendi firmasıyla gider — karar 124)
  const carried = dayFirms({ entries: [entry('u1', 'A', { extra: { guestHostId: 'B', replan: true } })] });
  assert.deepEqual([firm(carried, 'A').rows[0].guest, carried.guestOrders], [null, 0]);
  const carriedHost = dayFirms({ entries: [entry('u1', 'A', { extra: { guestHostId: 'B', replan: true } }), entry('b1', 'B')] });
  assert.equal(carriedHost.guestOrders, 1);
});

test('misafir sayısı (takvimin kırmızı göstergesi) gerçek ilişkilerden: aynı sipariş bir kez; sahibi ev sahibiyle aynı olan bağ sayılmaz', () => {
  const entries = [
    entry('u1', 'A', { extra: { guestHostId: 'B' } }), entry('u2', 'A'), entry('c1', 'C', { extra: { guestHostId: 'B' } }), entry('b1', 'B'),
  ];
  const links = [
    { orderId: 'u1', crateId: 'x', crateNo: 3, hostId: 'B' }, { orderId: 'u1', crateId: 'y', crateNo: 4, hostId: 'B' }, // eski kayıt: iki sandık → bir sipariş
  ];
  const r = dayFirms({ entries, crates: [crate('x', 'B', 3), crate('y', 'B', 4)], links });
  assert.equal(r.guestOrders, 2, 'u1 (sandıkta) + c1 (sandık bekliyor)');
  assert.equal(firm(r, 'A').rows.find((x) => x.entry.orderId === 'u1').guest.crateNo, 3, 'ilk sandık');
  assert.equal(dayFirms({ entries: [entry('u2', 'A')] }).guestOrders, 0, 'misafir yoksa 0 (kırmızı yuvarlak gösterilmez)');
});

test('özellik: rastgele günlerde her sandık tam bir firmada sayılır, cam ağırlığı bir kez sayılır, ticari toplamlar korunur', () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let round = 0; round < 300; round++) {
    const firms = ['A', 'B', 'C', 'D'].slice(0, 1 + rnd(4));
    const entries = [];
    const crates = [];
    const links = [];
    for (const f of firms) {
      const n = rnd(4);
      for (let i = 0; i < n; i++) {
        const host = rnd(3) === 0 ? firms[rnd(firms.length)] : null;
        entries.push(entry(`${f}${i}`, f, { load: { camAdet: 1 + rnd(9), metraj: (1 + rnd(400)) / 100, netKg: 1 + rnd(900), cnc: rnd(3), delik: rnd(5) }, extra: { guestHostId: host === f ? null : host, replan: rnd(5) === 0 } }));
      }
      const k = rnd(3);
      for (let i = 0; i < k; i++) crates.push(crate(`${f}c${i}`, f, crates.length + 1));
    }
    for (const e of entries) {
      if (!e.guestHostId) continue;
      const hc = crates.find((c) => c.customerId === e.guestHostId);
      if (hc && rnd(2)) links.push({ orderId: e.orderId, crateId: hc.id, crateNo: hc.crateNo, hostId: e.guestHostId });
    }
    const r = dayFirms({ entries, crates, links });
    assert.equal(r.firms.reduce((s, f) => s + f.crateList.length, 0), crates.length, 'her sandık tek firmada');
    for (const f of r.firms) if (f.crateList.length) assert.equal(f.crates, f.crateList.length);
    // Ağırlığı girilmemiş sandıklar: gün net ağırlığı = bütün camın ağırlığı (misafir cam bir kez)
    assert.equal(r.total.netKg, entries.reduce((s, e) => s + e.load.netKg, 0), `tur ${round}`);
    assert.equal(r.total.camAdet, entries.reduce((s, e) => s + e.load.camAdet, 0));
    assert.equal(r.total.orders, new Set(entries.map((e) => `${e.customerId}|${e.orderId}`)).size);
    for (const f of r.firms) {
      const sub = rowsTotal(f.rows);
      assert.deepEqual([sub.camAdet, sub.cnc, sub.delik, sub.metraj], [f.camAdet, f.cnc, f.delik, f.metraj]);
      assert.ok(f.rows.every((x) => x.entry.customerId === f.id), 'misafir sipariş ticari sahibinin satırında');
      assert.ok(f.grossKg >= f.netKg);
    }
  }
});

test('tahmin: sandık girilmemiş firmanın camı en çok 1700 kg / sandık ile bölünür (mevcut kural aynen)', () => {
  const r = dayFirms({ entries: [entry('a1', 'A', { load: { netKg: CRATE_MAX_KG + 1 } })] });
  assert.deepEqual([firm(r, 'A').crates, firm(r, 'A').grossKg, firm(r, 'A').estimatedCrates], [2, CRATE_MAX_KG + 1 + 2 * CRATE_TARE_KG, 2]);
});
