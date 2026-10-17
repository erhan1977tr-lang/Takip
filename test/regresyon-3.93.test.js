// 3.93.0 regresyon düzeltmeleri (karar 288) — saf kurallar ve yapı: 3.92.0 denetiminin (claude/regresyon-denetimi-3.92.0)
// bulguları için ÖNCE hatayı gösteren, düzeltmeden sonra geçen testler. Veritabanı gerektirenler test/db/regresyon-3.93-*.test.js.
// Gerçek ağ YOK: OpenAI / Telegram çağrıları sahte fetch ile; sahte, OpenAI'ın gerçek istek sözleşmesini (araç parametreleri,
// araç mesajı sırası) doğrular ve aykırı istekte gerçek API gibi 400 döner.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lockReasons } from '../server/orders/financial-lock.js';
import { profileActions } from '../server/profile/rules.js';
import { customerShortageView, customerStockLine } from '../server/profile/stock.js';
import { loadingParts } from '../server/orders/customer-offers.js';
import { parseReportFilters } from '../server/reports/filters.js';
import { LIMITS, TEXT, TEXT_RO, answer, assistantConfig, systemPrompt } from '../server/assistant/bot.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
globalThis.fetch = async (u) => { throw new Error(`test: gerçek ağ isteği (${String(u).slice(0, 40)})`); };

// ---------------------------------------------------------------- Y1 / Y2 — iptal kuralı (saf)

const facts = (o = {}) => ({ status: 'URETIMDE', orderTypeCode: 'GLASS_ORDER', documents: [], batches: [], jobs: [], payments: 0, activePayments: 0, loadingDays: [], profile: null, ...o });

test('Y1: cam iptali silmeyle aynı mali / yükleme nedenleriyle kilitlenir (belge, müşteri belgesi, bekleyen iş, onaylı yükleme, elle ödeme)', () => {
  assert.deepEqual(lockReasons(facts(), 'cancel'), []);
  assert.deepEqual(lockReasons(facts({ documents: [{ kind: 'PROFORMA', series: 'PRF', number: '1' }] }), 'cancel'), [{ code: 'FGO_DOCUMENT', kind: 'PROFORMA', ref: 'PRF1' }]);
  assert.deepEqual(lockReasons(facts({ batches: [{ kind: 'PROFORMA', status: 'ISSUED', document: null }] }), 'cancel'), [{ code: 'BILLING_BATCH', kind: 'PROFORMA', ref: null }]);
  assert.deepEqual(lockReasons(facts({ jobs: ['FGO_GLASS'] }), 'cancel'), [{ code: 'PENDING_DOCUMENT', kind: null, ref: null }]);
  assert.deepEqual(lockReasons(facts({ loadingDays: ['2026-10-01'] }), 'cancel'), [{ code: 'CONFIRMED_LOADING', ref: '2026-10-01' }]);
  assert.deepEqual(lockReasons(facts({ payments: 1, activePayments: 1 }), 'cancel'), [{ code: 'MANUAL_PAYMENT', ref: null }]);
});

const pf = (profile, o = {}) => facts({ orderTypeCode: 'PROFILE_ORDER', status: 'HAZIRLANIYOR', profile, ...o });

test('Y2: profil iptali — proforma tek başına engel değil; teslim, tahsilat, elle ödeme, avans / fatura belgesi ve bekleyen FGO işi engeller', () => {
  // Proforma (elle ya da FGO) + depoda, ödenmemiş: iptal edilebilir
  assert.deepEqual(lockReasons(pf({ proformaNo: 'PF-1', proformaAt: new Date(), warehouseSentAt: new Date(), stockDeducted: true }, { documents: [{ kind: 'PROFORMA', series: 'PRF', number: '9', paid: 0 }] }), 'cancel'), []);
  // Depo e-postası kuyrukta: mali işlem değil, engel değil (iptal edilen siparişin e-postası gönderilmez)
  assert.deepEqual(lockReasons(pf({}, { jobs: ['WAREHOUSE_EMAIL'] }), 'cancel'), []);
  // Teslim edildi
  assert.deepEqual(lockReasons(pf({ deliveredAt: new Date() }), 'cancel').map((r) => r.code), ['PROFILE_WAREHOUSE']);
  // Tahsilat: "ödeme alındı", FGO'nun gösterdiği ödeme ya da iptal edilmemiş elle ödeme
  assert.deepEqual(lockReasons(pf({ paidAt: new Date() }), 'cancel').map((r) => r.code), ['PAYMENT']);
  assert.deepEqual(lockReasons(pf({}, { documents: [{ kind: 'PROFORMA', series: 'PRF', number: '9', paid: 10 }] }), 'cancel').map((r) => r.code), ['PAYMENT']);
  assert.deepEqual(lockReasons(pf({}, { payments: 1, activePayments: 1 }), 'cancel').map((r) => r.code), ['MANUAL_PAYMENT']);
  // İptal edilmiş elle ödeme kaydı tahsilat değildir
  assert.deepEqual(lockReasons(pf({}, { payments: 1, activePayments: 0 }), 'cancel'), []);
  // Avans faturası / fatura: aktif mali yükümlülük
  assert.deepEqual(lockReasons(pf({}, { documents: [{ kind: 'ADVANCE', series: 'GKH', number: '5', paid: 0 }] }), 'cancel'), [{ code: 'FGO_DOCUMENT', kind: 'ADVANCE', ref: 'GKH5' }]);
  // Bekleyen FGO işi (proforma / fatura / avans): bekleyen finansal işlem
  for (const j of ['FGO_PROFORMA', 'FGO_INVOICE', 'FGO_PROFILE_ADVANCE']) assert.deepEqual(lockReasons(pf({}, { jobs: [j] }), 'cancel').map((r) => r.code), ['PENDING_DOCUMENT'], j);
});

