// TAKİP Telegram asistanı (3.84.0, karar 278) — gerçek PostgreSQL ile: her araç gerçek şemada READ ONLY işlemde çalışır ve
// doğru veriyi döner; işlem içindeki yazma veritabanında REDDEDİLİR; araçlar hiçbir tabloyu değiştirmez. Uçtan uca: sahte
// Telegram + sahte AI ile bir soru gerçek veritabanından yanıtlanır. Ağ isteği yok (offline).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const { readOnly } = await import('../../server/assistant/readonly.js');
const { TOOLS, runTool } = await import('../../server/assistant/tools.js');
const { createAssistant } = await import('../../server/assistant/bot.js');

let db, admin, firm, order;
const NOW = new Date('2026-10-15T09:00:00Z');
const CTX = { tz: 'Europe/Bucharest', now: NOW };
const TOKEN = '1234567890:AAH-sahteJetonDegeriTestIcinBurada_xyz12';
const USER = 555000111;

/** Önemli tabloların satır sayıları ve güncelleme damgaları (araçlar hiçbirini değiştirmemeli) */
const MODELS = ['customer', 'user', 'order', 'offer', 'offerLine', 'price', 'fgoDocument', 'stockMovement', 'profileProduct', 'notificationOutbox', 'notification', 'auditLog', 'adminAlert', 'integrationSetting', 'session', 'loadingConfirmation', 'billingBatch'];
async function snapshot() {
  const counts = await Promise.all(MODELS.map((m) => db[m].count()));
  const stamps = await db.order.findMany({ select: { id: true, updatedAt: true, version: true }, orderBy: { id: 'asc' } });
  return JSON.stringify([counts, stamps]);
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Glass and More SRL', prefix: 'GLA', contactPerson: 'Ana' } });
  admin = await db.user.create({ data: { email: 'admin@asistan.test', name: 'Admin', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
  order = await db.order.create({
    data: {
      orderNo: 'GLA68', customerOrderNo: '68', customerId: firm.id, createdById: admin.id, title: 'Duş camı', status: 'URETIMDE',
      estimatedShipDate: new Date('2026-10-16T12:00:00Z'),
    },
  });
  await db.offer.create({ data: { orderId: order.id, status: 'GONDERILDI', sentAt: NOW, currency: 'EUR', amount: 800, offerAmount: 1000, createdById: admin.id } });
  await db.fgoDocument.create({ data: { orderId: order.id, kind: 'PROFORMA', series: 'PRF', number: '501', issuedAt: NOW, currency: 'RON', total: 5000, paid: 1000 } });
  const p = await db.profileProduct.findFirstOrThrow({ where: { code: 'GK15' } });
  await db.profileProduct.update({ where: { id: p.id }, data: { criticalStock: 5 } });
  await db.stockMovement.create({ data: { productId: p.id, kind: 'GIRIS', qty: 3, createdById: admin.id } });
});
after(async () => { await closeDb(); });

dbTest('asistan: READ ONLY işlem — işlem içindeki yazma veritabanında reddedilir, kayıt oluşmaz', offline(async () => {
  const ro = readOnly(db);
  const before = await db.customer.count();
  await assert.rejects(ro((tx) => tx.customer.create({ data: { name: 'Sızma', prefix: 'SZM' } })), /read-only|25006/i);
  await assert.rejects(ro((tx) => tx.$executeRaw`UPDATE "Order" SET title = 'x'`), /read-only|25006/i);
  assert.equal(await db.customer.count(), before);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: order.id } })).title, 'Duş camı');
}));

