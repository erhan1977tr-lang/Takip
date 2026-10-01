// FGO bağlantısı ve BT kuru (Aşama 6b) — saf kurallar.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openSecret, sealSecret } from '../server/crypto/secret.js';
import { fetchBtEurSell, parseBtRate, parseManualRate } from '../server/fx/bt.js';
import { FgoError, emitereForm, fgoEmit, fgoHash, missingBilling, ronPrice, ronTotal, validateFgoSettings } from '../server/integrations/fgo.js';
import { profileActions } from '../server/profile/rules.js';

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

test('FGO ayarları: seri, tür, TVA, adres doğrulanır; açıkken CUI zorunlu', () => {
  const ok = validateFgoSettings({ enabled: true, env: 'prod', cui: 'RO 123456', proformaSeries: 'prf', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: '21', fxUrl: 'https://www.bancatransilvania.ro/curs-valutar' });
  assert.ok(ok.ok);
  assert.equal(ok.value.cui, '123456');
  assert.equal(ok.value.proformaSeries, 'PRF');
  assert.equal(ok.value.env, 'prod');
  const bad = validateFgoSettings({ enabled: true, cui: '', proformaSeries: 'P R', invoiceSeries: '', proformaType: '1', vatRate: '99', fxUrl: 'http://x' });
  assert.ok(!bad.ok);
  for (const e of ['CUI', 'PROFORMA_SERIES', 'INVOICE_SERIES', 'PROFORMA_TYPE', 'VAT', 'FX_URL']) assert.ok(bad.errors.includes(e), e);
});

test('FGO belge: RON birim fiyat = EUR × kur; hash; müşteri ve satırlar; tekrar kesimi önleyen IdExtern', () => {
  assert.equal(ronPrice(12.5, 4.9765), 62.21);
  const lines = [{ code: 'GK15', name: 'GARNITURA EPDM - GK15', unit: 'cutii', qty: 4, eur: 12.5 }, { code: 'SPIGOTI', name: 'SPIGOTI', unit: 'bucăți', qty: 20, eur: 3 }];
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
  assert.equal(f['Continut[0][PretUnitar]'], '62.21');
  assert.equal(f['Continut[1][NrProduse]'], '20');
  assert.equal(f['Continut[1][CotaTVA]'], '21');
  assert.match(f.Text, /Curs BT vânzare EUR 4\.9765 RON din 01\.10\.2026/);
  const inv = emitereForm({ settings, key: 'K', kind: 'invoice', orderNo: 'GLAP3', appUrl: '', customer, lines, rate: 4.9765, rateDate: '01.10.2026' });
  assert.equal(inv.Serie, 'GKH');
  assert.equal(inv.IdExtern, 'GLAP3-F');
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
