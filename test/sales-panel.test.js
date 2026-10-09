// Satış paneli düzeltme paketi 1 (3.62.0, 3.62.1): satışın sandık parası (karar 211, 214 — yöneticinin tablosuyla aynı düzen:
// bağımsız, numaralı kalem), "Yöneticiye göndermeyi geri al" (karar 212), uzun teklif tablosunda ↑ / ↓ her durumda (karar
// 213), sipariş sayfasında Sipariş Bilgileri → Teklif Tablosu → Teknik Çizim ve Onaylar (karar 214). Saf kurallar + yapı
// denetimi (veritabanıyla: test/db/sales-panel.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CRATE_LINE, EVENTS, atOfferPrice, availableActions, isCrateLine, isSalesCrate, offerProblems, offerSubmitter, offerTotals,
} from '../server/orders/rules.js';
import { glassTotals, invoiceLines, proformaLines } from '../server/glass/billing.js';
import { offerExportData } from '../server/orders/offer-export.js';
import { STAFF_EVENT_POLICY, eventsFor } from '../server/orders/order-view.js';
import { formatOfferProblems } from '../server/i18n/format.js';
import { DICTS } from '../server/i18n/index.js';

const src = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
// 1000 × 500 mm × 2 = 1 m²
const glass = (extra = {}) => ({ id: 'g1', kind: 'CAM', unit: 'm2', description: 'Cam', descriptionRo: 'Sticlă', enMm: 1000, boyMm: 500, adet: 2, unitPrice: '40', offerPrice: '50', free: false, crateFee: false, ...extra });
const cnc = (extra = {}) => ({ id: 'c1', kind: 'CNC', unit: 'adet', description: '', adet: 1, unitPrice: '10', offerPrice: '15', free: false, crateFee: false, ...extra });
const salesCrate = (extra = {}) => ({ id: 's1', kind: 'CAM', unit: 'adet', description: CRATE_LINE.tr, descriptionRo: CRATE_LINE.ro, enMm: null, boyMm: null, adet: 2, unitPrice: '25', offerPrice: '30', free: false, crateFee: false, ...extra });
const adminCrate = (extra = {}) => ({ ...salesCrate({ id: 'a1', adet: 1, unitPrice: '0', offerPrice: '45', crateFee: true }), ...extra });
const plain = (lines) => lines.map((l) => ({ ...l, unitPrice: String(l.unitPrice), offerPrice: l.offerPrice == null ? null : String(l.offerPrice) }));

test('sandık satırı: satışın sandık ücreti ile yöneticinin sandık bedeli ayrılır; adetli olmayan / başka adlı satır sandık değildir', () => {
  assert.equal(isCrateLine(salesCrate()), true);
  assert.equal(isSalesCrate(salesCrate()), true);
  assert.equal(isCrateLine(adminCrate()), true);
  assert.equal(isSalesCrate(adminCrate()), false, 'yöneticinin sandık bedeli satışın değil');
  for (const description of [CRATE_LINE.ro, ' sandık  PARASI ']) assert.equal(isSalesCrate(salesCrate({ description })), true, description);
  assert.equal(isSalesCrate(salesCrate({ unit: 'm2' })), false, 'm² satırı sandık ücreti değil');
  assert.equal(isSalesCrate(salesCrate({ kind: 'CNC' })), false);
  assert.equal(isSalesCrate(salesCrate({ description: 'Ek cam' })), false);
  assert.equal(isSalesCrate(glass()), false);
});

test('toplamlar: sandık ücreti tutara BİR kez girer, cam adedine girmez (offerTotals.crate); müşteri ve satış tutarı', () => {
  const lines = plain([glass(), cnc(), salesCrate(), glass({ id: 'g2', adet: 4 }), adminCrate()]);
  // satış: 1 m² × 40 + 10 + 2 × 25 + 2 m² × 40 + 1 × 0 = 180 · müşteri: 50 + 15 + 60 + 100 + 45 = 270
  assert.deepEqual(offerTotals(lines), { metraj: 3, amount: 180, adet: 6, cnc: 1, delik: 0, crate: 3 });
  assert.equal(offerTotals(atOfferPrice(lines)).amount, 270);
  // satışın gördüğü teklif: yöneticinin sandık bedeli yok (lib/orders.ts → offerPrices süzer)
  assert.deepEqual(offerTotals(lines.filter((l) => !l.crateFee)), { metraj: 3, amount: 180, adet: 6, cnc: 1, delik: 0, crate: 2 });
});

