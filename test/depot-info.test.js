// Profil proformasında depo konumu + iletişim kişileri (4.2.28 — ürün sahibi 26.11.2026; server/profile/depot-info.js).
// Bilgi YALNIZCA profil siparişinin proformasında yazılır: FGO belge e-postası, elle kesilen proformanın bildirim e-postası ve
// müşterinin uygulama içi bildirimi. Öbür bütün e-postalar / bildirimler aynen kalır (koruma testleri aşağıda).
// Veritabanıyla uçtan uca: test/db/profile.test.js (FGO proforma / fatura e-postası + bildirim), test/db/documents.test.js (cam).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEPOT_CONTACTS, DEPOT_MAPS_URL, depotHtml, depotRows, isProfileProforma, DEPOT_LABELS_RO, showDepotCard, telHref } from '../server/profile/depot-info.js';
import fs from 'node:fs';
import { renderDocEmail } from '../server/documents/delivery.js';
import { NOTIFY_RULES, renderNotification } from '../server/notifications/email.js';
import { renderInApp } from '../server/notifications/inapp.js';

const MARKERS = /google\.com\/maps|maps\.app\.goo\.gl|Adrian|Enis|723 344 443|750 492 221/;
const at = new Date('2026-11-26T09:00:00Z');
const profile = { id: 'o1', orderNo: 'GLAP12', orderTypeCode: 'PROFILE_ORDER', customer: { name: 'GLASSANDMORE SRL' } };
const glass = { ...profile, orderNo: 'GLA68', orderTypeCode: 'GLASS_ORDER' };
const mail = (type, order, recipient) => renderNotification({ type, order, createdAt: at, recipient, appUrl: 'https://takip.test', timeZone: 'Europe/Bucharest' });
const doc = (extra = {}) => renderDocEmail({ kind: 'PROFORMA', series: 'PRF', number: '552', issuedAt: at, orderNos: ['GLAP12'], total: '605.00', firmName: 'GLASSANDMORE SRL', attached: true, portalUrl: 'https://takip.test/belgeler', ...extra });

