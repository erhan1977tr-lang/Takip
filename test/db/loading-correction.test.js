// Onaylı yüklemenin düzeltilmesi, kısmi aktarım ve finansal etki saptaması (Aşama 7F-1, karar 105–106) — veritabanıyla.
//   - Onay ve kalemleri DEĞİŞMEZ: düzeltme yeni kayıt (LoadingCorrection) + yeni kalemler (revision) olarak eklenir;
//     geçerli durum effectiveItems() ile okunur.
//   - Kısmi aktarım: kapsamın vazgeçilmemiş aktarımlarının toplamı geçerli yüklenmeyen adedi aşamaz.
//   - Kesilmiş faturada fark: yalnızca saptanır (UNDER_INVOICED / OVER_INVOICED); otomatik belge kesilmez, kapsam yeniden
//     faturalanmaz.
// FGO'ya GERÇEK istek yapılmaz: bütün FGO çağrıları sahte fetchImpl'e gider; BNR de sahtedir.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const { saveFgoSettings } = await import('../../server/integrations/fgo.js');
const { supplierData } = await import('../../server/accounting/supplier.js');
const c = await import('../../server/loading/confirmation.js');
const rp = await import('../../server/loading/replan.js');
const co = await import('../../server/loading/correction.js');
const b = await import('../../server/glass/batch.js');
const inv = await import('../../server/glass/invoice-batch.js');
const un = await import('../../server/accounting/uninvoiced.js');

const SECRET = 'c'.repeat(40);
const TZ = 'Europe/Bucharest';
let db, admin, seq = 700;
const actor = (role = 'ADMIN') => ({ id: admin.id, role, ip: '127.0.0.1' });
const OTHERS = ['SATIS', 'CIZIM', 'MUSTERI', 'DENETIMCI'];
const dayOf = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const at = (key) => new Date(`${key}T12:00:00Z`);
const evening = (key) => new Date(`${key}T16:00:00Z`);
const date = (key) => new Date(`${key}T00:00:00Z`);
const tomorrow = () => date(dayOf(1));

/** Sahte FGO: emitere çağrıları sayılır; belge toplamı gönderilen satırlardan. emit: isteği reddeden yanıt (kesilemeyen fatura). */
function fakeFgo(start, { emit = null } = {}) {
  let n = start;
  const calls = [];
  const state = new Map();
  const fetchImpl = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    if (String(url).endsWith('/factura/getstatus')) {
      const s = state.get(`${form.Serie}${form.Numar}`);
      return new Response(JSON.stringify({ Success: true, Factura: { Valoare: (s?.total ?? 0).toFixed(2), ValoareAchitata: (s?.paid ?? 0).toFixed(2) } }));
    }
    if (emit) return emit(form);
    calls.push(form);
    n += 1;
    let total = 0;
    for (let i = 0; form[`Continut[${i}][Denumire]`] != null; i++) {
      total += form[`Continut[${i}][PretTotal]`] != null ? Number(form[`Continut[${i}][PretTotal]`]) : Math.round(Number(form[`Continut[${i}][NrProduse]`]) * Number(form[`Continut[${i}][PretUnitar]`]) * 121) / 100;
    }
    state.set(`${form.Serie}${n}`, { total: Math.round(total * 100) / 100, paid: 0 });
    return new Response(JSON.stringify({ Success: true, Factura: { Numar: String(n), Serie: form.Serie, Link: `https://fgo.example/${form.Serie}${n}.pdf` } }));
  };
  return { calls, fetchImpl, state };
}
const bnr = (rate) => async () => ({ ok: true, rate, date: dayOf(0), url: 'https://curs.bnr.ro/nbrfxrates.xml' });
const ctx = (fgo, extra = {}) => ({ secret: SECRET, appUrl: 'https://t', timeZone: TZ, fetchImpl: fgo.fetchImpl, sleep: async () => {}, ...extra });

const firm = (name, prefix) => db.customer.create({ data: { name, prefix, email: `${prefix.toLowerCase()}@fix.test`, taxId: '556677', county: 'Cluj', city: 'Cluj-Napoca', address: 'Str. 2', fxPolicy: 'BNR' } });
/** 1 m²'lik cam: maliyet 30, müşteri fiyatı 50 */
const glassLine = (adet, extra = {}) => ({ description: 'Temper', descriptionRo: 'Sticlă securizată', enMm: 1000, boyMm: 1000, adet, unit: 'm2', kind: 'CAM', unitPrice: '30', offerPrice: '50', ...extra });
const cncLine = () => ({ description: 'CNC', adet: 2, unit: 'adet', kind: 'CNC', unitPrice: '5', offerPrice: '10' });
async function glassOrder(f, day, lines) {
  const no = seq++;
  return db.order.create({
    data: {
      orderNo: `${f.prefix}${no}`, customerOrderNo: no, title: `Proje ${no}`, orderTypeCode: 'GLASS_ORDER', customerId: f.id, createdById: admin.id, status: 'URETIMDE', estimatedShipDate: at(day),
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '0', offerAmount: '0', createdById: admin.id, sentAt: new Date(), lines: { create: lines.map((l, i) => ({ sortOrder: i, ...l })) } } },
    },
    include: { offers: { include: { lines: { orderBy: { sortOrder: 'asc' } } } } },
  });
}
const lineKey = (o, i = 0) => `l:${o.offers[0].lines[i].id}`;
const confirm = async (day, notLoaded = [], now = new Date()) => c.confirmLoading(db, { day, key: (await c.previewLoading(db, day)).key, notLoaded, actor: actor(), now });
/** Onay anındaki kalemler (revision 0), olduğu gibi — "değişmedi" denetimi için */
const originalRows = async (day) => JSON.stringify(await db.loadingConfirmationItem.findMany({ where: { confirmation: { shipDay: date(day) }, revision: 0 }, orderBy: [{ orderId: 'asc' }, { sortOrder: 'asc' }, { status: 'asc' }] }));
/** Bir siparişin bir onaydaki GEÇERLİ cam kalemleri: [durum, adet] */
const effective = async (orderId, day) => c.effectiveItems(await db.loadingConfirmationItem.findMany({ where: { orderId, confirmation: { shipDay: date(day) } }, orderBy: [{ sortOrder: 'asc' }, { status: 'asc' }] }))
  .filter((i) => i.kind === 'CAM').map((i) => [i.status, i.quantity, i.revision]);
