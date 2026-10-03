// FGO bağlantısı ve BT kuru (Aşama 6b) — saf kurallar.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openSecret, sealSecret } from '../server/crypto/secret.js';
import { fetchBtEurSell, parseBtRate, parseManualRate } from '../server/fx/bt.js';
import { FGO_UM, FGO_UM_MAX, FgoError, fgoUnit, validUm, afterInvoiceIssued, emitereForm, fgoEmit, fgoHash, grossOf, manualInvoiceNumber, missingBilling, reserveInvoiceNumber, ronPrice, ronTotal, validateFgoSettings } from '../server/integrations/fgo.js';
import { profileActions } from '../server/profile/rules.js';
import { documentLines } from '../server/profile/fgo-jobs.js';
import { proformaLines, invoiceLines } from '../server/glass/billing.js';
import { UNITS } from '../prisma/seed/data/units.js';

const SECRET = 'x'.repeat(40);

test('gizli değer: şifrelenir, yalnızca aynı anahtarla açılır', () => {
  const sealed = sealSecret('ANAHTAR-123', SECRET, 'fgo-key');
  assert.ok(!sealed.includes('ANAHTAR'));
  assert.equal(openSecret(sealed, SECRET, 'fgo-key'), 'ANAHTAR-123');
  assert.equal(openSecret(sealed, 'y'.repeat(40), 'fgo-key'), null, 'başka AUTH_SECRET açamaz');
  assert.equal(openSecret(sealed, SECRET, 'baska-amac'), null);
  assert.equal(openSecret('bozuk', SECRET, 'fgo-key'), null);
  assert.notEqual(sealSecret('a', SECRET, 'p'), sealSecret('a', SECRET, 'p'), 'her seferinde farklı');
});

test('BT kuru: JSON ve HTML içinden EUR satış kuru; makul olmayan sayı alınmaz', () => {
  assert.equal(parseBtRate(JSON.stringify({ rates: [{ currency: 'USD', buy: 4.2, sell: 4.6 }, { currency: 'EUR', buy: '4,8900', sell: '5,0123' }] }), 'application/json'), 5.0123);
  assert.equal(parseBtRate(JSON.stringify([{ moneda: 'EUR', cumparare: 4.88, vanzare: 5.01 }])), 5.01);
  assert.equal(parseBtRate(JSON.stringify([{ code: 'EUR', a: 4.88, b: 5.02, cumparare: 4.88 }])), 5.02, 'satış alanı adı bilinmiyorsa alış dışındaki en büyük');
  const html = '<table><tr><td>USD</td><td>4,3100</td><td>4,6200</td></tr><tr><td>EUR</td><td>4,8750</td><td>5,0410</td></tr></table>';
  assert.equal(parseBtRate(html, 'text/html'), 5.041);
  // BT'nin resmî XML dosyası (dev.bancatransilvania.ro/exchange.xml)
  const xml = '<?xml version="1.0"?><xml><updateDate name="2026-10-01 09:20:02"/><exchangeRates><currency name="USD"><sell><value>4.7527</value></sell><buy><value>4.5663</value></buy></currency><currency name="EUR"><sell><value>5.325</value></sell><buy><value>5.225</value></buy></currency></exchangeRates></xml>';
  assert.equal(parseBtRate(xml, 'text/xml'), 5.325);
  assert.equal(parseBtRate(xml, ''), 5.325);
  // Birden çok tablo: "În unități BT" başlığından sonraki EUR satırı (karar 46); çevirici satırı karıştırılmaz
  const page = '<div>1 EUR = 5.1800 RON</div><h3>În cont</h3><table><tr><td>EUR</td><td>5.2601</td><td>5.1500</td><td>5.3700</td></tr></table>'
    + '<h3>În unități BT</h3><table><tr><th>Moneda</th><th>BNR</th><th>Cumpărare</th><th>Vânzare</th></tr><tr><td>EUR</td><td>5.2601</td><td>5.1800</td><td>5.3450</td></tr></table>';
  assert.equal(parseBtRate(page, 'text/html'), 5.345);
  assert.equal(parseBtRate(page.replace('În unități BT', 'In BT units'), 'text/html'), 5.345);
  // BT tablosu: EUR | BNR | alış | satış → satış
  assert.equal(parseBtRate('<tr><td>EUR</td><td>5.2601</td><td>5.1800</td><td>5.3450</td></tr>'), 5.345);
  assert.equal(parseBtRate('<p>EUR 1 2026</p>'), null);
  assert.equal(parseBtRate('<div>Cont business</div>'), null);
  assert.equal(parseManualRate('4,9765'), 4.9765);
  assert.equal(parseManualRate('49765'), null);
  assert.equal(parseManualRate('12,5'), null, 'aralık dışı');
});