dbTest('asistan: her araç gerçek şemada hatasız çalışır ve hiçbir tabloyu değiştirmez', offline(async () => {
  const ro = readOnly(db);
  const args = {
    genel_ozet: {}, siparis_ara: { metin: 'GLA' }, siparis_detay: { siparis_no: 'gla68' }, musteri_bilgi: { firma: 'glass' },
    yukleme_plani: { baslangic: '2026-10-15', bitis: '2026-10-20' }, stok_durumu: {}, alacaklar: {}, fatura_belgeleri: { firma: 'GLA' },
    faturalanmamis_yuklemeler: {}, tedarikci_hesaplari: {},
    siparis_camlari: { siparis_no: 'gla 68' }, yukleme_durumu: { siparis_no: 'GLA68' }, yukleme_gunu: { gun: '2026-10-16' }, sandiklar: { gun: '2026-10-16' },
  };
  assert.deepEqual(Object.keys(args).sort(), Object.keys(TOOLS).sort(), 'her araç denendi');
  const s0 = await snapshot();
  const out = {};
  for (const [name, a] of Object.entries(args)) {
    out[name] = await runTool(ro, name, JSON.stringify(a), CTX);
    assert.equal(out[name].hata, undefined, `${name}: ${JSON.stringify(out[name])}`);
  }
  assert.equal(await snapshot(), s0, 'araçlar yazmadı');
  assert.equal(out.genel_ozet.camSiparisleri.URETIMDE, 1);
  assert.equal(out.genel_ozet.yarinPlanlananYukleme, 1);
  assert.equal(out.siparis_ara.siparisler[0].no, 'GLA68');
  assert.equal(out.siparis_detay.musteriTeklifi.tutar, 1000);
  assert.equal(out.siparis_detay.fabrikaTutari, 800);
  assert.equal(out.siparis_detay.fgoBelgeleri[0].no, 'PRF501');
  assert.equal(out.musteri_bilgi.firmalar[0].kod, 'GLA');
  assert.equal(out.musteri_bilgi.firmalar[0].alacak.RON.rest, 4000);
  assert.equal(out.yukleme_plani.gunler[0].gun, '2026-10-16');
  assert.ok(out.stok_durumu.urunler.some((u) => u.kod === 'GK15' && u.kritik));
  assert.equal(out.alacaklar.cam.toplamlar.RON.rest, 4000);
  assert.equal(out.alacaklar.cam.enCokKalan[0].firma, 'Glass and More SRL');
  assert.equal(out.fatura_belgeleri.belgeler[0].no, 'PRF501');
  // 3.85.0: teklif tablosu olmayan sipariş "bulunamadı" değil "veri eksik"; sandık girilmemiş gün de öyle
  assert.deepEqual(out.siparis_camlari.veriEksik, ['TEKLIF_TABLOSU_YOK']);
  assert.equal(out.siparis_camlari.no, 'GLA68');
  assert.deepEqual(out.yukleme_durumu.veriEksik, ['TEKLIF_TABLOSU_YOK']);
  assert.equal(out.yukleme_gunu.durum, 'PLANLANDI');
  assert.deepEqual(out.yukleme_gunu.planaGirmeyen, [{ no: 'GLA68', neden: 'NO_SENT_OFFER' }]);
  assert.deepEqual(out.sandiklar.veriEksik, ['SANDIK_GIRILMEMIS']);
  // Bulunamayan kayıt ve hatalı aralık sabit yanıt
  assert.deepEqual(await runTool(ro, 'siparis_detay', '{"siparis_no":"YOK1"}', CTX), { bulunamadi: 'YOK1' });
  assert.deepEqual(await runTool(ro, 'yukleme_plani', '{"baslangic":"2026-10-01","bitis":"2026-12-01"}', CTX), { hata: 'RANGE' });
}));

dbTest('asistan uçtan uca: sahte Telegram + sahte AI, gerçek veritabanı — izinli kullanıcının sorusu gerçek veriyle yanıtlanır', offline(async () => {
  const sent = [];
  let round = 0;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    const body = JSON.parse(init.body);
    if (u.endsWith('/sendMessage')) { sent.push(body.text); return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) }; }
    if (u.includes('api.telegram.org')) return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
    if (u.endsWith('/chat/completions')) {
      round++;
      if (round === 1) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'siparis_detay', arguments: '{"siparis_no":"GLA68"}' } }] } }] }) };
      const tool = body.messages.find((m) => m.role === 'tool');
      const data = JSON.parse(tool.content);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: `${data.no}: ${data.durum}, ${data.firma}` } }] }) };
    }
    throw new Error(u);
  };
  const bot = createAssistant({ db, env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USER_ID: String(USER), OPENAI_API_KEY: 'sk-test-SAHTEanahtarTestIcin1234567890', APP_TIMEZONE: 'Europe/Bucharest' }, fetchImpl, clock: () => NOW });
  const s0 = await snapshot();
  await bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: Math.floor(NOW.getTime() / 1000), from: { id: USER }, chat: { id: USER, type: 'private' }, text: 'GLA68 ne durumda?' } });
  assert.deepEqual(sent, ['GLA68: URETIMDE, Glass and More SRL']);
  assert.equal(await snapshot(), s0, 'veritabanına yazılmadı');
}));
