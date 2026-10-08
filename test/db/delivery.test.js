// Paket 8 (karar 192–197) — veritabanıyla: çalışma takvimi istisnaları, profil teslim günü (depoya iletilme anı, yönetici
// değişikliği → tek bildirim), depo akışı (çift stok düşümü yok, teslim onayı bir kez, FGO işi bir kez), teslimat
// fotoğrafları (tekil kayıt, eşzamanlılık, değişmezlik, erişim) ve teslimat raporu (kopya, sürüm, tek form anahtarı,
// değişmezlik, PDF erişimi). Ağ yok (FGO / e-posta çağrılmaz).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { resetEnvCache } from '../../server/env.js';
import zlib from 'node:zlib';
import { FONTS } from '../../server/pdf/fonts.js';

const UPLOAD = fs.mkdtempSync(path.join(os.tmpdir(), 'takip-teslimat-'));
process.env.UPLOAD_DIR = UPLOAD;
resetEnvCache();
const { suggestNextNo } = await import('../../server/orders/create.js');
const { createProfileOrder } = await import('../../server/profile/create.js');
const { profileOrderItems } = await import('../../server/profile/rules.js');
const { runProfileAction, depotActor } = await import('../../server/profile/transitions.js');
const { addStockMovement } = await import('../../server/profile/stock.js');
const { dayKeyOf, depotReadyDay, depotToday, earliestPickup } = await import('../../server/profile/dates.js');
const { loadOverrides, setOverride } = await import('../../server/calendar/service.js');
const { addDaysKey, isOpenDay } = await import('../../server/calendar/rules.js');
const { createDeliveryReport, deliveryDocs, recordDeliveryPhoto, renderDeliveryReport } = await import('../../server/delivery/service.js');
const { dispatchInApp } = await import('../../server/notifications/inapp.js');
const { orderScope } = await import('../../server/orders/scope.js');
const { saveFgoSettings } = await import('../../server/integrations/fgo.js');

let db;
const people = {};
let firm, otherFirm;
const actor = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const codeOf = async (p) => p.then(() => 'OK', (e) => e.code ?? e.message);
const run = (orderId, action, who, payload = {}) => runProfileAction(db, { orderId, action, actor: actor(people[who]), payload });
const pickDay = () => earliestPickup({ now: new Date(Date.now() + 5 * 60_000) });
const D = (key) => new Date(`${key}T12:00:00.000Z`);
const load = (id) => db.order.findUniqueOrThrow({ where: { id }, include: { profile: true, offers: { orderBy: { createdAt: 'desc' }, include: { lines: true } } } });
const scopeOf = (who) => orderScope({ appRole: people[who].appRole, customerId: people[who].customerId });
// PDF metni (gömülü yazı tipinin glif kodlarından geri çevrilir)
const REVERSE = Object.fromEntries(['Regular', 'Bold'].map((k) => [k, new Map(FONTS[k].map.map(([cp, gid]) => [gid, cp]))]));
function textOf(pdf) {
  const out = [];
  const s = pdf.toString('latin1');
  const re = /<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g;
  for (let m; (m = re.exec(s));) {
    const start = m.index + m[0].length;
    let ops;
    try { ops = zlib.inflateSync(pdf.subarray(start, start + Number(m[1]))).toString('latin1'); } catch { continue; }
    for (const t of ops.matchAll(/\/(F1|F2) [\d.]+ Tf [\d.-]+ [\d.-]+ Td <([0-9a-f]*)> Tj/g)) {
      out.push((t[2].match(/.{4}/g) ?? []).map((h) => String.fromCodePoint(REVERSE[t[1] === 'F2' ? 'Bold' : 'Regular'].get(parseInt(h, 16)) ?? 63)).join(''));
    }
  }
  return out.join('\n');
}

