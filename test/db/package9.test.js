// Paket 9 (kararlar 198–202) — veritabanıyla: sipariş mesajı bildirimi (alıcılar, tek kullanımlık anahtar, işçi yeniden
// denemesi), okunmamış mesaj sayaçları (kapsam, iç not, kendi notu, okundu işaretinin geri gitmemesi), zil ile sayacın
// birlikte okunması ve müşteri e-posta dilinin olay anında saklanması. Gerçek SMTP / Google / FGO yok: e-posta sahte
// taşıyıcıya gider, çeviri kapalıdır, bütün testler ağ engeli altında çalışır.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const { addNote } = await import('../../server/notes/translation.js');
const { createNoteLimits } = await import('../../server/notes/limits.js');
const un = await import('../../server/notes/unread.js');
const n = await import('../../server/notifications/inapp.js');
const { dispatchNotifications, renderNotification } = await import('../../server/notifications/email.js');
const { enqueueOutbox } = await import('../../server/orders/journal.js');

let db, U, A, B, seq = 300;
const actor = (u) => ({ id: u.id, role: u.appRole, customerId: u.customerId, ip: '127.0.0.1' });
const user = (email, name, appRole, customerId, extra = {}) => db.user.create({ data: { email, name, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } });
const KEY = (s) => `p9-key-${s}`.padEnd(24, 'x');
const names = new Map();

async function order(firm, { drawer = null, type = 'GLASS_ORDER', by = null } = {}) {
  const no = seq++;
  return db.order.create({
    data: {
      orderNo: `${firm.prefix}${no}`, customerOrderNo: no, title: `Proje ${no}`, orderTypeCode: type, customerId: firm.id,
      createdById: (by ?? (firm.id === A.id ? U.a1 : U.b1)).id, status: 'HAZIRLANIYOR', drawingTrack: drawer ? 'YAPILIYOR' : 'YOK', assignedDrawerId: drawer?.id ?? null,
    },
  });
}
/** Notu, sunucu işleminin yaptığı gibi yazar ve olayını hemen dağıtır (deliverInAppNow → dispatchInAppFor) */
async function say(u, o, text, extra = {}) {
  const r = await addNote(db, { orderId: o.id, actor: actor(u), text, limits: createNoteLimits(), ...extra });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (r.ok && r.outboxId) await n.dispatchInAppFor(db, [r.outboxId]);
  return r;
}
const bell = async (o) => (await db.notification.findMany({ where: { orderId: o.id, type: un.NOTE_EVENT }, orderBy: { id: 'asc' } }))
  .map((x) => names.get(x.userId)).sort();

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  A = await db.customer.create({ data: { name: 'GLASSANDMORE SRL', prefix: 'GLA', email: 'firma@gla.test' } });
  B = await db.customer.create({ data: { name: 'ALEGRAD SRL', prefix: 'ALE', email: 'firma@ale.test' } });
  const old = new Date(Date.now() - 2 * 86_400_000);
  U = {
    admin: await user('admin@p9.test', 'Yönetici', 'ADMIN', factory.id, { createdAt: old }),
    sales: await user('satis@p9.test', 'Satış', 'SATIS', factory.id, { createdAt: old }),
    drawer: await user('cizim@p9.test', 'Çizim', 'CIZIM', factory.id, { createdAt: old }),
    inspector: await user('denetim@p9.test', 'Denetim', 'DENETIMCI', factory.id, { createdAt: old }),
    a1: await user('a1@gla.test', 'A1', 'MUSTERI', A.id, { createdAt: old, fixedLanguage: 'tr', language: 'tr' }),
    a2: await user('a2@gla.test', 'A2', 'MUSTERI', A.id, { createdAt: old }),
    aOff: await user('a3@gla.test', 'A pasif', 'MUSTERI', A.id, { createdAt: old, isActive: false }),
    b1: await user('b1@ale.test', 'B1', 'MUSTERI', B.id, { createdAt: old }),
  };
  for (const [k, u] of Object.entries(U)) names.set(u.id, k);
});
after(closeDb);

