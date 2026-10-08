// Paket 6 (kararlar 179–184) — veritabanıyla: tedarikçiler, ürünlerin alış bilgisi, tedarikçi siparişi (taslak, onay /
// gönder, revizyon, değişmezlik tetikleyicileri), e-posta işçisi (sahte taşıyıcı — gerçek e-posta YOK, gerçek tedarikçi
// adresi yok), tahmini yükleme tarihi hatırlatması, hesaplar ve stokla ilişki. Ağ isteği yok (offline).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { resetEnvCache } from '../../server/env.js';

const UPLOAD = fs.mkdtempSync(path.join(os.tmpdir(), 'takip-tedarik-'));
process.env.UPLOAD_DIR = UPLOAD;
resetEnvCache();
const svc = await import('../../server/suppliers/service.js');
const { dispatchSupplierOrderEmails } = await import('../../server/suppliers/dispatch.js');
const { saveProduct } = await import('../../server/profile/catalog.js');
const { MAIL_LOGO_CID } = await import('../../server/mail/send.js');

const TZ = 'Europe/Bucharest';
let db, factory, firm;
const U = {};
const act = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const A = () => act(U.admin);
const at = (iso) => new Date(iso);
const NOW = at('2026-10-08T09:00:00Z'); // Romanya'da 2026-10-08
const prod = (code) => db.profileProduct.findUniqueOrThrow({ where: { code }, include: { category: true } });
const jobs = (orderId) => db.notificationOutbox.findMany({ where: svc.jobsWhere(orderId), orderBy: { createdAt: 'asc' } });
const loadOrder = (id) => db.supplierOrder.findUniqueOrThrow({ where: { id }, include: { revisions: { orderBy: { revision: 'asc' }, include: { lines: { orderBy: { sortOrder: 'asc' } }, files: true } } } });

/** Sahte e-posta taşıyıcısı: gönderilenleri tutar; mode → hata türü (bağlantı / kalıcı ret) */
function transport(mode = 'ok') {
  const sent = [];
  return {
    sent,
    async sendMail(m) {
      if (mode === 'conn') throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:25'), { code: 'ECONNREFUSED', command: 'CONN' });
      if (mode === '550') throw Object.assign(new Error('550 5.1.1 mailbox unavailable'), { responseCode: 550, command: 'RCPT TO' });
      sent.push(m);
      return { messageId: `<m${sent.length}@test>` };
    },
  };
}
const dispatch = (t, now = new Date()) => dispatchSupplierOrderEmails(db, { transport: t, from: 'siparis@gkh.test', now, log: () => {} });

