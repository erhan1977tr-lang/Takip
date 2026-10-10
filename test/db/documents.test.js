// Mali belgeler (karar 111) — veritabanıyla: FGO kaleminde kaynak sipariş, belge kesilince TAKİP e-postası (PDF ekli,
// belge başına bir kez), e-posta durumu ve elle yeniden gönderme, müşterinin "Documente financiare" görünümü ve gizliliği,
// uygulama içi "belge hazır" bildirimi, tek seferlik fatura numarasının boşalması.
// FGO GERÇEKTİR: buradaki her FGO isteği sahte bir yanıtlayıcıya gider; gerçek ağ isteği yapılırsa test düşer.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';

const { saveFgoSettings, getFgoSettings } = await import('../../server/integrations/fgo.js');
const { dayKey } = await import('../../server/orders/loading.js');
const { refreshDocuments } = await import('../../server/accounting/receivables.js');
const g = await import('../../server/glass/billing.js');
const inv = await import('../../server/glass/invoice-batch.js');
const { snapshotLine } = await import('../../server/loading/confirmation.js');
const b = await import('../../server/glass/batch.js');
const d = await import('../../server/documents/delivery.js');
const cd = await import('../../server/documents/customer.js');
const n = await import('../../server/notifications/inapp.js');

const SECRET = 'd'.repeat(40);
const TZ = 'Europe/Bucharest';
const PDF = Buffer.from('%PDF-1.4\n% sahte belge\n');
let db, admin, A, B, uA, uA2, uB, seq = 100;
const net = [];
const realFetch = globalThis.fetch;
const actor = (role = 'ADMIN') => ({ id: admin.id, role, ip: '127.0.0.1' });
const noon = (offset) => new Date(`${dayKey(new Date(Date.now() + offset * 86_400_000))}T12:00:00Z`);
const bnr = (rate) => async () => ({ ok: true, rate, date: dayKey(new Date()), url: 'https://curs.bnr.ro/nbrfxrates.xml' });
const fgoOn = (extra = {}) => saveFgoSettings(db, {
  enabled: true, dailyLimit: 0, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21, invoiceNext: null, ...extra,
}, { key: 'K', secret: SECRET }, actor());

/**
 * Sahte FGO. emitere çağrıları `calls`ta, bütün adresler `urls`ta. getstatus: `paid` haritasından (belge no → ödenen).
 * print: yeni bir PDF bağlantısı verir (`print` verilirse onun döndürdüğü bağlantı). FGO dışındaki adres = PDF indirme (`pdf` yanıtlayıcısı).
 */
function fakeFgo(start, { emit = null, pdf = () => PDF, paid = {}, total = '605.00', print = null } = {}) {
  let num = start;
  const calls = [], urls = [], prints = [], downloads = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    urls.push(u);
    if (!u.includes('api-testuat.fgo.ro')) {
      downloads.push(u);
      const r = pdf(u);
      return r instanceof Response ? r : new Response(r, { headers: { 'content-type': 'application/pdf' } });
    }
    const form = Object.fromEntries(new URLSearchParams(init.body));
    if (u.endsWith('/factura/getstatus')) return new Response(JSON.stringify({ Success: true, Factura: { Valoare: total, ValoareAchitata: String(paid[`${form.Serie}${form.Numar}`] ?? '0') } }));
    if (u.endsWith('/factura/print')) {
      prints.push(`${form.Serie}${form.Numar}`);
      return new Response(JSON.stringify({ Success: true, Factura: { Link: print ? print(form) : `https://www.fgo.ro/print/${form.Serie}${form.Numar}.pdf` } }));
    }
    if (emit) { const r = emit(form); if (r) return r; }
    calls.push(form);
    num += 1;
    return new Response(JSON.stringify({ Success: true, Factura: { Numar: String(num), Serie: form.Serie, Link: `https://www.fgo.ro/facturi/${form.Serie}${num}.pdf` } }));
  };
  return { calls, urls, prints, downloads, fetchImpl, paid };
}
const ctx = (fgo, extra = {}) => ({ secret: SECRET, appUrl: 'https://takip.test', timeZone: TZ, fetchImpl: fgo.fetchImpl, bnrImpl: bnr('5.0000'), ...extra });
function mailbox() {
  const sent = [];
  return { sent, transport: { sendMail: async (m) => { sent.push(m); return {}; } } };
}
const mailCtx = (fgo, box, extra = {}) => ({ transport: box.transport, from: 'info@gkh.ro', appUrl: 'https://takip.test', secret: SECRET, timeZone: TZ, fetchImpl: fgo.fetchImpl, ...extra });

const customer = (name, prefix, data = {}) => db.customer.create({ data: { name, prefix, email: `${prefix.toLowerCase()}@belge.test`, taxId: '998877', county: 'Ilfov', city: 'Voluntari', address: 'Str. 1', fxPolicy: 'BNR', ...data } });
const user = (c, email) => db.user.create({ data: { email, name: email, type: 'CUSTOMER', appRole: 'MUSTERI', customerId: c.id } });
/** 2 m² × 50 EUR (müşteri fiyatı) → 500 RON + TVA = 605; isteğe bağlı CNC 2 × 10 */
async function order(c, shipDate, { cnc = false, no = null } = {}) {
  seq += 1;
  const num = no ?? seq;
  return db.order.create({
    data: {
      orderNo: `${c.prefix}${num}`, customerOrderNo: num, title: 'Ușă duș', orderTypeCode: 'GLASS_ORDER', customerId: c.id, createdById: admin.id, status: 'URETIMDE', estimatedShipDate: shipDate,
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '60.00', offerAmount: '100.00', createdById: admin.id, sentAt: new Date(),
        lines: { create: [
          { sortOrder: 0, description: 'Temper 10', descriptionRo: '6.2.6., Sticla, Gri-Transparent, securizata', enMm: 1000, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: '30', offerPrice: '50', kind: 'CAM' },
          ...(cnc ? [{ sortOrder: 1, description: 'CNC', adet: 2, unit: 'adet', unitPrice: '5', offerPrice: '10', kind: 'CNC' }] : []),
        ] } } },
    },
  });
}
const emails = (docId) => db.notificationOutbox.findMany({ where: { type: d.DOC_EMAIL, payload: { path: ['docId'], equals: docId } }, orderBy: { createdAt: 'asc' } });
const docsOf = (orderId) => db.fgoDocument.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
const keys = (form, field) => Object.keys(form).filter((k) => new RegExp(`^Continut\\[\\d+\\]\\[${field}\\]$`).test(k)).sort().map((k) => form[k]);
async function issue(o, kind, fgo) {
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind, actor: actor() }), { ok: true });
  return g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: o.id }));
}
let dayNo = 40;
/**
 * Nihai fatura (karar 239): onaylı yükleme (snapshotLine — confirmLoading ile aynı kopya) → yükleme gününün Faturalama
 * kartı → fatura partisi → işçi. Sipariş düzeyinde nihai fatura yoktur. { done, failed, batchId } döner.
 */
