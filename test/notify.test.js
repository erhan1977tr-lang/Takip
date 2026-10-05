// Bildirim e-postaları: olay → alıcı, metin (maske, bağlantı), gönderim / yeniden deneme / eski olaylar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchNotifications, recipientsFor, renderNotification } from '../server/notifications/email.js';

const order = {
  id: 'o1', orderNo: 'GLA68', orderTypeCode: 'GLASS_ORDER', customerId: 'c1', estimatedShipDate: new Date('2026-10-23T12:00:00Z'), actualShipDate: null,
  customer: { name: 'Glass and More', email: 'office@glass.test' },
  createdBy: { email: 'ana@glass.test', language: 'ro', customerId: 'c1' },
  assignedDrawer: null,
};
const users = [
  { email: 'admin@gkh.test', language: 'tr', appRole: 'ADMIN' },
  { email: 'satis@gkh.test', language: 'tr', appRole: 'SATIS' },
  { email: 'cizim@gkh.test', language: 'tr', appRole: 'CIZIM' },
];
const optedOut = [];
const fakeDb = (rows = []) => {
  const settings = new Map();
  return {
    rows,
    user: {
      findMany: async ({ where }) => users.filter((u) => where.appRole.in.includes(u.appRole)),
      findFirst: async ({ where }) => optedOut.find((e) => e === where.email.equals.toLowerCase()) ?? null,
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
          if (where.id && r.id !== where.id) continue;
          if (where.status && r.status !== where.status) continue;
          if (where.attempts != null && r.attempts !== where.attempts) continue;
          if (where.createdAt?.lt && !(r.createdAt < where.createdAt.lt)) continue;
          if (where.type?.in && !where.type.in.includes(r.type)) continue;
          if (data.attempts?.increment) r.attempts += 1; else Object.assign(r, data);
          n++;
        }
        return { count: n };
      },
      findMany: async ({ where }) => rows.filter((r) => where.type.in.includes(r.type) && r.status === 'PENDING' && r.availableAt <= where.availableAt.lte),
      update: async ({ where, data }) => Object.assign(rows.find((r) => r.id === where.id), data),
    },
  };
};