test('sabitler: Google Maps bağlantısı ve iki kişi (depo: Adrian, GKH: Enis)', () => {
  assert.match(DEPOT_MAPS_URL, /^https:\/\/(www\.google\.com\/maps|maps\.app\.goo\.gl)\//);
  assert.deepEqual(DEPOT_CONTACTS.map((c) => [c.key, c.name, c.phone]), [['depot', 'Adrian', '+40 723 344 443'], ['gkh', 'Enis', '+40 750 492 221']]);
  assert.deepEqual(depotRows(DEPOT_LABELS_RO), [
    ['Locație depozit', DEPOT_MAPS_URL], ['Contact depozit', 'Adrian: +40 723 344 443'], ['Contact GKH', 'Enis: +40 750 492 221'],
  ]);
  const html = depotHtml(DEPOT_LABELS_RO);
  assert.ok(html.includes(`href="${DEPOT_MAPS_URL.replace(/&/g, '&amp;')}"`), 'Maps bağlantısı tıklanabilir');
  assert.ok(html.includes('href="tel:+40723344443"') && html.includes('href="tel:+40750492221"'), 'telefonlar tıklanabilir');
});

test('kapsam kuralı: yalnızca PROFILE_ORDER + PROFORMA', () => {
  assert.equal(isProfileProforma({ orderTypeCode: 'PROFILE_ORDER', kind: 'PROFORMA' }), true);
  for (const x of [{ orderTypeCode: 'PROFILE_ORDER', kind: 'INVOICE' }, { orderTypeCode: 'PROFILE_ORDER', kind: 'ADVANCE' }, { orderTypeCode: 'GLASS_ORDER', kind: 'PROFORMA' }, { orderTypeCode: undefined, kind: 'PROFORMA' }]) {
    assert.equal(isProfileProforma(x), false, JSON.stringify(x));
  }
});

test('FGO belge e-postası: depot: true → bölüm eklenir; verilmezse e-posta BİREBİR eskisi gibi', () => {
  const on = doc({ depot: true });
  for (const s of [DEPOT_MAPS_URL, 'Contact depozit: Adrian: +40 723 344 443', 'Contact GKH: Enis: +40 750 492 221', 'Ridicare marfă — depozit']) assert.ok(on.text.includes(s), s);
  assert.ok(on.html.includes('data-depot-info') && on.html.includes('Deschide în Google Maps'));
  assert.ok(on.text.indexOf('Ridicare marfă') < on.text.indexOf('Cu stimă,'), 'imzadan önce');
  const off = doc();
  assert.deepEqual(off, doc({ depot: false }));
  assert.ok(!MARKERS.test(`${off.text} ${off.html}`), 'varsayılan: depo bilgisi yok');
  assert.equal(on.subject, off.subject, 'konu değişmez');
  // depo bölümü çıkarılınca metin aynen eskisi
  assert.equal(on.text.replace(/Ridicare marfă — depozit\n(?:.*\n){3}\n/, ''), off.text);
  for (const kind of ['INVOICE', 'ADVANCE']) assert.ok(!MARKERS.test(JSON.stringify(doc({ kind }))), kind);
});

test('elle kesilen profil proformasının bildirim e-postası (müşteri, tr + ro): depo bilgisi var', () => {
  for (const locale of ['tr', 'ro']) {
    const m = mail('ORDER_PROFORMA', profile, { locale, role: null });
    for (const s of [DEPOT_MAPS_URL, 'Adrian: +40 723 344 443', 'Enis: +40 750 492 221']) assert.ok(m.text.includes(s), `${locale}: ${s}`);
    assert.ok(m.html.includes('data-depot-info'));
    assert.equal(m.subject, `GLAP12 — ${locale === 'tr' ? 'Proforma kesildi' : 'Proformă emisă'}`, 'konu değişmez');
  }
  assert.match(mail('ORDER_PROFORMA', profile, { locale: 'tr', role: null }).text, /Depo konumu: https:/);
  assert.match(mail('ORDER_PROFORMA', profile, { locale: 'ro', role: null }).text, /Locație depozit: https:/);
});

test('koruma: başka hiçbir bildirim e-postası depo bilgisi taşımaz', () => {
  for (const type of Object.keys(NOTIFY_RULES)) {
    for (const order of [profile, glass]) {
      for (const recipient of [{ locale: 'tr', role: null }, { locale: 'ro', role: null }, { locale: 'tr', role: 'ADMIN' }, { locale: 'ro', role: 'SATIS' }]) {
        if (type === 'ORDER_PROFORMA' && order === profile && !recipient.role) continue;
        const m = mail(type, order, recipient);
        assert.ok(!MARKERS.test(`${m.text} ${m.html}`), `${type} ${order.orderTypeCode} ${recipient.role ?? 'müşteri'}`);
      }
    }
  }
});

test('uygulama içi: profil proforması bildirimi depo bilgisini taşır; öbür bildirimler değişmez', () => {
  const p = { aud: 'customer', orderNo: 'GLAP12' };
  const tr = renderInApp('tr', { type: 'ORDER_PROFORMA', params: p });
  const ro = renderInApp('ro', { type: 'ORDER_PROFORMA', params: p });
  assert.deepEqual(tr, { title: 'Proforma kesildi', body: `Sipariş GLAP12 · Depo konumu: ${DEPOT_MAPS_URL} · Depo iletişim: Adrian: +40 723 344 443 · GKH iletişim: Enis: +40 750 492 221` });
  assert.ok(ro.body.endsWith(`Locație depozit: ${DEPOT_MAPS_URL} · Contact depozit: Adrian: +40 723 344 443 · Contact GKH: Enis: +40 750 492 221`), ro.body);
  for (const type of ['ORDER_INVOICED', 'ORDER_PROFILE_OFFER_SENT', 'ORDER_PAID', 'ORDER_WAREHOUSE_SENT', 'ORDER_DELIVERED', 'ORDER_OFFER_SENT', 'ORDER_SHIP_DATE', 'DOC_PROFORMA', 'DOC_INVOICE', 'DOC_ADVANCE', 'ORDER_CREATED']) {
    for (const aud of ['customer', 'staff']) {
      for (const l of ['tr', 'ro']) assert.ok(!MARKERS.test(JSON.stringify(renderInApp(l, { type, params: { aud, orderNo: 'GLAP12', firm: 'GLA**********', day: '2026-11-27' } }))), `${type} ${aud} ${l}`);
    }
  }
});

test('sipariş sayfasındaki "Depo" kutusu: yalnızca müşteri, PROFORMA / DEPODA, iptal değil', () => {
  for (const stage of ['PROFORMA', 'DEPODA']) assert.equal(showDepotCard({ isCustomer: true, stage, cancelled: false }), true, stage);
  for (const stage of ['FIYAT_BEKLIYOR', 'TEKLIF_GONDERILDI', 'ONAYLANDI', 'TESLIM_EDILDI', 'FATURALANDI', null, undefined]) {
    assert.equal(showDepotCard({ isCustomer: true, stage, cancelled: false }), false, String(stage));
  }
  assert.equal(showDepotCard({ isCustomer: true, stage: 'PROFORMA', cancelled: true }), false, 'iptal');
  assert.equal(showDepotCard({ isCustomer: false, stage: 'PROFORMA', cancelled: false }), false, 'iç ekip');
  assert.deepEqual(DEPOT_CONTACTS.map((c) => telHref(c.phone)), ['tel:+40723344443', 'tel:+40750492221']);
  // Yapı: kutu yalnızca profil sipariş sayfasında, aynı kural ve aynı kaynakla; tıklanabilir harita ve telefon
  const page = fs.readFileSync(new URL('../app/(panel)/siparisler/[id]/ProfileOrderView.tsx', import.meta.url), 'utf8');
  assert.match(page, /showDepotCard\(\{ isCustomer, stage, cancelled \}\) && \(/);
  assert.match(page, /href=\{DEPOT_MAPS_URL\}/);
  assert.match(page, /href=\{telHref\(c\.phone\)\}/);
  const glassPage = fs.readFileSync(new URL('../app/(panel)/siparisler/[id]/page.tsx', import.meta.url), 'utf8');
  assert.ok(!/depot-info/.test(glassPage), 'cam sipariş sayfası değişmedi');
});