async function issueFinal(o, fgo) {
  const day = dayKey(new Date(`${new Date(Date.now() - (dayNo += 1) * 86_400_000).toISOString().slice(0, 10)}T12:00:00Z`));
  const conf = await db.loadingConfirmation.create({ data: { shipDay: new Date(`${day}T00:00:00Z`), confirmedById: admin.id, confirmedAt: new Date(`${day}T12:00:00Z`) } });
  const full = await db.order.findUnique({ where: { id: o.id }, include: { offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } } } });
  const offer = full.offers.find((x) => x.status === 'GONDERILDI');
  await db.loadingConfirmationItem.createMany({
    data: offer.lines.map((l) => snapshotLine(full, offer, l, { quantity: Number(l.adet) })).map((i) => ({ ...i, confirmationId: conf.id, scopeKey: `l:${i.offerLineId}`, m2: i.m2.toFixed(2), unitCost: i.unitCost.toFixed(2), unitSale: i.unitSale == null ? null : i.unitSale.toFixed(2), costAmount: i.costAmount.toFixed(4), saleAmount: i.saleAmount.toFixed(4) })),
  });
  const r = await inv.loadingBilling(db, { day, bnrImpl: bnr('5.0000') });
  const grp = r.customers.flatMap((c) => c.groups).find((x) => x.orders.some((y) => y.orderId === o.id));
  const created = await inv.createInvoiceBatch(db, { day, groupKey: grp.key, previewKey: grp.previewKey, actor: actor(), bnrImpl: bnr('5.0000') });
  assert.equal(created.ok, true, JSON.stringify(created));
  return { ...(await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: created.batchId, sleep: async () => {} }))), batchId: created.batchId };
}
const finalDocOf = (batchId) => db.fgoDocument.findFirst({ where: { batchId } });
const notices = (userId) => db.notification.findMany({ where: { userId, type: { in: Object.values(n.DOC_NOTICE) } }, orderBy: { createdAt: 'asc' } });

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  // Gerçek ağ isteği yapılırsa test düşer (FGO'ya, PDF adresine ya da başka yere)
  globalThis.fetch = async (u) => { net.push(String(u)); throw new Error(`gerçek ağ isteği: ${u}`); };
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  admin = await db.user.create({ data: { email: 'admin@belge.test', name: 'Admin', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
  A = await customer('Umi Glass SRL', 'UMI');
  B = await customer('Bravo SRL', 'BRV');
  uA = await user(A, 'a1@belge.test');
  uA2 = await user(A, 'a2@belge.test');
  uB = await user(B, 'b1@belge.test');
  await fgoOn();
});
after(async () => {
  globalThis.fetch = realFetch;
  await closeDb();
});

dbTest('sipariş belgesi: kalemde "Comanda UMI7"; belge yazılınca aynı işlemde TEK e-posta işi; e-posta PDF ekiyle bir kez gider; yeniden çalışan işçi / eşitleme / sayfa yinelemez', async () => {
  const o = await order(A, noon(10), { cnc: true, no: 7 });
  const fgo = fakeFgo(100);
  assert.deepEqual(await issue(o, 'PROFORMA', fgo), { done: 1, failed: 0 });

  // --- FGO kalemi: açıklama = kaynak sipariş; ad, birim, miktar, fiyat, TVA, IdExtern değişmedi
  const form = fgo.calls[0];
  assert.deepEqual(keys(form, 'Denumire'), ['6.2.6., Sticla, Gri-Transparent, securizata', 'Prelucrare CNC']);
  assert.deepEqual(keys(form, 'Descriere'), ['Comanda UMI7', 'Comanda UMI7']);
  assert.deepEqual([form['Continut[0][UM]'], form['Continut[0][NrProduse]'], form['Continut[0][PretUnitar]'], form['Continut[0][CotaTVA]']], ['mp', '2', '250.00', '21']);
  assert.deepEqual([form['Continut[1][UM]'], form['Continut[1][NrProduse]'], form['Continut[1][PretUnitar]']], ['buc', '2', '50.00']);
  assert.deepEqual([form.IdExtern, form.Valuta, 'Numar' in form], ['UMI7-P', 'RON', false]);
  assert.match(form.Text, /^Curs BNR: 5\.0000 RON\/EUR \(data \d{2}\.\d{2}\.\d{4}\)\.$/, 'Paket C (karar 235): kur cümlesi');
  // FGO'ya e-posta gönderme isteği / alanı yok: müşterinin e-postası yalnızca müşteri kartı bilgisi olarak gider
  assert.deepEqual(Object.keys(form).filter((k) => /mail/i.test(k)), ['Client[Email]']);
  assert.ok(fgo.urls.every((u) => /\/factura\/(emitere|getstatus)$/.test(u)), 'belge kesiminde yalnızca emitere + getstatus');

  // --- belge kaydı VAR, e-posta işi onu gösteriyor (belgeden önce yazılmış olamaz)
  const [doc] = await docsOf(o.id);
  assert.deepEqual([doc.kind, `${doc.series}${doc.number}`, doc.total.toString()], ['PROFORMA', 'PRF101', '605']);
  let rows = await emails(doc.id);
  assert.equal(rows.length, 1, 'belge başına bir otomatik e-posta işi');
  assert.deepEqual([rows[0].status, rows[0].orderId, rows[0].payload], ['PENDING', o.id, { docId: doc.id }]);
  assert.ok(rows[0].createdAt.getTime() >= doc.createdAt.getTime(), 'e-posta işi belge kaydından sonra');
  assert.equal(await d.queueDocEmail(db, { docId: doc.id, orderId: o.id }), false, 'aynı belge için ikinci otomatik iş yazılmaz');
  assert.equal((await d.emailStates(db, [doc])).get(doc.id).state, 'PENDING');

  // --- e-posta: firmanın kayıtlı adresi, Romence, PDF ekte, TAKİP bağlantısı; FGO bağlantısı yok
  const box = mailbox();
  assert.deepEqual(await d.dispatchDocEmails(db, mailCtx(fgo, box)), { sent: 1, failed: 0, skipped: 0 });
  const [mail] = box.sent;
  assert.deepEqual([mail.to, mail.subject, mail.from], ['umi@belge.test', 'Proformă PRF101 — comanda UMI7', 'GKH Trading Invest SRL <info@gkh.ro>']);
  assert.ok(!('replyTo' in mail), 'yanıt adresi eklenmez (yanıtlar gönderen adrese gider)');
  for (const re of [/Tip document: Proformă/, /Număr document: PRF101/, /Data emiterii: \d{2}\.\d{2}\.\d{4}/, /Comanda: UMI7/, /Total: 605,00 RON \(cu TVA\)/, /https:\/\/takip\.test\/belgeler/]) assert.match(mail.text, re);
  assert.ok(!/fgo\.ro/.test(mail.text) && !/fgo\.ro/.test(mail.html), 'e-postada FGO adresi yok');
  assert.deepEqual([mail.attachments.length, mail.attachments[0].filename, mail.attachments[0].contentType, Buffer.compare(mail.attachments[0].content, PDF)], [2, 'PRF101.pdf', 'application/pdf', 0]);
  // Ortak GKH başlığı (karar 129): HTML'in başında gömülü logo; logo satır içi ek olarak PDF'in ARDINDAN gelir; düz metin aynen
  assert.deepEqual([mail.attachments[1].cid, mail.attachments[1].contentType, mail.attachments[1].contentDisposition], ['gkh-logo@takip', 'image/png', 'inline']);
  assert.ok(mail.html.includes('<img src="cid:gkh-logo@takip"') && mail.html.indexOf('<img') < mail.html.indexOf('Stimate client'), 'logo e-postanın başında');
  assert.ok(!/cid:|<img/.test(mail.text));
  assert.deepEqual(fgo.downloads, ['https://www.fgo.ro/facturi/PRF101.pdf']);
  for (const word of ['cost', 'profit', 'Bravo']) assert.ok(!mail.text.includes(word), `iç bilgi yok: ${word}`);
  rows = await emails(doc.id);
  assert.deepEqual([rows[0].status, rows[0].payload.to, rows[0].payload.attached], ['SENT', 'umi@belge.test', true]);
  assert.deepEqual([(await d.emailStates(db, [doc])).get(doc.id).state, (await d.emailStates(db, [doc])).get(doc.id).to], ['SENT', 'umi@belge.test']);
  // AUD-1: geçmiş notunda yalnızca belge no — alıcı adresi (fatura e-postası) iş kaydında (payload.to), geçmişte değil
  const emailed = await db.orderEvent.findFirstOrThrow({ where: { orderId: o.id, event: 'FGO_DOC_EMAILED' } });
  assert.equal(emailed.note, 'PRF101');

  // --- tekrar yok: işçi yeniden çalışır, iki işçi birlikte çalışır, FGO durum eşitlemesi, müşteri / muhasebe sayfası
  assert.deepEqual(await d.dispatchDocEmails(db, mailCtx(fgo, box)), { sent: 0, failed: 0, skipped: 0 });
  await Promise.all([d.dispatchDocEmails(db, mailCtx(fgo, box)), d.dispatchDocEmails(db, mailCtx(fgo, box))]);
  const before1 = fgo.urls.length;
  assert.equal((await refreshDocuments(db, { orderType: 'GLASS_ORDER', secret: SECRET, fetchImpl: fgo.fetchImpl, sleep: async () => {} })).ok, true);
  assert.ok(fgo.urls.length > before1 && fgo.urls.slice(before1).every((u) => u.endsWith('/factura/getstatus')));
  const before2 = fgo.urls.length;
  await cd.customerDocuments(db, A.id);
  await cd.customerDocuments(db, A.id);
  await d.emailStates(db, [doc]);
  assert.equal(fgo.urls.length, before2, 'müşteri ve muhasebe ekranı FGO\'ya istek göndermez');
  await g.dispatchGlassJobs(db, ctx(fgo));
  await d.dispatchDocEmails(db, mailCtx(fgo, box));
  assert.equal(box.sent.length, 1, 'tek otomatik e-posta');
  assert.equal((await emails(doc.id)).length, 1);
  assert.equal(fgo.calls.length, 1, 'tek belge');
});

dbTest('iki işçi aynı anda: bekleyen e-posta işini yalnızca biri gönderir (atomik sahiplenme + kira)', async () => {
  const o = await order(A, noon(11));
  const fgo = fakeFgo(150);
  await issue(o, 'PROFORMA', fgo);
  const box = mailbox();
  // Yavaş SMTP: gönderim sürerken ikinci işçi kuyruğu okur
  const slow = { sendMail: async (m) => { await new Promise((r) => setTimeout(r, 80)); box.sent.push(m); return {}; } };
  const first = d.dispatchDocEmails(db, mailCtx(fgo, box, { transport: slow }));
  await new Promise((r) => setTimeout(r, 25));
  const second = d.dispatchDocEmails(db, mailCtx(fgo, box, { transport: slow }));
  const res = await Promise.all([first, second]);
  assert.equal(res[0].sent + res[1].sent, 1);
  assert.equal(box.sent.length, 1);
});

dbTest('kesilemeyen belge: belge kaydı, müşteri e-postası, müşteri belgesi ve "belge hazır" bildirimi YOK; aynı iş sonra başarıyla kesilince bir kez', async () => {
  const o = await order(A, noon(12));
  const reject = fakeFgo(200, { emit: () => new Response(JSON.stringify({ Success: false, Message: 'Numarul facturii exista deja' })) });
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'PROFORMA', actor: actor() }), { ok: true });
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(reject, { onlyOrderId: o.id })), { done: 0, failed: 1 });
  assert.equal((await docsOf(o.id)).length, 0);
  assert.equal(await db.notificationOutbox.count({ where: { type: d.DOC_EMAIL, orderId: o.id } }), 0, 'kesilemeyen belgenin e-posta işi yok');
  const seen = await cd.customerDocuments(db, A.id);
  assert.ok(!seen.some((x) => x.orders.some((y) => y.orderNo === o.orderNo)), 'müşteri kesilemeyen belgeyi görmez');
  const box = mailbox();
  await d.dispatchDocEmails(db, mailCtx(reject, box));
  await n.dispatchInApp(db);
  assert.equal(box.sent.length, 0);
  assert.equal(await db.notification.count({ where: { userId: { in: [uA.id, uA2.id] }, orderId: o.id } }), 0, 'müşteriye hata / belge bildirimi gitmez');
  assert.ok(await db.notification.findFirst({ where: { userId: admin.id, type: 'FGO_FAILED', orderId: o.id } }), 'hata yalnızca yönetici tarafında');

  // Yönetici yeniden ister → kesilir → belge + bir e-posta + müşteride görünür + bir bildirim
  const fgo = fakeFgo(200);
  assert.deepEqual(await issue(o, 'PROFORMA', fgo), { done: 1, failed: 0 });
  const [doc] = await docsOf(o.id);
  assert.equal((await emails(doc.id)).length, 1);
  await d.dispatchDocEmails(db, mailCtx(fgo, box));
  await d.dispatchDocEmails(db, mailCtx(fgo, box));
  assert.deepEqual(box.sent.map((m) => m.subject), [`Proformă PRF201 — comanda ${o.orderNo}`]);
  assert.ok((await cd.customerDocuments(db, A.id)).some((x) => x.ref === 'PRF201'));
  await n.dispatchInApp(db);
  await db.notificationOutbox.updateMany({ where: { type: d.DOC_EMAIL }, data: { inAppAt: null } });
  await Promise.all([n.dispatchInApp(db), n.dispatchInApp(db)]);
  const mine = (await notices(uA.id)).filter((x) => x.orderId === o.id);
  assert.equal(mine.length, 1, 'belge başına kullanıcıya tek bildirim (yeniden dağıtımda da)');
  assert.deepEqual([mine[0].type, mine[0].link, mine[0].params.ref, mine[0].params.aud], ['DOC_PROFORMA', `/belgeler#doc-${doc.id}`, 'PRF201', 'customer']);
  assert.equal(n.renderInApp('ro', mine[0]).title, 'Proforma este disponibilă.');
  assert.equal((await notices(uA2.id)).filter((x) => x.orderId === o.id).length, 1, 'firmanın öbür kullanıcısı da alır');
  assert.equal((await notices(uB.id)).length, 0, 'başka firmanın kullanıcısına gitmez');
  assert.equal((await notices(admin.id)).length, 0, 'iç ekibe "belge hazır" bildirimi yok');
});