test('belgeler: sandık parası faturada ve yükleme dökümünde camın tutarına eklenir, proformada ayrı adetli satır (ürün sahibinin kararı); iki kez sayılmaz', () => {
  const offer = { lines: plain([glass(), cnc(), salesCrate(), glass({ id: 'g2', description: 'Temper', descriptionRo: 'Securizat', adet: 4, offerPrice: '20' })]) };
  const customerTotal = offerTotals(atOfferPrice(offer.lines)).amount; // 50 + 15 + 60 + 40 = 165
  assert.equal(customerTotal, 165);
  // Fatura: sandık (2 × 30) ve CNC (15) birinci camın grubunda; ikinci cam yalnızca kendi tutarı
  const totals = glassTotals(offer);
  assert.deepEqual(totals.map((g) => [g.name, g.total]), [['Sticlă', 125], ['Securizat', 40]]);
  assert.equal(totals.reduce((s, g) => s + g.total, 0), customerTotal, 'fatura toplamı = teklifin müşteri toplamı');
  // RON fatura satırları: aynı parçalardan (kur 5, TVA 21) — toplam tek kez
  const inv = invoiceLines(offer, 5, 21);
  assert.equal(inv.reduce((s, l) => s + l.net, 0), 825);
  // Proforma: sandık ayrı adetli satır (Romence adıyla), CNC gibi — ürün sahibinin kararı (karar 214): proforma değişmedi
  const pro = proformaLines(offer);
  assert.deepEqual(pro.map((r) => [r.name, r.qty, r.eur]), [['Sticlă', 1, 50], ['Prelucrare CNC', 1, 15], [CRATE_LINE.ro, 2, 30], ['Securizat', 2, 20]]);
  assert.equal(Math.round(pro.reduce((s, r) => s + r.qty * r.eur, 0) * 100) / 100, customerTotal);
});

test('teklif eksikleri: sandık parası (satışın ya da yöneticinin) bağımsız, numaralı kalem — "n. satır (Sandık parası)"', () => {
  const lines = plain([glass(), salesCrate({ unitPrice: '' }), glass({ id: 'g2', description: 'Temper', unitPrice: '' })]);
  const p = offerProblems(lines);
  assert.deepEqual(p, [{ code: 'missing_prices', rows: [{ n: 2, kind: 'CAM', desc: CRATE_LINE.tr }, { n: 3, kind: 'CAM', desc: 'Temper' }] }]);
  assert.match(formatOfferProblems(p, { offerProblems: DICTS.tr.offerProblems, lineKind: DICTS.tr.status.lineKind })[0], /2\. satır \(Sandık parası\), 3\. satır \(Temper\)/);
  assert.match(formatOfferProblems(p, { offerProblems: DICTS.ro.offerProblems, lineKind: DICTS.ro.status.lineKind })[0], /rândul 2 \(Sandık parası\), rândul 3 \(Temper\)/);
  // Yöneticinin sandık bedeli de aynı düzende
  assert.deepEqual(offerProblems(plain([glass(), adminCrate({ unitPrice: '' })])), [{ code: 'missing_prices', rows: [{ n: 2, kind: 'CAM', desc: CRATE_LINE.tr }] }]);
  // İşlem sahipliği değişmedi
  assert.deepEqual(offerProblems(plain([glass({ adet: 1 }), cnc(), salesCrate()])), []);
  // "n. Sandık" satır türü artık yok (karar 214): sözlükte de yok
  for (const d of [DICTS.tr, DICTS.ro]) assert.equal(Object.hasOwn(d.status.lineKind, 'SANDIK'), false);
});