dbTest('mesaj bildirimi: müşterinin mesajı yönetici + satış + atanmış çizimciye; iç ekibin mesajı firmanın etkin müşteri kullanıcılarına; iç not hiç kimseye; yazana gitmez; metin bildirimde yok', offline(async () => {
  const o = await order(A, { drawer: U.drawer });
  await say(U.a1, o, 'Müşterinin gizli olmayan sorusu');
  assert.deepEqual(await bell(o), ['admin', 'drawer', 'sales']);
  await say(U.sales, o, 'Satışın yanıtı');
  assert.deepEqual(await bell(o), ['a1', 'a2', 'admin', 'drawer', 'sales'], 'müşteri kullanıcıları (pasif ve başka firma hariç); satışa kendi mesajı gitmez');
  await say(U.admin, o, 'İç not — müşteri görmez', { internal: true });
  assert.equal((await bell(o)).length, 5, 'iç not olay yazmaz');
  assert.equal(await db.notificationOutbox.count({ where: { orderId: o.id, type: un.NOTE_EVENT } }), 2);
  const rows = await db.notification.findMany({ where: { orderId: o.id } });
  for (const r of rows) {
    assert.ok(!JSON.stringify(r).includes('gizli olmayan') && !JSON.stringify(r).includes('yanıtı'), 'mesaj metni bildirimde yok');
    assert.equal(r.link, `/siparisler/${o.id}#notlar`);
  }
  // Satış ve çizim bildiriminde firma adı maskeli (ilk 3 karakter + 10 yıldız)
  for (const u of [U.sales, U.drawer]) {
    const x = rows.find((r) => r.userId === u.id);
    assert.equal(x.params.firm, 'GLA**********');
  }
  assert.equal(rows.find((r) => r.userId === U.admin.id).params.firm, 'GLASSANDMORE SRL');
  // Profil siparişinde müşterinin mesajı yalnızca yöneticiye (satışa / çizime uğramaz)
  const p = await order(A, { type: 'PROFILE_ORDER' });
  await say(U.a1, p, 'Profil sorusu');
  assert.deepEqual(await bell(p), ['admin']);
}));

dbTest('tekilleştirme: aynı form iki kez (paralel) → tek not, tek olay, tek bildirim; işçi aynı olayı yeniden dağıtsa da tek kayıt; yeni mesaj yeni bildirim', offline(async () => {
  const o = await order(A, { drawer: U.drawer });
  const limits = createNoteLimits();
  const rs = await Promise.all([1, 2, 3].map(() => addNote(db, { orderId: o.id, actor: actor(U.a1), text: 'Çift tıklama', requestKey: KEY('dup'), limits })));
  assert.ok(rs.every((r) => r.ok));
  assert.equal(new Set(rs.map((r) => r.ok && r.noteId)).size, 1);
  assert.equal(rs.filter((r) => r.ok && r.duplicate).length, 2);
  assert.equal(await db.orderNote.count({ where: { orderId: o.id } }), 1);
  assert.equal(await db.notificationOutbox.count({ where: { orderId: o.id, type: un.NOTE_EVENT } }), 1);
  const id = rs.find((r) => r.ok && r.outboxId)?.outboxId;
  await n.dispatchInAppFor(db, [id]);
  // İşçi yeniden denemesi: olay "dağıtılmamış" görünse de bildirim ikinci kez yazılmaz
  await db.notificationOutbox.update({ where: { id }, data: { inAppAt: null } });
  await n.dispatchInApp(db);
  await n.dispatchInAppFor(db, [id]);
  assert.deepEqual(await bell(o), ['admin', 'drawer', 'sales']);
  // Başka kullanıcının aynı anahtarı başka notu döndürmez
  assert.deepEqual(await addNote(db, { orderId: o.id, actor: actor(U.sales), text: 'x', requestKey: KEY('dup'), limits }), { ok: false, code: 'NOT_FOUND' });
  // Yeni form = yeni mesaj = yeni bildirim (revizyon / yeni olay engellenmez)
  await say(U.a1, o, 'İkinci mesaj', { requestKey: KEY('second') });
  assert.equal((await bell(o)).length, 6);
}));

