// Bildirim e-postaları: olay → alıcı, metin (maske, bağlantı), gönderim / yeniden deneme / eski olaylar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchNotifications, recipientsFor, renderNotification } from '../server/notifications/email.js';

const order = {
  id: 'o1', orderNo: 'GLA68', orderTypeCode: 'GLASS_ORDER', customerId: 'c1', createdById: 'u-ana', estimatedShipDate: new Date('2026-10-23T12:00:00Z'), actualShipDate: null,
  customer: { name: 'Glass and More', email: 'office@glass.test' },
  createdBy: { email: 'ana@glass.test', language: 'ro', customerId: 'c1' },
  assignedDrawer: null,
};
const OLD = new Date('2026-01-01T00:00:00Z');
const person = (id, email, appRole, extra = {}) => ({
  id, email, appRole, language: 'tr', fixedLanguage: null, isActive: true, deletedAt: null, emailNotifications: true, createdAt: OLD,
  type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', customerId: appRole === 'MUSTERI' ? 'c1' : 'f0', ...extra,
});
const users = [
  person('u-admin', 'admin@gkh.test', 'ADMIN'),
  person('u-satis', 'satis@gkh.test', 'SATIS'),
  person('u-cizim', 'cizim@gkh.test', 'CIZIM'),
  // Pasif yönetici hesabı (karar 218): yöneticinin e-postaları yalnızca etkin hesaplara
  person('u-eski', 'eski-yonetici@gkh.test', 'ADMIN', { language: 'ro', isActive: false }),
  // Siparişi açan müşteri kullanıcısı (firma c1)
  person('u-ana', 'ana@glass.test', 'MUSTERI', { language: 'ro' }),
];
/** Prisma'nın burada kullanılan where alt kümesi: eşitlik, { in }, { lte }, { lt }, { equals, mode: 'insensitive' }, OR, JSON path */
const matches = (row, where = {}) => Object.entries(where).every(([k, v]) => {
  if (k === 'OR') return v.some((w) => matches(row, w));
  if (k === 'payload' && v?.path) return row.payload?.[v.path[0]] === v.equals;
  const x = row[k];
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('in' in v) return v.in.includes(x);
    if ('equals' in v) return v.mode === 'insensitive' ? String(x ?? '').toLowerCase() === String(v.equals).toLowerCase() : x === v.equals;
    if ('lte' in v) return x <= v.lte;
    if ('lt' in v) return x < v.lt;
    if ('not' in v) return x !== v.not;
    return false;
  }
  return v === null ? x == null : x === v;
});
const sorted = (list) => [...list].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
const fakeDb = (rows = []) => {
  const settings = new Map();
  return {
    rows,
    user: {
      findMany: async ({ where }) => sorted(users.filter((u) => matches(u, where))),
      findFirst: async ({ where }) => sorted(users.filter((u) => matches(u, where)))[0] ?? null,
    },
    order: { findUnique: async () => order },
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
      findMany: async ({ where }) => rows.filter((r) => matches(r, where)),
      update: async ({ where, data }) => Object.assign(rows.find((r) => r.id === where.id), data),
    },
  };
};
/** Testin geçici kullanıcıları: test sonunda kaldırılır */
const withUsers = async (extra, fn) => {
  users.push(...extra);
  try { return await fn(); } finally { for (const u of extra) users.splice(users.indexOf(u), 1); }
};