// En küçük gerçek JPEG başlığı (SOF0 boyutu) — PDF'e gömülür; her çağrı ayrı içerik (sağlama toplamı farklı)
let seq = 0;
function photoFile(name = `foto-${++seq}.jpg`, content = null) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const buf = content ?? Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xfe, 0x00, 0x08]), Buffer.from(String(seq).padStart(6, '0')), sof, Buffer.from([0xff, 0xd9])]);
  const storageKey = `2026/10/${crypto.randomUUID()}.jpg`;
  fs.mkdirSync(path.join(UPLOAD, '2026', '10'), { recursive: true });
  fs.writeFileSync(path.join(UPLOAD, storageKey), buf);
  return { storageKey, name, size: buf.length, mime: 'image/jpeg', checksum: crypto.createHash('sha256').update(buf).digest('hex'), scanStatus: 'CLEAN', scanSignature: null, scannedAt: new Date() };
}

async function newProfileOrder(lines, f = firm, who = 'cust') {
  const products = await db.profileProduct.findMany({ where: { code: { in: lines.map((l) => l[0]) } }, include: { category: true } });
  const byCode = new Map(products.map((p) => [p.code, p.id]));
  const items = profileOrderItems(lines.map(([code, qty]) => ({ productId: byCode.get(code), qty })), products);
  assert.ok(items.ok);
  const next = await suggestNextNo(db, f.id, 'PROFILE_ORDER');
  return createProfileOrder(db, { actor: actor(people[who]), firm: f, title: null, requestedNo: next, suggestedNo: next, items: items.items });
}
/** Teklif → onay → proforma (depoya gitmeden önceki son adım) */
async function approvedOrder(lines, f = firm, who = 'cust') {
  const { id, orderNo } = await newProfileOrder(lines, f, who);
  let o = await load(id);
  await run(id, 'send_profile_offer', 'admin', { lines: o.offers[0].lines.map((l) => ({ id: l.id, offerPrice: '10' })) });
  o = await load(id);
  await run(id, 'approve_profile_offer', who, { offerId: o.offers[0].id, pickupDate: pickDay(), phone: '0723000000', plate: 'B 1 ABC' });
  await run(id, 'mark_proforma', 'admin', { proformaNo: 'PF-1' });
  return { id, orderNo };
}
async function depotOrder(lines = [['GK15', 2]], f = firm, who = 'cust') {
  const o = await approvedOrder(lines, f, who);
  await run(o.id, 'send_to_warehouse', 'admin');
  return o;
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Teslimat Cam', prefix: 'TES' } });
  otherFirm = await db.customer.create({ data: { name: 'Başka Firma', prefix: 'BAS' } });
  const mk = (key, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${key}@teslimat.test`, name: `${key} kişi`, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } })
      .then((u) => { people[key] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('sales', 'SATIS', factory.id);
  await mk('drawer', 'CIZIM', factory.id);
  await mk('inspector', 'DENETIMCI', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true });
  await mk('other', 'MUSTERI', otherFirm.id, { canApprove: true });
  const gk = await db.profileProduct.findUnique({ where: { code: 'GK15' } });
  await addStockMovement(db, { productId: gk.id, kind: 'GIRIS', qty: 100 }, actor(people.admin));
});
after(async () => {
  await closeDb();
  fs.rmSync(UPLOAD, { recursive: true, force: true });
});

// ---------- çalışma takvimi istisnaları ----------

dbTest('takvim: yalnızca yönetici işaretler (diğer roller veritabanına gitmeden reddedilir); karar denetimde; iki takvim ayrı', offline(async () => {
  const day = addDaysKey(dayKeyOf(depotToday()), 30);
  for (const who of ['sales', 'drawer', 'inspector', 'cust']) {
    assert.deepEqual(await setOverride(db, { calendar: 'RO_DEPOT', day, mode: 'CLOSED' }, actor(people[who])), { ok: false, code: 'FORBIDDEN' }, who);
  }
  assert.equal(await db.workCalendarOverride.count(), 0);
  assert.deepEqual(await setOverride(db, { calendar: 'RO_DEPOT', day, mode: 'CLOSED', note: 'envanter' }, actor(people.admin)), { ok: true, changed: true });
  assert.deepEqual(await setOverride(db, { calendar: 'RO_DEPOT', day, mode: 'CLOSED', note: 'envanter' }, actor(people.admin)), { ok: true, changed: false }, 'aynı karar yazılmaz');
  const ro = await loadOverrides(db, 'RO_DEPOT', day, day);
  const tr = await loadOverrides(db, 'TR_FACTORY', day, day);
  assert.deepEqual([ro.get(day), tr.size], [{ open: false, note: 'envanter' }, 0]);
  assert.equal(isOpenDay('RO_DEPOT', day, ro), false);
  assert.equal(isOpenDay('TR_FACTORY', day, tr), isOpenDay('TR_FACTORY', day, null), 'Romanya kararı Türkiye takvimini etkilemez');
  assert.deepEqual(await setOverride(db, { calendar: 'RO_DEPOT', day, mode: 'AUTO' }, actor(people.admin)), { ok: true, changed: true });
  assert.equal((await loadOverrides(db, 'RO_DEPOT', day, day)).size, 0);
  const audits = await db.auditLog.findMany({ where: { action: 'WORK_CALENDAR_OVERRIDE', entityId: `RO_DEPOT:${day}` }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(audits.map((a) => [a.details.before?.open ?? null, a.details.after?.open ?? null]), [[null, false], [false, null]]);
  assert.deepEqual(await setOverride(db, { calendar: 'RO_DEPOT', day: '2026-02-30', mode: 'OPEN' }, actor(people.admin)), { ok: false, code: 'DAY' });
}));

// ---------- teslim günü ----------

dbTest('teslim günü: yöneticinin kapattığı gün seçilemez; depoya iletilirken alış günü o anın depo kuralına göre denetlenir', offline(async () => {
  const { id } = await newProfileOrder([['GK15', 1]]);
  let o = await load(id);
  await run(id, 'send_profile_offer', 'admin', { lines: o.offers[0].lines.map((l) => ({ id: l.id, offerPrice: '10' })) });
  o = await load(id);
  const day = pickDay();
  await setOverride(db, { calendar: 'RO_DEPOT', day: dayKeyOf(day), mode: 'CLOSED' }, actor(people.admin));
  assert.equal(await codeOf(run(id, 'approve_profile_offer', 'cust', { offerId: o.offers[0].id, pickupDate: day, phone: '0723000000', plate: 'B 1 ABC' })), 'PICKUP_CLOSED');
  await setOverride(db, { calendar: 'RO_DEPOT', day: dayKeyOf(day), mode: 'AUTO' }, actor(people.admin));
  await run(id, 'approve_profile_offer', 'cust', { offerId: o.offers[0].id, pickupDate: day, phone: '0723000000', plate: 'B 1 ABC' });
  await run(id, 'mark_proforma', 'admin');
  // Müşterinin günü sonradan kapatıldı → iletilirken sonraki açık güne kayar ve müşteriye bildirilir (PICKUP_MOVED)
  await setOverride(db, { calendar: 'RO_DEPOT', day: dayKeyOf(day), mode: 'CLOSED' }, actor(people.admin));
  const r = await run(id, 'send_to_warehouse', 'admin');
  o = await load(id);
  assert.equal(r.result.moved, true);
  const expect = depotReadyDay(o.profile.warehouseSentAt, await loadOverrides(db, 'RO_DEPOT', dayKeyOf(depotToday()), addDaysKey(dayKeyOf(depotToday()), 60)));
  assert.ok(dayKeyOf(o.profile.pickupDate) >= dayKeyOf(expect) && dayKeyOf(o.profile.pickupDate) !== dayKeyOf(day));
  const moved = await db.notificationOutbox.findMany({ where: { orderId: id, type: 'ORDER_PICKUP_MOVED' } });
  assert.equal(moved.length, 1);
  assert.equal(moved[0].payload.day, dayKeyOf(o.profile.pickupDate));
  await setOverride(db, { calendar: 'RO_DEPOT', day: dayKeyOf(day), mode: 'AUTO' }, actor(people.admin));
}));

dbTest('teslim günü: yönetici depoda iken değiştirir → denetim + müşteriye TEK bildirim; aynı gün tekrar → bildirim yok; müşteri değiştiremez', offline(async () => {
  const { id } = await depotOrder();
  let o = await load(id);
  const before = dayKeyOf(o.profile.pickupDate);
  // Yeni gün: mevcut günden sonraki ilk açık gün
  let next = addDaysKey(before, 1);
  while (!isOpenDay('RO_DEPOT', next)) next = addDaysKey(next, 1);
  assert.equal(await codeOf(run(id, 'update_pickup', 'cust', { pickupDate: D(next) })), 'NOT_ALLOWED', 'müşteri depodaki siparişte değiştiremez');
  let past = addDaysKey(dayKeyOf(depotToday()), -1);
  while (!isOpenDay('RO_DEPOT', past)) past = addDaysKey(past, -1);
  assert.equal(await codeOf(run(id, 'update_pickup', 'admin', { pickupDate: D(past) })), 'PICKUP_PAST');
  let closed = addDaysKey(before, 1);
  while (isOpenDay('RO_DEPOT', closed)) closed = addDaysKey(closed, 1);
  assert.match(await codeOf(run(id, 'update_pickup', 'admin', { pickupDate: D(closed) })), /^PICKUP_(WEEKEND|CLOSED)$/);
  const res = await run(id, 'update_pickup', 'admin', { pickupDate: D(next) });
  assert.equal(res.result.deliveryDateChanged, true);
  o = await load(id);
  assert.equal(dayKeyOf(o.profile.pickupDate), next);
  const audit = await db.auditLog.findFirst({ where: { entityId: id, action: 'ORDER_TRANSITION', details: { path: ['action'], equals: 'update_pickup' } }, orderBy: { createdAt: 'desc' } });
  assert.deepEqual([audit.details.before.pickupDate, audit.details.after.pickupDate, audit.details.deliveryDateChanged, audit.actorRole], [before, next, true, 'ADMIN']);
  // Aynı gün yeniden kaydedildi: teslim günü olayı ve bildirimi yok
  const again = await run(id, 'update_pickup', 'admin', { pickupDate: D(next) });
  assert.equal(again.result.deliveryDateChanged, false);
  const rows = await db.notificationOutbox.findMany({ where: { orderId: id, type: 'ORDER_DELIVERY_DATE_CHANGED' } });
  assert.equal(rows.length, 1);
  // Önceki gün `prevDay`: `from` / `to` anahtarları outbox yükünde sipariş durumunu taşır (executeAction; depoda = HAZIRLANIYOR)
  assert.deepEqual([rows[0].payload.day, rows[0].payload.prevDay, rows[0].payload.from, rows[0].payload.to], [next, before, 'HAZIRLANIYOR', 'HAZIRLANIYOR']);
  // Uygulama içi: iki kez dağıtılsa da müşteri kullanıcısına TEK bildirim; yöneticiye (işlemi yapan) yok
  await dispatchInApp(db);
  await dispatchInApp(db);
  const notes = await db.notification.findMany({ where: { orderId: id, type: 'ORDER_DELIVERY_DATE_CHANGED' } });
  assert.deepEqual(notes.map((n) => [n.userId, n.params.day, n.link]), [[people.cust.id, next, `/siparisler/${id}#teslim`]]);
  assert.equal(await db.notification.count({ where: { orderId: id, type: 'ORDER_DELIVERY_DATE_CHANGED', userId: people.other.id } }), 0, 'başka firmaya gitmez');
  // Müşteri geçmişte görür (not = yeni gün)
  const ev = await db.orderEvent.findFirst({ where: { orderId: id, event: 'DELIVERY_DATE_CHANGED' } });
  assert.equal(ev.note, next.split('-').reverse().join('.'));
}));

