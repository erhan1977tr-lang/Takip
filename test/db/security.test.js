// Güvenlik sertleştirmesi (3.46.0) — veritabanıyla: oturum temizliği (SEC-11), yükleme kotası sorguları (SEC-05).
// Sandık satırının müşteriye göre seçimi (SEC-17) loading-replan.test.js içindeki gerçek "misafir sandık" verisiyle sınanır.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';

const { SESSION_IDLE_MS, SESSION_TTL_MS, pruneSessions } = await import('../../server/auth/session-policy.js');
const { checkUpload } = await import('../../server/files/limits.js');

const MB = 1024 * 1024;
let db, factory, staff, staff2, X, x1, x2, Y, y1, order, seq = 0;
const key = () => `2026/10/guvenlik-${++seq}`;
const f = (name, mb) => ({ name, size: mb * MB });
const NOW = new Date('2026-10-04T12:00:00Z');
const ago = (min) => new Date(NOW.getTime() - min * 60_000);
// Disk: 10 GB boş (denetim açık, sınırın çok üstünde)
const OPTS = { root: '/uploads', minFreeMb: 1024, now: NOW, statfs: async () => ({ bavail: 10 * 1024, bsize: MB }) };

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  staff = await db.user.create({ data: { email: 'cizim@guvenlik.test', name: 'Çizim', type: 'INTERNAL', appRole: 'CIZIM', customerId: factory.id } });
  staff2 = await db.user.create({ data: { email: 'satis@guvenlik.test', name: 'Satış', type: 'INTERNAL', appRole: 'SATIS', customerId: factory.id } });
  X = await db.customer.create({ data: { name: 'Kota Cam SRL', prefix: 'KOT' } });
  Y = await db.customer.create({ data: { name: 'Diger Cam SRL', prefix: 'DIG' } });
  x1 = await db.user.create({ data: { email: 'x1@guvenlik.test', name: 'X1', type: 'CUSTOMER', appRole: 'MUSTERI', customerId: X.id } });
  x2 = await db.user.create({ data: { email: 'x2@guvenlik.test', name: 'X2', type: 'CUSTOMER', appRole: 'MUSTERI', customerId: X.id } });
  y1 = await db.user.create({ data: { email: 'y1@guvenlik.test', name: 'Y1', type: 'CUSTOMER', appRole: 'MUSTERI', customerId: Y.id } });
  order = await db.order.create({ data: { orderNo: 'KOT1', customerOrderNo: 1, title: 'Kota', orderTypeCode: 'GLASS_ORDER', customerId: X.id, createdById: x1.id, status: 'URETIMDE' } });
});
after(closeDb);

dbTest('SEC-11: oturum temizliği — süresi dolmuş ve 7 gündür kullanılmayan oturumlar silinir; geçerli oturumlar kalır', async () => {
  const now = new Date();
  const mk = (label, createdAgoMs, seenAgoMs) => db.session.create({
    data: { userId: x1.id, tokenHash: `h-${label}`, createdAt: new Date(now - createdAgoMs), expiresAt: new Date(now.getTime() - createdAgoMs + SESSION_TTL_MS), lastSeenAt: new Date(now - seenAgoMs) },
  });
  const DAY = 86_400_000;
  await mk('yeni', 60_000, 60_000);
  await mk('alti-gun', 20 * DAY, 6 * DAY); // 20 gün önce açıldı, 6 gün önce kullanıldı: geçerli
  await mk('bosta', 10 * DAY, SESSION_IDLE_MS + 60_000); // 7 günden uzun süredir kullanılmadı
  await mk('doldu', SESSION_TTL_MS + 60_000, 60_000); // dün de kullanıldı ama 30 gün doldu
  await db.authFailure.createMany({ data: [
    { kind: 'LOGIN', email: 'a@x.test', ip: '1.1.1.1', createdAt: new Date(now - 2 * DAY) },
    { kind: 'LOGIN', email: 'a@x.test', ip: '1.1.1.1', createdAt: new Date(now - 60_000) },
  ] });
  assert.deepEqual(await pruneSessions(db, now), { sessions: 2, failures: 1 });
  assert.deepEqual((await db.session.findMany({ orderBy: { tokenHash: 'asc' } })).map((s) => s.tokenHash), ['h-alti-gun', 'h-yeni']);
  assert.equal(await db.authFailure.count(), 1);
  // İkinci tur hiçbir şey silmez; kullanıcı ve başka veriler yerinde
  assert.deepEqual(await pruneSessions(db, now), { sessions: 0, failures: 0 });
  assert.equal(await db.user.count({ where: { id: x1.id } }), 1);
  await db.session.deleteMany({});
});