test('Y2: profil "İptal et" teslim edilmiş / faturalanmış siparişte hiç sunulmaz (sunucu ve ekran aynı kural)', () => {
  for (const stage of ['FIYAT_BEKLIYOR', 'TEKLIF_GONDERILDI', 'ONAYLANDI', 'PROFORMA', 'DEPODA']) {
    assert.ok(profileActions({ role: 'ADMIN', stage, status: 'HAZIRLANIYOR' }).includes('cancel'), stage);
  }
  for (const stage of ['TESLIM_EDILDI', 'FATURALANDI']) {
    assert.ok(!profileActions({ role: 'ADMIN', stage, status: 'HAZIRLANIYOR' }).includes('cancel'), stage);
  }
});

// ---------------------------------------------------------------- D15 — teslim bilgisi yetkisi

test('D15: onay yetkisi olmayan müşteri kullanıcısı teslim bilgisini değiştiremez (yalnızca görür); yetkili müşteri ve yönetici değişmedi', () => {
  for (const stage of ['ONAYLANDI', 'PROFORMA']) {
    assert.ok(!profileActions({ role: 'MUSTERI', stage, status: 'HAZIRLANIYOR', canApprove: false }).includes('update_pickup'), stage);
    assert.ok(profileActions({ role: 'MUSTERI', stage, status: 'HAZIRLANIYOR', canApprove: true }).includes('update_pickup'), stage);
    assert.ok(profileActions({ role: 'ADMIN', stage, status: 'HAZIRLANIYOR' }).includes('update_pickup'), stage);
  }
});

// ---------------------------------------------------------------- O3 — müşteriye stok miktarı gitmez

test('O3: müşterinin stok uyarısı gerçek stok miktarını taşımaz (yalnızca kendi gereken adedi ve "yetersiz" işareti)', () => {
  const s = customerStockLine(500, 37);
  assert.deepEqual(s, { needed: 500, short: true });
  assert.deepEqual(customerStockLine(5, 37), { needed: 5, short: false });
  for (const v of customerShortageView([{ code: 'GK15', nameTr: 'Conta', nameRo: 'Garnitură', unitCode: 'CUTII', qty: 9, stock: 4 }])) {
    assert.ok(!('available' in v) && !('missing' in v) && !('stock' in v), JSON.stringify(v));
    assert.equal(v.needed, 9);
  }
  // Sunucu eylemi ve hesaplayıcı da müşteriye miktar döndürmez (yapı)
  const act = read('app/(panel)/siparisler/yeni/profile-calc-actions.ts');
  assert.ok(!/available/.test(act) && !/missing:\s*l\./.test(act), 'müşteri eylemi stok miktarı döndürmez');
});

// ---------------------------------------------------------------- D18 — tamamen yüklenmeyen cam "planlanan" değildir

