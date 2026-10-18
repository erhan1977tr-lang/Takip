// DÜZELTME 10 — Aşama 2B (3.97.0), gerçek PostgreSQL ile: M9 en çok 10 tedarikçi adresi (eşitleme, her alıcıya ayrı ileti,
// alıcı başına en çok bir kez, kısmi hata, "Tekrar gönder" yalnızca almayana), M5 tedarikçi ürün kodu (onayda kopya, kodsuz
// onay / gönderim yok, eski sipariş kodu değişmez), M2 açılış bakiyesi (tek servis, mükerrer form, iptal / karşı kayıt,
// para birimleri ayrı), M6 nakliye (EUR / RON kur, birim başına eşit pay, aynı fatura iki kez yok, iptal, kısmi kabul ve
// düzeltme sonrası stok maliyeti, ticari teklif önerisi). Gerçek e-posta YOK (sahte taşıyıcı, .test), ağ isteği yok.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { resetEnvCache } from '../../server/env.js';

const UPLOAD = fs.mkdtempSync(path.join(os.tmpdir(), 'takip-d10-2b-'));
process.env.UPLOAD_DIR = UPLOAD;
resetEnvCache();
const svc = await import('../../server/suppliers/service.js');
const costs = await import('../../server/suppliers/costs.js');
const recv = await import('../../server/suppliers/receipt.js');
const { dispatchSupplierOrderEmails } = await import('../../server/suppliers/dispatch.js');
const { localDay } = await import('../../server/profile/dates.js');
const commercial = await import('../../server/commercial/service.js');
const { runReport } = await import('../../server/reports/service.js');

const TZ = 'Europe/Bucharest';
const TODAY = localDay(new Date(), TZ);
let db;
const U = {};
const act = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const A = () => act(U.admin);
const key = () => randomUUID().replace(/-/g, '');
const prod = (code) => db.profileProduct.findUniqueOrThrow({ where: { code } });

/** Sahte taşıyıcı: alıcıya göre davranış (ok | conn | 550) */
function transport(by = {}) {
  const sent = [];
  return {
    sent,
    async sendMail(m) {
      const mode = by[m.to] ?? 'ok';
      if (mode === 'conn') throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', command: 'CONN' });
      if (mode === '550') throw Object.assign(new Error('550 mailbox unavailable'), { responseCode: 550, command: 'RCPT TO' });
      sent.push(m);
      return { messageId: `<m${sent.length}@test>` };
    },
  };
}
const dispatch = (t, now = new Date()) => dispatchSupplierOrderEmails(db, { transport: t, from: 'siparis@gkh.test', now, log: () => {} });

async function supplier(name, emails, extra = {}) {
  const r = await svc.saveSupplier(db, { name, emails, currency: 'EUR', ...extra }, A());
  assert.ok(r.ok, JSON.stringify(r));
  return db.supplier.findUniqueOrThrow({ where: { id: r.id }, include: { emails: { orderBy: { sortOrder: 'asc' } } } });
}
/** Taslak + satırlar → onay. lines: [kod, adet, fiyat?] */
async function sentOrder(sup, lines) {
  const c = await svc.createDraftOrder(db, { supplierId: sup.id }, A(), { timeZone: TZ });
  assert.ok(c.ok, JSON.stringify(c));
  const ids = await Promise.all(lines.map(async ([code]) => (await prod(code)).id));
  let o = await db.supplierOrder.findUniqueOrThrow({ where: { id: c.id } });
  const s = await svc.saveDraft(db, { orderId: c.id, version: o.version, orderDate: TODAY, note: '', lines: lines.map(([, qty, price], i) => ({ productId: ids[i], qty, unitPrice: price ?? '' })) }, A(), { timeZone: TZ });
  assert.ok(s.ok, JSON.stringify(s));
  o = await db.supplierOrder.findUniqueOrThrow({ where: { id: c.id } });
  return { id: c.id, approve: () => svc.approveAndSend(db, { orderId: c.id, version: o.version }, A()) };
}
async function receive(orderId, q) {
  const rev = await db.supplierOrderRevision.findFirstOrThrow({ where: { orderId, finalizedAt: { not: null } }, orderBy: { revision: 'desc' }, include: { lines: true } });
  const quantities = Object.fromEntries(Object.entries(q).map(([code, n]) => [rev.lines.find((l) => l.code === code).id, String(n)]));
  const r = await recv.receiveGoods(db, { orderId, receivedOn: TODAY, reference: null, requestKey: key(), quantities }, A(), { timeZone: TZ });
  assert.ok(r.ok, JSON.stringify(r));
  return r.receiptId;
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  const mk = (k, appRole) => db.user.create({ data: { email: `${k}@d10.test`, name: k, type: 'INTERNAL', appRole, customerId: factory.id } }).then((u) => { U[k] = u; });
  await mk('admin', 'ADMIN');
  await mk('sales', 'SATIS');
});
after(async () => { await closeDb(); });

