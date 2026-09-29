import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineWorkflow, WorkflowError } from '../server/domain/workflow.js';
import { transitionOrder } from '../server/domain/transition.js';
import { auditEntry } from '../server/domain/audit.js';
import { memoryOutbox, outboxEvent } from '../server/domain/outbox.js';

// Örnek akış — gerçek iş kuralları değil; yalnızca motoru test eder.
const wf = defineWorkflow({
  orderType: 'TEST_ORDER',
  states: ['A', 'B', 'C'],
  actions: {
    START: { from: ['A'], to: 'B', roles: ['SATIS', 'ADMIN'] },
    FINISH: { from: ['B'], to: 'C', roles: ['ADMIN'], guard: (ctx) => (ctx.payload?.ok ? null : 'MISSING_OK') },
    NOTE: { from: ['A', 'B', 'C'], to: null, roles: ['ADMIN', 'SATIS', 'CIZIM'] },
  },
});
const admin = { id: 'u1', role: 'ADMIN' };
const sales = { id: 'u2', role: 'SATIS' };
const viewer = { id: 'u3', role: 'DENETIMCI' };

test('workflow: tanım hataları yakalanır', () => {
  assert.throws(() => defineWorkflow({ orderType: 'X', states: ['A'], actions: { GO: { from: ['Z'], to: 'A', roles: ['ADMIN'] } } }), /bilinmeyen durum Z/);
  assert.throws(() => defineWorkflow({ orderType: 'X', states: ['A'], actions: { GO: { from: ['A'], to: 'Q', roles: ['ADMIN'] } } }), /bilinmeyen hedef Q/);
  assert.throws(() => defineWorkflow({ orderType: 'X', states: ['A'], actions: { GO: { from: ['A'], to: 'A', roles: [] } } }), /roles boş/);
});

test('workflow: rol, durum, tip ve koşul kontrolü kod döndürür', () => {
  const c = (state, action, actor, extra = {}) => wf.check({ state, orderType: 'TEST_ORDER', action, actor, ...extra }).code ?? 'OK';
  assert.equal(c('A', 'START', sales), 'OK');
  assert.equal(c('A', 'START', viewer), 'FORBIDDEN_ROLE');
  assert.equal(c('B', 'START', sales), 'INVALID_STATE');
  assert.equal(c('A', 'NOPE', admin), 'UNKNOWN_ACTION');
  assert.equal(wf.check({ state: 'A', orderType: 'OTHER', action: 'START', actor: admin }).code, 'WRONG_ORDER_TYPE');
  assert.equal(c('B', 'FINISH', admin), 'MISSING_OK');
  assert.equal(c('B', 'FINISH', admin, { ctx: { payload: { ok: true } } }), 'OK');
  assert.deepEqual(wf.available({ state: 'A', actor: sales }), ['START', 'NOTE']);
  assert.deepEqual(wf.available({ state: 'A', actor: viewer }), []);
});

/** İşlemi taklit eden sahte veritabanı: hata olursa yazılanlar geri alınır. */
function fakeDb(order) {
  const store = { order: { ...order }, history: [], audit: [] };
  const outbox = memoryOutbox();
  const db = {
    async $transaction(fn) {
      const snap = { order: { ...store.order }, history: store.history.length, audit: store.audit.length, outbox: outbox.events.length };
      try {
        return await fn({});
      } catch (e) {
        store.order = snap.order;
        store.history.length = snap.history;
        store.audit.length = snap.audit;
        outbox.events.length = snap.outbox;
        throw e;
      }
    },
  };
  const deps = {
    loadOrder: async (_tx, id) => (id === store.order.id ? { ...store.order } : null),
    apply: async (_tx, o, { to }) => {
      if (o.version !== store.order.version) return null;
      store.order = { ...store.order, status: to, version: store.order.version + 1 };
      return { ...store.order };
    },
    history: async (_tx, h) => store.history.push(h),
    audit: async (_tx, a) => store.audit.push(a),
    outbox,
    sanitize: (o, actor) => ({ id: o.id, status: o.status, secret: actor.role === 'ADMIN' ? o.secret : undefined }),
  };
  return { db, deps, store, outbox };
}
const base = { id: 'o1', status: 'A', orderType: 'TEST_ORDER', version: 1, secret: 'yönetici fiyatı' };

test('transitionOrder: geçerli geçiş durum + geçmiş + denetim + outbox yazar, temizlenmiş sonuç döner', async () => {
  const { db, deps, store, outbox } = fakeDb(base);
  const out = await transitionOrder({ db, workflow: wf, orderId: 'o1', action: 'START', actor: sales, payload: { note: 'n' }, deps });
  assert.deepEqual(out.order, { id: 'o1', status: 'B', secret: undefined });
  assert.equal(store.order.status, 'B');
  assert.deepEqual(store.history, [{ orderId: 'o1', event: 'START', from: 'A', to: 'B', action: 'START', actorId: 'u2', note: 'n' }]);
  assert.equal(store.audit.length, 1);
  assert.deepEqual(store.audit[0].details, { action: 'START', events: ['START'], from: 'A', to: 'B', role: 'SATIS' });
  assert.deepEqual(outbox.events.map((e) => e.type), ['ORDER_START']);
});