test('teklif PDF / Excel verisi: sandık parası (satışın ve yöneticinin) ekrandaki gibi numaralı, girintisiz kalem', () => {
  const data = offerExportData({ lines: plain([glass(), salesCrate(), glass({ id: 'g2' }), adminCrate()]), price: (l) => l.offerPrice, locale: 'tr', kindLabel: (k) => k });
  assert.deepEqual(data.rows.map((r) => [r.n, r.sub, r.desc, r.unit, r.amount]), [
    [1, false, 'Cam', 'm2', 50], [2, false, CRATE_LINE.tr, 'adet', 60], [3, false, 'Cam', 'm2', 50], [4, false, CRATE_LINE.tr, 'adet', 45],
  ]);
  assert.equal(data.total, 205);
});

test('geri alma (karar 212): yalnızca satış, teklif yöneticideyken; yönetici, müşteri, çizim, denetimci hiçbir durumda; beklemede yok', () => {
  const can = (p) => availableActions({ status: 'HAZIRLANIYOR', drawing: 'YOK', ...p }).includes('withdraw_offer');
  for (const drawing of ['YOK', 'GEREKLI', 'ONAY_BEKLIYOR', 'ONAYLANDI']) assert.equal(can({ role: 'SATIS', offer: 'YONETIMDE', drawing }), true, drawing);
  for (const offer of [null, 'HAZIRLANIYOR', 'GONDERILDI']) assert.equal(can({ role: 'SATIS', offer }), false, String(offer));
  for (const role of ['ADMIN', 'MUSTERI', 'CIZIM', 'DENETIMCI']) assert.equal(can({ role, offer: 'YONETIMDE', canApprove: true }), false, role);
  assert.equal(can({ role: 'SATIS', offer: 'YONETIMDE', onHold: true }), false, 'beklemede');
  for (const status of ['YENI', 'URETIMDE', 'YUKLENDI', 'ARSIVLENDI', 'IPTAL']) assert.equal(can({ role: 'SATIS', offer: 'YONETIMDE', status }), false, status);
  // Yöneticinin fiyat onayı / geri gönderme hakları değişmedi; satış yöneticideki teklifi düzenleyemez / gönderemez
  const admin = availableActions({ role: 'ADMIN', status: 'HAZIRLANIYOR', offer: 'YONETIMDE' });
  assert.ok(admin.includes('approve_price') && admin.includes('return_offer'));
  const sales = availableActions({ role: 'SATIS', status: 'HAZIRLANIYOR', offer: 'YONETIMDE' });
  assert.ok(!sales.includes('edit_offer') && !sales.includes('submit_offer') && !sales.includes('approve_price'));
});

test('teklifi gönderen: son OFFER_SUBMITTED olayının kullanıcısı (olaylar en yeniden eskiye)', () => {
  const ev = (event, userId) => ({ event, userId });
  assert.equal(offerSubmitter([ev('OFFER_WITHDRAWN', 'a'), ev('OFFER_SUBMITTED', 'b'), ev('OFFER_SUBMITTED', 'c')]), 'b');
  assert.equal(offerSubmitter([ev('OFFER_RETURNED', 'adm'), ev('CREATED', 'cust')]), null);
  assert.equal(offerSubmitter([]), null);
});