// ---------- depo akışı ----------

dbTest('depo: stok yetersizliği siparişi engellemez; depoya gönderim çift stok düşmez (eşzamanlı iki gönderim / ödeme); iptal bir kez geri ekler', offline(async () => {
  const pana = await db.profileProduct.findUnique({ where: { code: 'PANA-90-16' } });
  const { id } = await approvedOrder([['PANA-90-16', 999]]); // stok yok: engel değil
  // Eşzamanlı iki "depoya gönder" + bir "ödeme alındı": sipariş depoya BİR kez gider (ödeme sonra yalnızca ödeme olarak yazılabilir)
  const results = await Promise.allSettled([run(id, 'send_to_warehouse', 'admin'), run(id, 'send_to_warehouse', 'admin'), run(id, 'mark_paid', 'admin', { paidDate: depotToday() })]);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => ['CONFLICT', 'NOT_ALLOWED'].includes(r.reason.code)), JSON.stringify(results.map((r) => r.reason?.code ?? 'ok')));
  assert.equal(await db.orderEvent.count({ where: { orderId: id, event: 'WAREHOUSE_SENT' } }), 1, 'yalnızca biri depoya gönderir');
  assert.equal(await db.stockMovement.count({ where: { orderId: id, kind: 'CIKIS' } }), 1);
  assert.equal(await db.notificationOutbox.count({ where: { orderId: id, type: 'WAREHOUSE_EMAIL' } }), 1);
  const o = await load(id);
  assert.equal(o.profile.stage, 'DEPODA');
  assert.ok(o.profile.pickupDate, 'teslim günü stoktan bağımsız verildi');
  await run(id, 'cancel', 'admin', { note: 'test' });
  assert.equal(await codeOf(run(id, 'cancel', 'admin', { note: 'test' })), 'NOT_ALLOWED');
  assert.equal(await db.stockMovement.count({ where: { orderId: id, kind: 'IADE' } }), 1);
  assert.equal(await db.stockMovement.count({ where: { productId: pana.id, orderId: id } }), 2);
}));

