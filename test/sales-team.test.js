// Satışçı–çizimci ayrımı (4.3.0, karar 300) — saf kurallar ve yapı.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseRoutingRule, reassignBlocks, ruleAt, validDrawer, validSales, zonedToUtc, localParts, ROUTING_TIMEZONE,
} from '../server/orders/sales-routing.js';
import { lineIdentityChanged } from '../server/orders/transitions.js';
import { orderPeopleView, staffView } from '../server/orders/order-view.js';
import { orderScope } from '../server/orders/scope.js';
import { autoLinkRows, crateTeam, teamCrateWhere } from '../server/loading/crates.js';
import { buildTransportList, buildTransportSections } from '../server/loading/transport.js';
import { accountSummary, validAccount } from '../server/accounting/factory-accounts.js';
import { accountsMatchSummary, sameTotals } from '../server/orders/sales-link.js';
import { destinationCheck } from '../server/orders/compensation.js';
import { availableActions, EVENTS } from '../server/orders/rules.js';
import { can } from '../server/auth/permissions.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('kapsam: satış yalnızca kendi siparişleri, çizim yalnızca kendisine atanmış; atamasız sipariş hiçbir satışçıya / çizimciye açılmaz', () => {
  assert.equal(orderScope({ id: 's1', appRole: 'SATIS' }).salesUserId, 's1');
  assert.equal(orderScope({ id: 'd1', appRole: 'CIZIM' }).assignedDrawerId, 'd1');
  // Kimliksiz aktör: hiçbir satıra eşleşmez ("salesUserId: null" sorgusuna düşmez)
  assert.equal(orderScope({ appRole: 'SATIS' }).salesUserId, '__none__');
  assert.equal(orderScope({ appRole: 'CIZIM' }).assignedDrawerId, '__none__');
  assert.deepEqual(orderScope({ id: 'a', appRole: 'ADMIN' }), { removedAt: null });
});

test('yönlendirme kuralı: Europe/Bucharest yerel saat → UTC (yaz / kış), geçmiş ve çok ileri reddedilir, AUTO hedef ister', () => {
  const now = new Date('2026-10-22T07:00:00Z');
  // Ekim: EEST (UTC+3) → 10:00 yerel = 07:00Z; Aralık: EET (UTC+2)
  assert.equal(zonedToUtc('2026-10-22T10:00').toISOString(), '2026-10-22T07:00:00.000Z');
  assert.equal(zonedToUtc('2026-12-01T10:00').toISOString(), '2026-12-01T08:00:00.000Z');
  assert.equal(zonedToUtc('2026-13-01T10:00'), null);
  assert.deepEqual(localParts(new Date('2026-10-22T07:05:00Z'), ROUTING_TIMEZONE), { day: '2026-10-22', time: '10:05' });
  assert.equal(parseRoutingRule({ mode: 'AUTO' }, { now }).code, 'TARGET');
  assert.equal(parseRoutingRule({ mode: 'X', targetUserId: 'abcdefghij' }, { now }).code, 'MODE');
  assert.equal(parseRoutingRule({ mode: 'AUTO', targetUserId: 'abcdefghij', startsAt: '2026-10-22T09:00' }, { now }).code, 'PAST');
  assert.equal(parseRoutingRule({ mode: 'AUTO', targetUserId: 'abcdefghij', startsAt: '2028-10-22T09:00' }, { now }).code, 'FAR');
  const ok = parseRoutingRule({ mode: 'AUTO', targetUserId: 'abcdefghij', startsAt: '2026-10-22T12:00', note: ' n ' }, { now });
  assert.ok(ok.ok);
  assert.deepEqual([ok.rule.mode, ok.rule.targetUserId, ok.rule.startsAt.toISOString(), ok.rule.note], ['AUTO', 'abcdefghij', '2026-10-22T09:00:00.000Z', 'n']);
  const manual = parseRoutingRule({ mode: 'MANUAL', targetUserId: 'abcdefghij' }, { now });
  assert.deepEqual([manual.rule.targetUserId, manual.rule.startsAt.getTime()], [null, now.getTime()], 'MANUAL hedef taşımaz; boş başlangıç = şimdi');
  // Geçerli kural: başlangıcı geçmiş olanların en geç başlayanı; gelecekteki kural sayılmaz; kural değişikliği ileriye etkili
  const rules = [
    { id: 'a', startsAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'b', startsAt: '2026-10-01T00:00:00Z', createdAt: '2026-09-30T00:00:00Z' },
    { id: 'c', startsAt: '2026-11-01T00:00:00Z', createdAt: '2026-09-30T00:00:00Z' },
  ];
  assert.equal(ruleAt(rules, new Date('2026-10-22T00:00:00Z')).id, 'b');
  assert.equal(ruleAt(rules, new Date('2026-05-01T00:00:00Z')).id, 'a');
  assert.equal(ruleAt(rules, new Date('2025-05-01T00:00:00Z')), null);
  assert.equal(ruleAt([...rules, { id: 'd', startsAt: '2026-10-01T00:00:00Z', createdAt: '2026-10-05T00:00:00Z' }], new Date('2026-10-22T00:00:00Z')).id, 'd', 'eşit başlangıçta son yazılan');
});

