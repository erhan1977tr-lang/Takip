// 4.2.11 — bildirim e-postası alıcıları (ürün sahibi 28.10.2026, A2–A8): satış ekibi, müşteri firması ve izolasyonu, geçmiş
// kayıtların e-postaya dönüşmemesi, SMTP geçici hatasında güvenli yeniden deneme. Gerçek SMTP YOK (bellek içi sahte taşıyıcı);
// veritabanı yok (Prisma'nın burada kullanılan where alt kümesini taklit eden sahte istemci). Gerçek veritabanıyla aynı kurallar:
// test/db/eposta-alicilari.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchNotifications, NOTIFY_RULES, recipientsFor, renderNotification, STAMPED_MAIL_TYPES } from '../server/notifications/email.js';
import { enqueueOutbox } from '../server/orders/journal.js';

const OLD = new Date('2026-01-01T00:00:00Z');
const T0 = new Date('2026-10-28T10:00:00Z'); // olayın anı
const LATER = new Date('2026-10-28T11:00:00Z'); // olaydan sonra açılan hesap
const user = (id, email, appRole, extra = {}) => ({
  id, email, appRole, language: 'tr', fixedLanguage: null, isActive: true, deletedAt: null, emailNotifications: true, createdAt: OLD,
  type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', customerId: appRole === 'MUSTERI' ? 'fA' : 'f0', ...extra,
});
// Canlıdaki gibi üç etkin satış kullanıcısı + kitle dışında kalması gerekenler
const SALES = ['satis1@gkh.test', 'satis2@gkh.test', 'satis3@gkh.test'];
const USERS = [
  user('s1', SALES[0], 'SATIS'), user('s2', SALES[1], 'SATIS', { language: 'ro' }), user('s3', SALES[2], 'SATIS'),
  user('sOff', 'pasif-satis@gkh.test', 'SATIS', { isActive: false }),
  user('sDel', 'silindi+sdel@silindi.invalid', 'SATIS', { isActive: false, deletedAt: OLD }),
  user('sNew', 'yeni-satis@gkh.test', 'SATIS', { createdAt: LATER }),
  user('admin', 'admin@gkh.test', 'ADMIN'), user('asist', 'asist@gkh.test', 'YONETICI_YARDIMCISI'), user('drawer', 'cizim@gkh.test', 'CIZIM'),
  // Siparişin firması (fA): siparişi açan a1, öbür etkin kullanıcı a2, e-postayı kapatan a3, pasif a4, olaydan sonra açılan aNew
  user('a1', 'a1@alegrad.test', 'MUSTERI', { language: 'ro' }), user('a2', 'a2@alegrad.test', 'MUSTERI', { language: 'ro' }),
  user('a3', 'a3@alegrad.test', 'MUSTERI', { emailNotifications: false }), user('a4', 'a4@alegrad.test', 'MUSTERI', { isActive: false }),
  user('aNew', 'yeni@alegrad.test', 'MUSTERI', { createdAt: LATER }),
  // Başka firmanın kullanıcısı (fB): hiçbir koşulda alıcı değil
  user('b1', 'b1@beta.test', 'MUSTERI', { customerId: 'fB' }),
];
const ORDER = {
  id: 'o1', orderNo: 'ALE106', orderTypeCode: 'GLASS_ORDER', customerId: 'fA', createdById: 'a1', estimatedShipDate: null, actualShipDate: null,
  customer: { name: 'Alegrad Sticla SRL', email: 'office@alegrad.test' },
  createdBy: { email: 'a1@alegrad.test', language: 'ro', fixedLanguage: null, emailNotifications: true, customerId: 'fA', isActive: true },
  assignedDrawer: { email: 'cizim@gkh.test', language: 'tr', appRole: 'CIZIM', isActive: true },
  orderType: { usesSales: true },
};

