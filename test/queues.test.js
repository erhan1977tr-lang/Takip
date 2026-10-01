// "Sıra bende" kuyrukları: rol yetkisine göre bölümler; profil siparişleri satış/çizim kuyruklarına düşmez (Aşama 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queuesFor } from '../server/orders/queues.js';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const h = (n) => new Date(NOW + n * 3_600_000);
let seq = 0;
const row = (o = {}) => ({
  id: `o${++seq}`, orderTypeCode: 'GLASS_ORDER', status: 'HAZIRLANIYOR', onHold: false, drawingTrack: 'YOK',
  slaDeadline: h(48), offers: [], drawings: [], events: [], ...o,
});
const ids = (qs, key) => qs.find((q) => q.key === key)?.rows.map((r) => r.id) ?? null;
const keys = (qs) => qs.map((q) => q.key);

const rows = {
  yeni: row({ status: 'YENI', slaDeadline: h(2) }),
  teklifYok: row(),
  teklifSatista: row({ offers: [{ status: 'HAZIRLANIYOR' }] }),
  yonetimde: row({ offers: [{ status: 'YONETIMDE' }] }),
  cizim: row({ drawingTrack: 'YAPILIYOR', offers: [{ status: 'GONDERILDI', sentAt: h(-5) }] }),
  musteride: row({ drawingTrack: 'ONAY_BEKLIYOR', offers: [{ status: 'GONDERILDI', sentAt: h(-5) }] }),
  uretim: row({ status: 'URETIMDE', offers: [{ status: 'GONDERILDI', sentAt: h(-5) }] }),
  beklemede: row({ status: 'YENI', onHold: true, slaDeadline: h(-3) }),
  profil: row({ orderTypeCode: 'PROFILE_ORDER', status: 'YENI', slaDeadline: h(-10) }),
};
const all = Object.values(rows);

test('kuyruk: satış — yeni, teklif hazırlanacak, müşteri onayında, üretimde, SLA, beklemede', () => {
  const q = queuesFor(all, { review: true, send: false, drawing: false }, NOW);
  assert.deepEqual(keys(q), ['newOrders', 'offersToPrepare', 'atCustomer', 'production', 'sla', 'held']);
  assert.deepEqual(ids(q, 'newOrders'), [rows.yeni.id]);
  assert.deepEqual(ids(q, 'offersToPrepare'), [rows.teklifYok.id, rows.teklifSatista.id]);
  assert.deepEqual(ids(q, 'atCustomer'), [rows.musteride.id]);
  assert.deepEqual(ids(q, 'production'), [rows.uretim.id]);
  assert.deepEqual(ids(q, 'sla'), [rows.yeni.id], 'beklemedeki ve profil siparişi SLA listesinde yok');
  assert.deepEqual(ids(q, 'held'), [rows.beklemede.id]);
});

test('kuyruk: yönetici — fiyat onayı bekleyenler', () => {
  const q = queuesFor(all, { review: true, send: true, drawing: true }, NOW);
  assert.deepEqual(ids(q, 'priceApproval'), [rows.yonetimde.id]);
  assert.equal(ids(q, 'drawingJobs'), null, 'satış kararı veren rol çizim işleri kuyruğunu görmez');
});

test('kuyruk: çizim ekibi — çizim işleri ve müşteri onayındakiler; teklif kuyrukları yok', () => {
  const q = queuesFor(all, { review: false, send: false, drawing: true }, NOW);
  assert.deepEqual(keys(q), ['drawingJobs', 'atCustomer', 'approvedDrawings', 'sla', 'held'], 'kullanıcı kimliği verilmezse "Benim çizimlerim" yok');
  assert.deepEqual(ids(q, 'drawingJobs'), [rows.cizim.id]);
});

test('kuyruk: profil siparişi hiçbir satış/çizim kuyruğuna düşmez', () => {
  for (const can of [{ review: true, send: true, drawing: true }, { review: true, send: false, drawing: false }, { review: false, send: false, drawing: true }]) {
    const q = queuesFor([rows.profil, { ...rows.profil, status: 'HAZIRLANIYOR', drawingTrack: 'GEREKLI' }, { ...rows.profil, onHold: true }], can, NOW);
    assert.ok(q.every((x) => x.rows.length === 0), JSON.stringify(can));
  }
});

test('kuyruk: çizimci — başkasına atanmış iş "Çizilecekler"de görünmez; bana atanmışlar "Benim çizimlerim"de', () => {
  const mine = row({ drawingTrack: 'GEREKLI', assignedDrawerId: 'ben' });
  const other = row({ drawingTrack: 'YAPILIYOR', assignedDrawerId: 'baska' });
  const open = row({ drawingTrack: 'GEREKLI', assignedDrawerId: null });
  const waiting = row({ drawingTrack: 'ONAY_BEKLIYOR', assignedDrawerId: 'ben' });
  const q = queuesFor([mine, other, open, waiting], { review: false, send: false, drawing: true, userId: 'ben' }, NOW);
  assert.deepEqual(keys(q), ['drawingJobs', 'atCustomer', 'myDrawings', 'approvedDrawings', 'sla']);
  assert.deepEqual(ids(q, 'drawingJobs').sort(), [mine.id, open.id].sort());
  assert.deepEqual(ids(q, 'myDrawings').sort(), [mine.id, waiting.id].sort());
});

test('kuyruk: süresi geçenler en üstte, sonra son tarihi en yakın olan; SLA\'sızlar sonda', () => {
  const later = row({ drawingTrack: 'GEREKLI', slaDeadline: h(30) });
  const late = row({ drawingTrack: 'GEREKLI', slaDeadline: h(-2) });
  const none = row({ drawingTrack: 'GEREKLI', slaDeadline: null });
  const soon = row({ drawingTrack: 'GEREKLI', slaDeadline: h(1) });
  const lateMore = row({ drawingTrack: 'GEREKLI', slaDeadline: h(-20) });
  const q = queuesFor([later, late, none, soon, lateMore], { review: false, send: false, drawing: true, userId: 'x' }, NOW);
  assert.deepEqual(ids(q, 'drawingJobs'), [lateMore.id, late.id, soon.id, later.id, none.id]);
});

test('kuyruk: çizimci — müşterinin onayladığı çizimler ayrı bölümde (hazırlanırken ve üretimde); satış bu bölümü görmez', () => {
  const approved = row({ drawingTrack: 'ONAYLANDI' });
  const inProduction = row({ drawingTrack: 'ONAYLANDI', status: 'URETIMDE' });
  const held = row({ drawingTrack: 'ONAYLANDI', onHold: true });
  const pending = row({ drawingTrack: 'ONAY_BEKLIYOR' });
  const q = queuesFor([approved, inProduction, held, pending], { review: false, send: false, drawing: true, userId: 'ben' }, NOW);
  assert.deepEqual(ids(q, 'approvedDrawings').sort(), [approved.id, inProduction.id].sort());
  assert.deepEqual(ids(q, 'atCustomer'), [pending.id]);
  assert.equal(ids(queuesFor([approved], { review: true, send: false, drawing: false }, NOW), 'approvedDrawings'), null);
});