async function supplier(name, extra = {}) {
  const r = await svc.saveSupplier(db, { name, email: `${name.toLowerCase().replace(/[^a-z]/g, '')}@tedarikci.test`, currency: 'EUR', ...extra }, A());
  assert.ok(r.ok, JSON.stringify(r));
  return db.supplier.findUniqueOrThrow({ where: { id: r.id } });
}
/** Ürünün alış bilgisi (Profil Kataloğu formu) */
async function setPurchase(code, purchase, actor = A()) {
  const p = await prod(code);
  const value = { code: p.code, categoryCode: p.category.code, nameRo: p.nameRo, nameTr: p.nameTr, unitCode: p.unitCode, listPrice: p.listPrice == null ? null : Number(p.listPrice), isActive: p.isActive };
  return saveProduct(db, p.id, value, actor, undefined, purchase);
}
/** Taslak + satırlar (+ isteğe bağlı ek) → onay. Dönen: sipariş kimliği */
async function draft(sup, lines, { files = [] } = {}) {
  const c = await svc.createDraftOrder(db, { supplierId: sup.id }, A(), { now: NOW, timeZone: TZ });
  assert.ok(c.ok, JSON.stringify(c));
  const ids = await Promise.all(lines.map(async (l) => (await prod(l.code)).id));
  const o = await db.supplierOrder.findUniqueOrThrow({ where: { id: c.id } });
  const s = await svc.saveDraft(db, { orderId: c.id, version: o.version, orderDate: '2026-10-08', note: 'Not', lines: lines.map((l, i) => ({ productId: ids[i], qty: l.qty, unitPrice: l.price ?? '', color: l.color ?? '' })) }, A(), { now: NOW, timeZone: TZ });
  assert.ok(s.ok, JSON.stringify(s));
  if (files.length) {
    const stored = files.map((f, i) => {
      const key = `2026/10/tedarik-${c.id}-${i}.pdf`;
      fs.mkdirSync(path.join(UPLOAD, '2026/10'), { recursive: true });
      fs.writeFileSync(path.join(UPLOAD, key), f.content ?? '%PDF-1.4 teknik');
      return { storageKey: key, name: f.name, size: 15, mime: 'application/pdf', checksum: 'x', scanStatus: f.scanStatus ?? 'CLEAN', scannedAt: null };
    });
    assert.deepEqual(await svc.attachFiles(db, { orderId: c.id, stored }, A()), { ok: true });
  }
  return c.id;
}
async function approve(id) {
  const o = await db.supplierOrder.findUniqueOrThrow({ where: { id } });
  return svc.approveAndSend(db, { orderId: id, version: o.version }, A());
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db); // roller, sipariş tipleri, profil kataloğu
  factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Tedarik Cam', prefix: 'TED' } });
  const mk = (key, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${key}@tedarik.test`, name: key, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } })
      .then((u) => { U[key] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('admin2', 'ADMIN', factory.id);
  await mk('inspector', 'DENETIMCI', factory.id);
  await mk('sales', 'SATIS', factory.id);
  await mk('drawer', 'CIZIM', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true });
});
after(async () => {
  await closeDb();
  fs.rmSync(UPLOAD, { recursive: true, force: true });
});

dbTest('tedarikçi: ekle / düzenle / pasif (silinmez); ad tekil (Türkçe I); para birimi siparişten sonra kilitli; her değişiklik denetim kaydında', offline(async () => {
  const r = await svc.saveSupplier(db, { name: 'Işık Profil', contactName: 'Ayşe', email: 'siparis@isik.test', phone: '+90 212 000', address: 'İstanbul', currency: 'EUR' }, A());
  assert.ok(r.ok);
  assert.deepEqual(await svc.saveSupplier(db, { name: 'IŞIK PROFİL', email: '', currency: 'EUR' }, A()), { ok: false, code: 'EXISTS' });
  assert.deepEqual(await svc.saveSupplier(db, { name: 'Yeni', email: 'a@b.test, c@d.test', currency: 'EUR' }, A()), { ok: false, code: 'EMAIL', errors: ['EMAIL'] });
  // Düzenleme: e-posta yalnızca burada değişir; değişen alanlar denetim kaydında önce / sonra
  assert.deepEqual(await svc.saveSupplier(db, { id: r.id, name: 'Işık Profil', contactName: 'Ayşe', email: 'yeni@isik.test', phone: '+90 212 000', address: 'İstanbul', currency: 'EUR', isActive: true }, A()), { ok: true, id: r.id });
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'SUPPLIER_UPDATED', entityId: r.id } });
  assert.deepEqual(audit.details, { fields: ['email'], before: { email: 'siparis@isik.test' }, after: { email: 'yeni@isik.test' } });
  assert.equal(audit.userId, U.admin.id);
  // Pasif: kayıt durur; pasife yeni sipariş açılmaz
  assert.ok((await svc.setSupplierActive(db, { id: r.id, active: false }, A())).ok);
  assert.deepEqual(await svc.createDraftOrder(db, { supplierId: r.id }, A(), { now: NOW, timeZone: TZ }), { ok: false, code: 'SUPPLIER_INACTIVE' });
  assert.ok((await svc.setSupplierActive(db, { id: r.id, active: true }, A())).ok);
  assert.deepEqual((await db.auditLog.findMany({ where: { entityId: r.id }, orderBy: { createdAt: 'asc' } })).map((a) => a.action),
    ['SUPPLIER_CREATED', 'SUPPLIER_UPDATED', 'SUPPLIER_DEACTIVATED', 'SUPPLIER_ACTIVATED']);
  // Para birimi: siparişi olan tedarikçide değişmez
  const c = await svc.createDraftOrder(db, { supplierId: r.id }, A(), { now: NOW, timeZone: TZ });
  assert.ok(c.ok);
  assert.deepEqual(await svc.saveSupplier(db, { id: r.id, name: 'Işık Profil', email: 'yeni@isik.test', currency: 'USD' }, A()), { ok: false, code: 'CURRENCY_LOCKED' });
  // Yönetici dışı roller: hiçbir şey yazılmaz
  const before = await db.supplier.count();
  for (const who of ['inspector', 'sales', 'drawer', 'cust']) {
    assert.deepEqual(await svc.saveSupplier(db, { name: `X ${who}`, currency: 'EUR' }, act(U[who])), { ok: false, code: 'FORBIDDEN' });
    assert.deepEqual(await svc.setSupplierActive(db, { id: r.id, active: false }, act(U[who])), { ok: false, code: 'FORBIDDEN' });
  }
  assert.equal(await db.supplier.count(), before);
  await svc.deleteDraftOrder(db, { orderId: c.id }, A());
}));

dbTest('ürün alış bilgisi: yalnızca SUPPLIER_MANAGE; pasif tedarikçi seçilemez; müşterinin liste fiyatı değişmez; kayıtlı fiyat yalnızca aynı tedarikçi + para biriminde gelir', offline(async () => {
  const sup = await supplier('Conta Evi');
  const ron = await supplier('Lei Furnizor', { currency: 'RON' });
  const before = await prod('GK15');
  assert.deepEqual(await setPurchase('GK15', { supplierId: sup.id, purchasePrice: '12.5', purchaseCurrency: 'EUR', purchaseUnit: null }), { ok: true, id: before.id });
  const p = await prod('GK15');
  assert.equal(String(p.purchasePrice), '12.5');
  assert.equal(String(p.listPrice), String(before.listPrice), 'müşterinin liste fiyatı değişmez');
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'PROFILE_PRODUCT_UPDATE', entityId: p.id }, orderBy: { createdAt: 'desc' } });
  assert.deepEqual(audit.details.fields, ['supplierId', 'purchasePrice', 'purchaseCurrency']);
  // Denetimci alış bilgisini değiştiremez
  assert.deepEqual(await setPurchase('GK15', { supplierId: null, purchasePrice: null, purchaseCurrency: null, purchaseUnit: null }, act(U.inspector)), { ok: false, code: 'FORBIDDEN' });
  // Pasif tedarikçi yeni seçim olamaz
  const off = await supplier('Kapalı Firma');
  await svc.setSupplierActive(db, { id: off.id, active: false }, A());
  assert.deepEqual(await setPurchase('MC12', { supplierId: off.id, purchasePrice: '1', purchaseCurrency: 'EUR', purchaseUnit: null }), { ok: false, code: 'SUPPLIER' });
  // Sipariş: aynı tedarikçi + EUR → fiyat gelir; başka para birimindeki tedarikçiye fiyat gelmez (çevrilmez)
  const c1 = await svc.createDraftOrder(db, { supplierId: sup.id, items: [{ productId: p.id, qty: '4' }] }, A(), { now: NOW, timeZone: TZ });
  const c2 = await svc.createDraftOrder(db, { supplierId: ron.id, items: [{ productId: p.id, qty: '4' }] }, A(), { now: NOW, timeZone: TZ });
  const l1 = (await loadOrder(c1.id)).revisions[0].lines[0];
  const l2 = (await loadOrder(c2.id)).revisions[0].lines[0];
  assert.deepEqual([String(l1.unitPrice), l1.priceSource, String(l1.lineTotal)], ['12.5', 'CATALOG', '50']);
  assert.deepEqual([l2.unitPrice, l2.priceSource, l2.lineTotal], [null, null, null], 'fiyat uydurulmaz');
  for (const id of [c1.id, c2.id]) await svc.deleteDraftOrder(db, { orderId: id }, A());
}));

dbTest('taslak: kaydetmek, ürün / tarih / not değiştirmek, ek eklemek e-posta yazmaz; borç yok; stok değişmez; sürüm denetimi', offline(async () => {
  const sup = await supplier('Plastik AŞ');
  const stockBefore = await db.stockMovement.count();
  const id = await draft(sup, [{ code: 'MC12', qty: '10', price: '2,5' }], { files: [{ name: 'çizim.pdf' }] });
  const o = await loadOrder(id);
  assert.equal(o.status, 'TASLAK');
  assert.match(o.orderNo, /^TS-2026-\d{3}$/);
  // İkinci kayıt: eski sürümle → CONFLICT (üzerine yazılmaz)
  const p = await prod('MC16');
  const r = await svc.saveDraft(db, { orderId: id, version: o.version, orderDate: '2026-10-09', note: '', lines: [{ productId: p.id, qty: '3', unitPrice: '' }] }, A(), { now: NOW, timeZone: TZ });
  assert.ok(r.ok);
  assert.deepEqual(await svc.saveDraft(db, { orderId: id, version: o.version, orderDate: '2026-10-09', note: '', lines: [] }, A(), { now: NOW, timeZone: TZ }), { ok: false, code: 'CONFLICT' });
  // Numara taslakta değiştirilebilir, başka siparişin numarası alınamaz
  const other = await svc.createDraftOrder(db, { supplierId: sup.id }, A(), { now: NOW, timeZone: TZ });
  const v = (await loadOrder(id)).version;
  assert.deepEqual(await svc.saveDraft(db, { orderId: id, version: v, orderNo: other.orderNo, orderDate: '2026-10-09', note: '', lines: [{ productId: p.id, qty: '3' }] }, A(), { now: NOW, timeZone: TZ }), { ok: false, code: 'ORDER_NO_TAKEN' });
  assert.ok((await svc.saveDraft(db, { orderId: id, version: v, orderNo: 'gkh 15', orderDate: '2026-10-09', note: '', lines: [{ productId: p.id, qty: '3' }] }, A(), { now: NOW, timeZone: TZ })).ok);
  assert.equal((await loadOrder(id)).orderNo, 'GKH-15');
  assert.equal((await jobs(id)).length, 0, 'taslak e-posta işi yazmaz');
  assert.deepEqual((await svc.supplierAccount(db, sup.id)).balances, {}, 'taslak borç oluşturmaz');
  assert.equal(await db.stockMovement.count(), stockBefore);
  for (const x of [id, other.id]) assert.ok((await svc.deleteDraftOrder(db, { orderId: x }, A())).ok);
}));

dbTest('onay / gönder: tek iş; çift tıklama ve eşzamanlı istekler ikinci iş üretmez; kesin revizyon değişmez (tetikleyici); e-posta yoksa engellenir', offline(async () => {
  const sup = await supplier('Tek Gönderim');
  const id = await draft(sup, [{ code: 'MC12', qty: '10', price: '2.5' }, { code: 'MC16', qty: '1' }], { files: [{ name: 'a.pdf' }] });
  const o = await db.supplierOrder.findUniqueOrThrow({ where: { id } });
  const results = await Promise.all(Array.from({ length: 6 }, () => svc.approveAndSend(db, { orderId: id, version: o.version }, A())));
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  assert.ok(results.filter((r) => !r.ok).every((r) => ['NOT_DRAFT', 'CONFLICT'].includes(r.code)));
  assert.equal((await jobs(id)).length, 1);
  const after = await loadOrder(id);
  assert.equal(after.status, 'GONDERIM_BEKLIYOR');
  const rev = after.revisions[0];
  assert.ok(rev.finalizedAt);
  assert.deepEqual([String(rev.total), rev.missingPrice], ['25', true], 'toplam yalnızca fiyatlı satırlar; fiyatı eksik işaretli');
  // Kesin revizyon, satırları ve ekleri değişmez / silinmez (veritabanı tetikleyicisi)
  await assert.rejects(db.supplierOrderRevision.update({ where: { id: rev.id }, data: { note: 'değişti' } }), /final/i);
  await assert.rejects(db.supplierOrderLine.updateMany({ where: { revisionId: rev.id }, data: { qty: 99 } }), /final/i);
  await assert.rejects(db.supplierOrderLine.deleteMany({ where: { revisionId: rev.id } }), /final/i);
  await assert.rejects(db.supplierOrderLine.create({ data: { revisionId: rev.id, productId: rev.lines[0].productId, code: 'X', description: 'x', qty: 1, unitCode: 'BUCATI' } }), /final/i);
  await assert.rejects(db.supplierOrderFile.update({ where: { id: rev.files[0].id }, data: { name: 'baska.pdf' } }), /final/i);
  await assert.rejects(db.supplierOrder.delete({ where: { id } }), /final/i);
  // Arka plan taraması kesin revizyonun ekinde yalnızca tarama sonucunu yazabilir
  await db.supplierOrderFile.update({ where: { id: rev.files[0].id }, data: { scanStatus: 'CLEAN', scannedAt: new Date() } });
  // Taslak yoksa: düzenleme / ek yok
  assert.deepEqual(await svc.saveDraft(db, { orderId: id, version: after.version, orderDate: '2026-10-08', lines: [] }, A(), { now: NOW, timeZone: TZ }), { ok: false, code: 'NOT_DRAFT' });
  assert.deepEqual(await svc.fileQuota(db, { orderId: id, files: [{ name: 'b.pdf', size: 1 }] }, A()), { ok: false, code: 'NOT_DRAFT' });

  // E-posta yok / geçersiz → gönderim engellenir; revizyon kesinleşmez; iş yazılmaz
  const noMail = await supplier('Adressiz', { email: '' });
  const id2 = await draft(noMail, [{ code: 'MC12', qty: '1' }]);
  assert.deepEqual(await approve(id2), { ok: false, code: 'NO_EMAIL' });
  await db.supplier.update({ where: { id: noMail.id }, data: { email: 'bozuk adres' } }); // form dışı (eski veri)
  assert.deepEqual(await approve(id2), { ok: false, code: 'BAD_EMAIL' });
  const o2 = await loadOrder(id2);
  assert.deepEqual([o2.status, o2.revisions[0].finalizedAt, (await jobs(id2)).length], ['TASLAK', null, 0]);
  // Taranmamış / virüslü ek → gönderilmez
  const id3 = await draft(sup, [{ code: 'MC12', qty: '1' }], { files: [{ name: 'bekleyen.pdf', scanStatus: 'PENDING' }] });
  assert.deepEqual(await approve(id3), { ok: false, code: 'FILE_NOT_CLEAN', detail: 'bekleyen.pdf' });
  // Satırsız taslak onaylanmaz
  const empty = await svc.createDraftOrder(db, { supplierId: sup.id }, A(), { now: NOW, timeZone: TZ });
  assert.deepEqual(await approve(empty.id), { ok: false, code: 'NO_LINES' });
  // Yönetici dışı rol onaylayamaz
  for (const who of ['inspector', 'sales', 'drawer', 'cust']) {
    assert.deepEqual(await svc.approveAndSend(db, { orderId: id3, version: 0 }, act(U[who])), { ok: false, code: 'FORBIDDEN' });
  }
  assert.equal((await jobs(id3)).length, 0);
  await dispatch(transport()); // sonraki testlere kuyrukta iş kalmasın
}));

dbTest('işçi: başarılı gönderim → "Gönderildi"; tek e-posta (Türkçe konu, tablo, ek, logo); yeniden çalışınca ikinci e-posta yok', offline(async () => {
  const sup = await supplier('Başarılı Tedarik');
  const id = await draft(sup, [{ code: 'MC12', qty: '10', price: '2.5', color: 'RAL 7016' }], { files: [{ name: 'teknik-çizim.pdf' }] });
  assert.ok((await approve(id)).ok);
  const t = transport();
  const r = await dispatch(t);
  assert.equal(r.sent, 1);
  assert.equal(t.sent.length, 1);
  const m = t.sent[0];
  const o = await loadOrder(id);
  assert.equal(m.to, sup.email);
  assert.equal(m.from, 'GKH Trading Invest SRL <siparis@gkh.test>');
  assert.equal(m.subject, `GKH Trading Invest – Sipariş ${o.orderNo} – Başarılı Tedarik`);
  assert.ok(m.html.includes('Merhaba,') && m.html.includes('Birim Fiyat') && m.html.includes('25,00 EUR') && m.html.includes('RAL 7016'));
  assert.ok(m.text.includes('Siparişimizin tarafınıza ulaştığını ve tahmini yükleme tarihini teyit etmenizi rica ederiz.'));
  assert.deepEqual(m.attachments.map((a) => a.filename), ['teknik-çizim.pdf', m.attachments[1].filename]);
  assert.equal(m.attachments[1].cid, MAIL_LOGO_CID);
  assert.equal(String(m.attachments[0].content), '%PDF-1.4 teknik');
  assert.equal(o.status, 'GONDERILDI');
  assert.ok(o.sentAt);
  const [job] = await jobs(id);
  assert.deepEqual([job.status, job.payload.to, job.payload.attachments, job.payload.prices], ['SENT', sup.email, 1, true]);
  assert.ok(await db.auditLog.findFirst({ where: { action: 'SUPPLIER_ORDER_EMAIL_SENT', entityId: id } }));
  // İkinci tur: iş kapalı → gönderim yok
  const again = await dispatch(t);
  assert.deepEqual([again.sent, t.sent.length], [0, 1]);
  // Fiyatı olmayan satır: fiyat sütunları ve genel toplam e-postada yok
  const id2 = await draft(sup, [{ code: 'MC12', qty: '1', price: '3' }, { code: 'MC16', qty: '2' }]);
  assert.ok((await approve(id2)).ok);
  await dispatch(t);
  const m2 = t.sent[1];
  assert.ok(!m2.html.includes('Birim Fiyat') && !m2.html.includes('Genel Toplam') && !m2.html.includes('3,00'));
  assert.equal((await jobs(id2))[0].payload.prices, false);
  // SMTP ayarlı değilse (taşıyıcı yok) hiçbir şey yapılmaz, iş bekler
  const id3 = await draft(sup, [{ code: 'MC12', qty: '1' }]);
  assert.ok((await approve(id3)).ok);
  assert.deepEqual(await dispatchSupplierOrderEmails(db, { transport: null, from: 'x@gkh.test' }), { sent: 0, failed: 0, skipped: 0, retried: 0 });
  assert.equal((await jobs(id3))[0].status, 'PENDING');
  await dispatch(t); // sonraki testlere kuyrukta iş kalmasın
}));

dbTest('işçi: hata → "Gönderilemedi" (asla "Gönderildi" değil) + yöneticiye bildirim; "Tekrar gönder" açık kararla; bağlantı hatası güvenle yeniden denenir; yarıda kalan gönderim belirsiz sayılır, yeniden gönderilmez', offline(async () => {
  const sup = await supplier('Hatalı Tedarik');
  // Kalıcı ret (550)
  const id = await draft(sup, [{ code: 'MC12', qty: '1', price: '1' }]);
  assert.ok((await approve(id)).ok);
  const bad = transport('550');
  assert.equal((await dispatch(bad)).failed, 1);
  let o = await loadOrder(id);
  assert.deepEqual([o.status, o.sendError, o.sentAt], ['GONDERIM_HATASI', 'SMTP', null]);
  assert.deepEqual([(await jobs(id))[0].status, (await jobs(id))[0].lastError], ['FAILED', 'SMTP 550']);
  const notes = await db.notification.findMany({ where: { type: 'SUPPLIER_EMAIL_FAILED' } });
  assert.deepEqual(notes.map((n) => n.userId).sort(), [U.admin.id, U.admin2.id].sort(), 'yalnızca yöneticiler');
  assert.equal(notes[0].link, `/siparisler/tedarik/${id}`);
  // Otomatik yeniden gönderim yok
  const ok = transport();
  assert.equal((await dispatch(ok)).sent, 0);
  // "Tekrar gönder": yeni iş; kuyrukta iş varken ikincisi reddedilir
  assert.deepEqual(await svc.resendOrder(db, { orderId: id }, A()), { ok: true, attempt: 2 });
  assert.deepEqual(await svc.resendOrder(db, { orderId: id }, A()), { ok: false, code: 'NOT_ALLOWED' });
  assert.equal((await loadOrder(id)).status, 'GONDERIM_BEKLIYOR');
  assert.equal((await dispatch(ok)).sent, 1);
  o = await loadOrder(id);
  assert.deepEqual([o.status, o.sendError], ['GONDERILDI', null]);
  assert.deepEqual((await jobs(id)).map((j) => [j.status, j.payload.manual ?? false]), [['FAILED', false], ['SENT', true]]);

  // Bağlantı kurulamadı: ileti kesinlikle gitmedi → yeniden denenir (en çok 3 deneme), durum "Gönderim bekliyor" kalır
  const id2 = await draft(sup, [{ code: 'MC12', qty: '1' }]);
  assert.ok((await approve(id2)).ok);
  const conn = transport('conn');
  let now = new Date();
  assert.equal((await dispatch(conn, now)).retried, 1);
  let [j] = await jobs(id2);
  assert.deepEqual([j.status, j.lastError, j.payload.sendingAt], ['PENDING', 'SMTP_CONN', null]);
  assert.ok(j.availableAt > now);
  assert.equal((await loadOrder(id2)).status, 'GONDERIM_BEKLIYOR');
  assert.equal((await dispatch(conn, now)).retried, 0, 'bekleme süresi dolmadan denenmez');
  now = new Date(j.availableAt.getTime() + 1000);
  assert.equal((await dispatch(conn, now)).retried, 1);
  [j] = await jobs(id2);
  now = new Date(j.availableAt.getTime() + 1000);
  assert.equal((await dispatch(conn, now)).failed, 1, 'üçüncü deneme: gönderilemedi');
  assert.deepEqual([(await loadOrder(id2)).status, (await jobs(id2))[0].status], ['GONDERIM_HATASI', 'FAILED']);

  // Yarıda kalan gönderim (işçi gönderirken çöktü): sonuç belirsiz → yeniden GÖNDERİLMEZ
  const id3 = await draft(sup, [{ code: 'MC12', qty: '1' }]);
  assert.ok((await approve(id3)).ok);
  const [j3] = await jobs(id3);
  await db.notificationOutbox.update({ where: { id: j3.id }, data: { attempts: 1, payload: { ...j3.payload, sendingAt: new Date().toISOString() } } });
  const t3 = transport();
  assert.equal((await dispatch(t3)).failed, 1);
  assert.equal(t3.sent.length, 0);
  o = await loadOrder(id3);
  assert.deepEqual([o.status, o.sendError, (await jobs(id3))[0].lastError], ['GONDERIM_HATASI', 'UNKNOWN', 'UNKNOWN']);
}));

dbTest('revizyon: gönderilmiş sipariş değişmez; yeni revizyon ayrı onaylanıp "Revizyon 2" olarak gider; eski revizyonun bekleyen işi gönderilmez', offline(async () => {
  const sup = await supplier('Revizyon Tedarik');
  const id = await draft(sup, [{ code: 'MC12', qty: '5', price: '2' }]);
  assert.ok((await approve(id)).ok);
  let o = await loadOrder(id);
  const r = await svc.startRevision(db, { orderId: id, version: o.version }, A());
  assert.deepEqual(r, { ok: true, revision: 2 });
  assert.deepEqual(await svc.startRevision(db, { orderId: id, version: o.version + 1 }, A()), { ok: false, code: 'HAS_DRAFT' });
  o = await loadOrder(id);
  const p = await prod('MC16');
  assert.ok((await svc.saveDraft(db, { orderId: id, version: o.version, orderNo: 'DEGISMEZ', orderDate: '2026-10-08', note: 'rev 2', lines: [{ productId: p.id, qty: '7', unitPrice: '1' }] }, A(), { now: NOW, timeZone: TZ })).ok);
  o = await loadOrder(id);
  assert.notEqual(o.orderNo, 'DEGISMEZ', 'gönderilmiş siparişin numarası değişmez');
  assert.ok((await approve(id)).ok);
  const t = transport();
  const res = await dispatch(t);
  assert.deepEqual([res.sent, res.skipped], [1, 1]);
  const js = await jobs(id);
  assert.deepEqual(js.map((j) => [j.payload.revision, j.status, j.lastError]), [[1, 'SKIPPED', 'SUPERSEDED'], [2, 'SENT', null]]);
  assert.match(t.sent[0].subject, / – Revizyon 2$/);
  assert.ok(t.sent[0].text.includes('Bu e-posta siparişin 2. revizyonudur'));
  o = await loadOrder(id);
  // Revizyon 1 olduğu gibi duruyor
  assert.deepEqual(o.revisions.map((x) => [x.revision, x.lines.map((l) => `${l.code}×${l.qty}`).join(','), !!x.finalizedAt]), [[1, 'MC12×5', true], [2, 'MC16×7', true]]);
  // Hesaba son kesin revizyon girer (çift sayılmaz)
  assert.deepEqual((await svc.supplierAccount(db, sup.id)).balances.EUR, { debt: '7.00', paid: '0.00', balance: '7.00', orders: 1, missingPrice: 0 });
}));

dbTest('tahmini yükleme tarihi: yalnızca yönetici; 2 gün önce yöneticiye bir kez; tarih değişince yeni tarihe göre; başka role ve müşteriye gitmez; cam siparişine dokunmaz', offline(async () => {
  const glass = await db.order.create({ data: { orderNo: 'TED1', customerOrderNo: 1, customerId: firm.id, createdById: U.cust.id, estimatedShipDate: new Date('2026-10-20T12:00:00Z') } });
  const glassBefore = JSON.stringify(await db.order.findUniqueOrThrow({ where: { id: glass.id } }));
  const sup = await supplier('Takvim Tedarik');
  const id = await draft(sup, [{ code: 'MC12', qty: '1' }]);
  assert.deepEqual(await svc.setEta(db, { orderId: id, eta: '2026-10-15' }, A(), { now: NOW, timeZone: TZ }), { ok: false, code: 'NOT_ALLOWED' }, 'taslakta tarih yok');
  assert.ok((await approve(id)).ok);
  for (const who of ['inspector', 'sales', 'drawer', 'cust']) {
    assert.deepEqual(await svc.setEta(db, { orderId: id, eta: '2026-10-15' }, act(U[who]), { now: NOW, timeZone: TZ }), { ok: false, code: 'FORBIDDEN' });
  }
  assert.deepEqual(await svc.setEta(db, { orderId: id, eta: '2026-13-01' }, A(), { now: NOW, timeZone: TZ }), { ok: false, code: 'DATE' });
  assert.deepEqual(await svc.setEta(db, { orderId: id, eta: '2026-10-15' }, A(), { now: NOW, timeZone: TZ }), { ok: true, eta: '2026-10-15', changed: true });
  const reminders = () => db.notification.findMany({ where: { type: 'SUPPLIER_ETA' }, orderBy: { createdAt: 'asc' } });
  assert.equal((await reminders()).length, 0, 'tarih uzak: henüz hatırlatma yok');
  // 12 Ekim: henüz değil; 13 Ekim (2 gün önce): yöneticilere bir kez
  assert.deepEqual(await svc.remindSupplierEta(db, { now: at('2026-10-12T08:00:00Z'), timeZone: TZ }), { due: 0, created: 0 });
  assert.deepEqual(await svc.remindSupplierEta(db, { now: at('2026-10-13T06:00:00Z'), timeZone: TZ }), { due: 1, created: 2 });
  assert.deepEqual(await svc.remindSupplierEta(db, { now: at('2026-10-13T15:00:00Z'), timeZone: TZ }), { due: 1, created: 0 }, 'aynı tarih için ikinci kez yazılmaz');
  assert.deepEqual(await svc.remindSupplierEta(db, { now: at('2026-10-14T06:00:00Z'), timeZone: TZ }), { due: 1, created: 0 });
  let rs = await reminders();
  assert.deepEqual(rs.map((n) => n.userId).sort(), [U.admin.id, U.admin2.id].sort());
  assert.equal(rs[0].link, `/siparisler/tedarik/${id}`);
  assert.equal(rs[0].dedupeKey, `supplier-eta:${id}:2026-10-15`);
  assert.match(rs[0].message, /15\.10\.2026/);
  // Tarih değişti: yeni tarih için yeni hatırlatma (kaydederken, günü geldiyse hemen)
  const res = await svc.setEta(db, { orderId: id, eta: '2026-10-16' }, A(), { now: at('2026-10-14T07:00:00Z'), timeZone: TZ });
  assert.equal(res.changed, true);
  rs = await reminders();
  assert.equal(rs.length, 4);
  assert.deepEqual(rs.slice(2).map((n) => n.dedupeKey), [`supplier-eta:${id}:2026-10-16`, `supplier-eta:${id}:2026-10-16`]);
  // Başka rol ve müşteri hiç bildirim almadı; cam siparişi değişmedi
  for (const who of ['inspector', 'sales', 'drawer', 'cust']) assert.equal(await db.notification.count({ where: { userId: U[who].id } }), 0, who);
  assert.equal(JSON.stringify(await db.order.findUniqueOrThrow({ where: { id: glass.id } })), glassBefore);
  // Teslim alınınca açık değil: hatırlatma yok
  assert.ok((await svc.markReceived(db, { orderId: id }, A())).ok);
  assert.deepEqual(await svc.remindSupplierEta(db, { now: at('2026-10-15T06:00:00Z'), timeZone: TZ }), { due: 0, created: 0 });
  const audit = await db.auditLog.findMany({ where: { action: 'SUPPLIER_ORDER_ETA', entityId: id }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(audit.map((a) => [a.details.before, a.details.after]), [[null, '2026-10-15'], ['2026-10-15', '2026-10-16']]);
  await dispatch(transport()); // kuyrukta iş kalmasın
}));

dbTest('hesap: borç onaylanınca doğar (taslak değil), iptal düşer; ödeme form anahtarıyla bir kez; iptal edilen ödeme sayılmaz; para birimleri ayrı', offline(async () => {
  const sup = await supplier('Hesap Tedarik');
  const id1 = await draft(sup, [{ code: 'MC12', qty: '10', price: '12.5' }]);
  const id2 = await draft(sup, [{ code: 'MC12', qty: '1', price: '999' }]); // taslak kalır
  const id3 = await draft(sup, [{ code: 'MC12', qty: '4', price: '10' }, { code: 'MC16', qty: '1' }]);
  const id4 = await draft(sup, [{ code: 'MC12', qty: '1', price: '50' }]);
  for (const id of [id1, id3, id4]) assert.ok((await approve(id)).ok);
  assert.deepEqual(await svc.cancelOrder(db, { orderId: id4, reason: '' }, A()), { ok: false, code: 'REASON' });
  assert.ok((await svc.cancelOrder(db, { orderId: id4, reason: 'Tedarikçi stokta yok' }, A())).ok);
  assert.equal((await jobs(id4))[0].status, 'SKIPPED', 'iptal edilen siparişin bekleyen e-postası gönderilmez');
  // Ödemeler: aynı form iki kez → bir kayıt; başka para birimi ayrı satır
  const key = 'k-0123456789abcdef';
  const pay = (v) => svc.addPayment(db, { supplierId: sup.id, paidOn: '2026-10-05', note: 'Havale', requestKey: key, ...v }, A(), { now: NOW, timeZone: TZ });
  const p1 = await pay({ amount: '50', currency: 'EUR' });
  const p2 = await pay({ amount: '50', currency: 'EUR' });
  assert.deepEqual([p1.ok, p1.duplicate, p2.ok, p2.duplicate, p2.id === p1.id], [true, false, true, true, true]);
  const both = await Promise.all([1, 2, 3].map(() => svc.addPayment(db, { supplierId: sup.id, paidOn: '2026-10-06', amount: '10', currency: 'USD', requestKey: 'k-usd-0123456789ab' }, A(), { now: NOW, timeZone: TZ })));
  assert.equal(both.filter((r) => r.ok && !r.duplicate).length, 1, 'eşzamanlı aynı form: tek ödeme');
  assert.deepEqual(await svc.addPayment(db, { supplierId: sup.id, paidOn: '2026-10-09', amount: '1', currency: 'EUR', requestKey: 'k-gelecek-01234567' }, A(), { now: NOW, timeZone: TZ }), { ok: false, code: 'DATE' }, 'gelecek tarihli ödeme yok');
  assert.deepEqual(await svc.addPayment(db, { supplierId: sup.id, paidOn: '2026-10-05', amount: '0', currency: 'EUR', requestKey: 'k-sifir-012345678' }, A(), { now: NOW, timeZone: TZ }), { ok: false, code: 'AMOUNT' });
  const extra = await svc.addPayment(db, { supplierId: sup.id, paidOn: '2026-10-07', amount: '1000', currency: 'EUR', requestKey: 'k-yanlis-01234567' }, A(), { now: NOW, timeZone: TZ });
  assert.deepEqual(await svc.voidPayment(db, { paymentId: extra.id, reason: 'Yanlış giriş' }, A()), { ok: true });
  assert.deepEqual(await svc.voidPayment(db, { paymentId: extra.id, reason: 'tekrar' }, A()), { ok: false, code: 'ALREADY_VOID' });
  for (const who of ['inspector', 'sales', 'drawer', 'cust']) {
    assert.deepEqual(await svc.addPayment(db, { supplierId: sup.id, paidOn: '2026-10-05', amount: '1', currency: 'EUR', requestKey: `k-${who}-0123456789` }, act(U[who])), { ok: false, code: 'FORBIDDEN' });
  }
  const acc = await svc.supplierAccount(db, sup.id);
  assert.deepEqual(acc.balances, {
    EUR: { debt: '165.00', paid: '50.00', balance: '115.00', orders: 2, missingPrice: 1 },
    USD: { debt: '0.00', paid: '10.00', balance: '-10.00', orders: 0, missingPrice: 0 },
  });
  assert.deepEqual(acc.orders.map((o) => [o.status, o.counts]).sort(), [['GONDERIM_BEKLIYOR', true], ['GONDERIM_BEKLIYOR', true], ['IPTAL', false]].sort());
  assert.ok(!acc.orders.some((o) => o.id === id2), 'taslak hesapta yok');
  const all = await svc.supplierAccounts(db);
  assert.deepEqual(all.find((x) => x.supplier.id === sup.id)?.balances, acc.balances);
  assert.deepEqual((await db.auditLog.findMany({ where: { entityType: 'SupplierPayment' }, orderBy: { createdAt: 'asc' } })).map((a) => a.action),
    ['SUPPLIER_PAYMENT_ADDED', 'SUPPLIER_PAYMENT_ADDED', 'SUPPLIER_PAYMENT_ADDED', 'SUPPLIER_PAYMENT_VOIDED']);
  await dispatch(transport());
}));

dbTest('stok: sipariş, onay, e-posta, tahmini tarih ve teslim alma stoğu değiştirmez; beklenen tedarik ayrı tutulur ve teslimde düşer', offline(async () => {
  const sup = await supplier('Stok Tedarik');
  const p = await prod('AD45');
  const before = [await db.stockMovement.count(), JSON.stringify(await db.stockMovement.findMany({ orderBy: { id: 'asc' } }))];
  const id = await draft(sup, [{ code: 'AD45', qty: '6' }]);
  assert.equal((await svc.expectedSupplyMap(db)).get(p.id), undefined, 'taslak beklenen tedarik değil');
  assert.ok((await approve(id)).ok);
  assert.deepEqual((await svc.expectedSupplyMap(db)).get(p.id), { qty: 6, other: [], orders: 1 });
  await dispatch(transport());
  const o = await loadOrder(id);
  assert.ok((await svc.setEta(db, { orderId: id, eta: '2026-10-20' }, A(), { now: NOW, timeZone: TZ })).ok);
  assert.deepEqual(await svc.markReceived(db, { orderId: o.id }, A()), { ok: true });
  assert.equal((await loadOrder(id)).status, 'TESLIM_ALINDI');
  assert.equal((await svc.expectedSupplyMap(db)).get(p.id), undefined, 'teslim alınan sipariş beklenmez');
  assert.deepEqual([await db.stockMovement.count(), JSON.stringify(await db.stockMovement.findMany({ orderBy: { id: 'asc' } }))], before, 'stok hareketi yazılmadı');
}));