test('FGO ayarları: seri, tür, TVA doğrulanır; açıkken CUI zorunlu', () => {
  const ok = validateFgoSettings({ enabled: true, env: 'prod', cui: 'RO 123456', proformaSeries: 'prf', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: '21' });
  assert.ok(!('fxUrl' in ok.value) && !('fxMode' in ok.value), 'kur kaynağı FGO ayarı değildir: kur müşterinin kur politikasından (server/fx/resolve.js)');
  assert.ok(ok.ok);
  assert.equal(ok.value.cui, '123456');
  assert.equal(ok.value.proformaSeries, 'PRF');
  assert.equal(ok.value.env, 'prod');
  const bad = validateFgoSettings({ enabled: true, cui: '', proformaSeries: 'P R', invoiceSeries: '', proformaType: '1', vatRate: '99' });
  assert.ok(!bad.ok);
  for (const e of ['CUI', 'PROFORMA_SERIES', 'INVOICE_SERIES', 'PROFORMA_TYPE', 'VAT']) assert.ok(bad.errors.includes(e), e);
  assert.equal(ok.value.invoiceNext, null, 'boş = numarayı FGO verir');
  const base = { cui: '12', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: '21' };
  assert.equal(validateFgoSettings({ ...base, invoiceNext: '684' }).value?.invoiceNext, 684);
  assert.ok(validateFgoSettings({ ...base, invoiceNext: '0' }).errors?.includes('INVOICE_NEXT'));
  assert.ok(validateFgoSettings({ ...base, invoiceNext: 'GKH684' }).errors?.includes('INVOICE_NEXT'));
});

// Karar 87: fatura numarasını FGO verir. Sistem numara üretmez (son numara + 1 yok, kendiliğinden artan sayaç yok).
function numberingDb(docs, settingValue = {}) {
  const audits = [];
  const alerts = [];
  const setting = { value: settingValue };
  const db = {
    audits, alerts, setting,
    fgoDocument: {
      findMany: async ({ where }) => docs.filter((d) => d.series === where.series),
      findUnique: async ({ where }) => docs.find((d) => d.series === where.series_number.series && d.number === where.series_number.number) ?? null,
    },
    adminAlert: { create: async ({ data }) => alerts.push(data) },
    integrationSetting: {
      findUnique: async () => setting,
      update: async ({ data }) => { setting.value = data.value; },
    },
    order: { findUnique: async () => ({ id: 'o1', status: 'URETIMDE', orderTypeCode: 'GLASS_ORDER' }) },
    $transaction: async (fn) => fn({
      fgoDocument: { delete: async ({ where }) => docs.splice(docs.findIndex((d) => d.id === where.id), 1), count: async () => 0 },
      notificationOutbox: { updateMany: async () => ({ count: 0 }) },
      glassBilling: { updateMany: async () => ({ count: 0 }) },
      orderEvent: { create: async ({ data }) => audits.push({ action: `EVENT:${data.event}` }) },
      auditLog: { create: async ({ data }) => audits.push(data) },
    }),
  };
  return db;
}
/** Sahte FGO getstatus: `gone` numaraları "belge yok" der */
function statusFetch(gone = []) {
  const asked = [];
  const fetchImpl = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    asked.push(form.Numar);
    if (gone.includes(form.Numar)) return new Response(JSON.stringify({ Success: false, Message: 'Factura nu exista' }));
    return new Response(JSON.stringify({ Success: true, Factura: { Valoare: '10' } }));
  };
  return { asked, fetchImpl };
}