dbTest('firmanın e-postası yok: belge geçerli ve müşteride görünür; durum "Email yok", yeniden denenmez; e-posta girilince yönetici yeniden gönderir', async () => {
  const N = await customer('Nomail SRL', 'NOM', { email: null });
  const uN = await user(N, 'n1@belge.test');
  const o = await order(N, noon(10));
  const fgo = fakeFgo(300);
  assert.deepEqual(await issue(o, 'PROFORMA', fgo), { done: 1, failed: 0 });
  const [doc] = await docsOf(o.id);
  const box = mailbox();
  assert.deepEqual(await d.dispatchDocEmails(db, mailCtx(fgo, box)), { sent: 0, failed: 0, skipped: 1 });
  let [row] = await emails(doc.id);
  assert.deepEqual([row.status, row.lastError, row.attempts], ['SKIPPED', d.NO_EMAIL, 1]);
  assert.equal((await d.emailStates(db, [doc])).get(doc.id).state, 'NO_EMAIL');
  await d.dispatchDocEmails(db, mailCtx(fgo, box, { now: new Date(Date.now() + 86_400_000) }));
  [row] = await emails(doc.id);
  assert.equal(row.attempts, 1, 'yeniden denenmez');
  assert.equal(box.sent.length, 0);
  // Belge geçerli: müşteri görür, bildirimi gelir
  assert.deepEqual((await cd.customerDocuments(db, N.id)).map((x) => [x.ref, x.kind]), [['PRF301', 'PROFORMA']]);
  await n.dispatchInApp(db);
  assert.equal((await notices(uN.id)).length, 1);
  // Geçersiz adres de "e-posta yok" sayılır
  await db.customer.update({ where: { id: N.id }, data: { email: 'adres-degil' } });
  assert.deepEqual(await d.resendDocEmail(db, { docId: doc.id, actor: actor() }), { ok: true });
  await d.dispatchDocEmails(db, mailCtx(fgo, box));
  assert.equal((await d.emailStates(db, [doc])).get(doc.id).state, 'NO_EMAIL');
  // Adres girildi → yönetici yeniden gönderir
  await db.customer.update({ where: { id: N.id }, data: { email: 'conta@nomail.test' } });
  assert.deepEqual(await d.resendDocEmail(db, { docId: doc.id, actor: actor() }), { ok: true });
  await d.dispatchDocEmails(db, mailCtx(fgo, box));
  assert.deepEqual(box.sent.map((m) => m.to), ['conta@nomail.test']);
  assert.equal((await d.emailStates(db, [doc])).get(doc.id).state, 'SENT');
  assert.equal(fgo.calls.length, 1, 'yeniden gönderme belge kesmez');
  assert.equal((await notices(uN.id)).length, 1, 'yeniden gönderme bildirimi yinelemez');
});