/** Prisma where alt kümesi: eşitlik, { in }, { lte }, { lt }, { equals, mode }, OR, JSON path (payload) */
const matches = (row, where = {}) => Object.entries(where).every(([k, v]) => {
  if (k === 'OR') return v.some((w) => matches(row, w));
  if (k === 'payload' && v?.path) return row.payload?.[v.path[0]] === v.equals;
  const x = row[k];
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('in' in v) return v.in.includes(x);
    if ('equals' in v) return v.mode === 'insensitive' ? String(x ?? '').toLowerCase() === String(v.equals).toLowerCase() : x === v.equals;
    if ('lte' in v) return x <= v.lte;
    if ('lt' in v) return x < v.lt;
    return false;
  }
  return v === null ? x == null : x === v;
});
const sorted = (list) => [...list].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
function fakeDb({ users = USERS, order = ORDER, rows = [] } = {}) {
  const settings = new Map();
  const db = {
    rows, users,
    user: {
      findMany: async ({ where }) => sorted(users.filter((u) => matches(u, where))),
      findFirst: async ({ where }) => sorted(users.filter((u) => matches(u, where)))[0] ?? null,
    },
    order: { findUnique: async () => order },
    orderEvent: { findFirst: async () => null },
    offer: { findFirst: async () => null },
    drawingRevision: { findFirst: async () => null },
    fgoDocument: { count: async () => 0 },
    integrationSetting: {
      findUnique: async ({ where }) => (settings.has(where.key) ? { value: settings.get(where.key) } : null),
      upsert: async ({ where, create }) => settings.set(where.key, create.value),
    },
    notificationOutbox: {
      updateMany: async ({ where, data }) => {
        let n = 0;
        for (const r of rows) {
          if (!matches(r, where)) continue;
          if (data.attempts?.increment) r.attempts += 1; else Object.assign(r, data);
          n++;
        }
        return { count: n };
      },
      // Prisma gibi kopya döner (sayaç artışı okunan satırı değiştirmez)
      findMany: async ({ where, take }) => rows.filter((r) => matches(r, where)).sort((a, b) => a.createdAt - b.createdAt).slice(0, take ?? 1000).map((r) => ({ ...r })),
      update: async ({ where, data }) => Object.assign(rows.find((r) => r.id === where.id), data),
    },
  };
  return db;
}
const emails = (list) => list.map((r) => r.email);
const transportOf = (sent, failing = new Set()) => ({
  sendMail: async (m) => {
    if (failing.has(m.to)) { failing.delete(m.to); throw new Error('SMTP 451 geçici hata'); }
    sent.push(m);
    return { messageId: `m${sent.length}` };
  },
});
const ctx = { from: 'takip@gkh.test', appUrl: 'https://takip.test', timeZone: 'Europe/Bucharest' };
const row = (id, type, extra = {}) => ({ id, type, orderId: 'o1', status: 'PENDING', attempts: 0, availableAt: T0, createdAt: T0, payload: {}, ...extra });