test('fatura numarası: sistem numara üretmez — elle numara yoksa Numar gönderilmez (FGO numaralandırır)', async () => {
  assert.equal(manualInvoiceNumber({ invoiceNext: null }), null);
  assert.equal(manualInvoiceNumber({ invoiceNext: 0 }), null);
  assert.equal(manualInvoiceNumber({ invoiceNext: 684 }), '684');
  const s = { env: 'test', cui: '1', invoiceSeries: 'GKH', invoiceNext: null };
  // Sistemde 684, 699 kayıtlı: eskiden 700 gönderilirdi; artık numara gönderilmez
  const docs = [
    { id: 'd684', orderId: 'o1', kind: 'INVOICE', series: 'GKH', number: '684' },
    { id: 'd699', orderId: 'o2', kind: 'INVOICE', series: 'GKH', number: '699' },
    { id: 'p9', orderId: 'o3', kind: 'PROFORMA', series: 'PRF', number: '900' },
  ];
  const db = numberingDb(docs);
  const f = statusFetch();
  assert.equal(await reserveInvoiceNumber(db, s, { key: 'K', fetchImpl: f.fetchImpl, sleep: async () => {} }), null);
  assert.deepEqual(f.asked, ['699'], 'yalnızca en son fatura kaydı FGO\'da duruyor mu diye sorulur');
  assert.equal(docs.length, 3, 'FGO\'da duran kayda dokunulmaz');
  // Hiç fatura kaydı yoksa FGO'ya hiç sorulmaz
  const none = statusFetch();
  assert.equal(await reserveInvoiceNumber(numberingDb([]), s, { key: 'K', fetchImpl: none.fetchImpl, sleep: async () => {} }), null);
  assert.deepEqual(none.asked, []);
  // emitereForm: number yoksa Numar alanı hiç yok
  const form = emitereForm({ settings: { ...s, proformaSeries: 'PRF', invoiceType: 'Factura', vatRate: 21 }, key: 'K', kind: 'invoice', orderNo: 'GLA1', appUrl: '', customer: { name: 'X' }, lines: [], rate: 5, rateDate: '01.10.2026', number: null });
  assert.ok(!('Numar' in form));
});

test('fatura numarası: FGO\'da silinmiş son faturaların eski kaydı kaldırılır (FGO o numarayı yeniden verir); bu kontrol olmazsa da fatura kesimi durmaz', async () => {
  const docs = [
    { id: 'd684', orderId: 'o1', kind: 'INVOICE', series: 'GKH', number: '684' }, // FGO'da var
    { id: 'd685', orderId: 'o1', kind: 'INVOICE', series: 'GKH', number: '685' }, // FGO'da silinmiş
    { id: 'd686', orderId: 'o1', kind: 'INVOICE', series: 'GKH', number: '686' }, // FGO'da silinmiş
  ];
  const db = numberingDb(docs);
  const f = statusFetch(['685', '686']);
  const s = { env: 'test', cui: '1', invoiceSeries: 'GKH', invoiceNext: null };
  assert.equal(await reserveInvoiceNumber(db, s, { key: 'K', fetchImpl: f.fetchImpl, sleep: async () => {} }), null);
  assert.deepEqual(f.asked, ['686', '685', '684']);
  assert.deepEqual(docs.map((d) => d.number), ['684'], 'silinmiş belgelerin kaydı kaldırıldı; FGO\'da duran kaldı');
  assert.deepEqual(db.audits.map((a) => a.action), ['EVENT:FGO_DOC_DELETED', 'FGO_DOC_REMOVED', 'EVENT:FGO_DOC_DELETED', 'FGO_DOC_REMOVED']);
  // Kontrol yalnızca temizliktir: FGO'ya ulaşılamazsa ya da beklenmeyen bir yanıt gelirse kayıtlara dokunulmaz, kesim sürer
  const down = async () => { throw new Error('ECONNRESET'); };
  assert.equal(await reserveInvoiceNumber(db, s, { key: 'K', fetchImpl: down, sleep: async () => {} }), null);
  const odd = async () => new Response(JSON.stringify({ Success: false, Message: 'Eroare interna' }));
  assert.equal(await reserveInvoiceNumber(db, s, { key: 'K', fetchImpl: odd, sleep: async () => {} }), null);
  assert.deepEqual(docs.map((d) => d.number), ['684']);
});