dbTest('SEC-05: yükleme kotası gerçek kayıtlardan — müşteri firması birlikte sayılır; iç ekip (fabrikaya bağlı) kendi başına; başka firma etkilenmez', async () => {
  // Firma X son bir saatte: x1 sipariş dosyaları 500 MB, x2 taslak dosyaları 500 MB → 1000 MB
  await db.orderFile.createMany({ data: Array.from({ length: 5 }, () => ({ orderId: order.id, name: 'a.pdf', storageKey: key(), size: 100 * MB, uploadedById: x1.id, createdAt: ago(20) })) });
  const draft = await db.orderDraft.create({ data: { customerId: X.id, createdById: x2.id } });
  await db.orderDraftFile.createMany({ data: Array.from({ length: 5 }, () => ({ draftId: draft.id, name: 'b.pdf', storageKey: key(), size: 100 * MB, uploadedById: x2.id, createdAt: ago(10) })) });
  // İç ekip aynı siparişe 300 MB çizim yükledi (müşterinin kotasına girmez)
  const drawing = await db.drawing.create({ data: { orderId: order.id, version: 1, uploadedById: staff.id } });
  await db.drawingFile.createMany({ data: Array.from({ length: 3 }, () => ({ drawingId: drawing.id, name: 'c.dwg', storageKey: key(), size: 100 * MB, uploadedById: staff.id, createdAt: ago(5) })) });

  // x1 ve x2 aynı kotayı paylaşır: 1000 MB + 24 MB = sınır (1 GB); 25 MB aşar
  for (const u of [x1, x2]) {
    assert.equal(await checkUpload(db, [f('yeni.pdf', 24)], { userId: u.id }, OPTS), null, u.email);
    assert.deepEqual(await checkUpload(db, [f('yeni.pdf', 25)], { userId: u.id }, OPTS), { code: 'rate', name: '' }, u.email);
  }
  // Başka firma ve iç ekip etkilenmez; iç ekipten biri diğerinin yüklediğinden etkilenmez
  assert.equal(await checkUpload(db, [f('yeni.pdf', 100)], { userId: y1.id }, OPTS), null);
  assert.equal(await checkUpload(db, [f('yeni.dwg', 100)], { userId: staff.id }, OPTS), null);
  assert.equal(await checkUpload(db, [f('yeni.pdf', 100)], { userId: staff2.id }, OPTS), null);
  // Bir saat sonra saatlik sınır açılır (günlük sınır 3 GB: 1000 MB + 100 MB sığar)
  const later = { ...OPTS, now: new Date(NOW.getTime() + 61 * 60_000) };
  assert.equal(await checkUpload(db, [f('yeni.pdf', 100)], { userId: x1.id }, later), null);
  // 24 saat içindeki toplam 3 GB'ı aşamaz
  await db.orderFile.createMany({ data: Array.from({ length: 20 }, () => ({ orderId: order.id, name: 'd.pdf', storageKey: key(), size: 100 * MB, uploadedById: x2.id, createdAt: ago(180) })) });
  assert.deepEqual(await checkUpload(db, [f('yeni.pdf', 100)], { userId: x1.id }, later), { code: 'rate', name: '' });

  // Sipariş kotası: sipariş dosyaları (2500 MB) + çizim dosyaları (300 MB) 2 GB'ı aşmış → iç ekip de ekleyemez
  assert.deepEqual(await checkUpload(db, [f('yeni.dwg', 1)], { userId: staff.id, orderId: order.id }, OPTS), { code: 'order_quota', name: '' });
  // Başka (boş) sipariş etkilenmez
  const other = await db.order.create({ data: { orderNo: 'DIG1', customerOrderNo: 1, title: 'Diger', orderTypeCode: 'GLASS_ORDER', customerId: Y.id, createdById: y1.id, status: 'URETIMDE' } });
  assert.equal(await checkUpload(db, [f('yeni.dwg', 50)], { userId: staff.id, orderId: other.id }, OPTS), null);

  // Depo bağlantısı (giriş yok): yalnızca depodan yüklenenler sayılır — 200 MB / 40 dosya
  assert.equal(await checkUpload(db, [f('teslim.pdf', 20)], { userId: null, orderId: order.id, depot: true }, OPTS), null);
  await db.orderFile.createMany({ data: Array.from({ length: 10 }, () => ({ orderId: order.id, name: 'teslim.pdf', storageKey: key(), size: 19 * MB, kind: 'INTERNAL', source: 'DEPOT_LINK', uploadedById: null })) });
  assert.deepEqual(await checkUpload(db, [f('teslim.pdf', 11)], { userId: null, orderId: order.id, depot: true }, OPTS), { code: 'order_quota', name: '' });

  // Disk eşiği: boş alan sınırın altına inecekse kimse yükleyemez; hiçbir kayıt silinmez
  const files = await db.orderFile.count();
  const low = { ...OPTS, statfs: async () => ({ bavail: 1030, bsize: MB }) };
  assert.deepEqual(await checkUpload(db, [f('yeni.pdf', 10)], { userId: y1.id }, low), { code: 'disk', name: '' });
  assert.equal(await checkUpload(db, [f('yeni.pdf', 5)], { userId: y1.id }, low), null);
  assert.equal(await db.orderFile.count(), files);
});