// ---------------------------------------------------------------- A2: satış ekibi
test('A2: yeni cam siparişi, çizim revizyonu, teklif değişiklik talebi, üretim onayı → bütün etkin satış ekibi (üç satışçı); pasif / silinmiş / sonradan açılan hesap yok', async () => {
  const db = fakeDb();
  assert.deepEqual(NOTIFY_RULES.ORDER_PRODUCTION_APPROVED(ORDER), ['sales']);
  for (const type of ['ORDER_CREATED', 'ORDER_REVISION_REQUESTED', 'ORDER_OFFER_CHANGE_REQUESTED', 'ORDER_PRODUCTION_APPROVED']) {
    const r = await recipientsFor(db, type, ORDER, { at: T0 });
    assert.deepEqual(r.filter((x) => x.role === 'SATIS').map((x) => x.email), SALES, `${type}: bütün etkin satış ekibi`);
    for (const out of ['pasif-satis@gkh.test', 'silindi+sdel@silindi.invalid', 'yeni-satis@gkh.test']) assert.ok(!emails(r).includes(out), `${type}: ${out}`);
    // Müşteri adresi hiçbir satış olayında yok; yönetici e-postası yalnızca yeni siparişte (karar 218); revizyonda atanmış çizimci
    assert.ok(!r.some((x) => /alegrad|beta/.test(x.email)), `${type}: müşteri yok`);
    assert.equal(r.some((x) => x.email === 'admin@gkh.test'), type === 'ORDER_CREATED', `${type}: yönetici`);
    assert.equal(r.some((x) => x.email === 'cizim@gkh.test'), type === 'ORDER_REVISION_REQUESTED', `${type}: çizimci`);
    assert.equal(new Set(emails(r).map((e) => e.toLowerCase())).size, r.length, `${type}: aynı adres bir kez`);
  }
  // Satışçının dili kendi tercihi
  assert.deepEqual((await recipientsFor(db, 'ORDER_PRODUCTION_APPROVED', ORDER, { at: T0 })).map((x) => x.locale), ['tr', 'ro', 'tr']);
  // Olay sonradan (ör. yeniden denemede) değerlendirilse de sonradan açılan hesap almaz; olay yeni hesaptan sonraysa alır
  assert.ok(emails(await recipientsFor(db, 'ORDER_CREATED', ORDER, { at: new Date(LATER.getTime() + 1000) })).includes('yeni-satis@gkh.test'));
  // Satıştan geçmeyen tip (profil): satış kitlesi boş — satış göremediği siparişin e-postasını almaz
  const profile = { ...ORDER, orderTypeCode: 'PROFILE_ORDER', orderType: { usesSales: false } };
  assert.deepEqual(await recipientsFor(db, 'ORDER_PRODUCTION_APPROVED', profile, { at: T0 }), []);
  assert.deepEqual(emails(await recipientsFor(db, 'ORDER_CREATED', profile, { at: T0 })), ['admin@gkh.test', 'asist@gkh.test'], 'profil yalnızca yöneticiye');
});

test('A2: çizim onayı ve DWG yanıtları değişmedi (atanmış çizimci + ilgili satışçı); yönetici ve yardımcısı bu olaylarda e-posta almaz', async () => {
  const db = fakeDb();
  const withSales = { ...ORDER, salesUsers: [USERS.find((u) => u.id === 's2')] };
  for (const type of ['ORDER_DRAWING_APPROVED', 'ORDER_DWG_RESUBMITTED', 'ORDER_DWG_FACTORY_REQUESTED']) {
    assert.deepEqual(emails(await recipientsFor(db, type, withSales, { at: T0 })), ['cizim@gkh.test', 'satis2@gkh.test'], type);
  }
  for (const type of ['ORDER_REVISION_REQUESTED', 'ORDER_OFFER_CHANGE_REQUESTED', 'ORDER_PRODUCTION_APPROVED']) {
    const r = emails(await recipientsFor(db, type, withSales, { at: T0 }));
    assert.ok(!r.includes('admin@gkh.test') && !r.includes('asist@gkh.test'), `${type}: yönetici e-postası yok`);
  }
});

// ---------------------------------------------------------------- A4: müşteri firması
const FIRM_WIDE = ['ORDER_OFFER_SENT', 'ORDER_OFFER_UPDATED', 'ORDER_PRODUCTION_APPROVAL_REQUESTED', 'ORDER_PRODUCTION_APPROVAL_REMINDER'];
const LEGACY_CUSTOMER = ['ORDER_DWG_FAULTY', 'ORDER_DWG_FAULTY_UNDONE', 'ORDER_DRAWING_UPLOADED', 'ORDER_PROFILE_OFFER_SENT', 'ORDER_PROFORMA', 'ORDER_INVOICED', 'ORDER_SHIP_DATE', 'ORDER_DELIVERY_DATE_CHANGED', 'ORDER_PICKUP_MOVED'];