dbTest('PDF: alınamazsa e-posta bekletilir, sonra belge bağlantısıyla eksiz gider; bağlantı artık yoksa FGO\'dan (print) yenilenir', async () => {
  const o = await order(A, noon(13));
  const down = fakeFgo(400, { pdf: () => new Response('hata', { status: 500 }) });
  await issue(o, 'PROFORMA', down);
  const [doc] = await docsOf(o.id);
  const box = mailbox();
  const t0 = new Date();
  assert.deepEqual(await d.dispatchDocEmails(db, mailCtx(down, box, { now: t0 })), { sent: 0, failed: 1, skipped: 0 });
  let [row] = await emails(doc.id);
  assert.deepEqual([row.status, row.attempts], ['PENDING', 1]);
  assert.match(row.lastError, /^PDF alınamadı/);
  assert.equal((await d.emailStates(db, [doc])).get(doc.id).state, 'PENDING');
  assert.equal(down.prints.length, 0, 'sunucu hatasında FGO\'dan bağlantı istenmez (yalnızca bağlantı artık yoksa)');
  await d.dispatchDocEmails(db, mailCtx(down, box, { now: new Date(t0.getTime() + 60_000) }));
  assert.equal((await emails(doc.id))[0].attempts, 1, 'bekleme süresi dolmadan denenmez');
  await d.dispatchDocEmails(db, mailCtx(down, box, { now: new Date(t0.getTime() + 3 * 60_000) }));
  assert.equal(box.sent.length, 0, 'ikinci denemede de bekler');
  assert.deepEqual(await d.dispatchDocEmails(db, mailCtx(down, box, { now: new Date(t0.getTime() + 6 * 60_000) })), { sent: 1, failed: 0, skipped: 0 });
  assert.deepEqual(box.sent[0].attachments.map((a) => a.cid ?? a.filename), ['gkh-logo@takip'], 'PDF eki yok; yalnızca ortak başlığın gömülü logosu');
  assert.match(box.sent[0].text, /Document \(PDF\): https:\/\/www\.fgo\.ro\/facturi\/PRF401\.pdf/);
  assert.match(box.sent[0].text, /https:\/\/takip\.test\/belgeler/);
  [row] = await emails(doc.id);
  assert.deepEqual([row.status, row.payload.attached], ['SENT', false]);

  // Kayıtlı bağlantı artık yok (404): bağlantı FGO'dan bir kez yenilenir, kayda yazılır, PDF oradan alınır
  const moved = fakeFgo(400, { pdf: (u) => (u.includes('/facturi/') ? new Response('yok', { status: 404 }) : PDF) });
  const r = await d.fetchDocPdf(db, doc, { fetchImpl: moved.fetchImpl, secret: SECRET, appUrl: 'https://takip.test' });
  assert.equal(r.ok, true);
  assert.deepEqual(moved.prints, ['PRF401']);
  assert.equal((await db.fgoDocument.findUnique({ where: { id: doc.id } })).link, 'https://www.fgo.ro/print/PRF401.pdf');
  const fresh = await db.fgoDocument.findUnique({ where: { id: doc.id } });
  const again = await d.fetchDocPdf(db, fresh, { fetchImpl: moved.fetchImpl, secret: SECRET });
  assert.equal(again.ok, true);
  assert.equal(moved.prints.length, 1, 'bağlantı kayıtlıyken FGO\'ya yeniden sorulmaz');
  assert.ok(moved.urls.every((u) => !u.endsWith('/factura/emitere')), 'PDF almak belge kesmez');
  // PDF olmayan yanıt ve FGO dışı adres reddedilir
  const html = fakeFgo(400, { pdf: () => '<html>giriş</html>' });
  assert.equal((await d.fetchDocPdf(db, fresh, { fetchImpl: html.fetchImpl, secret: SECRET })).ok, false);
  const guard = fakeFgo(400);
  const evil = await d.fetchDocPdf(db, { ...fresh, id: 'yok', link: 'https://evil.test/x.pdf' }, { fetchImpl: guard.fetchImpl, secret: SECRET });
  assert.equal(evil.ok, true);
  assert.deepEqual(guard.downloads, ['https://www.fgo.ro/print/PRF401.pdf'], 'FGO dışı adres indirilmez; bağlantı FGO\'dan alınır');
});