dbTest('okunmamış sayaç: başkasının mesajı sayılır, kendi mesajı sayılmaz; müşteri iç notu saymaz; kapsam dışı sipariş sayılmaz; okundu işareti geri gitmez; zil aynı anda okunur', offline(async () => {
  // Bu testin kendi firmaları ve iç ekibi (öbür testlerin mesajları sayıya girmesin: yeni kullanıcı, oluşturulduğu andan sayar)
  const factoryId = U.sales.customerId;
  const C = await db.customer.create({ data: { name: 'CRISTAL VIEW SRL', prefix: 'CRI', email: 'firma@cri.test' } });
  const D = await db.customer.create({ data: { name: 'DOMO GLASS SRL', prefix: 'DOM', email: 'firma@dom.test' } });
  const V = {
    sales: await user('satis3@p9.test', 'Satış 3', 'SATIS', factoryId),
    drawer: await user('cizim3@p9.test', 'Çizim 3', 'CIZIM', factoryId),
    insp: await user('denetim3@p9.test', 'Denetim 3', 'DENETIMCI', factoryId),
    c1: await user('c1@cri.test', 'C1', 'MUSTERI', C.id),
    c2: await user('c2@cri.test', 'C2', 'MUSTERI', C.id),
    d1: await user('d1@dom.test', 'D1', 'MUSTERI', D.id),
  };
  for (const [k, u] of Object.entries(V)) names.set(u.id, `v.${k}`);
  await new Promise((r) => setTimeout(r, 20));
  const o = await order(C, { drawer: V.drawer, by: V.c1 });
  const other = await order(D, { by: V.d1 });
  const t0 = Date.now();
  await say(V.c1, o, 'm1');
  await say(V.sales, o, 's1');
  await say(U.admin, o, 'iç', { internal: true });
  await say(V.d1, other, 'başka firma');
  const counts = async (u) => Object.fromEntries(await un.unreadCounts(db, u, [o.id, other.id]));
  assert.deepEqual(await counts(V.c1), { [o.id]: 1 }, 'c1: satışın mesajı (kendi mesajı ve iç not değil)');
  assert.deepEqual(await counts(V.c2), { [o.id]: 2 }, 'c2: c1 ve satışın mesajı');
  assert.deepEqual(await counts(V.sales), { [o.id]: 2, [other.id]: 1 }, 'satış: müşteri mesajı + iç not');
  assert.deepEqual(await counts(V.insp), { [o.id]: 3, [other.id]: 1 });
  // Toplam (sol menü): yalnızca kapsamdaki siparişler — müşteri başka firmanın siparişini hiç saymaz
  assert.deepEqual(await un.unreadTotal(db, V.c1), { total: 1, orders: 1 });
  assert.deepEqual(await un.unreadTotal(db, V.d1), { total: 0, orders: 0 }, 'D firması: kendi siparişinde yalnızca kendi mesajı; C siparişi sayılmaz');
  // Çizimci: kapsamı çizim gereken siparişler — çizimsiz sipariş (other) sayılmaz
  assert.deepEqual(await un.unreadTotal(db, V.drawer), { total: 3, orders: 1 });
  // Okundu: başka firmanın kullanıcısı işaretleyemez (yazılmaz)
  assert.deepEqual(await un.markNotesRead(db, { user: V.d1, orderId: o.id }), { ok: false, code: 'NOT_FOUND' });
  assert.equal(await db.orderNoteRead.count({ where: { userId: V.d1.id } }), 0);
  // Sayfanın gösterdiği en yeni nota kadar okunur; sonra gelen mesaj okunmamış kalır (sayaç da zil de)
  const shown = (await db.orderNote.findFirstOrThrow({ where: { orderId: o.id }, orderBy: { createdAt: 'desc' } })).createdAt;
  await new Promise((r) => setTimeout(r, 15));
  await say(V.c1, o, 'm2 — sayfa açıldıktan sonra');
  assert.deepEqual(await un.markNotesRead(db, { user: V.sales, orderId: o.id, upTo: shown.toISOString() }), { ok: true, changed: true });
  assert.deepEqual(await counts(V.sales), { [o.id]: 1, [other.id]: 1 });
  const salesBell = await db.notification.findMany({ where: { userId: V.sales.id, orderId: o.id, type: un.NOTE_EVENT }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(salesBell.map((x) => x.isRead), [true, false], 'zilde yalnızca okunan mesajın bildirimi okundu');
  // Geri gitmez: eski bir an (başka sekme) okunma anını geri almaz
  await un.markNotesRead(db, { user: V.sales, orderId: o.id, upTo: new Date(t0 - 60_000).toISOString() });
  const read = await db.orderNoteRead.findUniqueOrThrow({ where: { userId_orderId: { userId: V.sales.id, orderId: o.id } } });
  assert.equal(read.lastReadAt.getTime(), shown.getTime());
  // Gelecek bir an yazılamaz (şimdiye kısılır); okunduktan sonra 0
  await un.markNotesRead(db, { user: V.sales, orderId: o.id, upTo: new Date(Date.now() + 86_400_000).toISOString() });
  assert.ok((await db.orderNoteRead.findUniqueOrThrow({ where: { userId_orderId: { userId: V.sales.id, orderId: o.id } } })).lastReadAt.getTime() <= Date.now());
  assert.deepEqual(await counts(V.sales), { [other.id]: 1 });
  assert.ok((await db.notification.findMany({ where: { userId: V.sales.id, orderId: o.id, type: un.NOTE_EVENT } })).every((x) => x.isRead));
  // Silinmiş sipariş hiçbir sayaca girmez
  await db.order.update({ where: { id: other.id }, data: { removedAt: new Date() } });
  assert.deepEqual(await un.unreadTotal(db, V.sales), { total: 0, orders: 0 });
  // Yeni kullanıcı: oluşturulmadan önceki mesajlar okunmamış görünmez
  const fresh = await user('yeni@p9.test', 'Yeni', 'SATIS', factoryId);
  assert.equal((await un.unreadTotal(db, fresh)).total, 0);
}));

dbTest('müşteri e-posta dili olay anında saklanır (karar 200): kullanıcı sonra dilini değiştirse de e-posta olaydaki dille gider; tercih yoksa Otomatik dil; gerçek SMTP yok', offline(async () => {
  const sent = [];
  const transport = { sendMail: async (m) => { sent.push(m); return { messageId: `m${sent.length}` }; } };
  const opts = { transport, from: 'takip@p9.test', appUrl: 'https://takip.test', timeZone: 'Europe/Bucharest' };
  // Gönderim başlangıç anı (önceki olaylar gönderilmez)
  await dispatchNotifications(db, { ...opts, now: new Date(Date.now() - 1000) });
  const o = await order(A);
  const ev = await db.$transaction((tx) => enqueueOutbox(tx, { type: 'ORDER_OFFER_SENT', orderId: o.id, payload: { actorId: U.admin.id } }));
  assert.equal(ev.payload.lang, 'tr', 'siparişi açan müşterinin kayıtlı tercihi');
  // Kullanıcı tercihini sonra değiştirir: olaydaki dil değişmez
  await db.user.update({ where: { id: U.a1.id }, data: { fixedLanguage: 'ro', language: 'ro' } });
  await dispatchNotifications(db, opts);
  const full = await db.order.findUniqueOrThrow({ where: { id: o.id }, include: { customer: { select: { name: true, email: true } }, createdBy: true, assignedDrawer: true } });
  const tr = renderNotification({ type: 'ORDER_OFFER_SENT', order: full, createdAt: ev.createdAt, recipient: { email: U.a1.email, locale: 'tr', role: null }, appUrl: opts.appUrl, timeZone: opts.timeZone });
  const ro = renderNotification({ type: 'ORDER_OFFER_SENT', order: full, createdAt: ev.createdAt, recipient: { email: U.a1.email, locale: 'ro', role: null }, appUrl: opts.appUrl, timeZone: opts.timeZone });
  assert.notEqual(tr.subject, ro.subject);
  assert.deepEqual(sent.map((m) => [m.to, m.subject]), [[U.a1.email, tr.subject], ['firma@gla.test', tr.subject]]);
  // Otomatik (sabit dil yok): kullanıcının algılanan / son giriş dili; yoksa Romence
  await db.user.update({ where: { id: U.a1.id }, data: { fixedLanguage: null, language: 'tr' } });
  const ev2 = await db.$transaction((tx) => enqueueOutbox(tx, { type: 'ORDER_SHIP_DATE', orderId: o.id, payload: {} }));
  assert.equal(ev2.payload.lang, 'tr');
  // Siparişi iç ekip açtıysa onun dili kullanılmaz → müşteri varsayılanı
  const staffMade = await order(A, { by: U.sales });
  const ev3 = await db.$transaction((tx) => enqueueOutbox(tx, { type: 'ORDER_OFFER_SENT', orderId: staffMade.id, payload: {} }));
  assert.equal(ev3.payload.lang, 'ro');
  // E-postası olmayan olay (mesaj) dil taşımaz; e-posta kuyruğuna da girmez
  await say(U.sales, o, 'mesaj');
  const note = await db.notificationOutbox.findFirstOrThrow({ where: { orderId: o.id, type: un.NOTE_EVENT } });
  assert.equal(note.payload.lang, undefined);
  const before = sent.length;
  await dispatchNotifications(db, opts);
  assert.ok(sent.slice(before).every((m) => !/mesaj/i.test(m.subject)), 'mesaj e-postası gönderilmez');
}));