test('hedef / çizimci geçerliliği ve ödeme hesabı: iç ekip satışçısı / çizimcisi; silinmiş olmaz', () => {
  assert.ok(validSales({ type: 'INTERNAL', appRole: 'SATIS', isActive: true, deletedAt: null }));
  assert.ok(!validSales({ type: 'INTERNAL', appRole: 'SATIS', isActive: false, deletedAt: null }));
  assert.ok(!validSales({ type: 'CUSTOMER', appRole: 'SATIS', isActive: true, deletedAt: null }));
  assert.ok(!validSales({ type: 'INTERNAL', appRole: 'ADMIN', isActive: true, deletedAt: null }));
  assert.ok(validDrawer({ type: 'INTERNAL', appRole: 'CIZIM', isActive: true, deletedAt: null }));
  assert.ok(!validDrawer({ type: 'INTERNAL', appRole: 'CIZIM', isActive: true, deletedAt: new Date() }));
  // Ödeme hesabı kalıcıdır: pasif satış hesabı da hesap olabilir; silinmiş olamaz
  assert.ok(validAccount({ type: 'INTERNAL', appRole: 'SATIS', deletedAt: null }));
  assert.ok(!validAccount({ type: 'INTERNAL', appRole: 'SATIS', deletedAt: new Date() }));
  assert.ok(!validAccount({ type: 'INTERNAL', appRole: 'CIZIM', deletedAt: null }));
});

test('başka satışçıya yönlendirme engelleri: ilk gönderim, çizim, maliyet, yükleme, belge, telafi, önceki ekibin gizli not / dosyası', () => {
  const base = { status: 'HAZIRLANIYOR', removed: false, orderType: 'GLASS_ORDER', drawingTrack: 'YOK', submittedEver: false, drawings: 0, pdfImports: 0, crates: 0, loaded: 0, documents: 0, payments: 0, compensations: false, staffNotes: 0, staffFiles: 0 };
  assert.deepEqual(reassignBlocks(base), []);
  assert.deepEqual(reassignBlocks({ ...base, status: 'YENI', drawingTrack: 'GEREKLI' }), [], 'çizime gönderilmiş ama çizim başlamamış: yönlendirilebilir');
  assert.deepEqual(reassignBlocks({ ...base, submittedEver: true }), ['SUBMITTED'], 'geri çekme sınırı sıfırlamaz: gönderim olayı kalıcı');
  assert.deepEqual(reassignBlocks({ ...base, drawingTrack: 'YAPILIYOR' }), ['DRAWING']);
  assert.deepEqual(reassignBlocks({ ...base, drawings: 1 }), ['DRAWING']);
  assert.deepEqual(reassignBlocks({ ...base, pdfImports: 1, crates: 1, loaded: 1 }), ['PDF_IMPORT', 'CRATES', 'LOADED']);
  assert.deepEqual(reassignBlocks({ ...base, documents: 1 }), ['DOCUMENTS']);
  assert.deepEqual(reassignBlocks({ ...base, payments: 1 }), ['DOCUMENTS']);
  assert.deepEqual(reassignBlocks({ ...base, compensations: true }), ['COMPENSATION']);
  assert.deepEqual(reassignBlocks({ ...base, staffNotes: 2, staffFiles: 1 }), ['INTERNAL_NOTES', 'INTERNAL_FILES']);
  assert.deepEqual(reassignBlocks({ ...base, status: 'YUKLENDI' }), ['CLOSED']);
  assert.deepEqual(reassignBlocks({ ...base, removed: true }), ['CLOSED']);
  assert.deepEqual(reassignBlocks({ ...base, orderType: 'PROFILE_ORDER' }), ['NOT_GLASS']);
  // Atama işlemi yalnızca atama yetkisiyle ve yalnızca cam siparişinde (beklemedeki sipariş de atanabilir)
  assert.ok(availableActions({ role: 'ADMIN', status: 'YENI', onHold: true, drawing: 'YOK', offer: null, orderType: 'GLASS_ORDER' }).includes('assign_sales'));
  assert.ok(!availableActions({ role: 'ADMIN', status: 'YENI', onHold: false, drawing: 'YOK', offer: null, orderType: 'PROFILE_ORDER' }).includes('assign_sales'));
  assert.ok(!availableActions({ role: 'SATIS', status: 'YENI', onHold: false, drawing: 'YOK', offer: null, orderType: 'GLASS_ORDER' }).includes('assign_sales'));
  assert.ok(!availableActions({ role: 'ADMIN', status: 'ARSIVLENDI', onHold: false, drawing: 'YOK', offer: null, orderType: 'GLASS_ORDER' }).includes('assign_sales'));
  assert.ok(can('ADMIN', 'ORDER_ASSIGN') && can('YONETICI_YARDIMCISI', 'ORDER_ASSIGN') && !can('SATIS', 'ORDER_ASSIGN') && !can('DENETIMCI', 'ORDER_ASSIGN'));
  assert.deepEqual(EVENTS.SALES_ASSIGNED, { customer: false });
});