dbTest('FGO bağlantısı dış veridir (AUD-5 / AUD-7): FGO dışı print bağlantısı kayda yazılmaz, indirilmez, e-postaya yazılmaz; yönlendirme her adımda doğrulanır; büyük yanıt alınmaz', async () => {
  const o = await order(A, noon(15));
  const fgo = fakeFgo(960);
  await issue(o, 'PROFORMA', fgo);
  const [doc] = await docsOf(o.id);
  const STORED = 'https://www.fgo.ro/facturi/PRF961.pdf';
  const EVIL = 'https://evil.example/fatura.pdf';
  assert.equal(doc.link, STORED);
  const stored = async () => (await db.fgoDocument.findUnique({ where: { id: doc.id } })).link;

  // 1) Kayıtlı bağlantı artık yok (404) ve factura/print FGO'nun olmayan bir adres veriyor: KAYDA YAZILMAZ, oraya istek gitmez
  for (const given of [EVIL, 'https://www.fgo.ro@evil.example/x.pdf', 'https://user:pw@www.fgo.ro/x.pdf', 'https://www.fgo.ro:8443/x.pdf', 'https://fgo.ro.evil.example/x.pdf', 'https://127.0.0.1/x.pdf', 'https://169.254.169.254/x']) {
    const bad = fakeFgo(960, { pdf: () => new Response('yok', { status: 404 }), print: () => given });
    const r = await d.fetchDocPdf(db, doc, { fetchImpl: bad.fetchImpl, secret: SECRET, appUrl: 'https://takip.test' });
    assert.deepEqual(r, { ok: false, link: STORED, error: 'PDF adresi FGO adresi değil' }, given);
    assert.deepEqual(bad.prints, ['PRF961']);
    assert.deepEqual(bad.downloads, [STORED], `FGO dışı adrese istek gitmedi: ${given}`);
    assert.equal(await stored(), STORED, 'kayıt değişmedi');
  }
  // http bağlantı FGO istemcisinde zaten elenir (bağlantı yok sayılır): yine yazılmaz, indirilmez
  const plain = fakeFgo(960, { pdf: () => new Response('yok', { status: 404 }), print: () => 'http://www.fgo.ro/print/PRF961.pdf' });
  const rp = await d.fetchDocPdf(db, doc, { fetchImpl: plain.fetchImpl, secret: SECRET });
  assert.deepEqual([rp.ok, rp.link], [false, STORED]);
  assert.deepEqual(plain.downloads, [STORED]);
  assert.equal(await stored(), STORED);

  // 2) Yönlendirme: FGO → FGO dışı izlenmez (hedefe istek gitmez); FGO → FGO izlenir (göreli adres dahil)
  const out = fakeFgo(960, { pdf: () => new Response(null, { status: 302, headers: { location: 'https://evil.example/cal' } }) });
  assert.deepEqual(await d.fetchDocPdf(db, doc, { fetchImpl: out.fetchImpl, secret: SECRET }), { ok: false, link: STORED, error: 'yönlendirme FGO dışı bir adrese' });
  assert.deepEqual(out.downloads, [STORED]);
  assert.equal(out.prints.length, 0, 'yönlendirme reddi bağlantıyı yeniletmez');
  const inside = fakeFgo(960, { pdf: (u) => (u === STORED ? new Response(null, { status: 307, headers: { location: '/arsiv/PRF961.pdf' } }) : PDF) });
  const ok = await d.fetchDocPdf(db, doc, { fetchImpl: inside.fetchImpl, secret: SECRET });
  assert.equal(ok.ok, true);
  assert.ok(ok.bytes.equals(PDF));
  assert.deepEqual(inside.downloads, [STORED, 'https://www.fgo.ro/arsiv/PRF961.pdf']);
  // 3) Büyük yanıt: bildirilen boy sınırı aşıyorsa alınmaz; bildirim yoksa okunurken kesilir
  const declared = fakeFgo(960, { pdf: () => new Response(PDF, { headers: { 'content-length': String(d.PDF_MAX_BYTES + 1) } }) });
  assert.deepEqual(await d.fetchDocPdf(db, doc, { fetchImpl: declared.fetchImpl, secret: SECRET }), { ok: false, link: STORED, error: 'PDF çok büyük' });
  let produced = 0;
  const endless = () => new Response(new ReadableStream({
    pull(c) { produced += 1; c.enqueue(new Uint8Array(produced === 1 ? Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1024 * 1024 - 9, 0x20)]) : Buffer.alloc(1024 * 1024, 0x20))); },
  }, { highWaterMark: 0 }));
  const big = fakeFgo(960, { pdf: endless });
  assert.deepEqual(await d.fetchDocPdf(db, doc, { fetchImpl: big.fetchImpl, secret: SECRET }), { ok: false, link: STORED, error: 'PDF çok büyük' });
  assert.ok(produced >= 16 && produced <= 18, `sonsuz gövde 15 MB'ta kesildi (${produced} MB üretildi)`);

  // 4) Kayıtlı bağlantının KENDİSİ FGO dışıysa (kayıt bozulmuş olsa bile): indirilmez, çağırana / e-postaya verilmez
  await db.fgoDocument.update({ where: { id: doc.id }, data: { link: EVIL } });
  const tampered = await db.fgoDocument.findUnique({ where: { id: doc.id } });
  const bad = fakeFgo(960, { print: () => EVIL });
  assert.deepEqual(await d.fetchDocPdf(db, tampered, { fetchImpl: bad.fetchImpl, secret: SECRET }), { ok: false, link: null, error: 'PDF adresi FGO adresi değil' });
  assert.deepEqual(bad.downloads, [], 'hiçbir indirme isteği yok');
  // Müşteri e-postası: iki bekleme, sonra eksiz ve BAĞLANTISIZ gider (belge bilgisi ve portal bağlantısı yerinde)
  const box = mailbox();
  const t0 = new Date();
  assert.deepEqual(await d.dispatchDocEmails(db, mailCtx(bad, box, { now: t0 })), { sent: 0, failed: 1, skipped: 0 });
  await d.dispatchDocEmails(db, mailCtx(bad, box, { now: new Date(t0.getTime() + 3 * 60_000) }));
  assert.equal(box.sent.length, 0);
  assert.deepEqual(await d.dispatchDocEmails(db, mailCtx(bad, box, { now: new Date(t0.getTime() + 6 * 60_000) })), { sent: 1, failed: 0, skipped: 0 });
  const [mail] = box.sent;
  for (const part of [mail.text, mail.html]) assert.doesNotMatch(part, /evil|Document \(PDF\)|Deschide documentul/);
  assert.match(mail.text, /Număr document: PRF961/);
  assert.match(mail.text, /https:\/\/takip\.test\/belgeler/);
  assert.deepEqual(mail.attachments.map((a) => a.cid ?? a.filename), ['gkh-logo@takip'], 'PDF eki yok');
  const [row] = await emails(doc.id);
  assert.deepEqual([row.status, row.payload.attached], ['SENT', false]);
  assert.ok(!JSON.stringify(row).includes('evil.example'), 'kuyruk kaydında da FGO dışı adres yok');
  assert.deepEqual(bad.downloads, [], 'e-posta gönderimi de FGO dışı adrese gitmedi');
  // FGO geçerli bir bağlantı verince kayıt düzelir (yalnızca doğrulanmış bağlantı yazılır) ve PDF alınır
  const healed = fakeFgo(960);
  assert.equal((await d.fetchDocPdf(db, tampered, { fetchImpl: healed.fetchImpl, secret: SECRET })).ok, true);
  assert.equal(await stored(), 'https://www.fgo.ro/print/PRF961.pdf');
});