dbTest('teslim onayı: bir kez işlenir (eşzamanlı ikinci onay reddedilir); yeni stok hareketi yok; FGO açıkken fatura işi BİR kez (mevcut kural)', offline(async () => {
  await saveFgoSettings(db, {
    enabled: true, dailyLimit: 0, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21,
  }, { key: 'GIZLI', secret: 'f'.repeat(40) }, actor(people.admin));
  try {
    const { id } = await depotOrder();
    const moves = await db.stockMovement.count({ where: { orderId: id } });
    const doc = () => ({ storageKey: `2026/10/${crypto.randomUUID()}.pdf`, name: 'imza.pdf', size: 10, mime: 'application/pdf', checksum: 'c', scanStatus: 'CLEAN' });
    const both = await Promise.allSettled([
      runProfileAction(db, { orderId: id, action: 'mark_delivered', actor: depotActor('1.2.3.4'), payload: { files: [doc()] } }),
      runProfileAction(db, { orderId: id, action: 'mark_delivered', actor: depotActor('1.2.3.4'), payload: { files: [doc()] } }),
    ]);
    assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await codeOf(run(id, 'mark_delivered', 'admin')), 'NOT_ALLOWED', 'teslim edilmiş sipariş yeniden onaylanmaz');
    const o = await load(id);
    assert.equal(o.profile.stage, 'TESLIM_EDILDI');
    assert.equal(await db.stockMovement.count({ where: { orderId: id } }), moves, 'teslim onayı stoğa dokunmaz');
    assert.equal(await db.notificationOutbox.count({ where: { orderId: id, type: 'FGO_INVOICE' } }), 1, 'fatura işi bir kez (FGO çağrılmadı — işçi yok)');
    assert.equal(await db.notificationOutbox.count({ where: { orderId: id, type: 'ORDER_DELIVERED' } }), 1);
    assert.equal(await db.orderEvent.count({ where: { orderId: id, event: 'DELIVERED' } }), 1);
  } finally {
    await db.integrationSetting.deleteMany({ where: { key: 'fgo' } });
  }
}));