test('satır kimliği değişince yöneticinin eski müşteri fiyatı geçersizleşir; yalnızca fiyat / sıra değişince kalır', () => {
  const old = { glassProductId: 'g1', description: 'Cam', enMm: 1000, boyMm: 2000, pieceM2: '2', unit: 'm2', kind: 'CAM', shaped: false, adet: 3 };
  assert.equal(lineIdentityChanged(old, { ...old }), false);
  assert.equal(lineIdentityChanged(old, { glassProductId: 'g2' }), true);
  assert.equal(lineIdentityChanged(old, { enMm: '1001' }), true);
  assert.equal(lineIdentityChanged(old, { boyMm: 2000, enMm: 1000 }), false);
  assert.equal(lineIdentityChanged(old, { pieceM2: '2.0004' }), false, 'kayan nokta gürültüsü değişiklik değil');
  assert.equal(lineIdentityChanged(old, { pieceM2: '2.01' }), true);
  assert.equal(lineIdentityChanged(old, { kind: 'DELIK' }), true);
  assert.equal(lineIdentityChanged(old, { shaped: true }), true);
  assert.equal(lineIdentityChanged({ ...old, glassProductId: null }, { description: 'Başka cam' }), true, 'katalog camı yoksa açıklama kimliktir');
  assert.equal(lineIdentityChanged(old, { unitPrice: '99' }), false, 'satış fiyatı kimlik değil');
  // İşlem satırı (CNC / DELİK) ve adetli satır: ölçü kimlik değil (form boş ölçüye varsayılan yazabilir)
  assert.equal(lineIdentityChanged({ kind: 'CNC', description: '', enMm: null, boyMm: null, unit: 'adet', adet: 1 }, { kind: 'CNC', description: '', enMm: 1000, boyMm: 1000, unit: 'adet' }), false);
  assert.equal(lineIdentityChanged({ kind: 'CNC', description: '', unit: 'adet' }, { kind: 'DELIK' }), true);
  // mergePrices: satışın kimlik değişikliği müşteri fiyatını boşaltır (yapı)
  const tr = read('server/orders/transitions.js');
  assert.match(tr, /const stale = !admin && own && lineIdentityChanged\(own, l\)/);
});