test('D18: onayda hiç yüklenmeyen (NOT_LOADED) cam geçmiş onay gününde "planlanan" görünmez — aktarım varsa o güne, yoksa tarihsiz', () => {
  const offer = { lines: [{ id: 'L1', kind: 'CAM', adet: 4, unit: 'm2', enMm: 1000, boyMm: 500, pieceBase: 0 }] };
  const conf = { shipDay: '2026-10-01T00:00:00.000Z' };
  const items = [{ confirmationId: 'C', offerLineId: 'L1', status: 'NOT_LOADED', quantity: 4, revision: 0, confirmation: conf }];
  const none = loadingParts({ estimatedShipDate: '2026-10-01T12:00:00Z', loadedItems: items, replans: [] }, offer);
  assert.deepEqual(none.map((p) => [p.day, p.lines.map((l) => l.adet)]), [[null, [4]]]);
  const replan = loadingParts({ estimatedShipDate: '2026-10-01T12:00:00Z', loadedItems: items, replans: [{ status: 'ACTIVE', quantity: 3, shipDay: '2026-10-09T00:00:00Z', sourceItem: { offerLineId: 'L1' } }] }, offer);
  assert.deepEqual(replan.map((p) => [p.day, p.lines.map((l) => l.adet)]), [['2026-10-09', [3]], [null, [1]]]);
});

// ---------------------------------------------------------------- D16 — rapor filtreleri sessizce yok sayılmaz

test('D16: geçersiz rapor filtresi (tür, sipariş tipi, durum, yükleme, firma kimliği, uzun metin) hata verir; tüm firmalar raporuna dönmez', () => {
  const ctx = { now: new Date('2026-10-15T09:00:00Z'), timeZone: 'Europe/Bucharest' };
  const errs = (i) => parseReportFilters(i, ctx).errors;
  assert.deepEqual(errs({}), []);
  assert.deepEqual(errs({ kind: 'finance', orderType: 'GLASS', status: '', loading: 'ALL' }), []);
  assert.ok(errs({ kind: 'yok' }).includes('KIND_INVALID'));
  assert.ok(errs({ orderType: 'X' }).includes('ORDER_TYPE_INVALID'));
  assert.ok(errs({ status: 'BOGUS' }).includes('STATUS_INVALID'));
  assert.ok(errs({ loading: 'X' }).includes('LOADING_INVALID'));
  assert.ok(errs({ customerId: "x' OR 1=1" }).includes('CUSTOMER_INVALID'));
  assert.ok(errs({ customer: 'a'.repeat(61) }).includes('CUSTOMER_INVALID'));
  assert.ok(errs({ product: 'b'.repeat(61) }).includes('PRODUCT_INVALID'));
});

// ---------------------------------------------------------------- O5 — OpenAI istek sözleşmesi

/**
 * OpenAI Chat Completions isteğinin araçla ilgili kuralları (gerçek API'nin 400 döndürdüğü durumlar):
 *   - tool_choice ve parallel_tool_calls yalnızca tools verildiğinde ("… is only allowed when 'tools' are specified")
 *   - tools verilirse boş olamaz
 *   - role:'tool' mesajı, hemen önceki asistan mesajının tool_calls kimliklerinden birine yanıt olmalı
 *   - tool_calls taşıyan asistan mesajının her çağrısına bir tool mesajı gelmeli
 */
function openAiContract(body) {
  const errors = [];
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  if (Array.isArray(body.tools) && body.tools.length === 0) errors.push('tools: [] is too short');
  if (!hasTools && body.tool_choice !== undefined) errors.push("tool_choice is only allowed when 'tools' are specified");
  if (!hasTools && body.parallel_tool_calls !== undefined) errors.push("parallel_tool_calls is only allowed when 'tools' are specified");
  const msgs = body.messages ?? [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const ids = new Set(m.tool_calls.map((c) => c.id));
      let j = i + 1;
      while (j < msgs.length && msgs[j].role === 'tool') { ids.delete(msgs[j].tool_call_id); j++; }
      if (ids.size) errors.push(`tool_calls without responses: ${[...ids].join(',')}`);
    }
    if (m.role === 'tool') {
      let k = i - 1;
      while (k >= 0 && msgs[k].role === 'tool') k--;
      const prev = msgs[k];
      if (!prev || prev.role !== 'assistant' || !(prev.tool_calls ?? []).some((c) => c.id === m.tool_call_id)) errors.push('tool message must follow tool_calls');
    }
  }
  return errors;
}

