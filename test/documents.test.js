// Mali belgelerin müşteriye ulaştırılması (karar 111) — saf kurallar: e-posta metni, PDF adresi, e-posta durumu,
// müşteri partisinde her kalemin kendi siparişi. Veritabanı ve FGO gerektirmez.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DOC_KIND_RO, NO_EMAIL, emailState, financialRecipient, isEmail, pdfUrl, renderDocEmail } from '../server/documents/delivery.js';
import { batchFgoLines } from '../server/glass/batch.js';
import { emitereForm } from '../server/integrations/fgo.js';
import { DOC_NOTICE, renderInApp } from '../server/notifications/inapp.js';

test('müşteri partisi: her kalem KENDİ siparişini taşır (bütün siparişler her kaleme yazılmaz); sipariş dışı satırda açıklama yok', () => {
  const batch = {
    orders: [{ orderId: 'o2', orderNo: 'UMI2' }, { orderId: 'o3', orderNo: 'UMI3' }, { orderId: 'o4', orderNo: 'UMI4' }, { orderId: 'o7', orderNo: 'UMI7' }],
    lines: [
      { orderId: 'o2', name: 'Comanda UMI2 — Sticla A', unit: 'mp', quantity: '2', unitPrice: '50.00', ronUnit: null, ronNet: null, ronGross: null },
      { orderId: 'o3', name: 'Comanda UMI3 — Sticla B', unit: 'mp', quantity: '1', unitPrice: '60.00', ronUnit: null, ronNet: null, ronGross: null },
      { orderId: 'o4', name: 'Comanda UMI4 — Sticla C', unit: 'mp', quantity: '3', unitPrice: null, ronUnit: null, ronNet: '300.00', ronGross: '363.00' },
      { orderId: 'o7', name: 'Comanda UMI7 — Sticla D', unit: 'mp', quantity: '4', unitPrice: '70.00', ronUnit: null, ronNet: null, ronGross: null },
      { orderId: null, name: 'Stornare avans conform factură GKH9', unit: 'buc', quantity: '-1', unitPrice: null, ronUnit: '100.00', ronNet: '-100.00', ronGross: '121.00' },
    ],
  };
  const lines = batchFgoLines(batch);
  assert.deepEqual(lines.map((l) => l.detail ?? null), ['Comanda UMI2', 'Comanda UMI3', 'Comanda UMI4', 'Comanda UMI7', null]);
  // Kalemin adı, birimi, miktarı ve fiyatı aynı kalır
  assert.deepEqual(lines.map((l) => [l.name, l.unit, l.qty]), batch.lines.map((l) => [l.name, l.unit, Number(l.quantity)]));
  assert.deepEqual([lines[0].eur, lines[2].net, lines[2].gross, lines[4].ron], [50, 300, 363, 100]);
  const settings = { cui: '1', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21 };
  const f = emitereForm({ settings, key: 'K', kind: 'invoice', orderNo: 'UMI2, UMI3, UMI4, UMI7', appUrl: '', customer: { name: 'Umi' }, lines, rate: 5, extern: 'LOT-b1', text: 'Comenzi: UMI2, UMI3, UMI4, UMI7.', rateNote: false });
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => f[`Continut[${i}][Descriere]`] ?? null), ['Comanda UMI2', 'Comanda UMI3', 'Comanda UMI4', 'Comanda UMI7', null]);
  assert.equal(f.IdExtern, 'LOT-b1');
  assert.ok(!Object.values(f).some((v) => /Comanda UMI2.*Comanda UMI3/s.test(String(v))), 'hiçbir kalemde iki sipariş birden yok');
  assert.ok(!Object.keys(f).some((k) => /mail|email/i.test(k) && k !== 'Client[Email]'), 'FGO\'ya e-posta gönderme alanı yollanmaz');
});

test('belge e-postası: Romence, belge türü / no / tarih / siparişler / toplam; iç bilgi yok', () => {
  assert.deepEqual(DOC_KIND_RO, { PROFORMA: 'Proformă', ADVANCE: 'Factură de avans', INVOICE: 'Factură' });
  const one = renderDocEmail({ kind: 'PROFORMA', series: 'PRF', number: '12', issuedAt: '2026-10-04T08:00:00Z', orderNos: ['UMI7'], total: 726, currency: 'RON', firmName: 'Umi <SRL>', attached: true, portalUrl: 'https://takip.test/belgeler' });
  assert.equal(one.subject, 'Proformă PRF12 — comanda UMI7');
  for (const re of [/Tip document: Proformă/, /Număr document: PRF12/, /Data emiterii: 04\.10\.2026/, /Comanda: UMI7/, /Total: 726,00 RON \(cu TVA\)/, /atașat acestui e-mail/, /Documente financiare/]) assert.match(one.text, re);
  assert.match(one.html, /Umi &lt;SRL&gt;/);
  assert.ok(!/fgo\./i.test(one.text), 'PDF ekteyken FGO bağlantısı yazılmaz');
  const many = renderDocEmail({ kind: 'INVOICE', series: 'GKH', number: '90', orderNos: ['UMI2', 'UMI3', 'UMI4', 'UMI7'], total: '1210.5', firmName: 'Umi', attached: false, link: 'https://www.fgo.ro/f/GKH90.pdf', portalUrl: 'https://takip.test/belgeler' });
  assert.equal(many.subject, 'Factură GKH90 — comenzile UMI2, UMI3, UMI4, UMI7');
  assert.match(many.text, /Comenzi: UMI2, UMI3, UMI4, UMI7/);
  assert.match(many.text, /Total: 1\.210,50 RON/);
  assert.match(many.text, /Document \(PDF\): https:\/\/www\.fgo\.ro\/f\/GKH90\.pdf/);
  assert.ok(!/atașat/.test(many.text));
  // Toplam henüz okunmadıysa satır yazılmaz ("—" ya da 0 uydurulmaz)
  assert.ok(!/Total:/.test(renderDocEmail({ kind: 'ADVANCE', series: 'GKH', number: '91', orderNos: ['UMI7'], total: null, firmName: 'Umi' }).text));
  for (const m of [one, many]) for (const word of ['cost', 'profit', 'furnizor', 'intern']) assert.ok(!m.text.toLowerCase().includes(word));
});

