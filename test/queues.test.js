// "Sıra bende" kuyrukları: rol yetkisine göre bölümler; profil siparişleri satış/çizim kuyruklarına düşmez (Aşama 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SALES_QUEUES, approvedDrawingList, dwgDrawingGroups, queuesFor, salesOfferGroups } from '../server/orders/queues.js';

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

test('kuyruk: satış (karar 155) — "Sıra bende"de yalnızca yeni siparişler ve SLA riski / gecikenler', () => {
  const q = queuesFor(all, { review: true, send: false, drawing: false }, NOW);
  assert.deepEqual(keys(q), ['newOrders', 'sla']);
  assert.deepEqual(keys(q), SALES_QUEUES);
  assert.deepEqual(ids(q, 'newOrders'), [rows.yeni.id]);
  assert.deepEqual(ids(q, 'sla'), [rows.yeni.id], 'beklemedeki ve profil siparişi SLA listesinde yok');
  // Onaylanmış çizimler, teklif hazırlanacaklar, müşteri onayındakiler, üretimdekiler ve beklemedekiler satışın bu
  // bölümünde yok (siparişler "Tüm aktif siparişler" sekmesinde durur; teklif işleri Teklifler sayfasında)
  const approved = row({ drawingTrack: 'ONAYLANDI' });
  const s = queuesFor([...all, approved], { review: true, send: false, drawing: false, userId: 'satis' }, NOW);
  for (const k of ['approvedDrawings', 'offersToPrepare', 'atCustomer', 'production', 'held', 'priceApproval', 'drawingJobs']) assert.equal(ids(s, k), null, k);
  // Yönetici ve çizim ekibinin bölümleri değişmedi
  assert.deepEqual(keys(queuesFor(all, { review: true, send: true, drawing: true }, NOW)).slice(0, 7),
    ['newOrders', 'offersToPrepare', 'priceApproval', 'offerCheck', 'atCustomer', 'approvedDrawings', 'production']);
});