dbTest('M9: adres listesi eşitlenir (en çok 10, tekil, birincil etkin); Supplier.email birincilin kopyası; değişiklik denetimde', offline(async () => {
  const s = await supplier('D10 Çok Adres', [{ email: 'a@d10.test', isPrimary: true }, { email: 'b@d10.test' }, { email: 'c@d10.test', isActive: false }]);
  assert.deepEqual(s.emails.map((e) => [e.email, e.isActive, e.isPrimary]), [['a@d10.test', true, true], ['b@d10.test', true, false], ['c@d10.test', false, false]]);
  assert.equal(s.email, 'a@d10.test');
  // Düzenleme: a silinir, B büyük harfle aynı kalır, yeni d birincil
  const r = await svc.saveSupplier(db, { id: s.id, name: s.name, currency: 'EUR', emails: [{ email: 'B@d10.test' }, { email: 'd@d10.test', isPrimary: true }, { email: 'c@d10.test', isActive: true }] }, A());
  assert.ok(r.ok);
  const after2 = await db.supplierEmail.findMany({ where: { supplierId: s.id }, orderBy: { sortOrder: 'asc' } });
  assert.deepEqual(after2.map((e) => [e.email, e.isActive, e.isPrimary]), [['B@d10.test', true, false], ['d@d10.test', true, true], ['c@d10.test', true, false]]);
  assert.equal((await db.supplier.findUniqueOrThrow({ where: { id: s.id } })).email, 'd@d10.test');
  assert.deepEqual(await svc.recipientsOf(db, s.id), ['d@d10.test', 'B@d10.test', 'c@d10.test']);
  assert.ok(await db.auditLog.findFirst({ where: { action: 'SUPPLIER_EMAILS_CHANGED', entityId: s.id } }));
  // Hatalı listeler hiçbir şey değiştirmez
  assert.equal((await svc.saveSupplier(db, { id: s.id, name: s.name, currency: 'EUR', emails: [{ email: 'x@d10.test' }, { email: 'X@D10.TEST' }] }, A())).code, 'EMAIL_DUPLICATE');
  assert.equal((await svc.saveSupplier(db, { id: s.id, name: s.name, currency: 'EUR', emails: Array.from({ length: 11 }, (_, i) => ({ email: `u${i}@d10.test` })) }, A())).code, 'EMAIL_LIMIT');
  assert.equal((await svc.saveSupplier(db, { id: s.id, name: s.name, currency: 'EUR', emails: 'BAD' }, A())).code, 'EMAIL');
  assert.equal(await db.supplierEmail.count({ where: { supplierId: s.id } }), 3);
}));