test('O5: çok araçlı soruda HER model turu OpenAI sözleşmesine uyar (son turda araç yokken tool_choice / parallel_tool_calls gönderilmez)', async () => {
  const KEY = 'sk-test-SAHTEanahtarTestIcin1234567890';
  const cfg = assistantConfig({ TELEGRAM_BOT_TOKEN: '1234567890:AAH-sahteJetonDegeriTestIcinBurada_xyz12', TELEGRAM_ALLOWED_USER_ID: '555000111', OPENAI_API_KEY: KEY });
  const violations = [];
  let round = 0;
  const fetchImpl = async (url, init) => {
    assert.equal(String(url), 'https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(init.body);
    const errs = openAiContract(body);
    if (errs.length) { violations.push(...errs); return { ok: false, status: 400, json: async () => ({ error: { message: errs[0] } }) }; }
    round++;
    // Model her turda iki araç çağırır (gerçekçi karmaşık soru); araç sonucu sorgu hatası (veritabanı yok)
    const msg = body.tools ? { role: 'assistant', content: null, tool_calls: [0, 1].map((k) => ({ id: `c${round}${k}`, type: 'function', function: { name: 'genel_ozet', arguments: '{}' } })) } : { role: 'assistant', content: 'Özet hazır, Boss.' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: msg }], usage: { total_tokens: 10 } }) };
  };
  const db = { $transaction: async () => { throw new Error('veritabanı yok'); } };
  const r = await answer({ question: 'Bugünün genel durumu, yarınki yükleme ve alacaklar?', cfg, db, fetchImpl, now: new Date('2026-10-15T09:00:00Z'), tz: 'Europe/Bucharest' });
  assert.deepEqual(violations, [], 'OpenAI isteği sözleşmeye aykırı (gerçek API 400 döner)');
  assert.equal(r.text, 'Özet hazır, Boss.');
  assert.equal(round, LIMITS.rounds);
});

// ---------------------------------------------------------------- D19 — Telegram dil ve sesli yanıt

test('D19: sesli yanıt yönergesi kapanış cümlesini zorunlu kılmaz; yardım / ses / desteklenmeyen ileti metinleri Romencede de var; dakika sınırı günlük sınırdan önce', () => {
  const p = systemPrompt('2026-10-15', { voice: true });
  assert.ok(!/kapanış cümlesiyle/.test(p), 'sesli yanıtta kapanış zorunlu değil (madde 151)');
  for (const k of ['help', 'voiceTooLong', 'unsupported']) assert.ok(TEXT_RO[k] && TEXT_RO[k] !== TEXT[k], k);
  const bot = read('server/assistant/bot.js');
  assert.ok(bot.indexOf('perMinute.take(key)') < bot.indexOf('perDay.take(key)'), 'dakika sınırına takılan ileti günlük hakkı tüketmez');
});

// ---------------------------------------------------------------- D9 / D13 / D14 / D20 — yapı

test('D9: cam belge isteği muhasebe yetkisiyle (ACCOUNTING_MANAGE) korunur — eylem ve servis', () => {
  const svc = read('server/glass/billing.js');
  const fn = svc.slice(svc.indexOf('export async function requestGlassDocument'), svc.indexOf('export async function requestGlassDocument') + 400);
  assert.match(fn, /ACCOUNTING_MANAGE/);
  assert.match(read('app/(panel)/siparisler/[id]/glass-billing-actions.ts'), /requirePermission\('ACCOUNTING_MANAGE'\)/);
});

test('D13: müşteri Excel izni yalnızca kapsamdaki, silinmemiş siparişte değişir', () => {
  const a = read('app/(panel)/siparisler/[id]/actions.ts');
  const fn = a.slice(a.indexOf('export async function setCustomerExcelAction'), a.indexOf('export async function readOfferExcelAction'));
  assert.match(fn, /orderScope\(user\)/);
  assert.match(fn, /removedAt: null/);
});

test('D14: Ayarlar sayfası adresten gelen serbest metni imzasız göstermez', () => {
  const page = read('app/(panel)/admin/entegrasyonlar/page.tsx');
  for (const k of ['profile.settings.bad', 'admin.integrations.fgo.bad', 'admin.integrations.fgo.testOk', 'admin.integrations.fgo.testFailed']) {
    const at = page.indexOf(`'${k}'`);
    assert.ok(at > 0, k);
    assert.ok(!/sp\.detail|sp\.types/.test(page.slice(at, at + 160)), `${k}: imzasız adres metni`);
  }
});

test('D20: profil kataloğu ve profil fiyat tablosu servisleri yetkiyi kendileri de denetler', () => {
  const cat = read('server/profile/catalog.js');
  for (const fn of ['saveProduct', 'changeProduct', 'saveCategory', 'setProductImage', 'applyProductImport']) {
    const body = cat.slice(cat.indexOf(`export async function ${fn}(`));
    assert.match(body.slice(0, 260), /CATALOG_MANAGE/, fn);
  }
  const pr = read('server/profile/pricing.js');
  assert.match(pr.slice(pr.indexOf('export async function saveTablePrices('), pr.indexOf('export async function saveTablePrices(') + 260), /PRICE_TABLE_MANAGE/);
});

// ---------------------------------------------------------------- D12 — profil kur anlık görüntüsü

