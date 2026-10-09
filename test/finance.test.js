// Paket 10 (kararlar 206–210) — saf kurallar: elle ödeme formu, RON karşılığı, "en büyüğü" kuralı (aynı ödeme iki kez
// sayılmaz), eşleştirme, aynı müşteride aynı tutar, onay anahtarı, belirsiz FGO sonucu sınıflaması. Ağ yok: FGO yanıtları
// sahte fetch ile.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DUPLICATE_WINDOW_DAYS, ackKeyOf, basisOf, centsText, coveredPaymentIds, duplicateMatches, ofProforma, parsePayment, paymentMatch, paymentRonCents, paymentState, toCents, validRequestKey,
} from '../server/finance/payments.js';
import { FgoError, fgoEmit, requestNotSent, uncertainEmit } from '../server/integrations/fgo.js';
import { PARKED_UNTIL, UNCERTAIN_MARK, expectedGross, isParked } from '../server/finance/uncertain.js';
import { WAITING_JOBS } from '../server/integrations/fgo-claim.js';
import { orderChain, billingState } from '../server/glass/billing.js';

const TODAY = '2026-10-09';
const ok = (raw) => parsePayment({ paidOn: TODAY, amount: '2000', currency: 'EUR', method: 'BANK_TRANSFER', ...raw }, { today: TODAY });

test('elle ödeme formu sunucuda doğrulanır: tarih, gelecek, tutar, para birimi, yöntem, uzunluklar', () => {
  assert.deepEqual(ok({}), { ok: true, value: { paidOn: TODAY, amount: '2000.00', currency: 'EUR', method: 'BANK_TRANSFER', reference: null, note: null } });
  assert.equal(ok({ amount: '1.234,56' }).value.amount, '1234.56', 'Türk / Rumen yazımı');
  assert.equal(ok({ amount: '99,5' }).value.amount, '99.50');
  assert.equal(ok({ reference: '  OP   123  ' }).value.reference, 'OP 123');
  for (const [raw, code] of [
    [{ paidOn: '2026-02-30' }, 'DATE'], [{ paidOn: '09.10.2026' }, 'DATE'], [{ paidOn: '2019-12-31' }, 'DATE'], [{ paidOn: '2026-10-10' }, 'FUTURE'],
    [{ amount: '0' }, 'AMOUNT'], [{ amount: '-5' }, 'AMOUNT'], [{ amount: '1.005' }, 'AMOUNT'], [{ amount: '10000000.01' }, 'AMOUNT'], [{ amount: 'abc' }, 'AMOUNT'], [{ amount: '' }, 'AMOUNT'],
    [{ currency: 'USD' }, 'CURRENCY'], [{ currency: '' }, 'CURRENCY'], [{ method: 'CRYPTO' }, 'METHOD'],
    [{ reference: 'x'.repeat(121) }, 'REFERENCE'], [{ note: 'x'.repeat(501) }, 'NOTE'],
  ]) assert.deepEqual(ok(raw), { ok: false, code }, JSON.stringify(raw));
  assert.equal(ok({ amount: '10000000' }).ok, true, 'üst sınır dahil');
});

test('RON karşılığı: RON aynen; EUR zincirin KAYITLI kuruyla, bir kez yarım-yukarı; kur yoksa EUR kaydedilmez', () => {
  assert.equal(paymentRonCents({ amount: '2000.00', currency: 'RON' }, { rate: null }), 200000n);
  assert.equal(paymentRonCents({ amount: '2000.00', currency: 'EUR' }, { rate: '4.9765' }), 995300n);
  assert.equal(paymentRonCents({ amount: '0.01', currency: 'EUR' }, { rate: '4.9750' }), 5n, '0,04975 → 0,05');
  assert.equal(paymentRonCents({ amount: '1.00', currency: 'EUR' }, { rate: null }), null);
  assert.equal(paymentRonCents({ amount: '1.00', currency: 'USD' }, { rate: '5' }), null);
  assert.equal(toCents('12.345'), 0n, 'üç ondalık geçersiz');
  assert.equal(toCents(12.345), 1235n, 'sayı 2 ondalığa yuvarlanır');
  assert.equal(centsText(-150n), '-1.50');
});