test('fatura numarası — elle numara: tam o numara; sistemde kayıtlıysa FGO\'ya sorulur; FGO\'da varsa BAŞKA NUMARA DENENMEZ', async () => {
  const docs = [
    { id: 'd684', orderId: 'o1', kind: 'INVOICE', series: 'GKH', number: '684' }, // FGO'da silinmiş deneme faturası
    { id: 'd700', orderId: 'o2', kind: 'INVOICE', series: 'GKH', number: '700' }, // FGO'da var
  ];
  const db = numberingDb(docs);
  const f = statusFetch(['684']);
  const s = { env: 'test', cui: '1', invoiceSeries: 'GKH', invoiceNext: 684 };
  const opts = { key: 'K', fetchImpl: f.fetchImpl, sleep: async () => {} };
  assert.equal(await reserveInvoiceNumber(db, s, opts), '684');
  assert.deepEqual(f.asked, ['684']);
  assert.ok(!docs.some((d) => d.number === '684'), 'silinmiş belgenin kaydı kaldırıldı');
  assert.deepEqual(db.audits.map((a) => a.action), ['EVENT:FGO_DOC_DELETED', 'FGO_DOC_REMOVED'], 'siparişin geçmişinde ve denetimde');
  // 700 hem sistemde hem FGO'da var: kalıcı hata, 701'e GEÇİLMEZ
  await assert.rejects(reserveInvoiceNumber(db, { ...s, invoiceNext: 700 }, opts), (e) => e instanceof FgoError && !e.retry && /GKH700/.test(e.message) && /başka numara denenmedi/.test(e.message));
  f.asked.length = 0;
  assert.equal(await reserveInvoiceNumber(db, { ...s, invoiceNext: 685 }, opts), '685', 'tam girilen numara');
  assert.deepEqual(f.asked, [], 'kayıt yoksa FGO\'ya sorulmaz');
  // FGO'ya ulaşılamazsa numara uydurulmaz (iş sonra yeniden denenir)
  const down = async () => { throw new Error('ECONNRESET'); };
  await assert.rejects(reserveInvoiceNumber(db, { ...s, invoiceNext: 700 }, { ...opts, fetchImpl: down }), (e) => e instanceof FgoError && e.retry);
});