test('teklifler, satış (karar 155): yalnızca "Fiyatımı bekleyenler" ve "Teklif tablosu açılmamış siparişler"', () => {
  const undone = row({ status: 'YENI', offers: [{ status: 'HAZIRLANIYOR' }] }); // karar geri alındı: taslak duruyor, tablo açık değil
  const closed = ['YUKLENDI', 'ARSIVLENDI', 'IPTAL'].map((status) => row({ status, offers: [{ status: 'HAZIRLANIYOR' }] }));
  const g = salesOfferGroups([...all, undone, ...closed]);
  assert.deepEqual(keys(g), ['awaitingPrice', 'notOpened']);
  assert.deepEqual(ids(g, 'awaitingPrice'), [rows.teklifSatista.id], 'yalnızca teklifi satışta olan (tablosu açık) sipariş');
  assert.deepEqual(ids(g, 'notOpened'), [rows.yeni.id, rows.teklifYok.id, rows.beklemede.id, undone.id], 'karar bekleyen ve teklifsiz siparişler');
  // Yönetici onayındaki ve müşterideki teklifler, profil siparişleri ve kapanmış siparişler iki listede de yok
  const listed = new Set(g.flatMap((x) => x.rows.map((r) => r.id)));
  for (const r of [rows.yonetimde, rows.cizim, rows.musteride, rows.uretim, rows.profil, ...closed]) assert.equal(listed.has(r.id), false, r.id);
  // Bir sipariş iki listede birden görünmez
  assert.equal(listed.size, g.reduce((n, x) => n + x.rows.length, 0));
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

test('kuyruk: yöneticinin Çizim Paneli — çizim ekibinin kuyrukları, ekibin tamamı için; kişiye özel bölüm ve teklif / fiyat kuyrukları yok', () => {
  const mine = row({ drawingTrack: 'GEREKLI', assignedDrawerId: 'cizimci-1' });
  const other = row({ drawingTrack: 'YAPILIYOR', assignedDrawerId: 'cizimci-2' });
  const open = row({ drawingTrack: 'REVIZYON_ISTENDI', assignedDrawerId: null });
  const waiting = row({ drawingTrack: 'ONAY_BEKLIYOR', assignedDrawerId: 'cizimci-1' });
  const approved = row({ status: 'URETIMDE', drawingTrack: 'ONAYLANDI', assignedDrawerId: 'cizimci-2' });
  const pricing = row({ drawingTrack: 'GEREKLI', assignedDrawerId: 'cizimci-1', offers: [{ status: 'YONETIMDE' }] });
  const list = [mine, other, open, waiting, approved, pricing, rows.profil];
  const q = queuesFor(list, { review: false, send: false, drawing: true, allDrawers: true }, NOW);
  // Çizim ekibinin gördüğü bölümlerle aynı; "Benim çizimlerim" (kişiye özel), fiyat onayı, profil ve satış kuyrukları yok
  assert.deepEqual(keys(q), ['drawingJobs', 'atCustomer', 'approvedDrawings', 'sla']);
  assert.deepEqual(ids(q, 'drawingJobs').sort(), [mine.id, other.id, open.id, pricing.id].sort(), 'kime atanmış olursa olsun');
  assert.deepEqual(ids(q, 'atCustomer'), [waiting.id]);
  assert.deepEqual(ids(q, 'approvedDrawings'), [approved.id]);
  // Aynı veride bir çizimci yalnızca kendisine atanmış ya da açıktaki işleri görür (davranışı değişmedi)
  const d = queuesFor(list, { review: false, send: false, drawing: true, userId: 'cizimci-1' }, NOW);
  assert.deepEqual(keys(d), ['drawingJobs', 'atCustomer', 'myDrawings', 'approvedDrawings', 'sla']);
  assert.deepEqual(ids(d, 'drawingJobs').sort(), [mine.id, open.id, pricing.id].sort());
  // Yöneticinin kendi "Sıra bende" sayfası değişmedi: çizim işleri kuyruğu yok, fiyat onayı var
  const a = queuesFor(list, { review: true, send: true, drawing: true, userId: 'yonetici' }, NOW);
  assert.equal(ids(a, 'drawingJobs'), null);
  assert.deepEqual(ids(a, 'priceApproval'), [pricing.id]);
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

test('kuyruk: müşterinin onayladığı çizimler ayrı bölümde (hazırlanırken ve üretimde) — çizim ekibi ve yönetici görür; satışın "Sıra bende"sinde yok', () => {
  const approved = row({ drawingTrack: 'ONAYLANDI' });
  const inProduction = row({ drawingTrack: 'ONAYLANDI', status: 'URETIMDE' });
  const held = row({ drawingTrack: 'ONAYLANDI', onHold: true });
  const pending = row({ drawingTrack: 'ONAY_BEKLIYOR' });
  const q = queuesFor([approved, inProduction, held, pending], { review: false, send: false, drawing: true, userId: 'ben' }, NOW);
  assert.deepEqual(ids(q, 'approvedDrawings').sort(), [approved.id, inProduction.id].sort());
  assert.deepEqual(ids(q, 'atCustomer'), [pending.id]);
  // Yönetici de görür (karar 84); satışın "Sıra bende"sinde bu bölüm yok (karar 155); profil siparişi bu listeye de
  // girmez; yetkisiz (denetimci) görmez
  assert.equal(ids(queuesFor([approved, held], { review: true, send: false, drawing: false }, NOW), 'approvedDrawings'), null);
  assert.deepEqual(ids(queuesFor([approved], { review: true, send: true, drawing: true }, NOW), 'approvedDrawings'), [approved.id]);
  assert.deepEqual(ids(queuesFor([{ ...approved, orderTypeCode: 'PROFILE_ORDER' }], { review: true, send: true, drawing: true }, NOW), 'approvedDrawings'), []);
  assert.equal(ids(queuesFor([approved], { review: false, send: false, drawing: false }, NOW), 'approvedDrawings'), null);
});

test('onaylanmış çizimler listesi: yükleme gününe göre süzme; gün içinde en yeni / en eski onay; geçersiz gün yok sayılır', () => {
  const dayOf = (d) => (d ? d.toISOString().slice(0, 10) : '');
  const at = (day, hour) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00Z`);
  const a = { id: 'a', estimatedShipDate: at('2026-10-09', 12), drawingSince: at('2026-10-01', 9) };
  const b = { id: 'b', estimatedShipDate: at('2026-10-09', 12), drawingSince: at('2026-10-02', 9) };
  const c = { id: 'c', estimatedShipDate: at('2026-10-16', 12), drawingSince: at('2026-09-30', 9) };
  const d = { id: 'd', estimatedShipDate: null, drawingSince: at('2026-10-03', 9) };
  const list = (o) => approvedDrawingList([a, b, c, d], { dayOf, ...o });
  assert.deepEqual(list({}).rows.map((x) => x.id), ['b', 'a', 'c', 'd'], 'yükleme günü sırası; gün içinde en yeni onay üstte; günü olmayan sonda');
  assert.deepEqual(list({ oldest: true }).rows.map((x) => x.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(list({}).days, ['2026-10-09', '2026-10-16']);
  assert.deepEqual(list({ day: '2026-10-09', oldest: true }).rows.map((x) => x.id), ['a', 'b']);
  assert.deepEqual(list({ day: '2026-10-16' }).rows.map((x) => x.id), ['c']);
  assert.deepEqual(list({ day: '2026-11-01' }).rows, []);
  assert.equal(list({ day: "x' OR 1=1" }).day, null);
  assert.equal(list({ day: 'x' }).rows.length, 4, 'geçersiz gün: süzgeç uygulanmaz');
});

test('DXF/DWG olarak gelen çizimler (karar 167): karar bekleyenler ve müşterinin düzeltmesi beklenenler — yalnızca cam, SLA sırasıyla', () => {
  const dwg = { name: 'plan.dwg', kind: 'CUSTOMER', scanStatus: 'CLEAN' };
  const first = row({ drawingTrack: 'GEREKLI', files: [dwg], slaDeadline: h(10), _count: { drawings: 0 } });
  const late = row({ drawingTrack: 'YAPILIYOR', files: [dwg], slaDeadline: h(-1), _count: { drawings: 0 } });
  const resent = row({
    drawingTrack: 'GEREKLI', files: [], slaDeadline: h(5), _count: { drawings: 2 },
    drawings: [{ id: 'd1', version: 1, source: 'MUSTERI_DXF_DWG', status: 'REVIZYON_ISTENDI' }, { id: 'd2', version: 2, source: 'MUSTERI_DXF_DWG', status: 'BEKLIYOR', sourceFiles: [{ id: 'f2', name: 'v2.dxf' }] }],
  });
  const decided = row({ drawingTrack: 'ONAYLANDI', files: [dwg], _count: { drawings: 1 }, drawings: [{ id: 'd3', version: 1, source: 'MUSTERI_DXF_DWG', status: 'ONAYLANDI' }] });
  const draft = row({ drawingTrack: 'YAPILIYOR', files: [dwg], _count: { drawings: 1 } }); // fabrika taslağı var (listede görünmez)
  const pdfOnly = row({ drawingTrack: 'GEREKLI', files: [{ name: 'plan.pdf', kind: 'CUSTOMER' }], _count: { drawings: 0 } });
  const held = row({ drawingTrack: 'GEREKLI', files: [dwg], onHold: true, _count: { drawings: 0 } });
  const fix = row({ drawingTrack: 'DUZELTME_BEKLIYOR', files: [dwg], slaDeadline: null, _count: { drawings: 1 } });
  const profile = row({ orderTypeCode: 'PROFILE_ORDER', drawingTrack: 'GEREKLI', files: [dwg], _count: { drawings: 0 } });
  const g = dwgDrawingGroups([first, late, resent, decided, draft, pdfOnly, held, fix, profile], NOW);
  assert.deepEqual(keys(g), ['pending', 'correction']);
  assert.deepEqual(ids(g, 'pending'), [late.id, resent.id, first.id], 'geciken üstte; sonra son tarihi en yakın');
  assert.deepEqual(ids(g, 'correction'), [fix.id]);
});

test('teklif kontrolü: müşterinin DWG/DXF karar kaydı ilk çizimi "ikinci" yapmaz; üretime hazır kabul edilen müşteri çizimi üretim çizimi sayılır', () => {
  const sent = { status: 'GONDERILDI', sentAt: h(-10) };
  const rec = (version, status, at) => ({ id: `r${version}`, version, source: 'MUSTERI_DXF_DWG', status, createdAt: h(at - 1), decidedAt: h(at) });
  const fac = (version, status, at) => ({ id: `f${version}`, version, source: 'FABRIKA', status, createdAt: h(at - 1), sentAt: h(at) });
  const check = (drawings) => queuesFor([row({ drawingTrack: 'ONAY_BEKLIYOR', offers: [sent], drawings })], { review: true, send: true, drawing: true }, NOW)
    .find((q) => q.key === 'offerCheck').rows.length;
  // "Çizimi Güncelle" sonrası ilk fabrika çizimi (v2) teklif gönderildikten sonra geldi: yine İLK çizim → kontrol yok
  assert.equal(check([rec(1, 'YAPILIYOR', -20), fac(2, 'ONAY_BEKLIYOR', -1)]), 0);
  // Fabrika revizyonu (ikinci fabrika çizimi): kontrol (eski davranış)
  assert.equal(check([rec(1, 'YAPILIYOR', -20), fac(2, 'REVIZYON_ISTENDI', -15), fac(3, 'ONAY_BEKLIYOR', -1)]), 1);
  assert.equal(check([fac(1, 'REVIZYON_ISTENDI', -15), fac(2, 'ONAY_BEKLIYOR', -1)]), 1);
  // Üretime hazır kabul edilen müşteri çiziminden sonraki fabrika revizyonu: ikinci üretim çizimi → kontrol
  assert.equal(check([rec(1, 'ONAYLANDI', -20), fac(2, 'ONAY_BEKLIYOR', -1)]), 1);
  // Karar bekleyen düzeltilmiş müşteri dosyası çizim değildir
  assert.equal(check([rec(1, 'REVIZYON_ISTENDI', -20), rec(2, 'BEKLIYOR', -1)]), 0);
});