const plan = (day, input) => co.planCorrection(db, { day, input });
/** Düzeltmeyi önizleyip kaydeder (yöneticinin gördüğü önizlemenin parmak iziyle) */
async function correct(day, input, reason = 'Sayım hatası', now = new Date()) {
  const p = await plan(day, input);
  if (!p.ok) return p;
  return co.correctLoading(db, { day, input, reason, key: p.key, actor: actor(), now });
}
const billing = (day) => inv.loadingBilling(db, { day, bnrImpl: bnr('5.0000') });
const customerOf = async (day, f) => (await billing(day)).customers.find((x) => x.customerId === f.id) ?? null;
async function invoice(day, f, fgo, { dispatch = true } = {}) {
  const grp = (await customerOf(day, f)).groups[0];
  const r = await inv.createInvoiceBatch(db, { day, groupKey: grp.key, previewKey: grp.previewKey, actor: actor(), bnrImpl: bnr('5.0000') });
  assert.equal(r.ok, true);
  if (dispatch) await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: r.batchId }));
  return db.billingBatch.findUnique({ where: { id: r.batchId }, include: { document: true, orders: true, lines: { orderBy: { sortOrder: 'asc' } } } });
}
const dayProfit = async (day) => (await supplierData(db, tomorrow())).days.find((d) => d.day === day);
const impactOf = (p, o) => p.impacts.find((x) => x.orderId === o.id);
const documents = () => db.fgoDocument.count();
const batches = () => db.billingBatch.count();

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  admin = await db.user.create({ data: { email: 'admin@fix.test', name: 'Yönetici', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
  await saveFgoSettings(db, { enabled: true, dailyLimit: 0, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21 }, { key: 'K', secret: SECRET }, actor());
});
after(closeDb);

dbTest('düzeltme: 10 yüklendi → 8 + 2 → 9 + 1 → 7 + 3; onay kaydı aynen durur, sıra artar, neden zorunlu, yalnızca yönetici; kısmi aktarım kapasitesi düzeltmeyi izler', async () => {
  const D1 = dayOf(-20), F1 = dayOf(7), F2 = dayOf(14), F3 = dayOf(21);
  const A = await firm('Fix A SRL', 'FXA');
  const B = await firm('Fix B SRL', 'FXB');
  const o = await glassOrder(A, D1, [glassLine(10), cncLine()]);
  const x = await glassOrder(B, D1, [glassLine(3)]);
  assert.deepEqual(await plan(D1, [{ key: lineKey(o), quantity: 2, reason: 'BROKEN' }]), { ok: false, code: 'NOT_CONFIRMED' });
  const r = await confirm(D1); // "Eksiksiz Yüklendi": 10 + CNC, 3
  assert.deepEqual([r.ok, r.items, r.notLoaded], [true, 3, 0]);
  const original = await originalRows(D1);
  const conf = await db.loadingConfirmation.findUniqueOrThrow({ where: { shipDay: date(D1) } });
  const confRow = JSON.stringify(conf);
  assert.deepEqual(await rp.notLoadedOfDay(db, D1), [], 'düzeltmeden önce yüklenmeyen yok: aktarım kapasitesi yok');

  // --- Giriş sunucuda doğrulanır; hatalı girişte hiçbir şey yazılmaz
  for (const [input, code] of [
    [[{ key: lineKey(o), quantity: 11, reason: 'BROKEN' }], 'BAD_QUANTITY'], // yüklenen + yüklenmeyen = onaylanan adet
    [[{ key: lineKey(o), quantity: -1, reason: 'BROKEN' }], 'BAD_QUANTITY'],
    [[{ key: lineKey(o), quantity: '1.5', reason: 'BROKEN' }], 'BAD_QUANTITY'],
    [[{ key: lineKey(o), quantity: 2, reason: '' }], 'BAD_REASON'],
    [[{ key: lineKey(o), quantity: 2, reason: 'OTHER', note: '  ' }], 'NOTE_REQUIRED'],
    [[{ key: lineKey(o, 1), quantity: 1, reason: 'BROKEN' }], 'BAD_EXCEPTION'], // yalnızca cam satırı
    [[{ key: 'l:yok', quantity: 1, reason: 'BROKEN' }], 'BAD_EXCEPTION'], // onayda olmayan satır eklenemez
    [[{ key: lineKey(o), quantity: 1, reason: 'BROKEN' }, { key: lineKey(o), quantity: 2, reason: 'BROKEN' }], 'BAD_EXCEPTION'],
    [[{ key: lineKey(o), quantity: 0 }], 'NO_CHANGE'],
    [[{ key: lineKey(o), quantity: '' }], 'NO_CHANGE'],
    [[], 'NO_CHANGE'],
  ]) assert.deepEqual(await plan(D1, input), { ok: false, code }, code);
  assert.deepEqual(await plan('2026-13-45', []), { ok: false, code: 'BAD_DAY' });

  // --- Önizleme: önce → sonra, aktarım yok, fatura yok
  const input1 = [{ key: lineKey(o), quantity: 2, reason: 'BROKEN' }];
  const p1 = await plan(D1, input1);
  assert.deepEqual([p1.ok, p1.revision, p1.blocked, p1.closing, p1.conflicts, p1.actionRequired], [true, 1, null, [], [], false]);
  assert.deepEqual(p1.changes.map((ch) => [ch.orderNo, ch.total, ch.before, ch.after]), [[o.orderNo, 10, { loaded: 10, notLoaded: 0, reason: null, note: null }, { loaded: 8, notLoaded: 2, reason: 'BROKEN', note: null }]]);
  assert.deepEqual(p1.impacts.map((i) => [i.orderNo, i.before, i.code]), [[o.orderNo, 'NO_BILLING', 'NO_BILLING']]);
  // Yetki, zorunlu neden, önizleme parmak izi
  for (const role of OTHERS) assert.deepEqual(await co.correctLoading(db, { day: D1, input: input1, reason: 'Sayım hatası', key: p1.key, actor: actor(role) }), { ok: false, code: 'FORBIDDEN' }, role);
  for (const reason of ['', '   ', 'ab', null]) assert.deepEqual(await co.correctLoading(db, { day: D1, input: input1, reason, key: p1.key, actor: actor() }), { ok: false, code: 'REASON_REQUIRED' });
  assert.deepEqual(await co.correctLoading(db, { day: D1, input: input1, reason: 'Sayım hatası', key: 'eski', actor: actor() }), { ok: false, code: 'STALE_PREVIEW' });
  assert.equal(await db.loadingCorrection.count(), 0);
  // Aynı anda iki düzeltme: tek kayıt
  const both = await Promise.all([1, 2].map(() => co.correctLoading(db, { day: D1, input: input1, reason: '2 cam kırık çıktı', key: p1.key, actor: actor() })));
  assert.deepEqual(both.map((y) => y.ok).sort(), [false, true]);
  assert.ok(['STALE_PREVIEW', 'NO_CHANGE'].includes(both.find((y) => !y.ok).code));
  const done1 = both.find((y) => y.ok);
  assert.deepEqual([done1.revision, done1.scopes, done1.closedReplans, done1.actionRequired], [1, 1, 0, false]);

  // --- Kayıt: düzeltme + yeni kalemler EKLENDİ; onay ve ilk kalemler bayt bayt aynı
  const fix1 = await db.loadingCorrection.findFirstOrThrow({ where: { confirmationId: conf.id } });
  assert.deepEqual([fix1.revision, fix1.reason, fix1.createdById], [1, '2 cam kırık çıktı', admin.id]);
  assert.equal(await db.loadingCorrection.count(), 1);
  const added = await db.loadingConfirmationItem.findMany({ where: { correctionId: fix1.id }, orderBy: { status: 'asc' } });
  assert.deepEqual(added.map((i) => [i.revision, i.status, i.quantity, Number(i.m2), i.notLoadedReason, i.scopeKey, Number(i.unitCost), Number(i.unitSale), Number(i.saleAmount)]),
    [[1, 'LOADED', 8, 8, null, lineKey(o), 30, 50, 400], [1, 'NOT_LOADED', 2, 2, 'BROKEN', lineKey(o), 30, 50, 100]]);
  assert.equal(await originalRows(D1), original, 'onay anındaki kalemler değişmedi');
  assert.equal(JSON.stringify(await db.loadingConfirmation.findUniqueOrThrow({ where: { id: conf.id } })), confRow, 'onay kaydı değişmedi');
  assert.deepEqual(await effective(o.id, D1), [['LOADED', 8, 1], ['NOT_LOADED', 2, 1]], 'geçerli durum: en yüksek sıra');
  assert.deepEqual(await effective(x.id, D1), [['LOADED', 3, 0]], 'düzeltilmeyen kapsam onay anındaki kalemiyle');
  // Veritabanı: düzeltme ve kalemler (ilk ve eklenen) güncellenemez / silinemez
  await assert.rejects(db.loadingCorrection.update({ where: { id: fix1.id }, data: { reason: 'başka' } }));
  await assert.rejects(db.loadingCorrection.delete({ where: { id: fix1.id } }));
  await assert.rejects(db.$executeRawUnsafe('TRUNCATE "LoadingCorrection" CASCADE'), /append-only/);
  await assert.rejects(db.loadingConfirmationItem.updateMany({ where: { confirmationId: conf.id }, data: { quantity: 1 } }));
  await assert.rejects(db.loadingConfirmationItem.deleteMany({ where: { correctionId: fix1.id } }));
  await assert.rejects(db.loadingConfirmation.update({ where: { id: conf.id }, data: { note: 'x' } }));
  // Aynı sıra ikinci kez yazılamaz (veritabanı)
  await assert.rejects(db.loadingCorrection.create({ data: { confirmationId: conf.id, revision: 1, reason: 'çift', createdById: admin.id } }), /Unique constraint/);
  // Geçmiş + denetim: onay, sıra, kapsam, önce / sonra, neden, yönetici, zaman
  assert.ok((await db.orderEvent.findMany({ where: { orderId: o.id } })).some((e) => e.event === 'LOADING_CORRECTED'));
  const audit1 = await db.auditLog.findFirstOrThrow({ where: { action: 'LOADING_CORRECTED', entityId: conf.id } });
  assert.deepEqual([audit1.userId, audit1.details.shipDay, audit1.details.revision, audit1.details.reason, audit1.details.correctionId, audit1.details.documentsCreated], [admin.id, D1, 1, '2 cam kırık çıktı', fix1.id, 0]);
  assert.deepEqual(audit1.details.scopes.map((s) => [s.orderNo, s.scope, s.quantity, s.before.loaded, s.before.notLoaded, s.after.loaded, s.after.notLoaded, s.after.reason]), [[o.orderNo, lineKey(o), 10, 10, 0, 8, 2, 'BROKEN']]);
  assert.ok(audit1.details.correctedAt);

  // --- Düzeltme aktarım kapasitesi açar: 2 yüklenmeyen → 1 adet F1, 1 adet F2 (kısmi aktarım); toplam 2'yi aşamaz
  let [row] = await rp.notLoadedOfDay(db, D1);
  assert.deepEqual([row.orderNo, row.planned, row.loaded, row.remaining, row.free, row.replans], [o.orderNo, 10, 8, 2, 2, []]);
  for (const role of OTHERS) assert.deepEqual(await rp.replanNotLoaded(db, { itemId: row.itemId, day: F1, quantity: 1, actor: actor(role) }), { ok: false, code: 'FORBIDDEN' }, role);
  // Düzeltmeyle yerini yenisi alan eski satırdan / yüklenen satırdan aktarım yapılamaz
  const stale = await db.loadingConfirmationItem.findFirstOrThrow({ where: { orderId: o.id, kind: 'CAM', revision: 0 } });
  assert.deepEqual(await rp.replanNotLoaded(db, { itemId: stale.id, day: F1, actor: actor() }), { ok: false, code: 'NOT_ALLOWED' });
  // Aynı anda üç istek, her biri 1 adet, üç ayrı güne: kapasite 2 → tam ikisi olur
  const tries = await Promise.all([F1, F2, F3].map((day) => rp.replanNotLoaded(db, { itemId: row.itemId, day, quantity: 1, actor: actor() })));
  assert.deepEqual(tries.map((y) => y.ok).sort(), [false, true, true]);
  assert.equal(tries.find((y) => !y.ok).code, 'NO_REMAINDER');
  const active = await db.loadingReplan.findMany({ where: { orderId: o.id, status: 'ACTIVE' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  assert.deepEqual(active.map((y) => [y.quantity, Number(y.m2), y.customerId]), [[1, 1, A.id], [1, 1, A.id]]);
  assert.equal(new Set(active.map((y) => y.shipDay.toISOString())).size, 2, 'iki ayrı güne');
  assert.deepEqual(await rp.replanNotLoaded(db, { itemId: row.itemId, day: dayOf(28), quantity: 1, actor: actor() }), { ok: false, code: 'NO_REMAINDER' }, 'toplam 2\'yi aşamaz');
  [row] = await rp.notLoadedOfDay(db, D1);
  assert.deepEqual([row.free, row.replans.map((y) => [y.status, y.quantity])], [0, [['ACTIVE', 1], ['ACTIVE', 1]]]);
  // Her aktarım yeni gününe yalnızca KENDİ adediyle girer
  const [keep, drop] = active;
  const keepDay = keep.shipDay.toISOString().slice(0, 10), dropDay = drop.shipDay.toISOString().slice(0, 10);
  for (const [rpl, day] of [[keep, keepDay], [drop, dropDay]]) {
    assert.deepEqual((await c.previewLoading(db, day)).items.map((i) => [c.itemKey(i), i.quantity, i.m2, i.unitSale]), [[`r:${rpl.id}`, 1, 1, 50]]);
  }
  // Başka güne alma: adet aynı kalır; kapasite aşılmaz (aynı kapsamın öbür aktarımının gününe alınamaz)
  assert.deepEqual(await rp.replanNotLoaded(db, { itemId: row.itemId, day: keepDay, replaceId: drop.id, actor: actor() }), { ok: false, code: 'ALREADY_PLANNED' });
  assert.deepEqual(await rp.replanNotLoaded(db, { itemId: row.itemId, day: dayOf(28), replaceId: drop.id, quantity: 2, actor: actor() }), { ok: false, code: 'BAD_QUANTITY' });

  // --- 2. düzeltme: 8 + 2 → 9 + 1. Yüklenmeyen adet azaldı: sığmayan (sonradan açılan) etkin aktarım AYNI işlemde kapanır
  const input2 = [{ key: lineKey(o), quantity: 1, reason: 'BROKEN' }];
  const p2 = await plan(D1, input2);
  assert.deepEqual([p2.revision, p2.blocked, p2.closing.map((y) => [y.id, y.quantity, y.day])], [2, null, [[drop.id, 1, dropDay]]]);
  const done2 = await co.correctLoading(db, { day: D1, input: input2, reason: 'Kırık sayısı 1', key: p2.key, actor: actor() });
  assert.deepEqual([done2.ok, done2.revision, done2.closedReplans], [true, 2, 1]);
  const fix2 = await db.loadingCorrection.findFirstOrThrow({ where: { confirmationId: conf.id, revision: 2 } });
  const [kept, closed] = await Promise.all([keep, drop].map((y) => db.loadingReplan.findUniqueOrThrow({ where: { id: y.id } })));
  assert.deepEqual([kept.status, kept.closedReason], ['ACTIVE', null]);
  assert.deepEqual([closed.status, closed.closedReason, closed.correctionId, closed.activeKey], ['CANCELLED', 'CORRECTION', fix2.id, null]);
  assert.equal((await c.previewLoading(db, dropDay)).items.length, 0, 'kapanan aktarım yeni günde yok');
  assert.deepEqual(await effective(o.id, D1), [['LOADED', 9, 2], ['NOT_LOADED', 1, 2]]);
  [row] = await rp.notLoadedOfDay(db, D1);
  assert.deepEqual([row.planned, row.loaded, row.remaining, row.free, row.replans.map((y) => y.id)], [10, 9, 1, 0, [keep.id]]);

  // --- Kalan aktarım ileri günde onaylandı (1 adet yüklendi): artık altına inen düzeltme REDDEDİLİR
  assert.equal((await confirm(keepDay, [], evening(keepDay))).ok, true);
  const p3 = await plan(D1, [{ key: lineKey(o), quantity: 0 }]);
  assert.deepEqual([p3.ok, p3.blocked, p3.conflicts.map((y) => [y.orderNo, y.confirmed, y.days])], [true, 'DOWNSTREAM_CONFLICT', [[o.orderNo, 1, [keepDay]]]]);
  assert.deepEqual(await co.correctLoading(db, { day: D1, input: [{ key: lineKey(o), quantity: 0 }], reason: 'Hepsi yüklenmişti', key: p3.key, actor: actor() }), { ok: false, code: 'DOWNSTREAM_CONFLICT' });
  assert.equal(await db.loadingCorrection.count({ where: { confirmationId: conf.id } }), 2, 'reddedilen düzeltme hiçbir şey yazmadı');
  // Yüklenmeyen adedi artıran düzeltme yapılabilir (3. sıra): onaylanmış aktarım (1) içinde kalır, 2 adet yeni kapasite
  const done3 = await correct(D1, [{ key: lineKey(o), quantity: 3, reason: 'MISSING' }], 'Eksik cam sayımı');
  assert.deepEqual([done3.ok, done3.revision], [true, 3]);
  [row] = await rp.notLoadedOfDay(db, D1);
  assert.deepEqual([row.loaded, row.remaining, row.free, row.reason, row.replans.map((y) => [y.status, y.quantity, y.loaded])], [7, 3, 2, 'MISSING', [['CONFIRMED', 1, 1]]]);

  // --- Tarihçe: ilk kayıt + sıralı düzeltmeler (kim, ne zaman, neden, önce → sonra); geçerli durum ayrı
  const view = await c.loadConfirmation(db, D1);
  assert.equal(view.revision, 3);
  assert.deepEqual(view.corrections.map((y) => [y.revision, y.reason, y.by, y.changes.map((ch) => [ch.before.loaded, ch.before.notLoaded, ch.after.loaded, ch.after.notLoaded])]), [
    [1, '2 cam kırık çıktı', 'Yönetici', [[10, 0, 8, 2]]], [2, 'Kırık sayısı 1', 'Yönetici', [[8, 2, 9, 1]]], [3, 'Eksik cam sayımı', 'Yönetici', [[9, 1, 7, 3]]],
  ]);
  assert.ok(view.corrections.every((y) => y.at instanceof Date));
  const qty = (orders, id) => orders.find((y) => y.orderId === id).items.filter((i) => i.kind === 'CAM').map((i) => [i.status, i.quantity]);
  assert.deepEqual([qty(view.original, o.id), qty(view.orders, o.id)], [[['LOADED', 10]], [['LOADED', 7], ['NOT_LOADED', 3]]]);
  assert.equal(await originalRows(D1), original, 'üç düzeltmeden sonra da ilk kalemler aynı');
  assert.equal(await db.auditLog.count({ where: { action: 'LOADING_CORRECTED', entityId: conf.id } }), 3);

  // --- Yanlış "yüklendi" denmiş kapsam: 0 yüklendi + tamamı yüklenmedi
  const doneX = await correct(D1, [{ key: lineKey(x), quantity: 3, reason: 'OTHER', note: 'kamyona hiç konmadı' }], 'Yanlış sipariş işaretlendi');
  assert.deepEqual([doneX.ok, doneX.revision], [true, 4]);
  assert.deepEqual(await effective(x.id, D1), [['NOT_LOADED', 3, 4]]);
  assert.equal((await c.loadedDays(db, [x.id, o.id])).has(x.id), false, 'geçerli durumda yüklenmiş sayılmaz');
  assert.equal(await customerOf(D1, B), null, 'yüklenen kalemi kalmayan sipariş faturalanmaz');

  // --- Kârlılık geçerli fiili yüklemeyi izler; hiçbir adet iki kez sayılmaz (7 + 1 = 8 yüklendi, 2'si hâlâ yüklenmedi)
  const [pd, pk] = [await dayProfit(D1), await dayProfit(keepDay)];
  assert.deepEqual([pd.m2, pd.byCur.EUR.sale, pd.byCur.EUR.cost, pd.accounting], [7, 370, 220, []]); // 7 × 50 + 2 × 10 · 7 × 30 + 2 × 5
  assert.deepEqual([pk.m2, pk.byCur.EUR.sale, pk.byCur.EUR.cost], [1, 50, 30]);
  // Fatura önizlemesi de geçerli durumdan: 7 adet
  assert.deepEqual((await customerOf(D1, A)).groups[0].orders[0].lines.map((l) => [l.pieces, l.amount]), [[7, 370]]);
  assert.deepEqual([await documents(), await batches()], [0, 0], 'hiçbir belge oluşmadı');
});

dbTest('finansal etki: kuyruktaki / kesilemeyen fatura düzeltmeyi engeller; kesilmiş faturada fark yalnızca saptanır — otomatik belge yok, kapsam iki kez faturalanmaz', async () => {
  const D2 = dayOf(-30), F = dayOf(40);
  const [Q, X, S, O, U, W] = await Promise.all([['Fix Queue SRL', 'FXQ'], ['Fix Failed SRL', 'FXX'], ['Fix Same SRL', 'FXS'], ['Fix Over SRL', 'FXO'], ['Fix Under SRL', 'FXU'], ['Fix Down SRL', 'FXW']].map(([n, p]) => firm(n, p)));
  const q = await glassOrder(Q, D2, [glassLine(10)]);
  const f = await glassOrder(X, D2, [glassLine(10)]);
  const s = await glassOrder(S, D2, [glassLine(10)]);
  const ov = await glassOrder(O, D2, [glassLine(10), glassLine(4, { description: 'Lamine', descriptionRo: 'Sticlă laminată', offerPrice: '80', unitPrice: '60' })]);
  const un = await glassOrder(U, D2, [glassLine(10)]);
  const w = await glassOrder(W, D2, [glassLine(10)]);
  // Onay: S, U, W ve O'nun lamine satırı 2'şer adet yüklenmedi
  const r = await confirm(D2, [
    { key: lineKey(s), quantity: 2, reason: 'BROKEN' }, { key: lineKey(un), quantity: 2, reason: 'NOT_READY' },
    { key: lineKey(w), quantity: 2, reason: 'BROKEN' }, { key: lineKey(ov, 1), quantity: 2, reason: 'NOT_READY' },
  ]);
  assert.equal(r.ok, true);
  const conf = await db.loadingConfirmation.findUniqueOrThrow({ where: { shipDay: date(D2) } });
  const original = await originalRows(D2);
  const fgo = fakeFgo(500);
  const one = (o, quantity, reason = 'BROKEN') => [{ key: lineKey(o), quantity, ...(quantity ? { reason } : {}) }];

  // --- Kuyruktaki fatura: düzeltme yapılamaz
  const qb = await invoice(D2, Q, fgo, { dispatch: false });
  let p = await plan(D2, one(q, 2));
  assert.deepEqual([p.blocked, impactOf(p, q).code, impactOf(p, q).before], ['QUEUED_BILLING', 'QUEUED_BILLING', 'QUEUED_BILLING']);
  assert.deepEqual(await co.correctLoading(db, { day: D2, input: one(q, 2), reason: 'Kırık', key: p.key, actor: actor() }), { ok: false, code: 'QUEUED_BILLING' });
  // Fatura kesildi: önizleme parmak izi tutmaz (durum değişti); yeni önizlemeyle fark saptanır
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: qb.id }));
  assert.deepEqual(await co.correctLoading(db, { day: D2, input: one(q, 2), reason: 'Kırık', key: p.key, actor: actor() }), { ok: false, code: 'STALE_PREVIEW' });

  // --- Kesilemeyen fatura: önce yönetici vazgeçer / yeniden dener, sonra düzeltir
  const fb = await invoice(D2, X, fakeFgo(9000, { emit: () => new Response(JSON.stringify({ Success: false, Message: 'Client invalid' })) }));
  assert.equal(fb.status, 'FAILED');
  p = await plan(D2, one(f, 2));
  assert.deepEqual([p.blocked, impactOf(p, f).code], ['FAILED_BILLING', 'FAILED_BILLING']);
  assert.deepEqual(await co.correctLoading(db, { day: D2, input: one(f, 2), reason: 'Kırık', key: p.key, actor: actor() }), { ok: false, code: 'FAILED_BILLING' });
  assert.deepEqual(await b.reviewFailedBatch(db, { batchId: fb.id, action: 'void', actor: actor() }), { ok: true });
  p = await plan(D2, one(f, 2));
  assert.deepEqual([p.blocked, impactOf(p, f).before, impactOf(p, f).code], [null, 'NO_BILLING', 'NO_BILLING']);
  assert.equal((await co.correctLoading(db, { day: D2, input: one(f, 2), reason: 'Kırık', key: p.key, actor: actor() })).ok, true);
  // Faturası olmayan kapsam: fatura geçerli (düzeltilmiş) durumdan kesilir — 8 adet
  assert.deepEqual((await customerOf(D2, X)).groups[0].orders[0].lines.map((l) => l.pieces), [8]);
  const xb = await invoice(D2, X, fgo);
  assert.deepEqual([xb.status, xb.lines[0].pieces, xb.orders[0].loadingRevision], ['ISSUED', 8, 1], 'fatura hangi düzeltme sırasından kesildiğini saklar');

  // --- Kesilmiş fatura, finansal fark YOK (yalnızca neden düzeltildi): düzeltme yapılır, muhasebe işlemi gerekmez
  const sb = await invoice(D2, S, fgo);
  p = await plan(D2, one(s, 2, 'MISSING'));
  assert.deepEqual([p.blocked, p.actionRequired, impactOf(p, s).code, impactOf(p, s).diff, impactOf(p, s).ref], [null, false, 'NO_FINANCIAL_DIFFERENCE', 0, `${sb.document.series}${sb.document.number}`]);
  assert.equal((await co.correctLoading(db, { day: D2, input: one(s, 2, 'MISSING'), reason: 'Neden yanlış girildi', key: p.key, actor: actor() })).actionRequired, false);
  assert.deepEqual((await customerOf(D2, S)).issued[0].impacts, []);

  // --- Kesilmiş fatura, FAZLA faturalandı: 10 yüklendi diye faturalandı, aslında 8 (ödenmiş fatura)
  const ob = await invoice(D2, O, fgo); // 10 × 50 + 2 × 80 = 660 EUR
  await db.fgoDocument.update({ where: { id: ob.document.id }, data: { paid: '100.00' } });
  const calls = fgo.calls.length, docs = await documents(), bats = await batches();
  p = await plan(D2, one(ov, 2));
  const io = impactOf(p, ov);
  assert.deepEqual([p.blocked, p.actionRequired, io.before, io.code, io.invoiced, io.effective, io.diff, io.currency, io.invoicePaid, io.advanceDeducted],
    [null, true, 'NO_FINANCIAL_DIFFERENCE', 'OVER_INVOICED', { pieces: 12, amount: 660 }, { pieces: 10, amount: 560 }, -100, 'EUR', true, false]);
  const fixO = await co.correctLoading(db, { day: D2, input: one(ov, 2), reason: '2 cam kırık çıktı', key: p.key, actor: actor() });
  assert.deepEqual([fixO.ok, fixO.actionRequired], [true, true]);
  // Hiçbir belge otomatik kesilmedi / değişmedi; kapsam bu onaydan yeniden faturalanamaz; "muhasebe işlemi gerekli" görünür
  let co2 = await customerOf(D2, O);
  assert.deepEqual([co2.groups, co2.issued.map((i) => [i.ref, i.impacts.map((y) => [y.orderNo, y.code, y.diff])])], [[], [[io.ref, [[ov.orderNo, 'OVER_INVOICED', -100]]]]]);
  const frozen = (y) => JSON.stringify([y.status, y.sourceTotal, y.ronNet, y.lines, y.document.series, y.document.number, y.document.total]);
  const obAfter = await db.billingBatch.findUnique({ where: { id: ob.id }, include: { document: true, lines: { orderBy: { sortOrder: 'asc' } } } });
  assert.equal(frozen(obAfter), frozen(ob), 'kesilmiş fatura partisi değişmedi');
  assert.deepEqual([fgo.calls.length, await documents(), await batches()], [calls, docs, bats], 'storno / ek fatura / düzeltme belgesi kesilmedi');
  const auditO = await db.auditLog.findFirstOrThrow({ where: { action: 'LOADING_CORRECTED', entityId: conf.id }, orderBy: { createdAt: 'desc' } });
  assert.deepEqual(auditO.details.financialImpact.map((y) => [y.orderNo, y.before, y.after, y.invoice, y.diff, y.invoicePaid]), [[ov.orderNo, 'NO_FINANCIAL_DIFFERENCE', 'OVER_INVOICED', io.ref, -100, true]]);

  // --- Fazla faturalanan camın aktarımı DONDURULUR: ileri günde yüklenince otomatik faturaya girmez (çift faturalama yok)
  const rows = await rp.notLoadedOfDay(db, D2);
  const rowOf = (o, i = 0) => rows.find((y) => y.orderId === o.id && y.key === lineKey(o, i));
  assert.equal((await rp.replanNotLoaded(db, { itemId: rowOf(ov).itemId, day: F, actor: actor() })).ok, true); // faturalanmış 2 adet
  assert.equal((await confirm(F, [], evening(F))).ok, true);
  co2 = await customerOf(F, O);
  assert.deepEqual([co2.groups, co2.excluded.map((y) => [y.orderNo, y.reason, y.ref])], [[], [[ov.orderNo, 'ACCOUNTING_ACTION', io.ref]]]);
  assert.deepEqual(await inv.createInvoiceBatch(db, { day: F, groupKey: `INVOICE:x:${O.id}:EUR:DIRECT`, previewKey: 'x', actor: actor(), bnrImpl: bnr('5.0000') }), { ok: false, code: 'NOTHING_TO_INVOICE' });
  assert.deepEqual([await documents(), await batches()], [docs, bats]);
  // Aynı siparişin faturalanMAMIŞ kalanı (lamine, 2 adet — düzeltmeyle ilgisiz) ayrı bir güne aktarılınca normal faturalanır
  const F2 = dayOf(47);
  assert.equal((await rp.replanNotLoaded(db, { itemId: rowOf(ov, 1).itemId, day: F2, actor: actor() })).ok, true);
  assert.equal((await confirm(F2, [], evening(F2))).ok, true);
  assert.deepEqual((await customerOf(F2, O)).groups[0].orders[0].lines.map((l) => [l.pieces, l.amount]), [[2, 160]]);
  // Kârlılık fiili yüklemeyi izler: D2'de O için 8 + 2 lamine; F'de 2 cam; muhasebe işlemi gerekli işareti durur
  const pd = await dayProfit(D2);
  assert.deepEqual(pd.accounting.map((y) => [y.orderNo, y.code, y.ref]), [[ov.orderNo, 'OVER_INVOICED', io.ref]]);
  assert.deepEqual([(await dayProfit(F)).byCur.EUR.sale, (await dayProfit(F)).m2], [100, 2]);

  // --- Kesilmiş fatura, EKSİK faturalandı: 8 + 2 diye onaylandı ve 8 faturalandı; aslında 10 yüklenmiş
  const ub = await invoice(D2, U, fgo);
  p = await plan(D2, one(un, 0));
  const iu = impactOf(p, un);
  assert.deepEqual([p.blocked, p.actionRequired, iu.code, iu.invoiced, iu.effective, iu.diff], [null, true, 'UNDER_INVOICED', { pieces: 8, amount: 400 }, { pieces: 10, amount: 500 }, 100]);
  assert.equal((await co.correctLoading(db, { day: D2, input: one(un, 0), reason: 'Hepsi yüklenmişti', key: p.key, actor: actor() })).actionRequired, true);
  const cu = await customerOf(D2, U);
  assert.deepEqual([cu.groups, cu.issued[0].impacts.map((y) => [y.code, y.diff])], [[], [['UNDER_INVOICED', 100]]], 'ek fatura otomatik kesilmez; kapsam yeniden faturaya açılmaz');
  assert.equal((await db.billingBatch.findUnique({ where: { id: ub.id } })).status, 'ISSUED');
  // Düzeltme geri alınırsa (yeni düzeltme) fark kalkar
  assert.equal((await correct(D2, one(un, 2, 'NOT_READY'), 'İlk kayıt doğruymuş')).actionRequired, false);
  assert.deepEqual((await customerOf(D2, U)).issued[0].impacts, []);

  // --- Sonraki onaya bağlı kapsam: aktarılan 2 adet ileri günde onaylandı ve faturalandı → altına inen düzeltme reddedilir
  const F3 = dayOf(54);
  await invoice(D2, W, fgo);
  assert.equal((await rp.replanNotLoaded(db, { itemId: rowOf(w).itemId, day: F3, actor: actor() })).ok, true);
  assert.equal((await confirm(F3, [], evening(F3))).ok, true);
  await invoice(F3, W, fgo);
  p = await plan(D2, one(w, 0));
  assert.deepEqual([p.blocked, p.conflicts.map((y) => [y.orderNo, y.confirmed, y.days])], ['DOWNSTREAM_CONFLICT', [[w.orderNo, 2, [F3]]]]);
  assert.deepEqual(await co.correctLoading(db, { day: D2, input: one(w, 0), reason: 'Hepsi yüklenmişti', key: p.key, actor: actor() }), { ok: false, code: 'DOWNSTREAM_CONFLICT' });
  // Sonraki onayın kendisi düzeltilebilir: faturası kesilmiş → fark saptanır
  const [wItem] = await db.loadingConfirmationItem.findMany({ where: { orderId: w.id, confirmation: { shipDay: date(F3) } } });
  p = await plan(F3, [{ key: c.itemKey(wItem), quantity: 1, reason: 'BROKEN' }]);
  assert.deepEqual([p.blocked, p.impacts[0].code, p.impacts[0].diff], [null, 'OVER_INVOICED', -50]);

  // Onay anındaki kalemler hiçbir düzeltmeden etkilenmedi
  assert.equal(await originalRows(D2), original);
});

dbTest('avans düşülmüş müşteri faturası: düzeltme farkı saptar, avans düşümü bildirilir; zincire ve belgelere dokunulmaz', async () => {
  const FP = dayOf(60);
  const C = await firm('Fix Chain SRL', 'FXC');
  const o = await glassOrder(C, FP, [glassLine(10)]);
  const fgo = fakeFgo(800);
  const pv = await b.previewBatch(db, { customerId: C.id, days: [FP], bnrImpl: bnr('5.0000') });
  const pr = await b.createBatch(db, { customerId: C.id, days: [FP], key: pv.key, actor: actor(), bnrImpl: bnr('5.0000') });
  assert.equal(pr.ok, true);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: pr.batchId })); // müşteri proforması: 10 × 50 × 5 × 1,21 = 3025
  await db.fgoDocument.updateMany({ where: { batchId: pr.batchId }, data: { paid: '1000.00' } }); // FGO'da tahsilat
  const av = await inv.createAdvanceBatch(db, { proformaBatchId: pr.batchId, actor: actor() });
  assert.equal(av.ok, true);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: av.batchId }));
  assert.equal((await confirm(FP, [], evening(FP))).ok, true);
  const ib = await invoice(FP, C, fgo);
  assert.ok(ib.lines.some((l) => l.refBatchId === av.batchId), 'fatura avansı düştü');
  const counts = [await documents(), await batches(), fgo.calls.length];
  const p = await plan(FP, [{ key: lineKey(o), quantity: 1, reason: 'BROKEN' }]);
  const i = impactOf(p, o);
  assert.deepEqual([p.blocked, i.code, i.diff, i.advanceDeducted, i.invoicePaid], [null, 'OVER_INVOICED', -50, true, false]);
  assert.equal((await co.correctLoading(db, { day: FP, input: [{ key: lineKey(o), quantity: 1, reason: 'BROKEN' }], reason: '1 cam kırık', key: p.key, actor: actor(), now: evening(FP) })).actionRequired, true);
  assert.deepEqual([await documents(), await batches(), fgo.calls.length], counts, 'avans / fatura / storno yeniden kesilmedi');
  // Zincir olduğu gibi: avans ve fatura partileri ISSUED, proforma kök
  assert.deepEqual((await db.billingBatch.findMany({ where: { customerId: C.id }, orderBy: { createdAt: 'asc' } })).map((y) => [y.kind, y.status]), [['PROFORMA', 'ISSUED'], ['ADVANCE', 'ISSUED'], ['INVOICE', 'ISSUED']]);
});