test('müşteri iç ekip kimliğini almaz: kişi "GKH · rol", satışçı / çizimci / atayan alanları boş; iç roller görür', () => {
  const u = { id: 'u1', name: 'Ali Satış', email: 'ali@gkh.test', appRole: 'SATIS', type: 'INTERNAL' };
  assert.deepEqual(staffView(u), { id: null, name: null, email: '', appRole: 'SATIS', type: 'INTERNAL', masked: true });
  const cust = { id: 'c1', name: 'Mert', email: 'm@x.test', appRole: 'MUSTERI', type: 'CUSTOMER' };
  assert.equal(staffView(cust), cust, 'müşteri kişisi müşteriye olduğu gibi');
  const order = { id: 'o1', createdBy: cust, salesUser: u, assignedDrawer: { ...u, appRole: 'CIZIM' }, salesAssignedBy: u, files: [{ uploadedBy: u }], drawings: [], notes: [{ user: u }], events: [] };
  const m = orderPeopleView('MUSTERI', order);
  assert.deepEqual([m.salesUser, m.assignedDrawer, m.salesAssignedBy], [null, null, null]);
  assert.deepEqual([m.files[0].uploadedBy.masked, m.files[0].uploadedBy.name, m.notes[0].user.email], [true, null, '']);
  assert.equal(m.createdBy, cust);
  const a = orderPeopleView('ADMIN', order);
  assert.equal(a.salesUser, u);
  // Satış (maskeli rol): müşteri kişisi maskelenir, iç ekip kişileri açık
  const s = orderPeopleView('SATIS', order);
  assert.equal(s.salesUser, u);
  assert.equal(s.createdBy.name, null);
});