dbTest('M5 + M9: kodsuz ürünle onay yok; kodlar onayda kopyalanır; e-posta her etkin adrese ayrı, kodla; alıcı başına bir kez; kısmi hata → Tekrar gönder yalnızca almayana', offline(async () => {
  const s = await supplier('D10 Gönderim', [{ email: 'p1@d10.test', isPrimary: true }, { email: 'p2@d10.test' }, { email: 'p3@d10.test' }, { email: 'pasif@d10.test', isActive: false }]);
  await db.profileProduct.update({ where: { code: 'GK15' }, data: { supplierCode: null } });
  const o = await sentOrder(s, [['MC12', 5, '2.5'], ['GK15', 2, '1']]);
  const no = await o.approve();
  assert.equal(no.code, 'NO_SUPPLIER_CODE');
  assert.match(no.detail, /GK15/);
  assert.equal(await db.notificationOutbox.count({ where: svc.jobsWhere(o.id) }), 0);
  await db.profileProduct.update({ where: { code: 'GK15' }, data: { supplierCode: 'SUP-GK-15' } });
  const ok = await o.approve();
  assert.ok(ok.ok, JSON.stringify(ok));
  const lines = await db.supplierOrderLine.findMany({ where: { revision: { orderId: o.id, finalizedAt: { not: null } } }, orderBy: { sortOrder: 'asc' } });
  assert.deepEqual(lines.map((l) => [l.code, l.supplierCode]), [['MC12', 'TED-MC12'], ['GK15', 'SUP-GK-15']]);
  // Ürünün kodu sonradan değişse de kesin siparişin kodu değişmez
  await db.profileProduct.update({ where: { code: 'GK15' }, data: { supplierCode: 'YENI-KOD' } });
  // Gönderim: p2 bağlantı hatası (yeniden denenecek), p3 kalıcı ret
  const t1 = transport({ 'p2@d10.test': 'conn', 'p3@d10.test': '550' });
  const r1 = await dispatch(t1);
  assert.equal(r1.retried, 1);
  assert.deepEqual(t1.sent.map((m) => m.to), ['p1@d10.test']);
  assert.ok(t1.sent.every((m) => !String(m.to).includes(',') && !m.cc && !m.bcc), 'her alıcıya ayrı ileti');
  assert.match(t1.sent[0].html, /SUP-GK-15/);
  assert.doesNotMatch(t1.sent[0].html, />GK15</);
  // İkinci tur: yalnızca p2 yeniden denenir (p1 tekrar almaz, p3 kalıcı ret — yeniden denenmez)
  const t2 = transport();
  const r2 = await dispatch(t2, new Date(Date.now() + 3 * 60_000));
  assert.deepEqual(t2.sent.map((m) => m.to), ['p2@d10.test']);
  assert.equal(r2.failed, 1);
  const order = await db.supplierOrder.findUniqueOrThrow({ where: { id: o.id } });
  assert.deepEqual([order.status, order.sendError], ['GONDERIM_HATASI', 'PARTIAL']);
  const job = (await db.notificationOutbox.findMany({ where: svc.jobsWhere(o.id) }))[0];
  assert.deepEqual([...job.payload.sentTo].sort(), ['p1@d10.test', 'p2@d10.test']);
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'SUPPLIER_ORDER_EMAIL_FAILED', entityId: o.id }, orderBy: { createdAt: 'desc' } });
  assert.deepEqual(audit.details.recipients.map((x) => [x.to, x.result]), [['p1@d10.test', 'SENT'], ['p2@d10.test', 'SENT'], ['p3@d10.test', 'SMTP 550']]);
  // Tekrar gönder: yalnızca p3
  const rs = await svc.resendOrder(db, { orderId: o.id }, A());
  assert.ok(rs.ok, JSON.stringify(rs));
  const t3 = transport();
  await dispatch(t3);
  assert.deepEqual(t3.sent.map((m) => m.to), ['p3@d10.test']);
  assert.equal((await db.supplierOrder.findUniqueOrThrow({ where: { id: o.id } })).status, 'GONDERILDI');
  // Herkes aldı → yeni "Tekrar gönder" yok
  await db.supplierOrder.update({ where: { id: o.id }, data: { status: 'GONDERIM_HATASI' } });
  assert.equal((await svc.resendOrder(db, { orderId: o.id }, A())).code, 'ALREADY_SENT');
}));