test('D12: profil kur anlık görüntüsünün politika / kâr payı / taban kuru yalnızca müşteri yönetimine gider (müşteri, denetimci süzülür)', async () => {
  const { profileFxView } = await import('../server/orders/order-view.js');
  const p = { fxRate: '5.1020', fxDate: '2026-10-01', fxSource: 'BNR', fxPolicy: 'BNR_PLUS_PERCENT', fxMarkupPercent: '2.000', fxBaseRate: '5.0020', fxManual: false, fxSourceDate: '2026-09-30', fxResolvedAt: '2026-10-01T08:00:00Z' };
  for (const role of ['MUSTERI', 'DENETIMCI', 'SATIS', 'CIZIM']) {
    const v = profileFxView(role, p);
    assert.deepEqual([v.fxRate, v.fxDate, v.fxSource], ['5.1020', '2026-10-01', 'BNR'], role);
    for (const k of ['fxPolicy', 'fxMarkupPercent', 'fxBaseRate', 'fxManual', 'fxSourceDate', 'fxResolvedAt']) assert.equal(v[k], null, `${role}: ${k}`);
  }
  assert.equal(profileFxView('ADMIN', p).fxMarkupPercent, '2.000');
  assert.equal(profileFxView('YONETICI_YARDIMCISI', p).fxPolicy, 'BNR_PLUS_PERCENT');
  assert.equal(profileFxView('MUSTERI', null), null);
});

// ---------------------------------------------------------------- D14 — imzalı adres metni

test('D14: adresteki serbest metin yalnızca işlemin imzasıyla geçerli (değiştirilmiş / imzasız / başka sonuç türü reddedilir)', async () => {
  const { signParams, verifyParams } = await import('../server/security/signed-param.js');
  const secret = 's'.repeat(40);
  const sig = signParams(secret, 'error:fgo', ['cui, seri', '']);
  assert.equal(verifyParams(secret, 'error:fgo', ['cui, seri', ''], sig), true);
  assert.equal(verifyParams(secret, 'error:fgo', ['Sahte uyarı: şifrenizi girin', ''], sig), false);
  assert.equal(verifyParams(secret, 'ok:fgoTest', ['cui, seri', ''], sig), false, 'başka sonuç türünde geçersiz');
  assert.equal(verifyParams('b'.repeat(40), 'error:fgo', ['cui, seri', ''], sig), false);
  assert.equal(verifyParams(secret, 'error:fgo', ['cui, seri', ''], undefined), false);
  assert.equal(verifyParams(secret, 'error:fgo', ['cui', ', seri'], signParams(secret, 'error:fgo', ['cui, ', 'seri'])), false, 'alan sınırı kaydırılamaz');
});

// ---------------------------------------------------------------- O4 — kayıt hatası belirsizdir

test('O4: belge kesildikten sonraki kayıt hatası "belirsiz" sayılır (iş yeniden FGO\'ya gitmez); kesilen numara taşınır', async () => {
  const { EmittedNotRecorded, mustPark, recordOrPark } = await import('../server/finance/uncertain.js');
  const never = () => false;
  await assert.rejects(recordOrPark({ series: 'PRF', number: '42' }, async () => { throw Object.assign(new Error('unique'), { code: 'P2002' }); }), (e) => e instanceof EmittedNotRecorded && e.issued.number === '42' && !/unique|P2002/.test(e.message));
  assert.equal(mustPark(new EmittedNotRecorded({ series: 'PRF', number: '1' }), never), true);
  assert.equal(mustPark(new Error('başka'), never), false);
  assert.equal(await recordOrPark({ series: 'PRF', number: '1' }, async () => 'ok'), 'ok');
  // Bütün belge işçileri kayıt adımını recordOrPark ile sarar (yapı)
  for (const f of ['server/glass/billing.js', 'server/glass/batch.js', 'server/profile/fgo-jobs.js']) {
    const src = read(f);
    assert.ok(!/\n\s+await record(Glass|Batch|Profile)\w*\(db/.test(src.replace(/recordOrPark\(doc, \(\) => record\w+\(db/g, '')), `${f}: kayıt recordOrPark dışında`);
    assert.match(src, /mustPark\(e, uncertainEmit\)/, f);
  }
});

// ---------------------------------------------------------------- O2 — avans düşümü sınırı (yapı)

test('O2: profil teslim faturasında avans toplamı fatura tutarını aşarsa fatura kesilmez (kalıcı engel, gerekçe)', () => {
  const src = read('server/profile/fgo-jobs.js');
  const at = src.indexOf("if (kind === 'invoice') {");
  const block = src.slice(at, at + 1600);
  assert.match(block, /advancedGross - goodsGross > 0\.005/);
  assert.match(block, /throw new Permanent\(/);
});