test('fatura kesildikten sonra: elle numara tek seferliktir (alan boşalır, +1 yapılmaz); FGO başka numara kestiyse uyarı', async () => {
  // Elle numara gönderilmedi: ayara dokunulmaz, uyarı yok
  let db = numberingDb([], { enabled: true, invoiceNext: null });
  await afterInvoiceIssued(db, { sent: null, issued: '701', orderId: 'o1' });
  assert.equal(db.setting.value.invoiceNext, null);
  assert.equal(db.alerts.length, 0);
  // Elle 684 gönderildi ve FGO 684 kesti: alan boşalır (685 olmaz)
  db = numberingDb([], { enabled: true, invoiceNext: 684 });
  await afterInvoiceIssued(db, { sent: '684', issued: '684', orderId: 'o1' });
  assert.equal(db.setting.value.invoiceNext, null);
  assert.equal(db.setting.value.enabled, true, 'diğer ayarlar aynen kalır');
  assert.equal(db.alerts.length, 0);
  // FGO başka numara kesti: uyarı + kaydedilen numara FGO'nunki; alan yine boşalır
  db = numberingDb([], { invoiceNext: 800 });
  await afterInvoiceIssued(db, { sent: '800', issued: '999', orderId: 'o2' });
  assert.equal(db.alerts[0].type, 'FGO_NUMBER');
  assert.equal(db.alerts[0].details.error, '800 → 999');
  assert.equal(db.setting.value.invoiceNext, null);
  // Yönetici bu arada başka numara girdiyse ona dokunulmaz
  db = numberingDb([], { invoiceNext: 900 });
  await afterInvoiceIssued(db, { sent: '800', issued: '800', orderId: 'o2' });
  assert.equal(db.setting.value.invoiceNext, 900);
});

test('FGO belge: RON birim fiyat = EUR × kur; hash; müşteri ve satırlar; tekrar kesimi önleyen IdExtern', () => {
  assert.equal(ronPrice(12.5, 4.9765), 62.21);
  const lines = [{ code: 'GK15', name: 'GARNITURA EPDM - GK15', unit: 'cutii', qty: 4, eur: 12.5 }, { code: 'SPIGOTI', name: 'SPIGOTI', unit: 'buc', qty: 20, eur: 3 }];
  assert.equal(ronTotal(lines, 4.9765), 4 * 62.21 + 20 * 14.93);
  const settings = { cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21 };
  const customer = { id: 'c1', name: 'Glass and More SRL', taxId: '998877', regCom: 'J40/1/2020', county: 'Ilfov', city: 'Voluntari', address: 'Str. X 1', country: null };
  const f = emitereForm({ settings, key: 'K', kind: 'proforma', orderNo: 'GLAP3', appUrl: 'https://t.ro', customer, lines, rate: 4.9765, rateDate: '01.10.2026' });
  assert.equal(f.Hash, crypto.createHash('sha1').update('123456KGlass and More SRL').digest('hex').toUpperCase());
  assert.equal(f.Hash, fgoHash('123456', 'K', 'Glass and More SRL'));
  assert.equal(f.Serie, 'PRF');
  assert.equal(f.TipFactura, 'Proforma');
  assert.equal(f.Valuta, 'RON');
  assert.equal(f.IdExtern, 'GLAP3-P');
  assert.equal(f['Client[Tara]'], 'RO');
  assert.equal(f['Client[CodUnic]'], '998877');
  assert.ok(!('Client[IdExtern]' in f), 'FGO müşteri IdExtern için tam sayı ister');
  assert.ok(f.IdExtern.length <= 36);
  assert.equal(f['Continut[0][PretUnitar]'], '62.21');
  assert.equal(f['Continut[1][NrProduse]'], '20');
  assert.equal(f['Continut[0][UM]'], 'cutii');
  assert.equal(f['Continut[1][UM]'], 'buc');
  assert.equal(f['Continut[1][CotaTVA]'], '21');
  assert.match(f.Text, /Curs BT vânzare EUR 4\.9765 RON din 01\.10\.2026/);
  const inv = emitereForm({ settings, key: 'K', kind: 'invoice', orderNo: 'GLAP3', appUrl: '', customer, lines, rate: 4.9765, rateDate: '01.10.2026' });
  assert.equal(inv.Serie, 'GKH');
  assert.equal(inv.IdExtern, 'GLAP3-F');
  assert.ok(!('Numar' in inv), 'numara verilmezse FGO numaralandırır');
  // Fatura numarası verilir (karar 62); TVA dahil satır toplamı PretTotal ile (karar 63)
  const num = emitereForm({ settings, key: 'K', kind: 'invoice', orderNo: 'GLA5', appUrl: '', customer, rate: 5, rateDate: '01.10.2026', number: '685',
    lines: [{ code: '', name: 'Securizat', unit: 'mp', qty: 2.13, net: 512.29, gross: 619.87 }] });
  assert.equal(num.Numar, '685');
  assert.equal(num.Hash, fgoHash('123456', 'K', 'Glass and More SRL'), 'emitere hash numaradan bağımsız');
  assert.equal(num['Continut[0][PretTotal]'], '619.87');
  assert.ok(!('Continut[0][PretUnitar]' in num));
  assert.equal(ronTotal([{ qty: 2.13, net: 512.29 }, { qty: 1, ron: 10 }], 5), 522.29);
  assert.equal(grossOf(100, 21), 121);
  assert.equal(grossOf(10.05, 21), 12.16);
  assert.deepEqual(missingBilling({ name: 'X', taxId: '1', county: null, city: 'B', address: '' }), ['county', 'address']);
});