test('transitionOrder: durum değiştirmeyen eylem de geçmiş ve denetim bırakır', async () => {
  const { db, deps, store } = fakeDb(base);
  await transitionOrder({ db, workflow: wf, orderId: 'o1', action: 'NOTE', actor: sales, deps });
  assert.equal(store.order.status, 'A');
  assert.equal(store.history[0].to, 'A');
  assert.equal(store.audit.length, 1);
});

test('transitionOrder: yetkisiz / geçersiz / bulunamadı → hata, hiçbir şey yazılmaz', async () => {
  for (const [orderId, action, actor, code] of [
    ['o1', 'START', viewer, 'FORBIDDEN_ROLE'],
    ['o1', 'FINISH', admin, 'INVALID_STATE'],
    ['yok', 'START', admin, 'NOT_FOUND'],
  ]) {
    const { db, deps, store, outbox } = fakeDb(base);
    await assert.rejects(transitionOrder({ db, workflow: wf, orderId, action, actor, deps }), (e) => e instanceof WorkflowError && e.code === code);
    assert.deepEqual([store.order.status, store.history.length, store.audit.length, outbox.events.length], ['A', 0, 0, 0]);
  }
});

test('transitionOrder: sürüm çakışması CONFLICT verir', async () => {
  const { db, deps, store } = fakeDb(base);
  const stale = deps.loadOrder;
  deps.loadOrder = async (tx, id) => ({ ...(await stale(tx, id)), version: 0 });
  await assert.rejects(transitionOrder({ db, workflow: wf, orderId: 'o1', action: 'START', actor: admin, deps }), { code: 'CONFLICT' });
  assert.equal(store.order.status, 'A');
});

test('transitionOrder: outbox yazılamazsa tüm işlem geri alınır', async () => {
  const { db, deps, store } = fakeDb(base);
  deps.outbox = { enqueue: async () => { throw new Error('outbox kapalı'); } };
  await assert.rejects(transitionOrder({ db, workflow: wf, orderId: 'o1', action: 'START', actor: admin, deps }), /outbox kapalı/);
  assert.deepEqual([store.order.status, store.history.length, store.audit.length], ['A', 0, 0]);
});

test('audit/outbox: biçim kontrolü', () => {
  assert.throws(() => auditEntry({ action: 'order changed', entityType: 'Order' }), /BÜYÜK_HARF/);
  assert.deepEqual(auditEntry({ action: 'LOGIN', entityType: 'User', entityId: 'u1', actor: admin }), {
    action: 'LOGIN', entityType: 'User', entityId: 'u1', userId: 'u1', details: { role: 'ADMIN' },
  });
  assert.equal(outboxEvent('ORDER_SENT', { orderId: 'o1' }).status, 'PENDING');
  assert.throws(() => outboxEvent('bad'), /BÜYÜK_HARF/);
});

test('transitionOrder: işlem birden çok geçmiş kaydı üretebilir (ör. onay + otomatik üretim)', async () => {
  const { db, deps, store, outbox } = fakeDb({ ...base, status: 'B' });
  deps.apply = async (_tx, o) => {
    store.order = { ...store.order, status: 'C', version: store.order.version + 1 };
    return {
      order: { ...store.order },
      entries: [{ event: 'APPROVED', from: 'B', to: 'B', note: 'v2' }, { event: 'PRODUCTION', from: 'B', to: 'C' }],
      audit: { amount: '10.00' },
      result: { produced: true },
    };
  };
  const out = await transitionOrder({ db, workflow: wf, orderId: 'o1', action: 'FINISH', actor: admin, payload: { ok: true }, deps });
  assert.deepEqual(out.result, { produced: true });
  assert.deepEqual(store.history.map((h) => [h.event, h.from, h.to, h.note]), [['APPROVED', 'B', 'B', 'v2'], ['PRODUCTION', 'B', 'C', null]]);
  assert.deepEqual(store.audit[0].details, { action: 'FINISH', events: ['APPROVED', 'PRODUCTION'], from: 'B', to: 'C', amount: '10.00', role: 'ADMIN' });
  assert.deepEqual(outbox.events.map((e) => e.type), ['ORDER_APPROVED', 'ORDER_PRODUCTION']);
});

test('transitionOrder: geçmiş kaydı olmayan işlem (ör. taslak kaydetme) yalnızca denetim bırakır', async () => {
  const { db, deps, store, outbox } = fakeDb(base);
  deps.apply = async () => ({ order: { ...store.order }, entries: [] });
  await transitionOrder({ db, workflow: wf, orderId: 'o1', action: 'NOTE', actor: sales, deps });
  assert.deepEqual([store.history.length, store.audit.length, outbox.events.length], [0, 1, 0]);
});