dbTest('M9: gönderim sırasında yarıda kalan alıcı belirsiz sayılır, otomatik yeniden GÖNDERİLMEZ; etkin adres yoksa onay yok', offline(async () => {
  const s = await supplier('D10 Yarıda', [{ email: 'y1@d10.test', isPrimary: true }, { email: 'y2@d10.test' }]);
  const o = await sentOrder(s, [['MC12', 1, '1']]);
  assert.ok((await o.approve()).ok);
  const job = (await db.notificationOutbox.findMany({ where: svc.jobsWhere(o.id) }))[0];
  // İşçi y1'e gönderirken çökmüş gibi: işaret yazılı, kira dolmuş
  await db.notificationOutbox.update({ where: { id: job.id }, data: { attempts: 1, payload: { ...job.payload, recipients: ['y1@d10.test', 'y2@d10.test'], sentTo: [], unknown: [], sending: 'y1@d10.test' } } });
  const t = transport();
  await dispatch(t);
  assert.deepEqual(t.sent.map((m) => m.to), ['y2@d10.test']);
  const done = await db.notificationOutbox.findUniqueOrThrow({ where: { id: job.id } });
  assert.deepEqual([done.status, done.payload.unknown], ['FAILED', ['y1@d10.test']]);
  // Etkin adres yok → onay yok
  const s2 = await supplier('D10 Pasif Adres', [{ email: 'z@d10.test', isActive: false }]);
  const o2 = await sentOrder(s2, [['MC12', 1, '1']]);
  assert.equal((await o2.approve()).code, 'NO_EMAIL');
}));

dbTest('M2: açılış bakiyesi — ayrı alan, tek servis (hesap, özet, rapor), mükerrer form tek kayıt, iptal ve karşı kayıt, para birimleri ayrı', offline(async () => {
  const s = await supplier('D10 Açılış', [{ email: 'o@d10.test' }]);
  const k = key();
  const a = await svc.addOpening(db, { supplierId: s.id, asOf: TODAY, amount: '1000', currency: 'EUR', direction: 'DEBT', note: 'devir', requestKey: k }, A(), { timeZone: TZ });
  assert.ok(a.ok);
  const again = await svc.addOpening(db, { supplierId: s.id, asOf: TODAY, amount: '1000', currency: 'EUR', direction: 'DEBT', requestKey: k }, A(), { timeZone: TZ });
  assert.deepEqual([again.ok, again.duplicate, again.id], [true, true, a.id]);
  // Karşı kayıt (−200) ve RON alacak
  assert.ok((await svc.addOpening(db, { supplierId: s.id, asOf: TODAY, amount: '200', currency: 'EUR', direction: 'CREDIT', correctsId: a.id, requestKey: key() }, A(), { timeZone: TZ })).ok);
  assert.equal((await svc.addOpening(db, { supplierId: s.id, asOf: TODAY, amount: '5', currency: 'RON', direction: 'DEBT', correctsId: a.id, requestKey: key() }, A(), { timeZone: TZ })).code, 'CURRENCY');
  assert.ok((await svc.addOpening(db, { supplierId: s.id, asOf: TODAY, amount: '50', currency: 'RON', direction: 'CREDIT', requestKey: key() }, A(), { timeZone: TZ })).ok);
  // Sipariş borcu + ödeme ile birlikte
  const o = await sentOrder(s, [['MC12', 10, '3']]);
  assert.ok((await o.approve()).ok);
  assert.ok((await svc.addPayment(db, { supplierId: s.id, paidOn: TODAY, amount: '10', currency: 'EUR', requestKey: key() }, A(), { timeZone: TZ })).ok);
  const acc = await svc.supplierAccount(db, s.id);
  assert.deepEqual(acc.balances, {
    EUR: { opening: '800.00', debt: '30.00', paid: '10.00', balance: '820.00', orders: 1, missingPrice: 0 },
    RON: { opening: '-50.00', debt: '0.00', paid: '0.00', balance: '-50.00', orders: 0, missingPrice: 0 },
  });
  const sum = (await svc.supplierAccounts(db)).find((x) => x.supplier.id === s.id);
  assert.deepEqual(sum.balances, acc.balances);
  // Rapor (finans) aynı servisten
  const rep = await runReport(db, { kind: 'finance', month: TODAY.slice(0, 7) }, { actor: A(), now: new Date(), timeZone: TZ });
  assert.ok(rep.ok, JSON.stringify(rep));
  const tbl = rep.report.tables.find((x) => x.key === 'supplierBalances');
  assert.ok(tbl, 'tedarikçi bakiyeleri tablosu');
  // İptal: bakiyeden çıkar, ikinci iptal yok
  assert.ok((await svc.voidOpening(db, { openingId: a.id, reason: 'yanlış tutar' }, A())).ok);
  assert.equal((await svc.voidOpening(db, { openingId: a.id, reason: 'x' }, A())).code, 'ALREADY_VOID');
  assert.equal((await svc.supplierAccount(db, s.id)).balances.EUR.opening, '-200.00');
  assert.ok(await db.auditLog.findFirst({ where: { action: 'SUPPLIER_OPENING_VOIDED', entityId: a.id } }));
  // Yetki
  assert.equal((await svc.addOpening(db, { supplierId: s.id, asOf: TODAY, amount: '1', currency: 'EUR', direction: 'DEBT', requestKey: key() }, act(U.sales))).code, 'FORBIDDEN');
}));

