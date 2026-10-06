// Kişi kimliği ve olay geçmişinin role göre görünümü (güvenlik denetimi 3.50.9 AUD-1, AUD-2; karar 139).
// Sipariş nesnesi İÇ İÇE taranır (her alan, her dizi öğesi, her metin): ekranda görünmese de istemciye giden veride gizli
// bilgi olmamalı. Eski biçimde yazılmış geçmiş satırları (alıcı e-postası, satış tutarı, ham FGO hatası) okurken korunur.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { STAFF_EVENT_POLICY, UNKNOWN_EVENT_POLICY, eventsFor, isCustomerPerson, orderPeopleView, personView } from '../server/orders/order-view.js';
import { EVENTS } from '../server/orders/rules.js';
import { orderScope } from '../server/orders/scope.js';
import { customerView } from '../server/orders/customer-view.js';
import { notesFor } from '../server/notes/view.js';
import { ROLES, can } from '../server/auth/permissions.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/**
 * İç içe tarama: değerin içinde (anahtarlar dahil, her derinlikte) iğnelerden biri geçen her yolu döndürür.
 * @param {unknown} value  @param {string[]} needles  @returns {string[]}
 */
export function deepLeaks(value, needles, at = '$', seen = new Set()) {
  const out = [];
  const check = (s, where) => { for (const n of needles) if (s.toLowerCase().includes(n.toLowerCase())) out.push(`${where}: ${n}`); };
  if (value == null) return out;
  if (typeof value === 'string') { check(value, at); return out; }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') { check(String(value), at); return out; }
  if (value instanceof Date) return out;
  if (typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) value.forEach((v, i) => out.push(...deepLeaks(v, needles, `${at}[${i}]`, seen)));
  else for (const [k, v] of Object.entries(value)) { check(k, `${at}.<key>`); out.push(...deepLeaks(v, needles, `${at}.${k}`, seen)); }
  return out;
}

// --- deneme siparişi: müşteri firması GLASSANDMORE; müşteri kişileri (biri adsız: ekranda e-postaya düşülürdü) ---
const FIRM = { id: 'c1', name: 'GLASSANDMORE SRL', prefix: 'GLA', email: 'office@glassandmore.ro', billingEmail: 'facturi@glassandmore.ro', contactPerson: 'Darius Pop', phone: '+40 700 111 222' };
const ION = { name: 'Ion Popescu', email: 'ion@glassandmore.ro', appRole: 'MUSTERI', type: 'CUSTOMER' };
const NONAME = { name: null, email: 'comenzi@glassandmore.ro', appRole: 'MUSTERI', type: 'CUSTOMER' };
const SALES = { name: 'Satış Kişi', email: 'satis@gkh.test', appRole: 'SATIS', type: 'INTERNAL' };
const ADMIN = { name: 'Yönetici', email: 'admin@gkh.test', appRole: 'ADMIN', type: 'INTERNAL' };
const DRAWER = { name: 'Çizim Kişi', email: 'cizim@gkh.test', appRole: 'CIZIM', type: 'INTERNAL' };
const SALES_TOTAL = '12345.67 EUR';
const FGO_RAW = 'Clientul GLASSANDMORE SRL CUI RO998877 invalid';