test('geçmiş: OFFER_WITHDRAWN müşteriye kapalı; iç ekipte satır görünür (fiyatlandırma hattı politikası)', () => {
  assert.equal(EVENTS.OFFER_WITHDRAWN?.customer, false);
  assert.deepEqual(STAFF_EVENT_POLICY.OFFER_WITHDRAWN, STAFF_EVENT_POLICY.OFFER_SUBMITTED);
  const events = [{ event: 'OFFER_WITHDRAWN', note: null, user: { name: 'Satış', email: 's@x.test', appRole: 'SATIS', type: 'INTERNAL' } }];
  assert.equal(eventsFor('MUSTERI', events).length, 0);
  for (const role of ['ADMIN', 'SATIS', 'CIZIM', 'DENETIMCI']) assert.equal(eventsFor(role, events).length, 1, role);
  for (const d of [DICTS.tr, DICTS.ro]) {
    assert.ok(d.events.OFFER_WITHDRAWN.label);
    assert.ok(d.order.ok.offer_withdrawn && d.order.errors.offerNotOwner && d.offer.view.withdraw && d.offer.view.withdrawConfirm);
    assert.ok(d.offer.editor.addCrate && d.offer.editor.salesCrateAdminBadge && d.offer.editor.countCrates);
    // Cam satırı altındaki "+Sandık" ve satıştaki "Sandık" rozeti kaldırıldı (karar 214)
    assert.equal(Object.hasOwn(d.offer.editor, 'addSalesCrate') || Object.hasOwn(d.offer.editor, 'salesCrateBadge'), false);
  }
  assert.equal(DICTS.tr.offer.view.withdraw, 'Yöneticiye göndermeyi geri al');
});

