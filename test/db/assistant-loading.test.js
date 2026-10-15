// TAKİP Telegram asistanı 3.85.0 (karar 280) — gerçek PostgreSQL ile: sipariş numarası arama (ALE40 / "ale 40" / bulunamadı /
// kaldırılmış / benzerler / veri eksik), camlar ve metraj (3 ondalık, TAKİP kuralı), yükleme miktarları (yüklenen / planlanan
// / planlanmamış kalan — kısmi yükleme + aktarım, ticari ve bedelsiz telafi ayrı), yükleme günü (onaylı / planlanan) ve
// sandıklar (her sandık bir kez, misafir yük işaretli). Yükleme verisi GERÇEK servislerle kurulur (previewLoading,
// confirmLoading, replanNotLoaded); araçlar READ ONLY işlemde çalışır ve hiçbir tabloyu değiştirmez. Ağ isteği yok.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const { readOnly } = await import('../../server/assistant/readonly.js');
const { runTool } = await import('../../server/assistant/tools.js');
const c = await import('../../server/loading/confirmation.js');
const rp = await import('../../server/loading/replan.js');

const NOW = new Date('2026-10-15T09:00:00Z');
const CTX = { tz: 'Europe/Bucharest', now: NOW };
const DAY = '2026-10-10';
const FUTURE = '2026-10-20';
const at = (day) => new Date(`${day}T12:00:00Z`);
const act = (u) => ({ id: u.id, role: u.appRole, ip: '127.0.0.1', customerId: u.customerId });
let db, admin, ale, gla, o40, oGla, ro;