test('A4: teklif ve üretim onayı olayları → firmanın bütün etkin, e-postası açık kullanıcıları + firma adresi; tercihi kapalı / pasif / sonradan açılan / başka firma yok', async () => {
  const db = fakeDb();
  for (const type of FIRM_WIDE) {
    assert.deepEqual(NOTIFY_RULES[type](ORDER), ['customerFirm'], type);
    const r = await recipientsFor(db, type, ORDER, { at: T0, lang: 'ro' });
    assert.deepEqual(emails(r), ['a1@alegrad.test', 'a2@alegrad.test', 'office@alegrad.test'], type);
    assert.ok(r.every((x) => x.role === null), `${type}: müşteri alıcısı (tam firma adı, maske yok)`);
  }
  // Siparişi açanın tercihi yalnızca kendisini etkiler (diğer kullanıcılar ve firma adresi alır)
  const quiet = fakeDb({ users: USERS.map((u) => (u.id === 'a1' ? { ...u, emailNotifications: false } : u)) });
  assert.deepEqual(emails(await recipientsFor(quiet, 'ORDER_OFFER_SENT', ORDER, { at: T0 })), ['a2@alegrad.test', 'office@alegrad.test']);
  // Öbür müşteri olayları talimatın listesinde değil: eski kural aynen (siparişi açan + firma adresi; siparişi açan kapattıysa hiçbiri)
  // — firma geneline alınmaları rapordadır, ürün sahibinin kararını bekler. Firma adresi izolasyonu bunlarda da geçerli.
  const quietOrder = { ...ORDER, createdBy: { ...ORDER.createdBy, emailNotifications: false } };
  for (const type of LEGACY_CUSTOMER) {
    assert.deepEqual(NOTIFY_RULES[type](ORDER), ['customer'], type);
    assert.deepEqual(emails(await recipientsFor(db, type, ORDER, { at: T0 })), ['a1@alegrad.test', 'office@alegrad.test'], type);
    assert.deepEqual(await recipientsFor(db, type, quietOrder, { at: T0 }), [], `${type}: eski tercih kuralı`);
  }
  // Siparişi açan pasifse ona gitmez; başka firmaya taşınmışsa (bugünkü kayıt) ona gitmez
  const moved = fakeDb({ users: USERS.map((u) => (u.id === 'a1' ? { ...u, customerId: 'fB' } : u)) });
  assert.deepEqual(emails(await recipientsFor(moved, 'ORDER_OFFER_SENT', ORDER, { at: T0 })), ['a2@alegrad.test', 'office@alegrad.test'], 'başka firmaya geçen hesap alıcı değil');
  // Olaydan sonra açılan hesap almaz (eski olay yeni hesaba gitmez)
  assert.ok(!emails(await recipientsFor(db, 'ORDER_OFFER_SENT', ORDER, { at: T0 })).includes('yeni@alegrad.test'));
});

test('A4 / A5: firma adresi bir hesabın adresiyse yalnızca firmanın etkin, tercihi açık müşteri hesabıysa; başka firmanın / iç ekibin / pasif hesabın adresine gitmez; tekil', async () => {
  const withFirm = (email) => ({ ...ORDER, customer: { ...ORDER.customer, email } });
  const db = fakeDb();
  // Firma adresi başka firmanın kullanıcısının giriş adresi (büyük / küçük harf farkıyla bile) → gönderilmez
  assert.deepEqual(emails(await recipientsFor(db, 'ORDER_OFFER_SENT', withFirm('B1@Beta.test'), { at: T0 })), ['a1@alegrad.test', 'a2@alegrad.test']);
  // İç ekibin adresi → gönderilmez (müşteri e-postası iç ekibe firma adresi diye gitmez)
  assert.deepEqual(emails(await recipientsFor(db, 'ORDER_OFFER_SENT', withFirm('satis1@gkh.test'), { at: T0 })), ['a1@alegrad.test', 'a2@alegrad.test']);
  // Firmanın pasif / tercihi kapalı kullanıcısının adresi → gönderilmez
  for (const e of ['a4@alegrad.test', 'a3@alegrad.test']) assert.deepEqual(emails(await recipientsFor(db, 'ORDER_OFFER_SENT', withFirm(e), { at: T0 })), ['a1@alegrad.test', 'a2@alegrad.test'], e);
  // Firmanın etkin kullanıcısının adresi → bir kez (tekil, büyük / küçük harf farkı sayılmaz)
  const same = await recipientsFor(db, 'ORDER_OFFER_SENT', withFirm(' A2@ALEGRAD.TEST '), { at: T0 });
  assert.deepEqual(emails(same), ['a1@alegrad.test', 'a2@alegrad.test']);
  // Geçersiz / boş firma adresi ya da geçersiz kullanıcı adresi diğer alıcıları engellemez
  const bad = fakeDb({ users: [...USERS, user('aBad', 'bozuk-adres', 'MUSTERI')] });
  for (const e of ['bozuk', '', null]) assert.deepEqual(emails(await recipientsFor(bad, 'ORDER_OFFER_SENT', withFirm(e), { at: T0 })), ['a1@alegrad.test', 'a2@alegrad.test'], String(e));
  // Eski kuralın olaylarında da (siparişi açan + firma adresi) başka firmanın kullanıcısının adresine firma adresi diye gitmez
  assert.deepEqual(emails(await recipientsFor(db, 'ORDER_SHIP_DATE', withFirm('B1@Beta.test'), { at: T0 })), ['a1@alegrad.test']);
  // Başka firmanın kullanıcısı hiçbir müşteri olayında alıcı değil
  let customerTypes = 0;
  for (const type of Object.keys(NOTIFY_RULES)) {
    if (!NOTIFY_RULES[type](ORDER).some((a) => a === 'customer' || a === 'customerFirm')) continue;
    customerTypes += 1;
    assert.ok(!emails(await recipientsFor(db, type, ORDER, { at: T0 })).includes('b1@beta.test'), type);
  }
  assert.equal(customerTypes, FIRM_WIDE.length + LEGACY_CUSTOMER.length, 'bütün müşteri olayları denetlendi');
});