/** Eski (yayından önce yazılmış) biçimde olay satırları dahil */
function order() {
  return {
    id: 'o1', orderNo: 'GLA68', customerId: 'c1', customer: { ...FIRM },
    createdBy: { ...NONAME },
    files: [
      { id: 'f1', name: 'olcu.pdf', kind: 'CUSTOMER', uploadedById: 'u-ion', uploadedBy: { ...ION } },
      { id: 'f2', name: 'ic.pdf', kind: 'INTERNAL', uploadedById: 'u-s', uploadedBy: { ...SALES } },
    ],
    drawings: [{
      id: 'd1', version: 1, status: 'ONAYLANDI', uploadedBy: { ...DRAWER }, sentBy: { name: DRAWER.name, appRole: 'CIZIM', type: 'INTERNAL' },
      decidedBy: { name: ION.name, appRole: 'MUSTERI', type: 'CUSTOMER' }, files: [],
    }],
    notes: [
      { id: 'n1', internal: false, text: 'Teşekkürler', user: { ...NONAME }, translation: null, translationLang: null, translationStatus: null, translationError: null, translationAt: null },
      { id: 'n2', internal: false, text: 'Merhaba', user: { ...ION }, translation: null, translationLang: null, translationStatus: null, translationError: null, translationAt: null },
      { id: 'n3', internal: true, text: 'iç not', user: { ...SALES }, translation: null, translationLang: null, translationStatus: null, translationError: null, translationAt: null },
    ],
    events: [
      { id: 'e1', event: 'CREATED', note: null, user: { ...NONAME } },
      { id: 'e2', event: 'REVISION_REQUESTED', note: 'Lütfen düzeltin — ion@glassandmore.ro', user: { ...ION } },
      { id: 'e3', event: 'DRAWING_APPROVED', note: 'v1', user: { ...ION } },
      // eski satırlar: satış tutarı, alıcı e-postası, ham FGO hata metni, belge no, eski / bilinmeyen olaylar
      { id: 'e4', event: 'OFFER_SUBMITTED', note: SALES_TOTAL, user: { ...SALES } },
      { id: 'e5', event: 'FGO_DOC_EMAILED', note: 'PRF123 → facturi@glassandmore.ro', user: null },
      { id: 'e6', event: 'FGO_DOC_ISSUED', note: 'PROFORMA:PRF123', user: null },
      { id: 'e7', event: 'FGO_FAILED', note: `PROFORMA: ${FGO_RAW}`, user: null },
      { id: 'e8', event: 'FGO_DOC_REQUESTED', note: 'PROFORMA', user: { ...ADMIN } },
      { id: 'e9', event: 'GLASS_PAID', note: '500.00 EUR', user: { ...ADMIN } },
      { id: 'e10', event: 'SOME_FUTURE_EVENT', note: 'gizli', user: { ...ADMIN } },
      { id: 'e11', event: 'COST_CORRECTED', note: 'Float 4 mm', user: { ...ADMIN } },
      { id: 'e12', event: 'HOLD', note: 'müşteri arayacak', user: { ...SALES } },
      { id: 'e13', event: 'OFFER_SENT', note: null, user: { ...ADMIN } },
    ],
  };
}

/** sanitizeOrder'ın kimlik / geçmiş adımları (müşteri alanı customerView, notlar notesFor ile — lib/orders.ts'teki sırayla) */
const view = (role) => {
  const o = order();
  return orderPeopleView(role, { ...o, customer: customerView(role, o.customer), notes: notesFor(role, o.notes) });
};
const ids = (o) => o.events.map((e) => e.event);

/** Müşterinin kimliğini (dolaylı yoldan da) ele veren her şey */
const IDENTITY = ['GLASSANDMORE', 'glassandmore.ro', 'Ion Popescu', 'comenzi@', 'Darius Pop', '+40 700'];

test('satış ve çizim: siparişin HİÇBİR iç içe alanında müşteri firması / müşteri kişisi kimliği yok (ad, e-posta, fatura alıcısı, FGO metni)', () => {
  for (const role of ['SATIS', 'CIZIM']) {
    const o = view(role);
    assert.deepEqual(deepLeaks(o, IDENTITY), [], role);
    // Maskelenmiş kişi yalnızca rolünü taşır; e-postaya düşülemez (alan boş)
    for (const u of [o.createdBy, o.files[0].uploadedBy, o.drawings[0].decidedBy, o.notes[0].user, o.notes[1].user, o.events.find((e) => e.event === 'CREATED').user]) {
      assert.equal(u.name, null, role);
      assert.ok(!u.email, role);
      assert.equal(u.appRole, 'MUSTERI', role);
    }
    // İç ekibin kişileri olduğu gibi
    assert.equal(o.files[1].uploadedBy.name, 'Satış Kişi');
    assert.equal(o.drawings[0].sentBy.name, 'Çizim Kişi');
    // Müşterinin serbest metnindeki e-posta da olay notunda silinir
    assert.equal(o.events.find((e) => e.event === 'REVISION_REQUESTED').note, 'Lütfen düzeltin — ***');
  }
});