// ---------- teslimat fotoğrafları ----------

dbTest('fotoğraf: birden çok fotoğraf; aynı içerik tekrar / eşzamanlı → tek kayıt; yetkisiz rol ve uygun olmayan adım reddedilir; değişmez', offline(async () => {
  const early = await approvedOrder([['GK15', 1]]);
  assert.deepEqual(await recordDeliveryPhoto(db, { orderId: early.id, stored: photoFile(), actor: actor(people.admin) }), { ok: false, code: 'STATE' }, 'depoya gitmeden');
  const { id } = await depotOrder();
  for (const who of ['sales', 'drawer', 'inspector', 'cust']) {
    assert.deepEqual(await recordDeliveryPhoto(db, { orderId: id, stored: photoFile(), actor: actor(people[who]) }), { ok: false, code: 'FORBIDDEN' }, who);
  }
  const a = await recordDeliveryPhoto(db, { orderId: id, stored: photoFile('a.jpg'), actor: depotActor('1.2.3.4') });
  const b = await recordDeliveryPhoto(db, { orderId: id, stored: photoFile('b.jpg'), actor: actor(people.admin) });
  const sameFile = photoFile('c.jpg');
  const c = await recordDeliveryPhoto(db, { orderId: id, stored: sameFile, actor: depotActor('1.2.3.4') });
  assert.ok(a.ok && b.ok && c.ok && !a.duplicate && !b.duplicate && !c.duplicate);
  // Aynı fotoğraf yeniden (farklı ad, aynı içerik) → tekrar
  const again = await recordDeliveryPhoto(db, { orderId: id, stored: { ...sameFile, name: 'c-kopya.jpg', storageKey: `2026/10/${crypto.randomUUID()}.jpg` }, actor: depotActor('1.2.3.4') });
  assert.deepEqual(again, { ok: true, photoId: c.photoId, duplicate: true });
  // Eşzamanlı aynı içerik: tek kayıt
  const twin = photoFile('d.jpg');
  const many = await Promise.all(Array.from({ length: 5 }, () => recordDeliveryPhoto(db, { orderId: id, stored: { ...twin, storageKey: `2026/10/${crypto.randomUUID()}.jpg` }, actor: depotActor('1.2.3.4') })));
  assert.ok(many.every((r) => r.ok));
  assert.equal(many.filter((r) => !r.duplicate).length, 1);
  assert.equal(new Set(many.map((r) => r.photoId)).size, 1);
  // Başarısız bir yükleme (uygun olmayan sipariş) öncekileri silmez
  await recordDeliveryPhoto(db, { orderId: early.id, stored: photoFile(), actor: actor(people.admin) });
  assert.equal(await db.deliveryPhoto.count({ where: { orderId: id } }), 4);
  assert.equal(await db.orderFile.count({ where: { orderId: id, source: 'DELIVERY_PHOTO' } }), 4, 'tekrarlar dosya satırı da bırakmaz');
  const files = await db.orderFile.findMany({ where: { orderId: id, source: 'DELIVERY_PHOTO' }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(files.map((f) => [f.kind, f.uploadedById]), [['INTERNAL', null], ['INTERNAL', people.admin.id], ['INTERNAL', null], ['INTERNAL', null]]);
  assert.equal(await db.auditLog.count({ where: { entityId: id, action: 'DELIVERY_PHOTO_ADDED' } }), 4);
  // Değişmez: güncelleme / silme veritabanında reddedilir
  await assert.rejects(db.deliveryPhoto.delete({ where: { id: a.photoId } }));
  await assert.rejects(db.deliveryPhoto.update({ where: { id: a.photoId }, data: { via: 'X' } }));
  await assert.rejects(db.orderFile.delete({ where: { id: files[0].id } }), 'fotoğrafın dosya satırı da silinemez');
  // Sayfa listesi: müşteriye kişi adı gitmez; iç ekipte yöneticinin adı
  const cust = await deliveryDocs(db, id, { staff: false });
  const staff = await deliveryDocs(db, id, { staff: true });
  assert.ok(cust.photos.every((p) => p.by === null));
  assert.deepEqual(staff.photos.map((p) => p.by), [null, people.admin.name, null, null]);
}));

dbTest('fotoğraf erişimi: siparişin müşterisi ve siparişi gören iç ekip; başka firma, satış ve çizim göremez', offline(async () => {
  const { id } = await depotOrder();
  const r = await recordDeliveryPhoto(db, { orderId: id, stored: photoFile(), actor: depotActor('1.2.3.4') });
  // Dosya yolunun sorgusu (app/dosya/[kind]/[id]/route.ts → teslimat): sipariş kapsamı
  const find = (who) => db.deliveryPhoto.findFirst({ where: { id: r.photoId, order: scopeOf(who) }, select: { id: true } });
  for (const who of ['cust', 'admin', 'inspector']) assert.ok(await find(who), who);
  for (const who of ['other', 'sales', 'drawer']) assert.equal(await find(who), null, who);
  // Silinmiş sipariş: kimse göremez
  await db.order.update({ where: { id }, data: { removedAt: new Date() } });
  for (const who of ['cust', 'admin']) assert.equal(await find(who), null, `silinmiş: ${who}`);
  await db.order.update({ where: { id }, data: { removedAt: null } });
}));

// ---------- teslimat raporu ----------

dbTest('rapor: yalnızca yönetici / depo; kopya + sürüm; aynı içerik ve aynı form anahtarı tek rapor; teslim onayından sonra da açılır; değişmez', offline(async () => {
  const early = await approvedOrder([['GK15', 1]]);
  assert.deepEqual(await createDeliveryReport(db, { orderId: early.id, actor: actor(people.admin) }), { ok: false, code: 'STATE' });
  const { id, orderNo } = await depotOrder([['GK15', 3]]);
  for (const who of ['sales', 'drawer', 'inspector', 'cust']) assert.deepEqual(await createDeliveryReport(db, { orderId: id, actor: actor(people[who]) }), { ok: false, code: 'FORBIDDEN' }, who);
  await recordDeliveryPhoto(db, { orderId: id, stored: photoFile('ilk.jpg'), actor: depotActor('1.2.3.4') });
  const key = crypto.randomBytes(18).toString('base64url');
  // Çift gönderim (aynı form anahtarı) → tek rapor
  const twice = await Promise.all([1, 2].map(() => createDeliveryReport(db, { orderId: id, note: 'Kutular sağlam', requestKey: key, actor: depotActor('1.2.3.4') })));
  assert.ok(twice.every((r) => r.ok && r.revision === 1));
  assert.equal(new Set(twice.map((r) => r.reportId)).size, 1);
  // Aynı içerik yeni anahtarla → yeni sürüm yok
  const same = await createDeliveryReport(db, { orderId: id, note: 'Kutular sağlam', requestKey: crypto.randomBytes(18).toString('base64url'), actor: depotActor('1.2.3.4') });
  assert.deepEqual([same.ok, same.revision, same.duplicate], [true, 1, true]);
  // Yeni fotoğraf → sürüm 2 (yönetici); eski rapor kalır
  await recordDeliveryPhoto(db, { orderId: id, stored: photoFile('ikinci.jpg'), actor: actor(people.admin) });
  const r2 = await createDeliveryReport(db, { orderId: id, note: 'Kutular sağlam', actor: actor(people.admin) });
  assert.deepEqual([r2.ok, r2.revision, r2.duplicate], [true, 2, false]);
  const reports = await db.deliveryReport.findMany({ where: { orderId: id }, orderBy: { revision: 'asc' } });
  assert.deepEqual(reports.map((r) => [r.revision, r.via, r.stage, r.data.photos.length, r.data.items[0].qty, r.data.orderNo]), [[1, 'DEPOT_LINK', 'DEPODA', 1, 3, orderNo], [2, 'ADMIN', 'DEPODA', 2, 3, orderNo]]);
  assert.equal(await db.orderEvent.count({ where: { orderId: id, event: 'DELIVERY_REPORT' } }), 2);
  assert.equal(await db.auditLog.count({ where: { entityId: id, action: 'DELIVERY_REPORT_CREATED' } }), 2);
  await assert.rejects(db.deliveryReport.update({ where: { id: reports[0].id }, data: { note: 'değişti' } }), 'kopya değişmez');
  await assert.rejects(db.deliveryReport.delete({ where: { id: reports[0].id } }));
  // Teslim onayı sonrası: rapor erişimi sürer; müşteriye kişi adı yok, iç ekipte var; başka firma / satış göremez
  await runProfileAction(db, { orderId: id, action: 'mark_delivered', actor: depotActor('1.2.3.4'), payload: { files: [{ storageKey: `2026/10/${crypto.randomUUID()}.pdf`, name: 'imza.pdf', size: 10, mime: 'application/pdf', checksum: 'c', scanStatus: 'CLEAN' }] } });
  const render = (who, reportId, staff) => renderDeliveryReport(db, { reportId, orderWhere: scopeOf(who), locale: 'ro', staff, appUrl: 'https://takip.test' });
  const mine = await render('cust', reports[1].id, false);
  assert.ok(mine && mine.buf.subarray(0, 5).toString() === '%PDF-');
  assert.equal(mine.name, `Raport-Livrare-${orderNo}-2.pdf`);
  const pdfText = mine.buf.toString('latin1');
  // Fotoğraflar 32 × 16 (logo 1596 × 643 ve saydamlık maskesi ayrı görsel nesnesidir)
  assert.equal((pdfText.match(/\/Subtype \/Image \/Width 32 \/Height 16 /g) ?? []).length, 2, 'iki fotoğraf gömülü');
  assert.ok(pdfText.includes('/Subtype /Image /Width 1596 /Height 643 '), 'logo gömülü');
  const custText = textOf(mine.buf);
  assert.ok(custText.includes(orderNo) && custText.includes('Kutular sağlam') && custText.includes('Raport de livrare #2'));
  assert.ok(!custText.includes(people.admin.name), 'müşterinin raporunda iç ekipten kişi adı yok');
  assert.ok(textOf((await render('admin', reports[1].id, true)).buf).includes(people.admin.name), 'iç ekip yükleyeni görür');
  assert.ok(await render('admin', reports[0].id, true));
  assert.ok(await render('inspector', reports[0].id, true));
  for (const who of ['other', 'sales', 'drawer']) assert.equal(await render(who, reports[1].id, false), null, who);
  // Teslimden sonra yeni rapor da açılabilir (durum: teslim edildi)
  const r3 = await createDeliveryReport(db, { orderId: id, actor: depotActor('1.2.3.4') });
  assert.equal((await db.deliveryReport.findUnique({ where: { id: r3.reportId } })).stage, 'TESLIM_EDILDI');
  // İptal edilen siparişe rapor / fotoğraf eklenmez; eski raporlar okunur
  const { id: id2 } = await depotOrder([['GK15', 1]]);
  await createDeliveryReport(db, { orderId: id2, actor: actor(people.admin) });
  await run(id2, 'cancel', 'admin', { note: 'iptal' });
  assert.deepEqual(await createDeliveryReport(db, { orderId: id2, note: 'x', actor: actor(people.admin) }), { ok: false, code: 'STATE' });
  assert.deepEqual(await recordDeliveryPhoto(db, { orderId: id2, stored: photoFile(), actor: actor(people.admin) }), { ok: false, code: 'STATE' });
  const old = await db.deliveryReport.findFirstOrThrow({ where: { orderId: id2 } });
  assert.ok(await render('cust', old.id, false));
}));