// ---------------------------------------------------------------- A7: geçmiş kayıtlar
test('A7: kuralı sonradan eklenen üretim onayı — eski (damgasız) PENDING satırlar e-postaya dönüşmez ve DOKUNULMADAN kalır; damgalı yeni satır bir kez gider', async () => {
  assert.deepEqual([...STAMPED_MAIL_TYPES], ['ORDER_PRODUCTION_APPROVED']);
  const before = new Date('2026-09-01T10:00:00Z');
  const rows = [
    // 4.2.1–4.2.10 arasında yalnızca uygulama içi bildirim için yazılmış onaylar (e-posta başlangıcından önce ve sonra)
    row('eski1', 'ORDER_PRODUCTION_APPROVED', { createdAt: before, availableAt: before, payload: { offerId: 'f1', revision: 1, actorId: 'a1' } }),
    row('eski2', 'ORDER_PRODUCTION_APPROVED', { createdAt: new Date('2026-10-20T10:00:00Z'), availableAt: new Date('2026-10-20T10:00:00Z'), payload: { offerId: 'f2', revision: 1, lang: 'ro' } }),
    // E-postası olmayan (yalnızca zil) olaylar: hep PENDING kalırlar (normal)
    ...['ORDER_DWG_READY', 'ORDER_NOTE_ADDED', 'ORDER_OFFER_RETURNED', 'ORDER_OFFER_SUBMITTED'].map((t, i) => row(`zil${i}`, t, { createdAt: before, availableAt: before })),
    // 4.2.11 kodunun yazdığı damgalı onay
    row('yeni', 'ORDER_PRODUCTION_APPROVED', { payload: { offerId: 'f3', revision: 2, emailRule: true, lang: 'ro' } }),
  ];
  const snapshot = JSON.stringify(rows.filter((r) => r.id !== 'yeni'));
  const db = fakeDb({ rows });
  // E-posta başlangıç anı ilk turda yazılır (eski1 ondan önce, eski2 sonra)
  await db.integrationSetting.upsert({ where: { key: 'notify.since' }, create: { key: 'notify.since', value: { at: '2026-10-01T00:00:00.000Z' } } });
  const sent = [];
  for (let i = 0; i < 4; i++) await dispatchNotifications(db, { ...ctx, transport: transportOf(sent), now: new Date(T0.getTime() + i * 3_600_000) });
  assert.equal(JSON.stringify(rows.filter((r) => r.id !== 'yeni')), snapshot, 'eski satırlar hiç değişmedi (durum, deneme, hata)');
  const fresh = rows.find((r) => r.id === 'yeni');
  assert.equal(fresh.status, 'SENT');
  assert.deepEqual(sent.map((m) => m.to), SALES, 'yalnızca yeni onay; satış kullanıcısı başına bir e-posta');
  assert.deepEqual(fresh.payload.sentTo, SALES.map((e) => e.toLowerCase()));
});