test('bildirim alıcıları: müşteri olayı → siparişi açan + firma e-postası; yeni cam siparişi → satış; çizim → çizim ekibi', async () => {
  const db = fakeDb();
  assert.deepEqual((await recipientsFor(db, 'ORDER_OFFER_SENT', order)).map((r) => r.email), ['ana@glass.test', 'office@glass.test']);
  // Yeni cam siparişi satışa VE yöneticiye (karar 218); pasif yönetici hesabına gitmez
  assert.deepEqual((await recipientsFor(db, 'ORDER_CREATED', order)).map((r) => r.email), ['satis@gkh.test', 'admin@gkh.test']);
  assert.deepEqual((await recipientsFor(db, 'ORDER_CREATED', { ...order, orderTypeCode: 'PROFILE_ORDER' })).map((r) => r.email), ['admin@gkh.test'], 'profil satışa gitmez');
  assert.deepEqual((await recipientsFor(db, 'ORDER_SENT_TO_DRAWING', order)).map((r) => r.email), ['cizim@gkh.test']);
  const assigned = { ...order, assignedDrawer: { email: 'ali@gkh.test', language: 'tr', appRole: 'CIZIM' } };
  // Müşterinin çizim onayı: atanmış çizimci + ilgili satışçı; yöneticiye gitmez (karar 84)
  const withSales = { ...assigned, salesUsers: [{ email: 'selin@gkh.test', language: 'ro', appRole: 'SATIS' }] };
  const adminAsSales = { ...assigned, salesUsers: [{ email: 'admin@gkh.test', language: 'tr', appRole: 'ADMIN' }] };
  assert.deepEqual((await recipientsFor(db, 'ORDER_DRAWING_APPROVED', withSales)).map((r) => r.email), ['ali@gkh.test', 'selin@gkh.test']);
  assert.deepEqual((await recipientsFor(db, 'ORDER_DRAWING_APPROVED', assigned)).map((r) => r.email), ['ali@gkh.test', 'satis@gkh.test'], 'satışçı bilinmiyorsa satış ekibi');
  // Müşterinin revizyon talebi (4.2.11): atanmış çizimci + BÜTÜN etkin satış ekibi — ilgili satışçı aranmaz; yöneticiye gitmez
  for (const o of [withSales, assigned, adminAsSales]) {
    assert.deepEqual((await recipientsFor(db, 'ORDER_REVISION_REQUESTED', o)).map((r) => r.email), ['ali@gkh.test', 'satis@gkh.test']);
  }
  for (const type of ['ORDER_REVISION_REQUESTED', 'ORDER_DRAWING_APPROVED']) {
    assert.ok(!(await recipientsFor(db, type, adminAsSales)).some((r) => r.email === 'admin@gkh.test'), `${type}: yöneticiye gitmez`);
  }
  assert.deepEqual((await recipientsFor(db, 'ORDER_REVISION_REQUESTED', withSales)).map((r) => r.role), ['CIZIM', 'SATIS']);
  assert.deepEqual(await recipientsFor(db, 'ORDER_HOLD', order), [], 'kuralı olmayan olay');
});

test('bildirim metni: sipariş no, firma (satış ve çizimde maskeli), işlem, tarih, yükleme tarihi, bağlantı', () => {
  const at = new Date('2026-10-01T10:00:00Z');
  const c = renderNotification({ type: 'ORDER_SHIP_DATE', order, createdAt: at, recipient: { locale: 'ro', role: null }, appUrl: 'https://takip.test', timeZone: 'Europe/Bucharest' });
  assert.match(c.subject, /^GLA68 — /);
  assert.match(c.text, /Glass and More/);
  assert.match(c.text, /23\.10\.2026/);
  assert.match(c.text, /https:\/\/takip\.test\/siparisler\/o1/);
  const s = renderNotification({ type: 'ORDER_CREATED', order, createdAt: at, recipient: { locale: 'tr', role: 'SATIS' }, appUrl: 'https://takip.test', timeZone: 'Europe/Bucharest' });
  assert.match(s.text, /Firma: Gla\*{10}/);
  assert.ok(!s.text.includes('Glass and More'), 'satış tam adı görmez');
  assert.match(s.subject, /Yeni sipariş/);
});