test('FGO yanıtı: başarı, ret (yeniden denenmez), ağ hatası (yeniden denenir); güvensiz bağlantı alınmaz', async () => {
  const settings = { env: 'test' };
  const ok = await fgoEmit(settings, { Serie: 'PRF' }, async () => new Response(JSON.stringify({ Success: true, Factura: { Numar: '552', Serie: 'PRF', Link: 'https://fgo.ro/x.pdf' } })));
  assert.deepEqual(ok, { series: 'PRF', number: '552', link: 'https://fgo.ro/x.pdf' });
  const js = await fgoEmit(settings, { Serie: 'PRF' }, async () => new Response(JSON.stringify({ Success: true, Factura: { Numar: '1', Link: 'javascript:alert(1)' } })));
  assert.equal(js.link, null);
  await assert.rejects(fgoEmit(settings, {}, async () => new Response(JSON.stringify({ Success: false, Message: 'Client invalid' }))), (e) => e instanceof FgoError && !e.retry && /Client invalid/.test(e.message));
  await assert.rejects(fgoEmit(settings, {}, async () => { throw new Error('ECONNRESET'); }), (e) => e instanceof FgoError && e.retry);
  await assert.rejects(fgoEmit(settings, {}, async () => new Response('bakım', { status: 503 })), (e) => e instanceof FgoError && e.retry);
});

test('profil: "FGO\'da yeniden dene" yalnızca yöneticide, onay ve teslim adımlarında', () => {
  const a = (role, stage) => profileActions({ role, stage, status: 'HAZIRLANIYOR' });
  assert.ok(a('ADMIN', 'ONAYLANDI').includes('retry_fgo'));
  assert.ok(a('ADMIN', 'TESLIM_EDILDI').includes('retry_fgo'));
  assert.ok(!a('ADMIN', 'PROFORMA').includes('retry_fgo'));
  assert.ok(!a('MUSTERI', 'ONAYLANDI').includes('retry_fgo'));
  assert.ok(!a('SATIS', 'ONAYLANDI').includes('retry_fgo'));
});

test('BT kuru: site reddederse (403) sebep yazılır; tarayıcı gibi istenir', async () => {
  let headers;
  const r = await fetchBtEurSell({ url: 'https://bt.example', fetchImpl: async (_u, init) => { headers = init.headers; return new Response('no', { status: 403, headers: { server: 'cloudflare', 'cf-ray': 'x' } }); } });
  assert.deepEqual(r, { ok: false, error: 'HTTP 403 (cloudflare)' });
  assert.match(headers['user-agent'], /Chrome/);
  const ok = await fetchBtEurSell({ url: 'https://bt.example', fetchImpl: async () => new Response('<td>EUR</td><td>5,2601</td><td>5,1800</td><td>5,3450</td>', { headers: { 'content-type': 'text/html' } }) });
  assert.deepEqual(ok, { ok: true, rate: 5.345, source: 'https://bt.example' });
});