dbTest('M6: nakliye — kısmi kabul + düzeltme sonrası gerçek miktar, birim başına eşit pay, RON kayıtlı kurla, aynı fatura iki kez yok, stok maliyeti ve ticari teklif önerisi; tedarikçi borcu ve stok değişmez', offline(async () => {
  const s = await supplier('D10 Nakliye', [{ email: 'n@d10.test' }]);
  const o1 = await sentOrder(s, [['MC12', 10, '2'], ['GK15', 30, '3']]);
  assert.ok((await o1.approve()).ok);
  const r1 = await receive(o1.id, { MC12: 10, GK15: 20 }); // GK15 kısmi
  const o2 = await sentOrder(s, [['MC12', 10, '4']]);
  assert.ok((await o2.approve()).ok);
  const r2 = await receive(o2.id, { MC12: 10 });
  const debtBefore = (await svc.supplierAccount(db, s.id)).balances.EUR.balance;
  const movesBefore = await db.stockMovement.count();
  // Nakliye bir tedarikçi siparişinin sayfasından girilir (3.97.6): başka siparişin kabulü bağlanamaz
  const base = { orderId: o1.id, carrierName: 'Trans SRL', invoiceNo: 'TR-1', invoiceDate: TODAY, receiptIds: [r1] };
  assert.equal((await costs.createTransport(db, { ...base, receiptIds: [r1, r2], amount: '1', currency: 'EUR', requestKey: key() }, A(), { timeZone: TZ })).code, 'RECEIPT_GONE');
  const opts = await costs.transportReceiptOptions(db, A(), o1.id);
  assert.deepEqual(opts.receipts.map((r) => [r.id, r.qty]), [[r1, 30]]);
  // RON kur yoksa reddedilir
  assert.equal((await costs.createTransport(db, { ...base, amount: '300', currency: 'RON', requestKey: key() }, A(), { timeZone: TZ })).code, 'FX_REQUIRED');
  // 300 RON / 5 = 60 EUR; toplam miktar 10 + 20 = 30 → birim başına 2 EUR
  const k = key();
  const t = await costs.createTransport(db, { ...base, amount: '300', currency: 'RON', fxRate: '5', requestKey: k }, A(), { timeZone: TZ });
  assert.ok(t.ok, JSON.stringify(t));
  assert.equal((await costs.createTransport(db, { ...base, amount: '300', currency: 'RON', fxRate: '5', requestKey: k }, A(), { timeZone: TZ })).duplicate, true);
  assert.equal((await costs.createTransport(db, { ...base, carrierName: ' trans  srl ', amount: '1', currency: 'EUR', requestKey: key() }, A(), { timeZone: TZ })).code, 'DUPLICATE_INVOICE');
  const row = await db.transportCost.findUniqueOrThrow({ where: { id: t.id }, include: { allocations: true } });
  assert.deepEqual([row.amountEur.toString(), row.fxRate.toString(), row.currency], ['60', '5', 'RON']);
  assert.equal(row.allocations.reduce((n, a) => n + Number(a.amountEur), 0).toFixed(4), '60.0000');
  assert.ok(row.allocations.every((a) => Number(a.amountEur) / a.qty === 2));
  // Sipariş sayfasının listesi: yalnızca o siparişe bağlı kayıtlar
  assert.deepEqual((await costs.listTransports(db, A(), { orderId: o1.id })).rows.map((x) => x.id), [t.id]);
  assert.deepEqual((await costs.listTransports(db, A(), { orderId: o2.id })).rows, []);
  // Stok hareketi ve tedarikçi borcu değişmedi
  assert.equal(await db.stockMovement.count(), movesBefore);
  assert.equal((await svc.supplierAccount(db, s.id)).balances.EUR.balance, debtBefore);
  // Stok maliyeti: MC12 = (10×2 + 10×4 + 10×2) / 20 = 4; GK15 = (20×3 + 20×2) / 20 = 5
  const c = await costs.productStockCosts(db, [(await prod('MC12')).id, (await prod('GK15')).id]);
  assert.equal(c.get((await prod('MC12')).id).avgEur, '4.00');
  assert.equal(c.get((await prod('GK15')).id).avgEur, '5.00');
  // Ticari teklif düzenleyicisi gerçekleşen stok maliyetini önerir (katalog alış fiyatından ayrı)
  const cat = await commercial.editorCatalog(db, A());
  const mc = cat.profile.find((p) => p.code === 'MC12');
  assert.equal(mc.stockCostEur, '4.00');
  // İptal: maliyetten çıkar; taşıyıcı borcundan çıkar
  assert.ok((await costs.voidTransport(db, { transportId: t.id, reason: 'yanlış fatura' }, A())).ok);
  assert.equal((await costs.productStockCosts(db, [(await prod('MC12')).id])).get((await prod('MC12')).id).avgEur, '3.00');
  const list = await costs.listTransports(db, A());
  assert.equal(list.carriers.length, 0);
  // Aynı fatura iptalden sonra yeniden girilebilir
  assert.ok((await costs.createTransport(db, { ...base, amount: '60', currency: 'EUR', requestKey: key() }, A(), { timeZone: TZ })).ok);
  // Yetki
  assert.equal((await costs.createTransport(db, { ...base, invoiceNo: 'X', amount: '1', currency: 'EUR', requestKey: key() }, act(U.sales))).code, 'FORBIDDEN');
}));