test('avans tutarı = max(FGO, elle) − avansı kesilen: aynı ödeme hem elle hem FGO\'da görünse de bir kez sayılır (senaryo 1–2)', () => {
  // 2.000 EUR (9.953 RON) elle kaydedildi → avans istenebilir
  const pay = [{ ron: '9953.00' }];
  let st = paymentState({ fgoPaid: 0, proformaTotal: '12100.00', payments: pay, advanced: 0 });
  assert.deepEqual([st.advanceRequired, st.advanceBasis, st.match, st.review, st.full], [9953, 'MANUAL', 'MANUAL_ONLY', [], false]);
  // Elle kayda dayanan avans kesildi
  st = paymentState({ fgoPaid: 0, proformaTotal: '12100.00', payments: pay, advanced: '9953.00' });
  assert.equal(st.advanceRequired, 0);
  // Aynı ödeme sonradan FGO eşitlemesinde görünür → ikinci avans YOK
  st = paymentState({ fgoPaid: '9953.00', proformaTotal: '12100.00', payments: pay, advanced: '9953.00' });
  assert.deepEqual([st.advanceRequired, st.match, st.advanceBasis], [0, 'MATCHED', 'FGO_MANUAL']);
  // Geçersiz kılınan kayıt sayılmaz
  st = paymentState({ fgoPaid: 0, payments: [{ ron: '500', voidedAt: new Date() }], advanced: 0 });
  assert.deepEqual([st.manualRon, st.advanceRequired, st.match], [0, 0, 'NONE']);
});

test('kısmi, birden çok, fazla ve uyuşmayan ödeme: tam ödeme sayılmaz, fark inceleme ister (senaryo 6–7)', () => {
  // Kısmi: proforma 1.210, ödenen 400 → avans 400, tam değil
  let st = paymentState({ fgoPaid: '400', proformaTotal: '1210', payments: [], advanced: 0 });
  assert.deepEqual([st.advanceRequired, st.full, st.match], [400, false, 'FGO_ONLY']);
  // Birden çok: iki elle kayıt (300 + 426), ilki avanslandı → ikinci avans yalnızca fark
  st = paymentState({ fgoPaid: 0, proformaTotal: '1210', payments: [{ ron: '300' }, { ron: '426' }], advanced: '300' });
  assert.equal(st.advanceRequired, 426);
  // Uyuşmayan: FGO 500, elle 450 → büyük olan esas, inceleme
  st = paymentState({ fgoPaid: '500', proformaTotal: '1210', payments: [{ ron: '450' }], advanced: 0 });
  assert.deepEqual([st.advanceRequired, st.match, st.review, st.advanceBasis], [500, 'MISMATCH', ['MISMATCH'], 'FGO']);
  // Fazla ödeme: proforma toplamını aşan → inceleme; "tam ödeme" fazla tutar için belge doğurmaz
  st = paymentState({ fgoPaid: '1300', proformaTotal: '1210', payments: [], advanced: 0 });
  assert.deepEqual([st.review, st.full], [['OVERPAID'], true]);
  assert.equal(paymentMatch(0n, 0n), 'NONE');
  assert.equal(basisOf(100n, 100n), 'FGO_MANUAL');
  assert.equal(basisOf(0n, 0n), 'FGO');
});

test('yalnızca geçerli proformaya kaydedilen ödeme sayılır: silinen proformanın ödemesi yeni zincire tahminle taşınmaz', () => {
  const pays = [{ ron: '100', proformaRef: 'PRF1' }, { ron: '200', proformaRef: 'PRF2' }];
  assert.deepEqual(ofProforma(pays, { series: 'PRF', number: '2' }).map((p) => p.ron), ['200']);
  assert.deepEqual(ofProforma(pays, null), []);
  const docs = [{ kind: 'PROFORMA', series: 'PRF', number: '2', paid: '0', total: '1210' }];
  assert.equal(orderChain(docs, pays).advanceRequired, 200);
  assert.equal(orderChain([], pays).advanceRequired, 0);
  // Cam düğmeleri: elle kayıt avans düğmesini açar, kapanış faturasını (yüklenmişse) bekletir
  const st = billingState({ status: 'URETIMDE', loaded: true, docs, hasOffer: true, payments: pays });
  assert.deepEqual([st.actions, st.wait, st.manualRon, st.basis], [['advance'], 'advance_required', 200, 'MANUAL']);
});