test('revizyon e-postası: müşterinin notu ve sürüm metin olarak yazılır (HTML kaçışlı, konuya girmez); firma adı maskeli', () => {
  const at = new Date('2026-10-01T10:00:00Z');
  const note = 'Kenar <b>5 mm</b> & "delik" <script>alert(1)</script>\nikinci satır';
  const base = { type: 'ORDER_REVISION_REQUESTED', order, createdAt: at, appUrl: 'https://takip.test', timeZone: 'Europe/Bucharest', revision: { note, version: 2 } };
  const d = renderNotification({ ...base, recipient: { locale: 'tr', role: 'CIZIM' } });
  assert.match(d.subject, /^GLA68 — Müşteri revizyon istedi$/, 'not konu satırında yok');
  assert.ok(d.text.includes(`Revizyon notu: ${note}`));
  assert.match(d.text, /Çizim sürümü: v2/);
  assert.match(d.text, /https:\/\/takip\.test\/siparisler\/o1/);
  assert.ok(!d.html.includes('<script>') && !d.html.includes('<b>5 mm</b>'), 'not HTML olarak yorumlanmaz');
  assert.ok(d.html.includes('Kenar &lt;b&gt;5 mm&lt;/b&gt; &amp; &quot;delik&quot; &lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.match(d.text, /Firma: Gla\*{10}/);
  assert.ok(!d.text.includes('Glass and More') && !d.html.includes('Glass and More'), 'çizim ve satış tam adı görmez');
  const s = renderNotification({ ...base, recipient: { locale: 'ro', role: 'SATIS' } });
  assert.match(s.text, /Nota de revizie: Kenar/);
  assert.ok(!s.text.includes('Glass and More'));
  // Onay e-postasında not satırı yok; başka olaya not sızmaz
  const a = renderNotification({ ...base, type: 'ORDER_DRAWING_APPROVED', recipient: { locale: 'tr', role: 'CIZIM' } });
  assert.ok(!a.text.includes('Revizyon notu') && !a.text.includes('Kenar'));
});

test('revizyon e-postası gönderimi (4.2.11): atanmış çizimci + bütün satış ekibi; ilgili satışçı aranmaz; not olayın anındaki talepten gelir', async () => {
  const t0 = new Date('2026-10-01T10:00:00Z');
  const db = fakeDb([]);
  await dispatchNotifications(db, { transport: { sendMail: async () => {} }, from: 'x', appUrl: 'https://takip.test', now: t0 });
  db.rows.push({ id: 'r1', type: 'ORDER_REVISION_REQUESTED', orderId: 'o1', status: 'PENDING', attempts: 0, availableAt: t0, createdAt: new Date(t0.getTime() + 1000), payload: {} });
  const asked = [];
  db.order.findUnique = async () => ({ ...order, assignedDrawer: { email: 'ali@gkh.test', language: 'tr', appRole: 'CIZIM' } });
  db.orderEvent = { findFirst: async (q) => { asked.push(['orderEvent', q.where]); return { user: { email: 'selin@gkh.test', language: 'tr', appRole: 'SATIS' } }; } };
  db.offer = { findFirst: async () => null };
  db.drawingRevision = { findFirst: async (q) => { asked.push(['revision', q.where]); return { comment: 'Delik yeri yanlış', drawing: { version: 1 } }; } };
  const mails = [];
  await withUsers([person('u-satis2', 'satis2@gkh.test', 'SATIS', { language: 'ro' })], async () => {
    const r = await dispatchNotifications(db, { transport: { sendMail: async (m) => mails.push(m) }, from: 'x', appUrl: 'https://takip.test', now: new Date(t0.getTime() + 2000) });
    assert.equal(r.sent, 1);
  });
  assert.deepEqual(mails.map((m) => m.to), ['ali@gkh.test', 'satis@gkh.test', 'satis2@gkh.test'], 'atanmış çizimci + bütün etkin satış ekibi; yönetici yok');
  // Ortak GKH başlığı (karar 129): bildirim e-postası logoyla gider — alıcılar ve metin aynen
  assert.ok(mails.every((m) => m.html.includes('<img src="cid:gkh-logo@takip"') && m.attachments.length === 1 && m.attachments[0].cid === 'gkh-logo@takip' && !('lang' in m)));
  assert.ok(mails.slice(0, 2).every((m) => m.text.includes('Revizyon notu: Delik yeri yanlış') && m.text.includes('GLA68')));
  assert.match(mails[2].text, /Nota de revizie: Delik yeri yanlış/, 'satışçının kendi dili');
  assert.deepEqual(asked.map(([k]) => k), ['revision'], 'ilgili satışçı (SENT_TO_DRAWING) aranmaz');
  assert.ok(asked[0][1].createdAt.lte instanceof Date && asked[0][1].drawing.orderId === 'o1');
});

test('bildirim gönderimi: ilk çalıştırmadan önceki olaylar atlanır; hata yeniden denenir, gönderilen alıcıya tekrar gitmez', async () => {
  const t0 = new Date('2026-10-01T10:00:00Z');
  const rows = [{ id: 'old', type: 'ORDER_OFFER_SENT', orderId: 'o1', status: 'PENDING', attempts: 0, availableAt: t0, createdAt: new Date(t0.getTime() - 60_000), payload: {} }];
  const db = fakeDb(rows);
  const sent = [];
  let failOnce = true;
  const senders = [];
  const transport = { sendMail: async (m) => { senders.push(m.from); if (m.to === 'office@glass.test' && failOnce) { failOnce = false; throw new Error('SMTP 451'); } sent.push(m.to); } };
  const ctx = { transport, from: 'Takip <n@gkh.test>', appUrl: 'https://takip.test' };
  const r0 = await dispatchNotifications(db, { ...ctx, now: t0 });
  assert.equal(r0.skipped, 1);
  assert.equal(rows[0].status, 'SKIPPED', 'birikmiş eski olay gönderilmez');
  rows.push({ id: 'n1', type: 'ORDER_OFFER_SENT', orderId: 'o1', status: 'PENDING', attempts: 0, availableAt: t0, createdAt: new Date(t0.getTime() + 1000), payload: {} });
  const r1 = await dispatchNotifications(db, { ...ctx, now: new Date(t0.getTime() + 2000) });
  assert.equal(r1.failed, 1);
  assert.deepEqual(sent, ['ana@glass.test']);
  assert.equal(rows[1].status, 'PENDING');
  assert.match(rows[1].lastError, /SMTP 451/);
  const r2 = await dispatchNotifications(db, { ...ctx, now: new Date(t0.getTime() + 10 * 60_000) });
  assert.equal(r2.sent, 1);
  assert.deepEqual(sent, ['ana@glass.test', 'office@glass.test'], 'ilk alıcıya ikinci kez gitmez');
  assert.equal(rows[1].status, 'SENT');
  // Gönderen (karar 133): her denemede (başarısız olan dahil) resmî firma adı + ayarlanan adres; yeniden deneme kuralı aynı
  assert.deepEqual(senders, ['GKH Trading Invest SRL <n@gkh.test>', 'GKH Trading Invest SRL <n@gkh.test>', 'GKH Trading Invest SRL <n@gkh.test>']);
});

test('bildirim tercihi (4.2.11): siparişi açanın tercihi yalnızca kendisini etkiler; firmanın diğer kullanıcıları ve firma adresi alır; iç ekip etkilenmez; dil', async () => {
  const db = fakeDb();
  const ana = users.find((u) => u.id === 'u-ana');
  await withUsers([person('u-mihai', 'mihai@glass.test', 'MUSTERI', { language: 'ro' })], async () => {
    ana.emailNotifications = false;
    try {
      assert.deepEqual((await recipientsFor(db, 'ORDER_OFFER_SENT', order)).map((r) => r.email), ['mihai@glass.test', 'office@glass.test'], 'siparişi açan kapattı: yalnızca kendisi çıkar');
      assert.deepEqual((await recipientsFor(db, 'ORDER_CREATED', order)).map((r) => r.email), ['satis@gkh.test', 'admin@gkh.test'], 'iç ekip bildirimi sürer');
    } finally {
      ana.emailNotifications = true;
    }
    // Firma adresi bildirimi kapatmış bir kullanıcının adresiyse (büyük / küçük harf farkı sayılmaz) firma adresi diye kullanılmaz
    await withUsers([person('u-office', 'Office@Glass.test', 'MUSTERI', { emailNotifications: false })], async () => {
      assert.deepEqual((await recipientsFor(db, 'ORDER_OFFER_SENT', order)).map((r) => r.email), ['ana@glass.test', 'mihai@glass.test'], 'bildirimi kapatmış kullanıcının adresi atlanır');
    });
    // Dil (karar 200): siparişi açan ve firma adresi olayın dili (sabit dil / payload.lang); firmanın diğer kullanıcısı kendi dili
    const fixed = { ...order, createdBy: { ...order.createdBy, language: 'ro', fixedLanguage: 'tr' } };
    assert.deepEqual((await recipientsFor(db, 'ORDER_OFFER_SENT', fixed)).map((r) => [r.email, r.locale]), [['ana@glass.test', 'tr'], ['mihai@glass.test', 'ro'], ['office@glass.test', 'tr']]);
    assert.deepEqual((await recipientsFor(db, 'ORDER_OFFER_SENT', order, { lang: 'tr' })).map((r) => r.locale), ['tr', 'ro', 'tr'], 'olayın saklanan dili');
    // Teklif / onay dışındaki müşteri olayları eski kuralla: siparişi açan + firma adresi; siparişi açan kapattıysa hiçbiri
    assert.deepEqual((await recipientsFor(db, 'ORDER_SHIP_DATE', order)).map((r) => r.email), ['ana@glass.test', 'office@glass.test']);
    const off = { ...order, createdBy: { ...order.createdBy, emailNotifications: false } };
    assert.deepEqual(await recipientsFor(db, 'ORDER_SHIP_DATE', off), [], 'eski kural: ne kendisine ne firma adresine');
  });
});

test('yöneticinin e-postaları (karar 218): yeni sipariş, fabrika fiyatı değişikliği, geri alma, telafi fiyatı; işlemi yapan yöneticiye ve pasif hesaba gitmez; tutar yazılmaz', async () => {
  const db = fakeDb();
  for (const type of ['ORDER_PRICE_OVERRIDE', 'ORDER_OFFER_WITHDRAWN', 'ORDER_COMPENSATION_PRICE']) {
    assert.deepEqual((await recipientsFor(db, type, order)).map((r) => r.email), ['admin@gkh.test'], `${type}: yalnızca etkin yönetici`);
    // Telafiyi yöneticinin kendisi açtıysa kendi işlemi kendisine e-postalanmaz
    assert.deepEqual(await recipientsFor(db, type, order, { actorId: 'u-admin' }), [], `${type}: işlemi yapana değil`);
  }
  // Satışın / müşterinin işlemi yöneticiye gider (işlemi yapan yönetici değil)
  assert.deepEqual((await recipientsFor(db, 'ORDER_OFFER_WITHDRAWN', order, { actorId: 'u-satis' })).map((r) => r.email), ['admin@gkh.test']);
  // Şifre sıfırlama: yönetici başlatır, kod kullanıcıya kendiliğinden gider — yöneticiye e-posta olayı yok
  for (const type of ['ORDER_PASSWORD_RESET', 'PASSWORD_RESET', 'USER_PASSWORD_RESET']) assert.deepEqual(await recipientsFor(db, type, order), [], type);
  const at = new Date('2026-10-09T08:00:00Z');
  const admin = { locale: 'tr', role: 'ADMIN' };
  const render = (type, payload) => renderNotification({ type, order, createdAt: at, recipient: admin, appUrl: 'https://takip.test', timeZone: 'Europe/Bucharest', payload });
  const over = render('ORDER_PRICE_OVERRIDE', { qty: 2, alertId: 'a1' });
  assert.equal(over.subject, 'GLA68 — Satış fabrika fiyatını değiştirdi');
  assert.match(over.text, /Açıklama: Satış, teklifi 2 satırda fabrika fiyat tablosundaki fiyattan farklı/);
  assert.match(over.text, /https:\/\/takip\.test\/siparisler\/o1/);
  const back = render('ORDER_OFFER_WITHDRAWN', {});
  assert.equal(back.subject, 'GLA68 — Satış, yöneticiye gönderdiği teklifi geri aldı');
  assert.match(back.text, /Açıklama: Teklif yeniden satışta/);
  const free = render('ORDER_COMPENSATION_PRICE', { mode: 'FREE', qty: 3, sourceOrderNo: 'GLA60', pending: false });
  assert.equal(free.subject, 'GLA68 — Telafi camı bedelsiz açıldı');
  assert.match(free.text, /3 adet telafi camı · kaynak sipariş GLA60\./);
  const custom = render('ORDER_COMPENSATION_PRICE', { mode: 'CUSTOM', qty: 1, sourceOrderNo: 'GLA60', pending: true });
  assert.equal(custom.subject, 'GLA68 — Telafi camı için farklı fiyat seçildi');
  assert.match(custom.text, /yöneticinin onayını bekliyor/);
  // Romence ve ortak GKH düzeni (logo başlığı); hiçbir e-postada tutar / para birimi yok
  const ro = renderNotification({ type: 'ORDER_PRICE_OVERRIDE', order, createdAt: at, recipient: { locale: 'ro', role: 'ADMIN' }, appUrl: 'https://takip.test', timeZone: 'Europe/Bucharest', payload: { qty: 1 } });
  assert.equal(ro.subject, 'GLA68 — Vânzările au modificat prețul fabricii');
  for (const m of [over, back, free, custom, ro]) {
    assert.match(m.html, /cid:gkh-logo@takip|gkh-logo/);
    assert.doesNotMatch(m.text, /EUR|RON|\d+,\d{2}/, 'tutar yok');
  }
  // Yeni sipariş e-postası (yöneticiye de): mevcut metin
  assert.equal(render('ORDER_CREATED', null).subject, 'GLA68 — Yeni sipariş');
});