const MODELS = ['order', 'offer', 'offerLine', 'loadingConfirmation', 'loadingConfirmationItem', 'loadingReplan', 'crate', 'crateOrder', 'auditLog', 'notificationOutbox'];
const snapshot = async () => JSON.stringify(await Promise.all(MODELS.map((m) => db[m].count())));
const run = (name, args) => runTool(ro, name, JSON.stringify(args), CTX);

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  ro = readOnly(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  ale = await db.customer.create({ data: { name: 'ALEGRAD SRL', prefix: 'ALE' } });
  gla = await db.customer.create({ data: { name: 'Glass and More SRL', prefix: 'GLA' } });
  admin = await db.user.create({ data: { email: 'admin@asistan2.test', name: 'Admin', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
  // ALE40: 10 cam (kayıtlı parça m² 1,234321 → 12,343 m²) + 2 CNC + bedelsiz telafi 2 cam (0,60 m²) + yöneticinin sandık bedeli
  o40 = await db.order.create({
    data: {
      orderNo: 'ALE40', customerOrderNo: '40', title: 'Balkon', orderTypeCode: 'GLASS_ORDER', customerId: ale.id, createdById: admin.id, status: 'URETIMDE', estimatedShipDate: at(DAY),
      items: { create: [{ glassName: 'Temper 8 mm — Şeffaf', camAdedi: 0 }] },
      offers: {
        create: {
          status: 'GONDERILDI', currency: 'EUR', amount: '400', offerAmount: '900', createdById: admin.id, sentAt: new Date('2026-10-01T09:00:00Z'),
          lines: {
            create: [
              { sortOrder: 0, description: 'Temper 8 mm', enMm: 1111, boyMm: 1111, adet: 10, unit: 'm2', kind: 'CAM', unitPrice: '30', offerPrice: '60', pieceM2: '1.234321' },
              { sortOrder: 1, description: 'CNC kesim', adet: 2, unit: 'adet', kind: 'CNC', unitPrice: '5', offerPrice: '9' },
              { sortOrder: 2, description: 'Temper 8 mm', enMm: 500, boyMm: 600, adet: 2, unit: 'm2', kind: 'CAM', unitPrice: '30', offerPrice: '0', free: true },
              { sortOrder: 3, description: 'Sandık parası', adet: 1, unit: 'adet', kind: 'CAM', unitPrice: '0', offerPrice: '40', crateFee: true },
            ],
          },
        },
      },
    },
    include: { offers: { include: { lines: { orderBy: { sortOrder: 'asc' } } } } },
  });
  // GLA68: teklif tablosu açılmamış (satırsız taslak) — veri eksik
  oGla = await db.order.create({ data: { orderNo: 'GLA68', customerOrderNo: '68', customerId: gla.id, createdById: admin.id, status: 'HAZIRLANIYOR', estimatedShipDate: at('2026-10-25'), offers: { create: { status: 'HAZIRLANIYOR', currency: 'EUR', createdById: admin.id } } } });
  // Kaldırılmış sipariş
  await db.order.create({ data: { orderNo: 'ALE55', customerOrderNo: '55', customerId: ale.id, createdById: admin.id, status: 'IPTAL', removedAt: NOW, removedStatus: 'YENI', numberActive: null } });

  // 10.10: yükleme onayı — ALE40'ın 4 camı yüklenmedi (kırık); 3'ü 20.10'a aktarıldı, 1'i planlanmadı
  const line = o40.offers[0].lines[0];
  const preview = await c.previewLoading(db, DAY);
  const r = await c.confirmLoading(db, { day: DAY, key: preview.key, notLoaded: [{ key: `l:${line.id}`, quantity: 4, reason: 'BROKEN' }], actor: act(admin), now: NOW });
  assert.equal(r.ok, true, r.code);
  const rest = await db.loadingConfirmationItem.findFirstOrThrow({ where: { orderId: o40.id, status: 'NOT_LOADED' } });
  const rr = await rp.replanNotLoaded(db, { itemId: rest.id, day: FUTURE, quantity: 3, actor: act(admin), now: NOW });
  assert.equal(rr.ok, true, rr.code);

  // Sandıklar (10.10): ALE'nin #5'i ALE40 + GLA68 (misafir yük), #6'sı ALE40; ikisi de ALE40'a bağlı — her biri bir kez sayılmalı
  const c5 = await db.crate.create({ data: { shipDay: new Date(`${DAY}T00:00:00Z`), customerId: ale.id, crateNo: 5, lengthMm: 2400, widthMm: 400, heightMm: 1500, netAgirlik: '500' } });
  const c6 = await db.crate.create({ data: { shipDay: new Date(`${DAY}T00:00:00Z`), customerId: ale.id, crateNo: 6 } });
  await db.crateOrder.createMany({ data: [{ crateId: c5.id, orderId: o40.id }, { crateId: c5.id, orderId: oGla.id }, { crateId: c6.id, orderId: o40.id }] });
});
after(async () => { await closeDb(); });

dbTest('asistan 3.85: sipariş numarası — ALE40, "ale 40", "ALE-40"; bulunamadı / kaldırılmış / benzer ve veri eksik ayrı', offline(async () => {
  for (const q of ['ALE40', 'ale 40', 'ALE-40', 'ale40']) assert.equal((await run('siparis_detay', { siparis_no: q })).no, 'ALE40', q);
  assert.deepEqual(await run('siparis_detay', { siparis_no: 'ALE41' }), { bulunamadi: 'ALE41' });
  assert.deepEqual(await run('siparis_detay', { siparis_no: 'ale55' }), { bulunamadi: 'ALE55', kaldirilmis: true });
  assert.deepEqual(await run('siparis_camlari', { siparis_no: 'LA68' }), { bulunamadi: 'LA68', benzerler: ['GLA68'] });
  const missing = await run('siparis_camlari', { siparis_no: 'GLA68' });
  assert.equal(missing.no, 'GLA68');
  assert.deepEqual(missing.veriEksik, ['TEKLIF_TABLOSU_YOK']);
  assert.equal((await run('siparis_ara', { metin: 'ale 40' })).siparisler[0].no, 'ALE40');
}));

dbTest('asistan 3.85: camlar — tür, ölçü, adet, satır ve toplam m² (3 ondalık); bedelsiz telafi ayrı; sandık bedeli cam değil', offline(async () => {
  const r = await run('siparis_camlari', { siparis_no: 'ALE40' });
  assert.equal(r.teklifGonderildi, true);
  assert.deepEqual(r.istenenCamlar, ['Temper 8 mm — Şeffaf']);
  assert.deepEqual(r.satirlar.map((l) => [l.sira ?? null, l.tur, l.en ?? null, l.boy ?? null, l.adet, l.m2 ?? null, !!l.bedelsizTelafi]), [
    [1, 'CAM', 1111, 1111, 10, 12.343, false],
    [null, 'CNC', null, null, 2, null, false],
    [2, 'CAM', 500, 600, 2, 0.6, true],
    [3, 'SANDIK', null, null, 1, null, false],
  ]);
  assert.deepEqual(r.camToplami, { ticari: { adet: 10, m2: 12.343 }, bedelsizTelafi: { adet: 2, m2: 0.6 }, toplam: { adet: 12, m2: 12.943 } });
  assert.deepEqual(r.islemler, { cnc: 2, delik: 0 });
}));

dbTest('asistan 3.85: yükleme durumu — yüklenen / planlanan (aktarım) / planlanmamış kalan; toplamları siparişe eşit', offline(async () => {
  const r = await run('yukleme_durumu', { siparis_no: 'ALE40' });
  assert.deepEqual(r.siparisToplami.ticari, { adet: 10, m2: 12.343 });
  assert.deepEqual(r.yuklenen.ticari, { adet: 6, m2: 7.406 });
  assert.deepEqual(r.yuklenen.bedelsizTelafi, { adet: 2, m2: 0.6 });
  assert.deepEqual(r.yuklenen.gunler.map((g) => g.gun), [DAY]);
  assert.deepEqual(r.planlanan.ticari, { adet: 3, m2: 3.703 });
  assert.deepEqual(r.planlanan.gunler.map((g) => g.gun), [FUTURE]);
  assert.deepEqual(r.kalanPlansiz.ticari, { adet: 1, m2: 1.234 });
  assert.deepEqual(r.kalanPlansiz.bedelsizTelafi, { adet: 0, m2: 0 });
  // Bölümler siparişin ticari toplamını paylaşır (iki kez sayılmaz)
  const sum = Math.round((r.yuklenen.ticari.m2 + r.planlanan.ticari.m2 + r.kalanPlansiz.ticari.m2) * 1000) / 1000;
  assert.equal(sum, r.siparisToplami.ticari.m2);
  assert.equal(r.yuklenen.ticari.adet + r.planlanan.ticari.adet + r.kalanPlansiz.ticari.adet, 10);
  assert.deepEqual(r.yuklenmeyenKayitlari, [{ gun: DAY, adet: 4, neden: 'BROKEN' }]);
  // Teklif tablosu olmayan sipariş: veri eksik (bulunamadı değil)
  assert.deepEqual((await run('yukleme_durumu', { siparis_no: 'GLA68' })).veriEksik, ['TEKLIF_TABLOSU_YOK']);
}));

dbTest('asistan 3.85: yükleme günü — onaylı gün fiilen yüklenen, onaylanmamış gün planlanan (yalnızca aktarılan adet)', offline(async () => {
  const done = await run('yukleme_gunu', { gun: DAY });
  assert.equal(done.durum, 'ONAYLANDI');
  assert.deepEqual(done.toplam, { ticari: { adet: 6, m2: 7.406 }, bedelsizTelafi: { adet: 2, m2: 0.6 }, toplam: { adet: 8, m2: 8.006 } });
  const row = done.firmalar.find((f) => f.firma === 'ALEGRAD SRL').siparisler[0];
  assert.equal(row.no, 'ALE40');
  assert.deepEqual(row.yuklenmeyen, { adet: 4, m2: 4.937 });
  assert.equal(done.sandik.sayi, 2);
  const plan = await run('yukleme_gunu', { gun: FUTURE });
  assert.equal(plan.durum, 'PLANLANDI');
  assert.deepEqual(plan.toplam.ticari, { adet: 3, m2: 3.703 });
  assert.deepEqual(plan.firmalar[0].siparisler[0].aktarilanKalan, [DAY]);
  assert.equal(plan.sandik.sayi, 0);
}));

dbTest('asistan 3.85: sandıklar — her sandık bir kez, içerik ve misafir yük; gün / firma süzgeci; sandık yoksa veri eksik', offline(async () => {
  const s0 = await snapshot();
  const byOrder = await run('sandiklar', { siparis_no: 'ALE40' });
  assert.equal(byOrder.sandikSayisi, 2);
  assert.deepEqual(byOrder.sandiklar.map((x) => x.sandikNo), [5, 6]);
  const c5 = byOrder.sandiklar[0];
  assert.equal(c5.sahibiFirma, 'ALEGRAD SRL');
  assert.equal(c5.olcuMm, '2400×400×1500');
  assert.equal(c5.netKg, 500);
  assert.equal(c5.brutKg, 550);
  assert.deepEqual(c5.siparisler.map((x) => [x.no, !!x.misafir]), [['ALE40', false], ['GLA68', true]]);
  assert.equal(byOrder.girilenNetKg, 500);
  assert.equal(byOrder.agirligiGirilmemis, 1);
  assert.equal((await run('sandiklar', { gun: DAY })).sandikSayisi, 2);
  const guest = await run('sandiklar', { gun: DAY, firma: 'GLA' });
  assert.deepEqual(guest.sandiklar.map((x) => x.sandikNo), [5]);
  assert.deepEqual((await run('sandiklar', { gun: '2026-10-11' })).veriEksik, ['SANDIK_GIRILMEMIS']);
  assert.deepEqual(await run('sandiklar', {}), { hata: 'INVALID_ARGS' });
  assert.equal(await snapshot(), s0, 'araçlar yazmadı');
}));