test('sandık bölümü (crateTeam): satış yalnızca kendi bölümü; yönetici seçer, birden çok satışçıda seçim zorunlu', () => {
  assert.deepEqual(crateTeam({ role: 'SATIS', id: 's1' }, undefined, []), { ok: true, team: 's1' });
  assert.deepEqual(crateTeam({ role: 'SATIS', id: 's1' }, 's2', []), { ok: false, code: 'TEAM_FORBIDDEN' });
  assert.deepEqual(crateTeam({ role: 'ADMIN', id: 'a' }, 's2', []), { ok: true, team: 's2' });
  assert.deepEqual(crateTeam({ role: 'ADMIN', id: 'a' }, '', []), { ok: true, team: null });
  assert.deepEqual(crateTeam({ role: 'ADMIN', id: 'a' }, undefined, [{ salesUserId: 's1' }, { salesUserId: 's1' }]), { ok: true, team: 's1' });
  assert.deepEqual(crateTeam({ role: 'ADMIN', id: 'a' }, undefined, [{ salesUserId: 's1' }, { salesUserId: 's2' }]), { ok: false, code: 'TEAM_REQUIRED' });
  assert.deepEqual(crateTeam({ role: 'ADMIN', id: 'a' }, undefined, []), { ok: true, team: null });
  assert.deepEqual(teamCrateWhere('s1'), { OR: [{ salesUserId: 's1' }, { salesUserId: null }] }, 'satışçısız eski sandık kaydeden bölümün');
  assert.deepEqual(teamCrateWhere(null), { salesUserId: null });
  // Otomatik bağ yalnızca bölümün (verilen) siparişlerine: başka satışçının siparişi listede yoksa bağlanmaz
  const rows = autoLinkRows([{ crateNo: 1, orderIds: ['x'] }], [], [{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(rows[0].orderIds, ['a', 'b']);
});

test('nakliye listesi satışçı bölümleri: her sandık bir bölümde ve bir kez; satışçı ara toplamı; genel toplam = bölümlerin toplamı', () => {
  const crate = (no, team, kg, orderNo, customerId = 'c1') => ({ crateNo: no, lengthMm: 100, widthMm: 10, heightMm: 5, netAgirlik: null, brutAgirlik: kg, note: null, customerId, salesUserId: team, customer: { prefix: 'GLA', name: 'G' }, orders: [{ order: { orderNo, customerId } }] });
  const crates = [crate(1, 's1', 60, 'GLA1'), crate(2, 's2', 70, 'GLA2'), crate(3, null, 10, 'GLA5', 'c2')];
  const orders = [
    { orderNo: 'GLA1', customerId: 'c1', salesUserId: 's1' }, { orderNo: 'GLA2', customerId: 'c1', salesUserId: 's2' },
    { orderNo: 'GLA3', customerId: 'c1', salesUserId: 's2' }, { orderNo: 'GLA5', customerId: 'c2', salesUserId: null },
  ];
  const l = buildTransportSections(crates, orders, { teamName: (id) => ({ s1: 'Veli', s2: 'Ali' })[id] ?? 'Hesapsız' });
  assert.deepEqual(l.sections.map((s) => [s.name, s.crateCount, s.totalKg, s.missing]), [['Ali', 1, 70, []], ['Veli', 1, 60, []], ['Hesapsız', 1, 10, []]], 'ada göre; hesapsız sonda');
  assert.deepEqual([l.crateCount, l.totalKg], [3, 140]);
  const plain = buildTransportList(crates, orders);
  assert.deepEqual([plain.crateCount, plain.totalKg], [3, 140], 'bölümsüz liste aynı toplam');
  // Aynı müşterinin başka satışçıdaki siparişi eksik sayılmaz: firmanın o bölümde sandığı var
  assert.deepEqual(l.sections[0].missing, []);
});

test('fabrika hesapları: hesap bazında maliyet / ödeme / bakiye; borçlu ve avanslı toplamlar ayrı; para birimleri karışmaz; toplam = genel özet', () => {
  const lines = [
    { salesUserId: 'a', currency: 'EUR', cost: 100 }, { salesUserId: 'b', currency: 'EUR', cost: 50 }, { salesUserId: 'c', currency: 'EUR', cost: 10 },
    { salesUserId: 'a', currency: 'RON', cost: 7 }, null, { salesUserId: null, currency: 'EUR', cost: 3 },
  ];
  const payments = [{ salesUserId: 'a', currency: 'EUR', amount: '40' }, { salesUserId: 'b', currency: 'EUR', amount: '80' }, { salesUserId: null, currency: 'EUR', amount: '5' }];
  const r = accountSummary(lines, payments);
  assert.deepEqual(r.overview.EUR, { cost: 163, paid: 125, balance: 38, debt: 70, advance: 32 });
  assert.deepEqual(r.overview.RON, { cost: 7, paid: 0, balance: 7, debt: 7, advance: 0 });
  assert.deepEqual(r.accounts.map((x) => [x.account, x.byCur.EUR?.balance ?? null]), [['a', 60], ['b', -30], ['c', 10], [null, -2]]);
  // debt − advance = net bakiye
  assert.equal(r.overview.EUR.debt - r.overview.EUR.advance, r.overview.EUR.balance);
  // Ödeme hesabı değişince A'dan düşer B'ye eklenir, genel toplam değişmez
  const moved = accountSummary(lines, [{ ...payments[0], salesUserId: 'b' }, payments[1], payments[2]]);
  assert.deepEqual([moved.overview.EUR.cost, moved.overview.EUR.paid, moved.overview.EUR.balance], [163, 125, 38], 'genel maliyet / ödeme / bakiye değişmez');
  assert.deepEqual([moved.overview.EUR.debt, moved.overview.EUR.advance], [110, 72], 'borçlu / avanslı dağılımı hesaplara göre değişir');
  assert.deepEqual(moved.accounts.map((x) => [x.account, x.byCur.EUR.balance]), [['a', 100], ['b', -70], ['c', 10], [null, -2]]);
  // Geçiş kontrolü: para birimi başına toplamlar ve sayımlar aynı; hesap toplamı özetle eşit
  const snap = { perCur: { EUR: { cost: 163, paid: 125, balance: 38 } }, perAcc: { EUR: { cost: 163, paid: 125, balance: 38 } }, counts: { orders: 5, crates: 1, payments: 3 } };
  assert.ok(sameTotals(snap, { ...snap, perCur: { EUR: { cost: 163, paid: 125, balance: 38 } } }));
  assert.ok(!sameTotals(snap, { ...snap, perCur: { EUR: { cost: 163.01, paid: 125, balance: 38 } } }));
  assert.ok(!sameTotals(snap, { ...snap, counts: { ...snap.counts, payments: 4 } }));
  assert.ok(accountsMatchSummary(snap));
  assert.ok(!accountsMatchSummary({ ...snap, perAcc: { EUR: { cost: 160, paid: 125, balance: 35 } } }));
});

test('telafi: hedef sipariş kaynağın satışçısında olmalı (ekipler birleşmez); kaynak atamasızsa yalnızca atamasız hedef', () => {
  const base = { id: 'd', customerId: 'c1', orderTypeCode: 'GLASS_ORDER', removedAt: null, status: 'HAZIRLANIYOR', onHold: false, offers: [{ status: 'GONDERILDI', currency: 'EUR', offerAmount: '1' }] };
  const ctx = { sourceOrderId: 's', customerId: 'c1', currency: 'EUR', today: '2026-10-22', day: '2026-10-30', locked: false, salesUserId: 's1' };
  assert.deepEqual(destinationCheck({ ...base, salesUserId: 's1' }, ctx), { ok: true, via: 'SENT' });
  assert.deepEqual(destinationCheck({ ...base, salesUserId: 's2' }, ctx), { ok: false, reason: 'OTHER_SALES' });
  assert.deepEqual(destinationCheck({ ...base, salesUserId: null }, ctx), { ok: false, reason: 'OTHER_SALES' });
  assert.deepEqual(destinationCheck({ ...base, salesUserId: null }, { ...ctx, salesUserId: null }), { ok: true, via: 'SENT' });
  assert.deepEqual(destinationCheck({ ...base, salesUserId: 's2' }, { ...ctx, salesUserId: undefined }), { ok: true, via: 'SENT' }, 'eski çağrı (satışçı verilmeden) değişmedi');
  // Yeni -T siparişi kaynağın satışçı ve çizimcisini taşır (yapı)
  assert.match(read('server/orders/compensation.js'), /salesUserId: src\.salesUserId \?\? null, assignedDrawerId: src\.assignedDrawerId \?\? null,/);
});

test('yapı: bağlama ve yönlendirme servisleri HTTP yolundan çağrılmaz; teklif işlemleri sürümsüz çalışmaz; fiyat tablosu varsayılana düşmez', () => {
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const web = [...walk('app'), ...walk('lib'), ...walk('components')].filter((f) => /\.(ts|tsx|js)$/.test(f));
  for (const f of web) {
    const s = read(f);
    assert.ok(!s.includes('sales-link'), `${f}: bağlama betiği web kodundan çağrılmaz`);
    assert.ok(!/routeNewOrder\(/.test(s), `${f}: yönlendirme yalnızca sipariş oluşturma işleminde`);
  }
  assert.match(read('server/orders/create.js'), /const owner = await routeNewOrder\(tx, \{ now, orderNo \}\)/);
  const act = read('app/(panel)/siparisler/[id]/actions.ts');
  for (const name of ['saveOfferAction', 'withdrawOfferAction', 'assignSalesAction']) assert.ok(act.includes(`export async function ${name}`), name);
  assert.ok((act.match(/await requiredVersion\(formData, id\)/g) ?? []).length >= 3, 'teklif ve atama işlemleri sayfanın sürümünü ister');
  assert.match(act, /requirePermission\('ORDER_ASSIGN'\)/);
  const tables = read('server/pricing/tables.js');
  assert.match(tables, /export function resolveTable\(user, tables, \{ fallback = false \} = \{\}\)/);
  assert.doesNotMatch(read('app/(panel)/siparisler/[id]/page.tsx'), /pricingForUser\(db, user\.id\)/, 'fiyat tablosu siparişin sorumlu satışçısından');
  assert.match(read('app/(panel)/siparisler/[id]/page.tsx'), /pricingForUser\(db, order\.salesUserId\)/);
  assert.match(read('server/commercial/glass-cost.js'), /fallback: true/, 'ticari teklif maliyet önerisi varsayılan tabloya düşebilir (değişmedi)');
  // Bildirim: atamasız siparişte satış / çizim ekibine düşme yok
  const email = read('server/notifications/email.js');
  assert.doesNotMatch(email, /appRole: \{ in: ROLE_SETS\.sales \}/);
  assert.match(email, /ORDER_SALES_ASSIGNED: \(\) => \['orderSales'\]/);
  // Yükleme: satış kendi sandıkları / misafir yükleri + ekip görüntülemesi (karar 301 — yalnızca okuma; kayıt crateTeam ile kendi bölümü)
  const loading = read('lib/loading.ts');
  assert.match(loading, /user\.appRole === 'SATIS' \? \{ customerId: \{ not: null \}, salesUserId: salesView\(user\) \}/);
  // Nakliye: satış kendi bölümü + ekip bölümleri (görüntüleme)
  assert.match(read('app/(panel)/yuklemeler/nakliye/route.ts'), /const team = sales \? salesView\(user\)\.in : undefined/);
  // Muhasebe: ödeme hesabı serviste; hesap değişikliği yalnızca servis
  const acc = read('app/(panel)/admin/muhasebe/actions.ts');
  assert.doesNotMatch(acc, /factoryPayment\.create\(/, 'ödeme yalnızca addFactoryPayment ile');
  assert.match(acc, /changePaymentAccount\(db/);
  assert.match(read('server/accounting/factory-accounts.js'), /FOR UPDATE/);
  // Seed: işaret yalnızca boş veritabanında
  assert.match(read('prisma/seed/steps/sales-routing.mjs'), /if \(glass > 0\) return/);
});