test('avansın karşıladığı elle kayıtlar: tarih sırasıyla, avanslanan toplamı aşmayanlar; bağlı / geçersiz olanlar atlanır', () => {
  const p = (id, ron, day, extra = {}) => ({ id, ron, paidOn: new Date(`2026-10-0${day}T00:00:00Z`), createdAt: new Date(`2026-10-0${day}T08:00:00Z`), ...extra });
  const list = [p('b', '200', 3), p('a', '100', 2), p('v', '999', 1, { voidedAt: new Date() }), p('c', '50', 4)];
  assert.deepEqual(coveredPaymentIds(list, '300'), ['a', 'b']);
  assert.deepEqual(coveredPaymentIds(list, '299.99'), ['a']);
  assert.deepEqual(coveredPaymentIds(list.map((x) => (x.id === 'a' ? { ...x, linked: true } : x)), '350'), ['b', 'c']);
});

test('aynı müşteride aynı tutar: aynı RON ya da (elle kayıtta) aynı tutar + para birimi; 180 gün; onay anahtarı eşleşmeye bağlı (senaryo 5, 8)', () => {
  const now = new Date('2026-10-09T10:00:00Z');
  const old = new Date(now.getTime() - (DUPLICATE_WINDOW_DAYS + 1) * 86_400_000);
  const c = [
    { key: 'P:1', kind: 'PAYMENT', ron: '9953.00', amount: '2000.00', currency: 'EUR', at: '2026-10-01' },
    { key: 'D:2', kind: 'ADVANCE', ron: '9953.00', at: '2026-09-01' },
    { key: 'P:3', kind: 'PAYMENT', ron: '9900.00', amount: '2000.00', currency: 'EUR', at: '2026-10-02' }, // başka kur, aynı EUR
    { key: 'P:4', kind: 'PAYMENT', ron: '2000.00', amount: '2000.00', currency: 'RON', at: '2026-10-02' }, // aynı rakam, başka para birimi
    { key: 'B:5', kind: 'ADVANCE', ron: '9953.00', at: old }, // süre dışı
  ];
  assert.deepEqual(duplicateMatches({ ron: '9953.00', amount: '2000.00', currency: 'EUR' }, c, { now }).map((m) => m.key), ['D:2', 'P:1', 'P:3']);
  assert.deepEqual(duplicateMatches({ ron: '9953.00' }, c, { now }).map((m) => m.key), ['D:2', 'P:1'], 'avans: yalnızca RON karşılığı');
  assert.deepEqual(duplicateMatches({ ron: '9953.00', exclude: ['P:1'] }, c, { now }).map((m) => m.key), ['D:2']);
  assert.deepEqual(duplicateMatches({ ron: '1.00' }, c, { now }), []);
  const k1 = ackKeyOf([{ key: 'D:2' }, { key: 'P:1' }]);
  assert.match(k1, /^[0-9a-f]{24}$/);
  assert.equal(k1, ackKeyOf([{ key: 'D:2' }, { key: 'P:1' }]), 'aynı eşleşmeler → aynı anahtar');
  assert.notEqual(k1, ackKeyOf([{ key: 'D:2' }, { key: 'P:1' }, { key: 'P:9' }]), 'yeni eşleşme eklenince eski onay geçmez');
  assert.equal(ackKeyOf([]), '');
  assert.equal(validRequestKey('a'.repeat(16)), true);
  assert.equal(validRequestKey('a'.repeat(15)), false);
  assert.equal(validRequestKey('<script>aaaaaaaaaaa'), false);
});

test('FGO belge isteği: bağlantı kurulamadıysa kesin (yeniden denenir); gönderilmiş olabilirse BELİRSİZ (senaryo 9)', async () => {
  const settings = { env: 'test' };
  const fail = async (impl) => fgoEmit(settings, { Serie: 'GKH' }, impl).then(() => null, (e) => e);
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  assert.equal(requestNotSent(refused), true);
  assert.equal(requestNotSent(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })), true);
  assert.equal(requestNotSent(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } })), true);
  assert.equal(requestNotSent(new Error('ECONNRESET')), false, 'bilinmeyen hata: gönderilmiş olabilir');
  const cases = [
    ['bağlantı reddedildi', async () => { throw refused; }, { retry: true, uncertain: false }],
    ['bağlantı koptu', async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); }, { retry: true, uncertain: true }],
    ['zaman aşımı', async () => { throw new DOMException('aborted', 'TimeoutError'); }, { retry: true, uncertain: true }],
    ['503', async () => new Response('bakım', { status: 503 }), { retry: true, uncertain: true }],
    ['500 JSON', async () => new Response(JSON.stringify({ Success: false, Message: 'x' }), { status: 500 }), { retry: true, uncertain: true }],
    ['429', async () => new Response(JSON.stringify({ Message: 'Prea multe cereri' }), { status: 429 }), { retry: true, uncertain: false }],
    ['200 okunamayan', async () => new Response('<html>', { status: 200 }), { retry: false, uncertain: true }],
    ['400 okunamayan', async () => new Response('<html>', { status: 400 }), { retry: false, uncertain: false }],
    ['ret', async () => new Response(JSON.stringify({ Success: false, Message: 'Client invalid' })), { retry: false, uncertain: false }],
    ['numarasız başarı', async () => new Response(JSON.stringify({ Success: true, Factura: {} })), { retry: false, uncertain: true }],
  ];
  for (const [name, impl, want] of cases) {
    const e = await fail(impl);
    assert.ok(e instanceof FgoError, name);
    assert.deepEqual({ retry: e.retry, uncertain: e.uncertain }, want, name);
    assert.equal(e.emit, true, name);
    assert.equal(uncertainEmit(e), want.uncertain, name);
  }
  // Okuma isteklerinde (getstatus vb.) emit işareti yoktur: belirsiz sayılmaz
  assert.equal(uncertainEmit(new FgoError('x', { retry: true, uncertain: true })), false);
});