test('çizim ve denetimci: satış (maliyet) tutarı olay geçmişinden alınamaz; satış ve yönetici kendi tutarını görür (eski satır)', () => {
  for (const role of ['CIZIM', 'DENETIMCI']) {
    const o = view(role);
    assert.deepEqual(deepLeaks(o.events, ['12345', '500.00']), [], role);
    assert.ok(ids(o).includes('OFFER_SUBMITTED'), `${role}: olay görünür, notu yok`);
  }
  assert.equal(view('SATIS').events.find((e) => e.event === 'OFFER_SUBMITTED').note, SALES_TOTAL);
  assert.equal(view('ADMIN').events.find((e) => e.event === 'OFFER_SUBMITTED').note, SALES_TOTAL);
});

test('FGO / muhasebe olayları: alıcı e-postası ve ham FGO hatası yalnızca yöneticide; denetimci belgenin varlığını görür, ayrıntısını değil', () => {
  for (const role of ['SATIS', 'CIZIM']) {
    const o = view(role);
    assert.deepEqual(ids(o).filter((e) => e.startsWith('FGO_') || ['GLASS_PAID', 'COST_CORRECTED', 'SOME_FUTURE_EVENT'].includes(e)), [], role);
    assert.deepEqual(deepLeaks(o, ['facturi@', 'PRF123', 'RO998877', 'gizli']), [], role);
  }
  const insp = view('DENETIMCI');
  assert.deepEqual(ids(insp).filter((e) => e.startsWith('FGO_')).sort(), ['FGO_DOC_EMAILED', 'FGO_DOC_ISSUED']);
  for (const e of insp.events.filter((x) => x.event.startsWith('FGO_'))) assert.equal(e.note, null);
  assert.deepEqual(deepLeaks(insp.events, ['facturi@', 'RO998877', 'gizli', 'Float 4 mm']), []);
  // Denetimci firma adını görür (karar 11): kimlik maskelenmez
  assert.equal(insp.customer.name, FIRM.name);
  assert.equal(insp.events.find((e) => e.event === 'CREATED').user.email, NONAME.email);

  const admin = view('ADMIN');
  assert.deepEqual(ids(admin), ids(order()), 'yönetici her olayı görür');
  assert.equal(admin.events.find((e) => e.event === 'FGO_DOC_EMAILED').note, 'PRF123 → facturi@glassandmore.ro');
  assert.equal(admin.events.find((e) => e.event === 'FGO_FAILED').note, `PROFORMA: ${FGO_RAW}`);
  assert.equal(admin.createdBy.email, NONAME.email);
  assert.equal(admin.notes[1].user.name, 'Ion Popescu');
});

test('müşteri: kendi bilgilerini görür; geçmişte yalnızca müşteriye açık olaylar, işlemi yapan kişi yok, iç not / FGO / tutar yok', () => {
  const o = view('MUSTERI');
  assert.equal(o.customer.name, FIRM.name);
  assert.equal(o.notes.find((n) => n.id === 'n2').user.name, 'Ion Popescu', 'kendi kişileri görünür');
  assert.deepEqual(ids(o), ['CREATED', 'REVISION_REQUESTED', 'DRAWING_APPROVED', 'OFFER_SENT']);
  for (const e of o.events) assert.equal(e.user, null);
  assert.equal(o.events.find((e) => e.event === 'REVISION_REQUESTED').note, 'Lütfen düzeltin — ion@glassandmore.ro', 'kendi notu aynen');
  assert.deepEqual(deepLeaks(o.events, [SALES_TOTAL, 'PRF123', FGO_RAW, 'müşteri arayacak', 'satis@gkh.test']), []);
  assert.ok(!o.notes.some((n) => n.internal));
});