test('PDF yalnızca FGO adresinden indirilir (https, fgo.ro ve alt alan adları)', () => {
  assert.equal(pdfUrl('https://fgo.ro/facturi/001_BV.pdf'), 'https://fgo.ro/facturi/001_BV.pdf');
  assert.ok(pdfUrl('https://www.fgo.ro/x.pdf'));
  assert.ok(pdfUrl('https://api-testuat.fgo.ro/v1/x'));
  for (const bad of ['http://fgo.ro/x.pdf', 'https://fgo.ro.evil.test/x.pdf', 'https://evilfgo.ro/x.pdf', 'https://127.0.0.1/x', 'file:///etc/passwd', '', null]) assert.equal(pdfUrl(bad), null, String(bad));
});

test('e-posta durumu: Gönderildi / Bekliyor / Başarısız / Email yok; kapatılmış başka iş durum sayılmaz', () => {
  const at = new Date('2026-10-04T10:00:00Z');
  assert.equal(emailState({ status: 'SENT', sentAt: at, payload: { docId: 'd', to: 'a@b.ro' } }).state, 'SENT');
  assert.equal(emailState({ status: 'SENT', sentAt: at, payload: { docId: 'd', to: 'a@b.ro' } }).to, 'a@b.ro');
  assert.equal(emailState({ status: 'PENDING', createdAt: at, payload: { docId: 'd' } }).state, 'PENDING');
  assert.deepEqual([emailState({ status: 'FAILED', lastError: 'SMTP 550', payload: {} }).state, emailState({ status: 'FAILED', lastError: 'SMTP 550', payload: {} }).error], ['FAILED', 'SMTP 550']);
  assert.equal(emailState({ status: 'SKIPPED', lastError: NO_EMAIL, payload: {} }).state, 'NO_EMAIL');
  assert.equal(emailState({ status: 'SKIPPED', lastError: "belge FGO'da silindi", payload: {} }), null);
  assert.equal(emailState({ status: 'PENDING', payload: { manual: true } }).manual, true);
  assert.equal(emailState(null), null);
  assert.deepEqual([isEmail('a@b.ro'), isEmail(' a@b.ro '), isEmail('a@b'), isEmail(''), isEmail(null)], [true, true, false, false, false]);
});

test('uygulama içi bildirim: "Proforma este disponibilă." / "Factura este disponibilă." (müşteri), belge no ile', () => {
  assert.deepEqual(DOC_NOTICE, { PROFORMA: 'DOC_PROFORMA', ADVANCE: 'DOC_ADVANCE', INVOICE: 'DOC_INVOICE' });
  const p = renderInApp('ro', { type: 'DOC_PROFORMA', params: { aud: 'customer', orderNo: 'UMI7', ref: 'PRF12' } });
  assert.equal(p.title, 'Proforma este disponibilă.');
  assert.equal(p.body, 'Comanda UMI7 · document PRF12');
  assert.equal(renderInApp('ro', { type: 'DOC_INVOICE', params: { aud: 'customer', ref: 'GKH90' } }).title, 'Factura este disponibilă.');
  assert.equal(renderInApp('ro', { type: 'DOC_ADVANCE', params: { aud: 'customer', ref: 'GKH91' } }).title, 'Factura de avans este disponibilă.');
  assert.equal(renderInApp('tr', { type: 'DOC_INVOICE', params: { aud: 'customer', ref: 'GKH90' } }).title, 'Faturanız hazır.');
});

// Karar 115: mali belge e-postasının alıcısı — fatura e-postası, yoksa firmanın e-postası, yoksa "Email yok"
test('mali belge alıcısı: billingEmail → Customer.email → yok; geçersiz adres atlanır, kullanıcı e-postasına düşülmez', () => {
  assert.equal(financialRecipient({ email: 'office@client.ro', billingEmail: null }), 'office@client.ro');
  assert.equal(financialRecipient({ email: 'office@client.ro', billingEmail: 'facturi@client.ro' }), 'facturi@client.ro');
  assert.equal(financialRecipient({ email: null, billingEmail: ' facturi@client.ro ' }), 'facturi@client.ro');
  assert.equal(financialRecipient({ email: null, billingEmail: null }), null);
  assert.equal(financialRecipient({ email: '', billingEmail: '' }), null);
  // Geçersiz fatura e-postası güvenle atlanır: firmanın geçerli e-postasına düşer; o da geçersizse alıcı yok
  assert.equal(financialRecipient({ email: 'office@client.ro', billingEmail: 'adres-degil' }), 'office@client.ro');
  assert.equal(financialRecipient({ email: 'bozuk@', billingEmail: 'a b@c.ro' }), null);
  // Yalnızca bu iki alan okunur: firmaya bağlı kullanıcıların e-postaları alıcı olamaz
  assert.equal(financialRecipient({ email: null, billingEmail: null, users: [{ email: 'user@client.ro' }], contactPerson: 'x@y.ro' }), null);
  assert.equal(financialRecipient(null), null);
});