test('bildirim alıcıları: müşteri olayı → siparişi açan + firma e-postası; yeni cam siparişi → satış; çizim → çizim ekibi', async () => {
  const db = fakeDb();
  assert.deepEqual((await recipientsFor(db, 'ORDER_OFFER_SENT', order)).map((r) => r.email), ['ana@glass.test', 'office@glass.test']);
  assert.deepEqual((await recipientsFor(db, 'ORDER_CREATED', order)).map((r) => r.email), ['satis@gkh.test']);
  assert.deepEqual((await recipientsFor(db, 'ORDER_CREATED', { ...order, orderTypeCode: 'PROFILE_ORDER' })).map((r) => r.email), ['admin@gkh.test'], 'profil satışa gitmez');
  assert.deepEqual((await recipientsFor(db, 'ORDER_SENT_TO_DRAWING', order)).map((r) => r.email), ['cizim@gkh.test']);
  const assigned = { ...order, assignedDrawer: { email: 'ali@gkh.test', language: 'tr', appRole: 'CIZIM' } };
  // Müşterinin çizim kararı (revizyon / onay): atanmış çizimci + ilgili satışçı; yöneticiye gitmez (karar 84)
  const withSales = { ...assigned, salesUsers: [{ email: 'selin@gkh.test', language: 'ro', appRole: 'SATIS' }] };
  for (const type of ['ORDER_REVISION_REQUESTED', 'ORDER_DRAWING_APPROVED']) {
    assert.deepEqual((await recipientsFor(db, type, withSales)).map((r) => r.email), ['ali@gkh.test', 'selin@gkh.test'], type);
    assert.deepEqual((await recipientsFor(db, type, assigned)).map((r) => r.email), ['ali@gkh.test', 'satis@gkh.test'], `${type}: satışçı bilinmiyorsa satış ekibi`);
    const adminAsSales = { ...assigned, salesUsers: [{ email: 'admin@gkh.test', language: 'tr', appRole: 'ADMIN' }] };
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

test('revizyon e-postası gönderimi: ilgili satışçı sipariş kayıtlarından bulunur; not olayın anındaki talepten gelir', async () => {
  const t0 = new Date('2026-10-01T10:00:00Z');
  const db = fakeDb([]);
  await dispatchNotifications(db, { transport: { sendMail: async () => {} }, from: 'x', appUrl: 'https://takip.test', now: t0 });
  db.rows.push({ id: 'r1', type: 'ORDER_REVISION_REQUESTED', orderId: 'o1', status: 'PENDING', attempts: 0, availableAt: t0, createdAt: new Date(t0.getTime() + 1000), payload: {} });
  const asked = [];
  db.order.findUnique = async () => ({ ...order, assignedDrawer: { email: 'ali@gkh.test', language: 'tr', appRole: 'CIZIM' } });
  db.orderEvent = { findFirst: async (q) => { asked.push(q.where); return { user: { email: 'selin@gkh.test', language: 'tr', appRole: 'SATIS' } }; } };
  db.offer = { findFirst: async () => null };
  db.drawingRevision = { findFirst: async (q) => { asked.push(q.where); return { comment: 'Delik yeri yanlış', drawing: { version: 1 } }; } };
  const mails = [];
  const r = await dispatchNotifications(db, { transport: { sendMail: async (m) => mails.push(m) }, from: 'x', appUrl: 'https://takip.test', now: new Date(t0.getTime() + 2000) });
  assert.equal(r.sent, 1);
  assert.deepEqual(mails.map((m) => m.to), ['ali@gkh.test', 'selin@gkh.test'], 'atanmış çizimci + ilgili satışçı; yönetici yok');
  // Ortak GKH başlığı (karar 129): bildirim e-postası logoyla gider — alıcılar ve metin aynen
  assert.ok(mails.every((m) => m.html.includes('<img src="cid:gkh-logo@takip"') && m.attachments.length === 1 && m.attachments[0].cid === 'gkh-logo@takip' && !('lang' in m)));
  assert.ok(mails.every((m) => m.text.includes('Revizyon notu: Delik yeri yanlış') && m.text.includes('GLA68')));
  assert.equal(asked[0].event, 'SENT_TO_DRAWING');
  assert.deepEqual(asked[0].user.appRole.in, ['SATIS'], 'yalnızca satış rolü aranır');
  assert.ok(asked[1].createdAt.lte instanceof Date && asked[1].drawing.orderId === 'o1');
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

test('bildirim tercihi: müşteri kapattıysa o siparişin müşteri bildirimi gitmez; iç ekip bildirimleri etkilenmez; sabit dil kullanılır', async () => {
  const db = fakeDb();
  const off = { ...order, createdBy: { ...order.createdBy, emailNotifications: false } };
  assert.deepEqual(await recipientsFor(db, 'ORDER_OFFER_SENT', off), [], 'siparişi açan kapattı: ne kendisine ne firma adresine');
  assert.deepEqual((await recipientsFor(db, 'ORDER_CREATED', off)).map((r) => r.email), ['satis@gkh.test'], 'iç ekip bildirimi sürer');
  optedOut.push('office@glass.test');
  assert.deepEqual((await recipientsFor(db, 'ORDER_OFFER_SENT', order)).map((r) => r.email), ['ana@glass.test'], 'bildirimi kapatmış kullanıcının adresi atlanır');
  optedOut.length = 0;
  const fixed = { ...order, createdBy: { ...order.createdBy, language: 'ro', fixedLanguage: 'tr' } };
  assert.deepEqual((await recipientsFor(db, 'ORDER_OFFER_SENT', fixed)).map((r) => r.locale), ['tr', 'tr']);
});