dbTest('müşteri partisi: her kalem kendi siparişini taşır; e-postada ve müşteri ekranında kaynak siparişler; başka firma göremez / PDF isteyemez', async () => {
  const o1 = await order(B, noon(20)), o2 = await order(B, noon(20), { cnc: true }), o3 = await order(B, noon(27));
  const days = [dayKey(noon(20)), dayKey(noon(27))];
  const p = await b.previewBatch(db, { customerId: B.id, days, bnrImpl: bnr('5.0000') });
  const made = await b.createBatch(db, { customerId: B.id, days, key: p.key, actor: actor(), bnrImpl: bnr('5.0000') });
  assert.equal(made.ok, true);
  const fgo = fakeFgo(500, { total: '1936.00' });
  assert.deepEqual(await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: made.batchId })), { done: 1, failed: 0 });
  const form = fgo.calls[0];
  // Her kalem KENDİ siparişi (o2'nin iki kalemi var: cam + CNC); bütün siparişler her kaleme yazılmaz
  assert.deepEqual(keys(form, 'Descriere'), [o1, o2, o2, o3].map((o) => `Comanda ${o.orderNo}`));
  assert.ok(keys(form, 'Denumire').every((name, i) => name.startsWith(`Comanda ${[o1, o2, o2, o3][i].orderNo} — `)), 'kalem adı değişmedi');
  assert.deepEqual([form.IdExtern, form['Continut[0][UM]'], form['Continut[0][PretUnitar]'], form['Continut[0][CotaTVA]']], [`LOT-${made.batchId}`, 'mp', '250.00', '21']);
  const doc = await db.fgoDocument.findUnique({ where: { batchId: made.batchId } });
  assert.equal((await emails(doc.id)).length, 1);
  const box = mailbox();
  await d.dispatchDocEmails(db, mailCtx(fgo, box));
  const nos = [o1, o2, o3].map((o) => o.orderNo).join(', ');
  assert.deepEqual([box.sent[0].to, box.sent[0].subject], ['brv@belge.test', `Proformă PRF501 — comenzile ${nos}`]);
  assert.match(box.sent[0].text, new RegExp(`Comenzi: ${nos}`));
  assert.match(box.sent[0].text, /Total: 1\.936,00 RON/);
  assert.equal(box.sent[0].attachments[0].filename, 'PRF501.pdf');

  // Müşteri ekranı: belge bir kez, kaynak sipariş numaralarıyla
  const mine = await cd.customerDocuments(db, B.id);
  assert.deepEqual(mine.map((x) => [x.ref, x.kind, x.orders.map((y) => y.orderNo).join(', '), x.total, x.currency, x.payment]), [['PRF501', 'PROFORMA', nos, 1936, 'RON', 'UNPAID']]);
  // Bildirim: B'nin kullanıcısına, bağlantı belgeye
  await n.dispatchInApp(db);
  const note = (await notices(uB.id)).find((x) => x.link === `/belgeler#doc-${doc.id}`);
  assert.deepEqual([note.type, note.orderId, note.params.orderNo], ['DOC_PROFORMA', null, nos]);
  assert.ok(!(await notices(uA.id)).some((x) => x.link === note.link));

  // --- gizlilik: A firması B'nin belgesini listede göremez; belge / parti / sipariş kimliğiyle de alamaz
  const theirs = await cd.customerDocuments(db, A.id);
  assert.ok(theirs.length > 0 && !theirs.some((x) => x.ref === 'PRF501' || x.orders.some((y) => y.orderNo.startsWith('BRV'))));
  assert.ok(!mine.some((x) => x.orders.some((y) => y.orderNo.startsWith('UMI'))));
  assert.equal(await cd.customerDocument(db, { docId: doc.id, customerId: A.id }), null, 'başka firmanın belgesi "yok"');
  for (const forged of [made.batchId, o1.id, 'yok', '', null]) assert.equal(await cd.customerDocument(db, { docId: forged, customerId: A.id }), null);
  for (const nobody of [null, undefined, '']) {
    assert.equal(await cd.customerDocument(db, { docId: doc.id, customerId: nobody }), null);
    assert.deepEqual(await cd.customerDocuments(db, nobody), []);
  }
  assert.deepEqual((await cd.customerDocument(db, { docId: doc.id, customerId: B.id })).number, '501');
  const aDoc = (await db.fgoDocument.findFirst({ where: { order: { customerId: A.id } } }));
  assert.equal(await cd.customerDocument(db, { docId: aDoc.id, customerId: B.id }), null);
});

dbTest('müşteri kendi proforma, avans faturası ve faturasını görür; ödeme durumu FGO eşitlemesinden; her belge için bir e-posta', async () => {
  const C = await customer('Chain SRL', 'CHN');
  const o = await order(C, noon(5));
  const fgo = fakeFgo(600);
  await issue(o, 'PROFORMA', fgo);
  const view = async () => (await cd.customerDocuments(db, C.id)).map((x) => [x.kind, x.ref, x.payment]);
  assert.deepEqual(await view(), [['PROFORMA', 'PRF601', 'UNPAID']]);
  // FGO'da tahsilat: kısmi → mevcut eşitleme yazar, müşteri ekranı onu gösterir
  fgo.paid.PRF601 = '300.00';
  const sync = () => refreshDocuments(db, { orderType: 'GLASS_ORDER', secret: SECRET, fetchImpl: fgo.fetchImpl, sleep: async () => {} });
  await sync();
  assert.deepEqual(await view(), [['PROFORMA', 'PRF601', 'PARTIAL']]);
  // Avans faturası (tutar = FGO tahsilatı) → tamamen ödenmiş görünür
  assert.deepEqual(await issue(o, 'ADVANCE', fgo), { done: 1, failed: 0 });
  assert.equal(fgo.calls[1]['Continut[0][Descriere]'], `Comanda ${o.orderNo}`, 'avans kaleminde de kaynak sipariş');
  const adv = (await docsOf(o.id)).find((x) => x.kind === 'ADVANCE');
  await db.fgoDocument.update({ where: { id: adv.id }, data: { total: '300.00', paid: '300.00' } });
  assert.deepEqual((await view()).sort(), [['ADVANCE', 'GKH602', 'PAID'], ['PROFORMA', 'PRF601', 'PARTIAL']]);
  // Onaylı yükleme → nihai fatura yükleme gününden, siparişin zincirinde (karar 239); proforma "faturalandı"
  const fin = await issueFinal(o, fgo);
  assert.deepEqual([fin.done, fin.failed], [1, 0]);
  assert.deepEqual(keys(fgo.calls[2], 'Descriere'), [`Comanda ${o.orderNo}`, `Comanda ${o.orderNo}`], 'fatura: cam kalemi + avans düşümü aynı siparişin');
  const invDoc = await finalDocOf(fin.batchId);
  await db.fgoDocument.update({ where: { id: invDoc.id }, data: { total: '305.00', paid: '0' } });
  assert.deepEqual((await view()).sort(), [['ADVANCE', 'GKH602', 'PAID'], ['INVOICE', 'GKH603', 'UNPAID'], ['PROFORMA', 'PRF601', 'REPLACED']]);
  const row = (await cd.customerDocuments(db, C.id)).find((x) => x.kind === 'INVOICE');
  assert.deepEqual([row.orders, row.total, row.currency], [[{ id: o.id, orderNo: o.orderNo }], 305, 'RON']);
  // Her belge için bir e-posta: Proformă, Factură de avans, Factură
  const box = mailbox();
  await d.dispatchDocEmails(db, mailCtx(fgo, box));
  await d.dispatchDocEmails(db, mailCtx(fgo, box));
  assert.deepEqual(box.sent.filter((m) => m.to === 'chn@belge.test').map((m) => m.subject.split(' — ')[0]).sort(), ['Factură GKH603', 'Factură de avans GKH602', 'Proformă PRF601']);
  // Silinmiş siparişin (karar 110) belgesi durur; sipariş bağlantısı verilmez
  await db.order.update({ where: { id: o.id }, data: { removedAt: new Date(), status: 'IPTAL', removedStatus: 'URETIMDE' } });
  assert.deepEqual((await cd.customerDocuments(db, C.id)).map((x) => x.orders[0]), [{ id: null, orderNo: o.orderNo }, { id: null, orderNo: o.orderNo }, { id: null, orderNo: o.orderNo }]);
});