test('belirsiz iş bekletilir: işçi ve "bekleyenleri öne al" ona dokunmaz; beklenen toplam satırlardan', () => {
  assert.equal(PARKED_UNTIL.getUTCFullYear(), 9999);
  assert.equal(isParked({ status: 'PENDING', lastError: `${UNCERTAIN_MARK} zaman aşımı` }), true);
  assert.equal(isParked({ status: 'FAILED', lastError: `${UNCERTAIN_MARK} x` }), false);
  assert.equal(isParked({ status: 'PENDING', lastError: 'FGO HTTP 429' }), false);
  assert.deepEqual(WAITING_JOBS.AND[1], { NOT: { lastError: { startsWith: UNCERTAIN_MARK } } });
  assert.deepEqual(expectedGross([{ gross: 726 }], { rate: 1, vatRate: 21 }), { gross: 726, tolerance: 0.11 });
  assert.deepEqual(expectedGross([{ ron: 100, qty: 2 }, { eur: 10, qty: 1 }], { rate: 5, vatRate: 21 }), { gross: 302.5, tolerance: 0.12 });
});

test('yapı: elle ödeme kaydı yalnızca finans servisinde; servisler ilk iş yetkiyi denetler; FGO\'da belge silen / iptal eden çağrı yok', () => {
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const files = (dir) => fs.readdirSync(new URL(`../${dir}`, import.meta.url), { recursive: true }).filter((f) => /\.(js|mjs|ts|tsx)$/.test(f)).map((f) => `${dir}/${f}`);
  const all = [...files('server'), ...files('app'), ...files('lib'), ...files('scripts')];
  const writers = all.filter((f) => /manualPayment\.(create|update|updateMany|delete|deleteMany|upsert)\(/.test(read(f)));
  assert.deepEqual(writers.sort(), ['server/finance/service.js'], 'elle ödeme kaydını yalnızca finans servisi yazar / bağlar / geçersiz kılar');
  const svc = read('server/finance/service.js');
  for (const fn of ['recordManualPayment', 'voidManualPayment', 'requestProfileAdvance']) {
    const body = svc.slice(svc.indexOf(`export async function ${fn}(`));
    assert.match(body.slice(0, body.indexOf('\n', body.indexOf('{\n') + 2) + 1), /if \(!allowed\(actor\)\) return FORBIDDEN;/, fn);
  }
  const unc = read('server/finance/uncertain.js');
  assert.equal(unc.slice(unc.indexOf('export async function resolveUncertainJob(')).split('\n')[1], "  if (!actor || !can(actor.role, 'ACCOUNTING_MANAGE')) return { ok: false, code: 'FORBIDDEN' };");
  // Belirsiz sonuçta FGO'ya yalnızca okuma isteği (getstatus) gider; belge silme / iptal ucu yok
  for (const f of ['server/finance/uncertain.js', 'server/finance/service.js', 'server/finance/view.js', 'server/finance/recorders.js']) {
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /factura\/(anulare|stergere|emitere)|fgoEmit\(/, f);
  }
  // Ekran / işlemler: belge kayıtları, ödeme tutarları ve müşteri verisi günlüğe yazılmaz
  for (const f of ['server/finance/service.js', 'server/finance/uncertain.js', 'app/(panel)/siparisler/[id]/finance-actions.ts']) {
    assert.doesNotMatch(read(f), /console\.(log|info|warn|error)/, f);
  }
});