dbTest('M9 migration: mevcut tek adres birincil + etkin olarak taşınır; ikinci çalıştırma kayıt eklemez; boş / listesi olan atlanır', offline(async () => {
  const dir = fs.readdirSync(path.resolve('prisma/migrations')).find((d) => d.endsWith('_supplier_email_backfill'));
  assert.ok(dir, 'migration klasörü');
  const sql = fs.readFileSync(path.resolve('prisma/migrations', dir, 'migration.sql'), 'utf8');
  const old = await db.supplier.create({ data: { name: 'D10 Eski Adres', email: ' Eski@D10.test ', currency: 'EUR' } });
  const none = await db.supplier.create({ data: { name: 'D10 Adressiz', email: null, currency: 'EUR' } });
  const listed = await supplier('D10 Listeli', [{ email: 'liste@d10.test' }]);
  await db.supplier.update({ where: { id: listed.id }, data: { email: 'baska@d10.test' } });
  await db.$executeRawUnsafe(sql);
  await db.$executeRawUnsafe(sql);
  const rows = await db.supplierEmail.findMany({ where: { supplierId: old.id } });
  assert.deepEqual(rows.map((e) => [e.email, e.emailKey, e.isPrimary, e.isActive]), [['Eski@D10.test', 'eski@d10.test', true, true]]);
  assert.equal(await db.supplierEmail.count({ where: { supplierId: none.id } }), 0);
  assert.deepEqual((await db.supplierEmail.findMany({ where: { supplierId: listed.id } })).map((e) => e.email), ['liste@d10.test']);
  assert.deepEqual(await svc.recipientsOf(db, old.id), ['Eski@D10.test']);
}));