test('A7: enqueueOutbox yalnızca kuralı sonradan eklenen türü damgalar; dil kuralı aynen', async () => {
  const written = [];
  const tx = {
    order: { async findUnique() { return { customerId: 'fA', createdBy: { fixedLanguage: 'tr', language: 'ro', customerId: 'fA' } }; } },
    notificationOutbox: { async create({ data }) { written.push(data); return { id: `ob${written.length}`, ...data }; } },
  };
  await enqueueOutbox(tx, { type: 'ORDER_PRODUCTION_APPROVED', orderId: 'o1', payload: { offerId: 'f1', revision: 2, actorId: 'a1' } });
  await enqueueOutbox(tx, { type: 'ORDER_OFFER_SENT', orderId: 'o1', payload: { actorId: 'x' } });
  await enqueueOutbox(tx, { type: 'ORDER_NOTE_ADDED', orderId: 'o1', payload: { noteId: 'n1' } });
  assert.deepEqual(written.map((w) => [w.type, w.payload.emailRule ?? null, w.payload.lang ?? null]), [
    ['ORDER_PRODUCTION_APPROVED', true, 'tr'], ['ORDER_OFFER_SENT', null, 'tr'], ['ORDER_NOTE_ADDED', null, null],
  ]);
  assert.deepEqual(written[0].payload, { offerId: 'f1', revision: 2, actorId: 'a1', lang: 'tr', emailRule: true }, 'olayın verisi korunur');
});

// ---------------------------------------------------------------- A8: yeniden deneme / mükerrer yok
test('A8: SMTP geçici hatası — öbür alıcılar alır, satır bekler; yeniden denemede yalnızca hata veren alıcıya; aynı adrese ikinci e-posta yok', async () => {
  const rows = [row('r1', 'ORDER_PRODUCTION_APPROVED', { payload: { offerId: 'f3', revision: 2, emailRule: true } })];
  const db = fakeDb({ rows });
  await db.integrationSetting.upsert({ where: { key: 'notify.since' }, create: { key: 'notify.since', value: { at: OLD.toISOString() } } });
  const sent = [];
  const failing = new Set([SALES[1]]);
  const transport = transportOf(sent, failing);
  const r1 = await dispatchNotifications(db, { ...ctx, transport, now: T0 });
  assert.deepEqual([r1.sent, r1.failed], [0, 1]);
  assert.deepEqual(sent.map((m) => m.to), [SALES[0], SALES[2]]);
  assert.equal(rows[0].status, 'PENDING');
  assert.match(rows[0].lastError, /satis2@gkh\.test: SMTP 451/);
  assert.deepEqual(rows[0].payload.sentTo, [SALES[0], SALES[2]], 'kabul edilen alıcılar yazıldı');
  assert.equal(rows[0].availableAt.getTime(), T0.getTime() + 60_000, 'artan aralıkla yeniden (1 dk)');
  // Süre dolmadan yeni deneme yok
  await dispatchNotifications(db, { ...ctx, transport, now: new Date(T0.getTime() + 30_000) });
  assert.equal(sent.length, 2);
  const r2 = await dispatchNotifications(db, { ...ctx, transport, now: new Date(T0.getTime() + 61_000) });
  assert.equal(r2.sent, 1);
  assert.deepEqual(sent.map((m) => m.to), [SALES[0], SALES[2], SALES[1]], 'yalnızca hata veren alıcıya');
  assert.equal(rows[0].status, 'SENT');
  for (let i = 0; i < 3; i++) await dispatchNotifications(db, { ...ctx, transport, now: new Date(T0.getTime() + (i + 2) * 3_600_000) });
  assert.equal(sent.length, 3, 'gönderilmiş satır yeniden gönderilmez');
});