dbTest('yönetici "e-postayı tekrar gönder": yalnızca TAKİP e-postası — FGO\'da belge kesilmez, numara / kayıt değişmez; yalnızca muhasebe yetkisi', async () => {
  const o = await order(A, noon(15));
  const fgo = fakeFgo(700);
  await issue(o, 'PROFORMA', fgo);
  const [doc] = await docsOf(o.id);
  const box = mailbox();
  await d.dispatchDocEmails(db, mailCtx(fgo, box));
  const mark = fgo.urls.length;
  const snapshot = JSON.stringify(await db.fgoDocument.findMany({ orderBy: { id: 'asc' } }));
  const settings = JSON.stringify(await getFgoSettings(db));
  // Yetki sunucuda: satış, çizim, müşteri, denetimci, kimliksiz
  for (const role of ['SATIS', 'CIZIM', 'MUSTERI', 'DENETIMCI', null]) assert.deepEqual(await d.resendDocEmail(db, { docId: doc.id, actor: actor(role) }), { ok: false, code: 'FORBIDDEN' }, String(role));
  assert.deepEqual(await d.resendDocEmail(db, { docId: 'yok', actor: actor() }), { ok: false, code: 'NOT_FOUND' });
  assert.equal((await emails(doc.id)).length, 1);
  const two = await Promise.all([d.resendDocEmail(db, { docId: doc.id, actor: actor() }), d.resendDocEmail(db, { docId: doc.id, actor: actor() })]);
  assert.deepEqual(two.map((r) => (r.ok ? 'ok' : r.code)).sort(), ['ALREADY_QUEUED', 'ok'], 'çift tıklama tek iş');
  assert.deepEqual((await emails(doc.id)).map((r) => [r.status, r.payload.manual === true]), [['SENT', false], ['PENDING', true]]);
  assert.equal((await d.emailStates(db, [doc])).get(doc.id).state, 'PENDING');
  await d.dispatchDocEmails(db, mailCtx(fgo, box));
  assert.deepEqual(box.sent.map((m) => m.subject), [`Proformă PRF701 — comanda ${o.orderNo}`, `Proformă PRF701 — comanda ${o.orderNo}`], 'elle yeniden gönderme bilinçlidir: ikinci e-posta gider');
  // FGO: belge kesme isteği yok; yalnızca PDF indirildi. Belge kayıtları, numara ve ayarlar aynı.
  const after1 = fgo.urls.slice(mark);
  assert.deepEqual(after1, ['https://www.fgo.ro/facturi/PRF701.pdf']);
  assert.equal(fgo.calls.length, 1);
  assert.equal(JSON.stringify(await db.fgoDocument.findMany({ orderBy: { id: 'asc' } })), snapshot);
  assert.equal(JSON.stringify(await getFgoSettings(db)), settings);
  assert.equal(await db.notificationOutbox.count({ where: { type: g.GLASS_FGO, orderId: o.id, status: 'PENDING' } }), 0, 'FGO işi kuyruğa girmedi');
  assert.ok(await db.auditLog.findFirst({ where: { action: 'FGO_DOC_EMAIL_RESEND', entityId: doc.id, userId: admin.id } }));
  await n.dispatchInApp(db);
  assert.equal((await notices(uA.id)).filter((x) => x.orderId === o.id).length, 1, 'yeniden gönderme bildirimi yinelemez');
});