test('FGO ölçü birimi (UM): tek eşleme, en çok 5 karakter; geçersiz birim FGO\'ya gönderilmeden reddedilir', () => {
  // Tek kaynak: cam m² → mp, adet → buc; profil birimleri; "bucăți" (6 karakter, FGO reddeder) → buc
  assert.equal(fgoUnit('m2'), 'mp');
  assert.equal(fgoUnit('adet'), 'buc');
  assert.deepEqual(UNITS.map((u) => fgoUnit(u.code)), ['cutii', 'pungi', 'bară', 'buc']);
  assert.equal(fgoUnit('bucati'), 'buc', 'büyük/küçük harf');
  assert.equal(fgoUnit('PALET'), null, 'tanımsız kod uydurulmaz');
  for (const um of Object.values(FGO_UM)) assert.ok(validUm(um), um);
  assert.equal(FGO_UM_MAX, 5);
  assert.ok(!validUm('bucăți') && !validUm('') && !validUm(' ') && !validUm(null) && !validUm('buc '));

  // Profil belgesi satırları: katalog birimi → FGO birimi; birimsiz satır adetle fiyatlanır
  const profile = documentLines({ lines: [
    { poz: 'GK15', description: 'G', descriptionRo: 'Garnitura', unitCode: 'CUTII', unit: 'adet', adet: 4, offerPrice: '12.5' },
    { poz: 'SPIGOTI', description: 'S', descriptionRo: 'Spigoti', unitCode: 'BUCATI', unit: 'adet', adet: 20, offerPrice: '3' },
    { poz: 'B1', description: 'B', descriptionRo: 'Bara', unitCode: 'BARA', unit: 'adet', adet: 2, offerPrice: '9' },
    { poz: 'P1', description: 'P', descriptionRo: 'Pungi', unitCode: 'PUNGI', unit: 'adet', adet: 1, offerPrice: '1' },
    { poz: '', description: 'X', descriptionRo: '', unitCode: null, unit: 'adet', adet: 1, offerPrice: '1' },
  ] });
  assert.deepEqual(profile.map((l) => l.unit), ['cutii', 'buc', 'bară', 'pungi', 'buc']);
  // Cam belgeleri: mp / buc (değişmedi)
  const offer = { lines: [
    { kind: 'CAM', unit: 'm2', description: 'Temper', descriptionRo: 'Securizat', enMm: 1000, boyMm: 2000, adet: 1, offerPrice: '50' },
    { kind: 'CNC', unit: 'adet', description: 'CNC', adet: 2, offerPrice: '10' },
    { kind: 'DIGER', unit: 'adet', description: 'Sandık parası', descriptionRo: 'Ambalaj (ladă)', adet: 1, offerPrice: '30' },
  ] };
  assert.deepEqual(proformaLines(offer).map((l) => l.unit), ['mp', 'buc', 'buc']);
  assert.deepEqual(invoiceLines(offer, 5, 21).map((l) => l.unit), ['mp']);

  // Gönderimden önce doğrulama: boş ya da 5 karakterden uzun birim → kalıcı hata (yeniden denenmez), kırpılmaz
  const settings = { cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21 };
  const base = { settings, key: 'K', kind: 'proforma', orderNo: 'GLAP3', appUrl: '', customer: { name: 'X SRL', taxId: '12' }, rate: 5, rateDate: '01.10.2026' };
  for (const unit of ['bucăți', '', undefined, 'PALETI']) {
    assert.throws(() => emitereForm({ ...base, lines: [{ code: 'A', name: 'Ürün', unit, qty: 1, eur: 1 }] }), (e) => e instanceof FgoError && e.retry === false && /ölçü birimi/.test(e.message));
  }
  const ok = emitereForm({ ...base, lines: profile });
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => ok[`Continut[${i}][UM]`]), ['cutii', 'buc', 'bară', 'pungi', 'buc']);
});
