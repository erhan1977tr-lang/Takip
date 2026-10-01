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
  assert.deepEqual((await recipientsFor(db, 'ORDER_REVISION_REQUESTED', assigned)).map((r) => r.email), ['ali@gkh.test'], 'atanmış çizimci');
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

test('bildirim gönderimi: ilk çalıştırmadan önceki olaylar atlanır; hata yeniden denenir, gönderilen alıcıya tekrar gitmez', async () => {
  const t0 = new Date('2026-10-01T10:00:00Z');
  const rows = [{ id: 'old', type: 'ORDER_OFFER_SENT', orderId: 'o1', status: 'PENDING', attempts: 0, availableAt: t0, createdAt: new Date(t0.getTime() - 60_000), payload: {} }];
  const db = fakeDb(rows);
  const sent = [];
  let failOnce = true;
  const transport = { sendMail: async (m) => { if (m.to === 'office@glass.test' && failOnce) { failOnce = false; throw new Error('SMTP 451'); } sent.push(m.to); } };
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