// Karar 115: mali belge e-postası firmanın "E-mail facturare" adresine gider; yoksa firmanın e-postasına; ikisi de yoksa "Email yok"
dbTest('fatura e-postası (billingEmail): öncelik, geri düşüş, geçersiz adres, bildirim tercihi; "Email yok" belgesi adres girilince yeniden gönderilir — FGO\'da belge kesilmez', async () => {
  const fgo = fakeFgo(800);
  const box = mailbox();
  const send = async (c, shipOffset) => {
    const o = await order(c, noon(shipOffset));
    assert.deepEqual(await issue(o, 'PROFORMA', fgo), { done: 1, failed: 0 });
    const [doc] = await docsOf(o.id);
    const r = await d.dispatchDocEmails(db, mailCtx(fgo, box));
    return { o, doc, r };
  };
  const stateOf = async (doc) => (await d.emailStates(db, [doc])).get(doc.id).state;
  /** Bu testin firmalarına giden e-postalar (önceki testlerden kalan iş olsa da karışmaz) */
  const to = () => box.sent.map((m) => m.to).filter((a) => /@(client|doar|eronat|faramail)\.test$/.test(a));
  /** Belgenin değişmemesi gereken alanları (FGO'dan okunan toplam / ödenen önbelleği dışında her şey) */
  const core = async (id) => {
    const { total: _total, paid: _paid, checkedAt: _checkedAt, checkError: _checkError, ...rest } = await db.fgoDocument.findUniqueOrThrow({ where: { id } });
    return JSON.stringify(rest);
  };

  // Fatura e-postası yok → firmanın e-postasına (geri düşüş)
  const C = await customer('Factura SRL', 'FCT', { email: 'office@client.test' });
  let x = await send(C, 20);
  assert.deepEqual(to(), ['office@client.test']);
  // Fatura e-postası var → firmanın e-postasının yerine oraya; firmanın e-postasına AYRICA gitmez
  await db.customer.update({ where: { id: C.id }, data: { billingEmail: 'facturi@client.test' } });
  x = await send(C, 21);
  assert.deepEqual(to(), ['office@client.test', 'facturi@client.test']);
  assert.equal((await emails(x.doc.id))[0].payload.to, 'facturi@client.test');
  // Yalnızca fatura e-postası var (firmanın e-postası yok)
  const D = await customer('Doar Facturi SRL', 'DFA', { email: null, billingEmail: 'facturi@doar.test' });
  await send(D, 20);
  assert.equal(to().at(-1), 'facturi@doar.test');
  // Geçersiz fatura e-postası güvenle atlanır: firmanın geçerli e-postasına gider
  const E = await customer('Eronat SRL', 'ERO', { email: 'office@eronat.test', billingEmail: 'adres-degil' });
  await send(E, 20);
  assert.equal(to().at(-1), 'office@eronat.test');

  // Bildirim tercihi mali belgeyi ETKİLEMEZ: firmanın bütün kullanıcıları e-posta bildirimlerini kapatmış olsa da belge gider;
  // alıcı yine firmanın adresidir — kullanıcıların giriş e-postasına gönderilmez
  const uC = await user(C, 'kullanici@client.test');
  await db.user.updateMany({ where: { customerId: C.id }, data: { emailNotifications: false } });
  const sentBefore = to().length;
  x = await send(C, 22);
  assert.equal(await stateOf(x.doc), 'SENT');
  assert.deepEqual(to().slice(sentBefore), ['facturi@client.test']);
  assert.ok(!box.sent.some((m) => m.to === uC.email));

  // --- İkisi de yok → "Email yok" (kullanıcısı olsa bile kullanıcı e-postasına düşülmez); belge geçerli
  const N = await customer('Fara Mail SRL', 'FMA', { email: null });
  const uN = await user(N, 'giris@faramail.test');
  x = await send(N, 20);
  assert.equal(await stateOf(x.doc), 'NO_EMAIL');
  assert.equal((await emails(x.doc.id))[0].lastError, d.NO_EMAIL);
  assert.ok(!box.sent.some((m) => m.to === uN.email));
  // Geçersiz fatura e-postası + firmanın e-postası yok → yine "Email yok"
  await db.customer.update({ where: { id: N.id }, data: { billingEmail: 'bozuk@' } });
  assert.deepEqual(await d.resendDocEmail(db, { docId: x.doc.id, actor: actor() }), { ok: true });
  await d.dispatchDocEmails(db, mailCtx(fgo, box));
  assert.equal(await stateOf(x.doc), 'NO_EMAIL');

  // --- Yönetici fatura e-postasını girer → "Tekrar gönder": Email yok → Bekliyor → Gönderildi; VAR OLAN belge gider
  const docBefore = await core(x.doc.id);
  const billingBefore = JSON.stringify(await db.glassBilling.findMany({ where: { orderId: x.o.id } }));
  const docCount = await db.fgoDocument.count();
  const settings = JSON.stringify(await getFgoSettings(db));
  const emits = fgo.calls.length;
  await db.customer.update({ where: { id: N.id }, data: { billingEmail: 'facturi@faramail.test' } });
  assert.equal(await stateOf(x.doc), 'NO_EMAIL', 'adres girmek kendiliğinden göndermez');
  assert.deepEqual(await d.resendDocEmail(db, { docId: x.doc.id, actor: actor() }), { ok: true });
  assert.equal(await stateOf(x.doc), 'PENDING');
  await d.dispatchDocEmails(db, mailCtx(fgo, box));
  assert.equal(await stateOf(x.doc), 'SENT');
  const mail = box.sent.findLast((m) => m.to === 'facturi@faramail.test');
  assert.equal(box.sent.filter((m) => m.to === 'facturi@faramail.test').length, 1, 'tek e-posta');
  assert.deepEqual([mail.to, mail.subject, mail.attachments?.[0]?.filename], ['facturi@faramail.test', `Proformă ${x.doc.series}${x.doc.number} — comanda ${x.o.orderNo}`, `${x.doc.series}${x.doc.number}.pdf`]);
  // FGO: belge kesme (emitere) çağrısı SIFIR — var olan belgenin PDF'i indirilir (toplam hiç okunmadıysa salt okunur durum
  // sorgusuyla okunur). Belge kaydı (tür, seri, numara, sıra, tarih, para birimi), kur / faturalama kaydı ve ayarlar aynı;
  // yeni belge ya da FGO işi yok
  assert.equal(fgo.calls.length, emits, 'emitere çağrılmadı');
  assert.equal(await core(x.doc.id), docBefore);
  assert.equal(JSON.stringify(await db.glassBilling.findMany({ where: { orderId: x.o.id } })), billingBefore);
  assert.equal(await db.fgoDocument.count(), docCount);
  assert.equal(JSON.stringify(await getFgoSettings(db)), settings);
  assert.equal(await db.notificationOutbox.count({ where: { type: g.GLASS_FGO, orderId: x.o.id, status: 'PENDING' } }), 0);

  // --- Fatura e-postası yalnızca teslim bilgisidir: erişim hakkı vermez. Başka firmanın kullanıcısının giriş e-postası
  // bu firmanın fatura e-postasıyla aynı olsa da belgeyi göremez / açamaz; belgenin sahibi gerçek firmadır.
  const stranger = await user(B, 'facturi@faramail.test');
  assert.ok(!(await cd.customerDocuments(db, stranger.customerId)).some((r) => r.id === x.doc.id));
  assert.equal(await cd.customerDocument(db, { docId: x.doc.id, customerId: stranger.customerId }), null);
  assert.ok(await cd.customerDocument(db, { docId: x.doc.id, customerId: N.id }));
  assert.deepEqual((await cd.customerDocuments(db, N.id)).map((r) => r.id), [x.doc.id]);
});

dbTest('tek seferlik fatura numarası: FGO\'da kullanılınca boşalır — belge kaydı yazılamasa bile (eski numara sonraki faturaya gitmez)', async () => {
  const E = await customer('Numar SRL', 'NUM');
  const o1 = await order(E, noon(-5)), o2 = await order(E, noon(-5));
  // Olağan: elle numara bir kez gönderilir, fatura kesilince alan boşalır; sonraki faturada Numar yok (nihai fatura onaylı
  // yüklemeden — karar 239)
  await fgoOn({ invoiceNext: 900 });
  const fgo = fakeFgo(899);
  assert.deepEqual(await issueFinal(o1, fgo).then((r) => [r.done, r.failed]), [1, 0]);
  assert.equal(fgo.calls[0].Numar, '900');
  assert.equal((await getFgoSettings(db)).invoiceNext, null, 'başarılı kullanımdan sonra boş');
  assert.deepEqual(await issueFinal(o2, fgo).then((r) => [r.done, r.failed]), [1, 0]);
  assert.ok(!('Numar' in fgo.calls[1]), 'sonraki faturanın numarasını FGO verir');

  // FGO belgeyi kesti ama kayıt yazılamadı (FGO'nun döndürdüğü numara sistemde başka belgede kayıtlı): alan yine boşalır
  const o3 = await order(E, noon(-5)), o4 = await order(E, noon(-5));
  await fgoOn({ invoiceNext: 950 });
  const clash = fakeFgo(0, { emit: (form) => new Response(JSON.stringify({ Success: true, Factura: { Numar: '900', Serie: form.Serie, Link: null } })) });
  const r3 = await issueFinal(o3, clash);
  assert.deepEqual([r3.done, r3.failed], [0, 1]);
  assert.equal(await finalDocOf(r3.batchId), null, 'kayıt yazılamadı');
  assert.equal((await getFgoSettings(db)).invoiceNext, null, 'numara FGO\'da kullanıldı: alan boşaldı');
  assert.equal(await db.notificationOutbox.count({ where: { type: d.DOC_EMAIL, orderId: o3.id } }), 0, 'kaydı olmayan belgenin e-postası yok');
  const next = fakeFgo(960);
  assert.deepEqual(await issueFinal(o4, next).then((r) => [r.done, r.failed]), [1, 0]);
  assert.ok(!('Numar' in next.calls[0]), 'eski elle numara sonraki faturaya gönderilmedi');
  await fgoOn();
});

dbTest('gerçek ağ isteği yapılmadı (FGO, PDF, e-posta)', () => {
  assert.deepEqual(net, []);
});