test('yapı: sandık sahipliği sunucuda; geri alma tek işlemde (gönderen, durum, sürüm); ↑ / ↓ salt okunur teklifte de', () => {
  const tr = src('server/orders/transitions.js');
  // Satış yöneticinin sandık satırına dokunamaz; satışın sandık ücreti işaretsiz yazılır; satır sahibi değişmez
  assert.match(tr, /if \(l\.id && crateIds\.has\(l\.id\)\) throw new WorkflowError\('CRATE_FEE_ADMIN'\)/);
  assert.match(tr, /crateFee: false, \.\.\.\(crate \? \{ unit: 'adet', enMm: null, boyMm: null, splitGroup: null \} : \{\}\)/);
  assert.match(tr, /own \? !!own\.crateFee : !!l\.crateFee \|\| isCrateText\(l\.description\)/);
  // Geri alma: gönderen satışçı, koşullu durum güncellemesi, açık uyarılar kapanır, geçmiş + denetim
  const w = tr.slice(tr.indexOf('async withdraw_offer(h)'), tr.indexOf('async update_offer(h)'));
  assert.match(w, /event: 'OFFER_SUBMITTED'/);
  assert.match(w, /WorkflowError\('OFFER_NOT_OWNER'\)/);
  assert.match(w, /offer\.updateMany\(\{ where: \{ id: offer\.id, status: 'YONETIMDE' \}/);
  assert.match(w, /WorkflowError\('CONFLICT'\)/);
  assert.match(w, /h\.event\('OFFER_WITHDRAWN'\)/);
  assert.match(tr, /withdraw_offer: \['withdraw_offer'\]/);
  // Eylem sayfada yalnızca gönderene; işlem sipariş sürümüyle çağrılır
  const page = src('app/(panel)/siparisler/[id]/page.tsx');
  assert.match(page, /can\('withdraw_offer'\) && !!user\.id && offerSubmitter\(order\.events\) === user\.id/);
  assert.match(page, /<form action=\{withdrawOfferAction\}/);
  const act = src('app/(panel)/siparisler/[id]/actions.ts');
  assert.match(act, /act\(user, id, 'withdraw_offer', \{ expectedVersion: expectedVersion\(formData\) \}\)/);
  // Satışın gördüğü teklif: yöneticinin sandık bedeli satışa hiç gitmez (değişmedi)
  assert.match(src('lib/orders.ts'), /o\.lines\.filter\(\(l\) => !l\.crateFee\)\.map\(\(l\) => \(\{ \.\.\.l, offerPrice: null \}\)\)/);
  // ↑ / ↓: düzenlenebilir ve salt okunur teklif tablosu aynı bileşen, aynı hedef
  assert.match(page, /<div className="table-wrap offer-wrap" id="offer-table">/);
  assert.match(page, /<TableJump targetId="offer-table" up=\{t\('offer\.import\.jumpTop'\)\} down=\{t\('offer\.import\.jumpBottom'\)\} \/>/);
  assert.match(src('app/(panel)/siparisler/[id]/OfferEditor.tsx'), /<TableJump targetId="offer-table"/);
  const jump = src('components/TableJump.tsx');
  assert.match(jump, /document\.querySelector\('\.topbar'\)/);
  assert.match(jump, /window\.scrollTo\(/);
  // "+ Sandık parası" (karar 214): satışta ve yöneticide tablonun altındaki araç çubuğunda, "+ Cam ekle"nin hemen yanında;
  // cam satırının altında sandık düğmesi yok. Satışınki satışın satırını, yöneticininki yöneticinin (gizli) satırını ekler.
  const ed = src('app/(panel)/siparisler/[id]/OfferEditor.tsx');
  const tools = ed.slice(ed.indexOf('<div className="offer-tools">'), ed.indexOf('<TableJump'));
  assert.match(tools, /\+ \{m\.editor\.addGlass\}<\/button>\s*\{adminMode && <button type="button" className="btn" onClick=\{addCrate\}>\+ \{m\.editor\.addCrate\}<\/button>\}[\s\S]{0,200}\{!adminMode && <button type="button" className="btn" data-add-sales-crate onClick=\{addSalesCrate\}>\+ \{m\.editor\.addCrate\}<\/button>\}/);
  assert.equal((ed.match(/addSalesCrate/g) ?? []).length, 2, 'tanım + araç çubuğundaki tek düğme');
  assert.doesNotMatch(ed, /addSalesCrate\(l\.key\)|blockEnd/);
  // Satışın sandık parası numaralı kalemdir (yöneticinin satırı gibi): numara yalnızca CNC / delik satırında atlanır
  assert.match(ed, /if \(!sub\) glassNo \+= 1;/);
  assert.match(ed, /readOnly=\{sc\}/);
  assert.match(page, /if \(!sub\) n \+= 1;/);
});

test('sipariş sayfası (karar 214): Sipariş Bilgileri → Teklif Tablosu → Teknik Çizim ve Onaylar; çizim ekibinin ekranı değişmedi', () => {
  const page = src('app/(panel)/siparisler/[id]/page.tsx');
  const main = page.slice(page.indexOf('export default async function OrderPage'), page.indexOf('function History('));
  const at = (needle) => { const i = main.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  // Yönetici, satış, müşteri, denetimci: bilgiler → teklif (düzenleme / görünüm; altında özel durum ve telafi formu) → çizim
  assert.ok(at('<OrderInfo') < at('<OfferEditor') && at('<OfferEditor') < at('<OfferView '));
  assert.ok(at('<OfferView ') < at('{guestHost}') && at('{guestHost}') < at('<CompensationForm'));
  assert.ok(at('<CompensationForm') < at('{!drawerView && <Drawings ') && at('{!drawerView && <Drawings ') < at('{canComp && <Decisions'));
  assert.equal(main.split('<Drawings ').length - 1, 1, 'çizim kartı bir kez');
  // Çizim ekibi: müşteri dosyaları → çizim dosyaları → onay / revizyon → notlar → sipariş bilgileri (karar 169; değişmedi)
  assert.ok(at('{drawerView && <Files ') < at('{drawerView && <DrawingFiles ') && at('{drawerView && <DrawingFiles ') < at('{drawerView && <DrawingReview '));
  assert.ok(at('{drawerView && <DrawingReview ') < at('\n      {notesCard}\n') && at('\n      {notesCard}\n') < at('<OrderInfo'));
  // Görünürlük kuralları aynı: çizim kartı çizimi olmayan siparişte yok; teklif görünümü / düzenleyici koşulları değişmedi
  assert.match(page, /if \(order\.drawingTrack === 'YOK' && order\.drawings\.length === 0\) return null;/);
  assert.match(page, /const shownOffer = !userCan\(user, 'OFFER_VIEW'\) \? undefined : isCustomer \? sent : editable \|\| updating \? undefined : offer;/);
});