test('A8: işçi turun ortasında hata alırsa (kayıt yazılamadı) ilerleme alıcı başına yazılmış olduğundan yeniden denemede mükerrer e-posta gitmez', async () => {
  const rows = [row('r2', 'ORDER_OFFER_CHANGE_REQUESTED', { createdAt: new Date(T0.getTime() - 120_000), payload: { offerId: 'f3', revision: 2 } })];
  const db = fakeDb({ rows });
  await db.integrationSetting.upsert({ where: { key: 'notify.since' }, create: { key: 'notify.since', value: { at: OLD.toISOString() } } });
  // Tur sonundaki "gönderildi" kaydı bir kez yazılamaz (veritabanı kesintisi)
  const realUpdate = db.notificationOutbox.update;
  let broken = true;
  db.notificationOutbox.update = async (q) => {
    if (broken && q.data.status === 'SENT') { broken = false; throw new Error('bağlantı koptu'); }
    return realUpdate(q);
  };
  const sent = [];
  const r1 = await dispatchNotifications(db, { ...ctx, transport: transportOf(sent), now: T0 });
  assert.equal(r1.failed, 1);
  assert.deepEqual(sent.map((m) => m.to), SALES);
  assert.equal(rows[0].status, 'PENDING');
  assert.deepEqual(rows[0].payload.sentTo, SALES, 'ilerleme alıcı başına yazılmıştı');
  const r2 = await dispatchNotifications(db, { ...ctx, transport: transportOf(sent), now: new Date(T0.getTime() + 10 * 60_000) });
  assert.equal(r2.sent, 1);
  assert.equal(rows[0].status, 'SENT');
  assert.deepEqual(sent.map((m) => m.to), SALES, 'yeniden denemede kimseye ikinci e-posta yok');
});

// ---------------------------------------------------------------- A3: üretim onayı e-postasının içeriği
test('A3: üretim onayı e-postası — sipariş no, maskeli firma, onay tarihi ve saati (Romanya), teklif sürümü, güvenli bağlantı; tutar yok; tr / ro', () => {
  const at = new Date('2026-10-28T10:15:00Z');
  const mail = (locale) => renderNotification({ type: 'ORDER_PRODUCTION_APPROVED', order: ORDER, createdAt: at, recipient: { locale, role: 'SATIS' }, appUrl: 'https://takip.test', timeZone: 'Europe/Bucharest', payload: { offerId: 'f3', revision: 2, actorId: 'a1', emailRule: true } });
  const tr = mail('tr');
  assert.equal(tr.subject, 'ALE106 — Müşteri üretime alınmasını onayladı');
  assert.match(tr.text, /Sipariş no: ALE106/);
  assert.match(tr.text, /Firma: Ale\*{10}/);
  assert.match(tr.text, /Onay tarihi ve saati: 28\.10\.2026, 12:15/);
  assert.match(tr.text, /Teklif sürümü: v2/);
  assert.match(tr.text, /https:\/\/takip\.test\/siparisler\/o1/);
  assert.ok(!tr.text.includes('Alegrad') && !tr.html.includes('Alegrad'), 'satışa tam firma adı gitmez');
  assert.ok(!/office@|a1@|EUR|RON|\d+,\d{2}\b/.test(tr.text.replace(/28\.10\.2026, 12:15/, '')), 'adres / tutar yok');
  assert.match(tr.html, /cid:gkh-logo@takip/, 'ortak GKH şablonu');
  const ro = mail('ro');
  assert.equal(ro.subject, 'ALE106 — Clientul a aprobat intrarea în producție');
  assert.match(ro.text, /Data și ora aprobării: 28\.10\.2026, 12:15/);
  assert.match(ro.text, /Versiunea ofertei: v2/);
  // Öbür olayların tarih satırı değişmedi
  const created = renderNotification({ type: 'ORDER_CREATED', order: ORDER, createdAt: at, recipient: { locale: 'tr', role: 'SATIS' }, appUrl: 'https://takip.test', timeZone: 'Europe/Bucharest' });
  assert.match(created.text, /Tarih: 28\.10\.2026, 12:15/);
  assert.ok(!created.text.includes('Teklif sürümü'));
});