dbTest('fatura bekliyor (karar 126): yükleme düzeltmesi ve aktarım yanlış uyarı üretmez — yalnızca GEÇERLİ yüklenen kapsam, yüklendiği onayın gününe göre', offline(async () => {
  const D = dayOf(-45), F = dayOf(9);
  const plus = (day, k) => new Date(Date.parse(`${day}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
  const A = await firm('Fix Remind SRL', 'FXR');
  const o = await glassOrder(A, D, [glassLine(10)]);
  const p = await glassOrder(A, D, [glassLine(4)]);
  assert.equal((await confirm(D, [], evening(D))).ok, true); // "Yükleme yapıldı" (yükleme günü kaydedildi): 10 + 4
  const mine = async (now) => (await un.uninvoicedLoadings(db, { now })).filter((x) => x.customerId === A.id).map((r) => [r.orderNo, r.day, r.revision]);
  assert.deepEqual(await mine(at(plus(D, 6))), [[o.orderNo, D, 0], [p.orderNo, D, 0]]);

  // Düzeltme 1: p aslında hiç yüklenmemiş → p'nin faturalanacak kapsamı kalmadı: uyarı kalkar (onay kaydı aynen durur)
  assert.equal((await correct(D, [{ key: lineKey(p), quantity: 4, reason: 'MISSING' }])).ok, true);
  assert.deepEqual(await mine(at(plus(D, 6))), [[o.orderNo, D, 0]]);
  // Düzeltme 2: o'nun 3 adedi yüklenmemiş → uyarı yalnızca geçerli yüklenen 7 adet için sürer (kapsam değişti: yeni sıra)
  assert.equal((await correct(D, [{ key: lineKey(o), quantity: 3, reason: 'BROKEN' }])).ok, true);
  assert.deepEqual(await mine(at(plus(D, 6))), [[o.orderNo, D, 2]]);
  assert.deepEqual(await effective(o.id, D), [['LOADED', 7, 2], ['NOT_LOADED', 3, 2]]);

  // Yüklenmeyen 3 adet ileri güne aktarılır: henüz yüklenmedi → faturalanamaz → uyarı üretmez (planlanan gün geçse de)
  const row = (await rp.notLoadedOfDay(db, D)).find((x) => x.orderId === o.id);
  assert.equal((await rp.replanNotLoaded(db, { itemId: row.itemId, day: F, actor: actor() })).ok, true);
  const fgo = fakeFgo(900);
  const bill = await invoice(D, A, fgo); // geçerli yüklenen 7 adet faturalanır
  assert.deepEqual(bill.lines.map((l) => l.pieces), [7]);
  assert.deepEqual(await mine(at(plus(F, 30))), [], 'D kapsamı faturalandı; aktarılan 3 adet yüklenmedikçe uyarı doğmaz');

  // Aktarılan kalan F gününde fiilen yüklenir: uyarı günü F + 6 (asıl planlanan D gününe göre değil)
  assert.equal((await confirm(F, [], evening(F))).ok, true);
  assert.deepEqual(await mine(at(plus(F, 5))), []);
  assert.deepEqual(await mine(at(plus(F, 6))), [[o.orderNo, F, 0]]);
  assert.equal(fgo.calls.length, 1, 'uyarı hesabı belge kesmez');
}));

dbTest('fatura bekliyor (karar 126): "muhasebe işlemi gerekli" diye dondurulan kapsam uyarı üretmez — faturalama ekranının dışladığı kapsamla aynı karar', offline(async () => {
  const { removeDeletedDocument } = await import('../../server/integrations/fgo-deleted.js');
  const D = dayOf(-50), F = dayOf(11);
  const plus = (day, k) => new Date(Date.parse(`${day}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
  const A = await firm('Fix Hold SRL', 'FXH');
  const o = await glassOrder(A, D, [glassLine(10)]);
  const ctl = await glassOrder(A, F, [glassLine(3)]); // karşılaştırma: aynı müşterinin F gününde olağan yüklenen siparişi
  /** Bu müşterinin uyarı satırları: [sipariş, yükleme günü, not] — gün, sonra sipariş sırasıyla */
  const mine = async (now) => (await un.uninvoicedLoadings(db, { now })).filter((x) => x.customerId === A.id).map((r) => [r.orderNo, r.day, r.note]);
  /** Faturalama ekranının aynı gün için kararı: faturalanabilir siparişler ve dışarıda kalanlar */
  const screen = async (day) => {
    const v = await customerOf(day, A);
    return { open: v.groups.flatMap((g) => [...g.orders, ...g.unselected].map((x) => x.orderNo)).sort(), excluded: v.excluded.map((x) => [x.orderNo, x.reason, x.ref]) };
  };

  // D günü: 10 adet "Yükleme yapıldı" diye onaylanır ve faturalanır → kapsam kapalı, uyarı yok
  assert.equal((await confirm(D, [], evening(D))).ok, true);
  const fgo = fakeFgo(950);
  const bill = await invoice(D, A, fgo);
  const ref = `${bill.document.series}${bill.document.number}`;
  assert.deepEqual([bill.status, bill.lines.map((l) => l.pieces)], ['ISSUED', [10]]);
  assert.deepEqual(await mine(at(plus(D, 6))), []);
  // Düzeltme: aslında 8 adet yüklenmiş → kesilmiş fatura fazla (2 adet): MUHASEBE İŞLEMİ GEREKLİ; belge kesilmez / değişmez
  const fix = await correct(D, [{ key: lineKey(o), quantity: 2, reason: 'BROKEN' }], '2 cam kırık çıktı');
  assert.deepEqual([fix.ok, fix.actionRequired], [true, true]);
  assert.deepEqual((await customerOf(D, A)).issued.map((i) => [i.ref, i.impacts.map((y) => [y.orderNo, y.code])]), [[ref, [[o.orderNo, 'OVER_INVOICED']]]]);
  // Faturalanmış 2 adet ileri güne aktarılır ve orada fiilen yüklenir (aynı gün müşterinin olağan siparişi de yüklenir)
  const row = (await rp.notLoadedOfDay(db, D)).find((x) => x.orderId === o.id);
  assert.equal((await rp.replanNotLoaded(db, { itemId: row.itemId, day: F, actor: actor() })).ok, true);
  assert.deepEqual(await mine(at(plus(F, 30))), [], 'aktarılan cam yüklenmedikçe uyarı doğmaz');
  assert.equal((await confirm(F, [], evening(F))).ok, true);
  const confF = await db.loadingConfirmation.findUniqueOrThrow({ where: { shipDay: date(F) } });
  assert.deepEqual(await effective(o.id, F), [['LOADED', 2, 0]], 'cam F gününde fiilen yüklendi');

  // --- Faturalama ekranı: o camı müşteri faturasına ALMAZ (zaten GKH… faturasında) — yalnızca olağan sipariş faturalanabilir
  assert.deepEqual(await screen(F), { open: [ctl.orderNo], excluded: [[o.orderNo, 'ACCOUNTING_ACTION', ref]] });
  // --- Uyarı: aynı karar. Dondurulan kapsam uyarı günü geçse de listede yok; olağan sipariş uyarı gününde listede
  assert.deepEqual(await mine(at(plus(F, 5))), []);
  assert.deepEqual(await mine(at(plus(F, 6))), [[ctl.orderNo, F, null]]);
  assert.deepEqual(await mine(at(plus(F, 400))), [[ctl.orderNo, F, null]], 'dondurma süreyle çözülmez: ne kadar beklerse beklesin uyarı üretmez');
  assert.deepEqual((await mine(at(plus(F, 6)))).map((r) => r[0]), (await screen(F)).open, 'uyarı listesi = faturalama ekranının faturalanabilir dediği kapsam');
  // İşçinin bildirimi de yalnızca olağan sipariş için yazılır (dondurulan kapsam için bildirim yok); tekrar çalışınca yenisi yazılmaz
  const keys = async () => [...new Set((await db.notification.findMany({ where: { type: 'INVOICE_OVERDUE', dedupeKey: { startsWith: `uninvoiced:${confF.id}:` } }, select: { dedupeKey: true } })).map((n) => n.dedupeKey))];
  await un.remindUninvoiced(db, { now: at(plus(F, 6)) });
  assert.deepEqual(await keys(), [`uninvoiced:${confF.id}:${ctl.id}:r0`]);
  assert.equal(await db.notification.count({ where: { type: 'INVOICE_OVERDUE', orderId: o.id } }), 0);
  assert.equal((await un.remindUninvoiced(db, { now: at(plus(F, 7)) })).created, 0);
  assert.deepEqual([fgo.calls.length, await db.fgoDocument.count({ where: { batch: { customerId: A.id } } }), await db.billingBatch.count({ where: { customerId: A.id } })], [1, 1, 1], 'uyarı hesabı belge / parti üretmez');

  // --- Karşı sınama: dondurmanın nedeni kalkınca (fazla kesilen fatura FGO'da silindi → parti geçersiz) iki ekran da
  // birlikte değişir: kapsam faturalama ekranında açılır VE uyarı listesine girer (D'nin geçerli 8 adedi de yeniden açık)
  await removeDeletedDocument(db, bill.document, 'test: belge FGO\'da silindi');
  assert.deepEqual(await screen(F), { open: [ctl.orderNo, o.orderNo].sort(), excluded: [] });
  assert.deepEqual((await mine(at(plus(F, 6)))).map((r) => `${r[0]}@${r[1]}`).sort(), [`${o.orderNo}@${D}`, `${o.orderNo}@${F}`, `${ctl.orderNo}@${F}`].sort());
  assert.deepEqual((await screen(D)).open, [o.orderNo]);
  assert.equal(fgo.calls.length, 1, 'FGO\'ya başka istek gitmedi');
}));