test('olay politikası: müşteriye açık her olayın iç ekip kuralı var; tabloda olmayan olay yalnızca muhasebe yetkisine', () => {
  for (const e of Object.keys(EVENTS)) assert.ok(STAFF_EVENT_POLICY[e], `politika eksik: ${e}`);
  assert.deepEqual(UNKNOWN_EVENT_POLICY, { row: 'ACCOUNTING_MANAGE', note: 'ACCOUNTING_MANAGE' });
  // Uygulamanın geçmişe yazdığı her olay kodu tabloda (yeni bir olay yazan kod eklenince bu test hatırlatır)
  const written = new Set();
  const walk = (dir) => {
    for (const f of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(js|ts|tsx)$/.test(f.name)) {
        for (const m of read(p).matchAll(/h\.event\('([A-Z_]+)'|event: '([A-Z_]+)'|event: [\w.]+ \? '([A-Z_]+)' : '([A-Z_]+)'/g)) for (const g of m.slice(1)) if (g) written.add(g);
      }
    }
  };
  for (const d of ['server', 'app', 'lib']) walk(d);
  assert.ok(written.size > 40, `bulunan olay kodu: ${written.size}`);
  assert.deepEqual([...written].filter((e) => !STAFF_EVENT_POLICY[e]).sort(), []);
});

test('kişi kuralı: firma adını gören roller değişmeden; rol / tür bilgisi olmayan kişi maskelenir (bilinmiyorsa kapalı)', () => {
  for (const role of ROLES) {
    const masked = personView(role, { ...ION });
    if (can(role, 'CUSTOMER_NAME_VIEW')) assert.deepEqual(masked, ION, role);
    else assert.deepEqual(masked, { name: null, email: '', appRole: 'MUSTERI', type: 'CUSTOMER' }, role);
    assert.deepEqual(personView(role, { ...SALES }), SALES, `${role}: iç ekip kişisi değişmez`);
  }
  assert.equal(isCustomerPerson({ name: 'x', email: 'x@y.z' }), true);
  assert.equal(isCustomerPerson({ name: 'x', appRole: 'ADMIN' }), false);
  assert.equal(personView('SATIS', null), null);
});

test('yetki ve müşteri A / B ayrımı değişmedi: kapsam kuralı aynı', () => {
  assert.deepEqual(orderScope({ appRole: 'MUSTERI', customerId: 'A' }), { removedAt: null, customerId: 'A' });
  assert.deepEqual(orderScope({ appRole: 'MUSTERI', customerId: null }), { removedAt: null, customerId: '__none__' });
  assert.deepEqual(orderScope({ appRole: 'SATIS' }), { removedAt: null, orderType: { usesSales: true } });
  assert.deepEqual(orderScope({ appRole: 'CIZIM' }), { removedAt: null, drawingTrack: { not: 'YOK' }, orderType: { usesDrawing: true } });
  assert.deepEqual(orderScope({ appRole: 'ADMIN' }), { removedAt: null });
  // Görünüm işlevi siparişi / müşteriyi değiştirmez (yalnızca kişi ve geçmiş alanları)
  const o = view('SATIS');
  assert.deepEqual([o.id, o.customerId, o.orderNo, o.customer.name], ['o1', 'c1', 'GLA68', 'GLA**********']);
  assert.deepEqual(eventsFor('SATIS', []), []);
});

test('yapı: sanitizeOrder kişi / geçmiş kuralını uygular; kişi ilişkileri rol ve tür taşır; sayfa e-postaya düşmez; yeni notlar e-posta / tutar yazmaz', () => {
  const lib = read('lib/orders.ts');
  assert.match(lib, /return orderPeopleView\(user\.appRole, \{/);
  assert.match(lib, /const PERSON = \{ name: true, email: true, appRole: true, type: true \} as const;/);
  for (const rel of ['uploadedBy: \\{ select: PERSON \\}', 'user: \\{ select: PERSON \\}', 'createdBy: \\{ select: PERSON \\}']) assert.match(lib, new RegExp(rel));
  assert.match(lib, /decidedBy: \{ select: \{ name: true, appRole: true, type: true \} \}/);
  assert.doesNotMatch(lib, /select: \{ name: true, email: true \} \}/, 'rol / tür olmadan kişi seçilmez');
  const page = read('app/(panel)/siparisler/[id]/page.tsx');
  assert.doesNotMatch(page, /(e|n)\.user\.name \|\| (e|n)\.user\.email/);
  assert.doesNotMatch(page, /decidedBy\?\.name/);
  assert.match(read('server/documents/delivery.js'), /event: 'FGO_DOC_EMAILED', actorId: null, note: `\$\{doc\.series\}\$\{doc\.number\}` \}/);
  assert.match(read('server/orders/transitions.js'), /h\.event\('OFFER_SUBMITTED'\);/);
});
