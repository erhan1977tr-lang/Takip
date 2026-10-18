// Bağımsız yönetici ticari teklifi (3.83.0, karar 277) — veritabanıyla: numaralama (otomatik, elle, eşzamanlı tekil), taslak
// kaydı (iyimser kilit), kesinleştirme (kesin sürüm değişmez), yeni sürüm, kabul / ret / iptal (yalnızca kayıt), yetki
// (yalnızca yönetici + yardımcısı), maliyetin müşteri görünümüne girmemesi ve modülün sipariş / FGO / stok / bildirim
// tablolarına hiç yazmaması. Ağ isteği yok (offline).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const svc = await import('../../server/commercial/service.js');
const { customerView, computeOffer } = await import('../../server/commercial/rules.js');
const { runRailingCalc, loadCalcOptions } = await import('../../server/profile/calc-service.js');

let db, factory, firm, glass;
const U = {};
const act = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const A = () => act(U.admin);
const prod = (code) => db.profileProduct.findUniqueOrThrow({ where: { code } });

/** Sipariş / FGO / stok / bildirim tablolarının satır sayıları — modül bunlara hiç yazmamalı */
const OTHER = ['order', 'offer', 'offerLine', 'price', 'orderEvent', 'notificationOutbox', 'notification', 'stockMovement', 'fgoDocument', 'billingBatch', 'adminAlert', 'profileOrder'];
const counts = async () => Object.fromEntries(await Promise.all(OTHER.map(async (m) => [m, await db[m].count()])));

async function form(extra = {}) {
  const [fbl, gk] = await Promise.all([prod('FBL115-7016'), prod('GK15')]);
  return {
    date: '2026-10-06', firmName: 'Trademark Glass', validityDays: '5', terms: ['Metode de plată: 75% avans, 25% înainte de livrare.'], note: 'iç not',
    glassExtraCost: '1700',
    glass: [{ productId: glass.id, description: '8.2.8., TRANSPARENT, Securizat, cantuit', en: '1000', boy: '970', qty: '280', price: '63.10', cost: '50' }],
    profile: [{ productId: fbl.id, meters: '300', color: 'RAL7016', price: '28.15', cost: '22.12' }, { productId: gk.id, meters: '270', price: '1.10' }],
    ...extra,
  };
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db); // roller, profil kataloğu ve korkuluk hesaplayıcısı varsayılanları
  factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Trademark Glass SRL', prefix: 'TRD' } });
  glass = await db.glassProduct.create({ data: { nameTr: '8.8.2 TEMPER LAMİNE', colorTr: 'ŞEFFAF', nameRo: '8.2.8., TRANSPARENT', colorRo: 'Securizat', weightKgM2: 40 } });
  const mk = (key, appRole, customerId) =>
    db.user.create({ data: { email: `${key}@teklif.test`, name: key, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId } }).then((u) => { U[key] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('assistant', 'YONETICI_YARDIMCISI', factory.id);
  await mk('sales', 'SATIS', factory.id);
  await mk('drawer', 'CIZIM', factory.id);
  await mk('inspector', 'DENETIMCI', factory.id);
  await mk('cust', 'MUSTERI', firm.id);
});
after(async () => { await closeDb(); });

dbTest('ticari teklif: yalnızca yönetici ve yardımcısı; diğer rollere her işlev FORBIDDEN (veritabanına dokunmadan)', offline(async () => {
  const before = await db.commercialOffer.count();
  for (const key of ['sales', 'drawer', 'inspector', 'cust']) {
    const a = act(U[key]);
    assert.equal((await svc.createOffer(db, await form(), a)).code, 'FORBIDDEN', key);
    assert.equal((await svc.listOffers(db, {}, a)).code, 'FORBIDDEN', key);
    assert.equal((await svc.loadOffer(db, 'x', a)).code, 'FORBIDDEN', key);
    assert.equal((await svc.offerVersion(db, { id: 'x' }, a)).code, 'FORBIDDEN', key);
    assert.equal((await svc.editorCatalog(db, a)).code, 'FORBIDDEN', key);
    assert.equal((await svc.saveDraft(db, { offerId: 'x' }, a)).code, 'FORBIDDEN', key);
    assert.equal((await svc.issueOffer(db, { offerId: 'x' }, a)).code, 'FORBIDDEN', key);
    assert.equal((await svc.newRevision(db, { offerId: 'x' }, a)).code, 'FORBIDDEN', key);
    assert.equal((await svc.setOfferStatus(db, { offerId: 'x', status: 'KABUL' }, a)).code, 'FORBIDDEN', key);
    assert.equal((await svc.suggestNo(db, a)).code, 'FORBIDDEN', key);
  }
  assert.equal(await db.commercialOffer.count(), before);
  // Yardımcı yönetici oluşturabilir
  const r = await svc.createOffer(db, await form({ no: '9000' }), act(U.assistant));
  assert.ok(r.ok, JSON.stringify(r));
}));

dbTest('ticari teklif: oluştur → taslak kaydet → kesinleştir → yeni sürüm → kabul; sipariş / FGO / stok / bildirim YOK', offline(async () => {
  const other = await counts();
  const c = await svc.createOffer(db, await form({ no: '496' }), A());
  assert.ok(c.ok, JSON.stringify(c));
  assert.equal(c.no, 496);
  let o = await db.commercialOffer.findUniqueOrThrow({ where: { id: c.id }, include: { versions: true } });
  assert.equal(o.status, 'TASLAK');
  assert.equal(o.total.toString(), '25884.36'); // 17137.96 + 8445.00 + 301.40
  assert.equal(o.versions[0].cost.toString(), '21916'); // 13580 + 1700 + 6636 (GK15 maliyeti eksik)
  // Taslak kaydı: eski ekran (editVersion) → CONFLICT; doğru ekran → kayıt
  assert.equal((await svc.saveDraft(db, { ...(await form()), offerId: c.id, editVersion: o.editVersion + 5 }, A())).code, 'CONFLICT');
  const s = await svc.saveDraft(db, { ...(await form({ firmName: 'Trademark Glass (rev)' })), offerId: c.id, editVersion: o.editVersion }, A());
  assert.ok(s.ok, JSON.stringify(s));
  // Kesinleştir: TASLAK → HAZIR; kesin sürüm bir daha değişmez
  o = await db.commercialOffer.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(o.firmName, 'Trademark Glass (rev)');
  const iss = await svc.issueOffer(db, { offerId: c.id, editVersion: o.editVersion }, A());
  assert.ok(iss.ok, JSON.stringify(iss));
  o = await db.commercialOffer.findUniqueOrThrow({ where: { id: c.id }, include: { versions: true } });
  assert.equal(o.status, 'HAZIR');
  assert.ok(o.versions[0].issuedAt);
  const frozen = JSON.stringify(o.versions[0].data);
  assert.equal((await svc.saveDraft(db, { ...(await form({ firmName: 'Değişti' })), offerId: c.id, editVersion: o.editVersion }, A())).code, 'NOT_DRAFT');
  assert.equal((await svc.issueOffer(db, { offerId: c.id, editVersion: o.editVersion }, A())).code, 'NOT_DRAFT');
  // Yeni sürüm: önceki aynen kalır; numara artık değişmez
  const rv = await svc.newRevision(db, { offerId: c.id, editVersion: o.editVersion }, A());
  assert.deepEqual(rv, { ok: true, version: 2 });
  o = await db.commercialOffer.findUniqueOrThrow({ where: { id: c.id }, include: { versions: { orderBy: { version: 'asc' } } } });
  assert.equal(o.status, 'TASLAK');
  const s2 = await svc.saveDraft(db, { ...(await form({ no: '777', glass: [] })), offerId: c.id, editVersion: o.editVersion }, A());
  assert.ok(s2.ok, JSON.stringify(s2));
  o = await db.commercialOffer.findUniqueOrThrow({ where: { id: c.id }, include: { versions: { orderBy: { version: 'asc' } } } });
  assert.equal(o.no, 496, 'kesinleşmiş teklifin numarası değişmez');
  assert.equal(JSON.stringify(o.versions[0].data), frozen, 'sürüm 1 değişmedi');
  assert.equal(o.versions[1].data.glass.length, 0);
  await svc.issueOffer(db, { offerId: c.id, editVersion: o.editVersion }, A());
  o = await db.commercialOffer.findUniqueOrThrow({ where: { id: c.id } });
  // Kabul yalnızca kayıttır
  assert.equal((await svc.setOfferStatus(db, { offerId: c.id, editVersion: o.editVersion, status: 'IPTAL', note: '' }, A())).code, 'REASON');
  const acc = await svc.setOfferStatus(db, { offerId: c.id, editVersion: o.editVersion, status: 'KABUL', note: 'telefonla' }, A());
  assert.ok(acc.ok, JSON.stringify(acc));
  o = await db.commercialOffer.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(o.status, 'KABUL');
  assert.equal((await svc.newRevision(db, { offerId: c.id, editVersion: o.editVersion }, A())).code, 'NOT_REVISABLE');
  assert.equal((await svc.setOfferStatus(db, { offerId: c.id, editVersion: o.editVersion, status: 'RED' }, A())).code, 'NOT_ALLOWED');
  assert.deepEqual(await counts(), other, 'sipariş / teklif / FGO / stok / bildirim tablolarına yazılmadı');
  // Geçmiş: denetim kayıtları
  const audit = await db.auditLog.findMany({ where: { entityType: 'CommercialOffer', entityId: c.id }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(audit.map((a) => a.action), [
    'COMMERCIAL_OFFER_CREATED', 'COMMERCIAL_OFFER_SAVED', 'COMMERCIAL_OFFER_ISSUED', 'COMMERCIAL_OFFER_REVISION', 'COMMERCIAL_OFFER_SAVED', 'COMMERCIAL_OFFER_ISSUED', 'COMMERCIAL_OFFER_STATUS',
  ]);
  assert.equal(audit.at(-1).details.orderCreated, false);
  // Liste ve tek teklif (iç görünüm maliyetli; müşteri görünümü maliyetsiz)
  const list = await svc.listOffers(db, { q: '496' }, A());
  assert.ok(list.ok && list.rows.some((r) => r.id === c.id));
  const v1 = await svc.offerVersion(db, { id: c.id, version: '1' }, A());
  assert.equal(v1.ok && v1.draft, false);
  const view = JSON.stringify(customerView({ no: v1.no, version: 1, data: v1.data, draft: false }));
  assert.doesNotMatch(view, /cost|profit|margin|iç not|1700/);
  assert.equal(computeOffer(v1.data).totals.missingCost, 1);
}));

dbTest('ticari teklif: numara otomatik (son + 1), elle verilen tekil; eşzamanlı oluşturmada çakışma yok', offline(async () => {
  const f = await form();
  const taken = await svc.createOffer(db, { ...f, no: '496' }, A());
  assert.equal(taken.code, 'NUMBER_TAKEN');
  assert.equal((await svc.createOffer(db, { ...f, no: '0' }, A())).code, 'NUMBER');
  const last = (await db.commercialOffer.findFirst({ orderBy: { no: 'desc' } })).no;
  const many = await Promise.all(Array.from({ length: 8 }, () => svc.createOffer(db, f, A())));
  assert.ok(many.every((r) => r.ok), JSON.stringify(many));
  assert.deepEqual(many.map((r) => r.no).sort((a, b) => a - b), Array.from({ length: 8 }, (_, i) => last + 1 + i));
}));

dbTest('ticari teklif: doğrulama sunucuda — pasif ürün, yanlış satır, bilinmeyen müşteri; tarayıcının ürün bilgisine güvenilmez', offline(async () => {
  const f = await form();
  assert.equal((await svc.createOffer(db, { ...f, customerId: 'yok' }, A())).code, 'CUSTOMER');
  const r = await svc.createOffer(db, { ...f, glass: [{ ...f.glass[0], en: '0' }] }, A());
  assert.deepEqual([r.code, r.section, r.index], ['DIMENSION', 'glass', 0]);
  const passive = await db.glassProduct.create({ data: { nameTr: 'PASİF', nameRo: 'PASIV', isActive: false } });
  assert.equal((await svc.createOffer(db, { ...f, glass: [{ ...f.glass[0], productId: passive.id }] }, A())).code, 'GLASS_PRODUCT');
  const ok = await svc.createOffer(db, { ...f, firmName: '', customerId: firm.id, profile: [{ ...f.profile[0], code: 'SAHTE', unitCode: 'X' }] }, A());
  assert.ok(ok.ok, JSON.stringify(ok));
  const v = await svc.offerVersion(db, { id: ok.id }, A());
  assert.equal(v.data.firmName, 'Trademark Glass SRL');
  assert.equal(v.data.customerId, firm.id);
  assert.deepEqual([v.data.profile[0].code, v.data.profile[0].unitCode, v.data.profile[0].qty], ['FBL115-7016', 'BARA', 50]);
  // Boş teklif kesinleşmez
  const empty = await svc.createOffer(db, { ...f, glass: [], profile: [] }, A());
  const eo = await db.commercialOffer.findUniqueOrThrow({ where: { id: empty.id } });
  assert.equal((await svc.issueOffer(db, { offerId: empty.id, editVersion: eo.editVersion }, A())).code, 'EMPTY');
  // İptal (gerekçeyle) yalnızca kayıt
  const cancel = await svc.setOfferStatus(db, { offerId: empty.id, editVersion: eo.editVersion, status: 'IPTAL', note: 'müşteri vazgeçti' }, A());
  assert.ok(cancel.ok);
}));

dbTest('ticari teklif: profil miktarları mevcut hesaplayıcıdan (yalnızca metre) — hesaplayıcı kayıt yazmaz', offline(async () => {
  const opts = await loadCalcOptions(db);
  const fbl = opts.profiles.find((p) => p.code === 'FBL115');
  const thick = opts.thicknesses.find((x) => x.mm === '16.76');
  assert.ok(fbl && thick, 'korkuluk varsayılanları');
  const moves = await db.stockMovement.count();
  const r = await runRailingCalc(db, { profileId: fbl.id, handrailId: '', color: 'RAL7016', thicknessId: thick.id, meters: '300' });
  assert.ok(r.ok, JSON.stringify(r));
  const profile = r.lines.find((l) => l.code === 'FBL115-7016');
  assert.equal(profile.qty, 50);
  // Hesaplayıcının ihtiyacı (metre) teklif satırına yazılınca paket sayısı aynı çıkar
  const p = await prod('FBL115-7016');
  const c = await svc.createOffer(db, await form({ glass: [], profile: [{ productId: p.id, meters: profile.need, color: 'RAL7016', price: '28.15' }] }), A());
  assert.ok(c.ok, JSON.stringify(c));
  const v = await svc.offerVersion(db, { id: c.id }, A());
  assert.equal(v.data.profile[0].qty, profile.qty);
  assert.equal(await db.stockMovement.count(), moves);
}));

dbTest('DÜZELTME 10: kategori sırası (Alüminyum → Conta → …) ve "GKH Trakya 2026" cam maliyeti — elle değişiklik denetimde; kesin sürüm sabit', offline(async () => {
  const table = await db.priceTable.create({ data: { name: 'GKH Trakya 2026', kind: 'SALES', currency: 'EUR', items: { create: [{ glassProductId: glass.id, unitPrice: '41.50' }] } } });
  try {
    const cat = await svc.editorCatalog(db, A());
    assert.equal(cat.glassCostTable, 'GKH Trakya 2026');
    assert.equal(cat.glass.find((g) => g.id === glass.id)?.listCost, '41.5');
    // Düzenleyicideki profil ürünleri modül sırasıyla: önce PROFILE_ALUMINIU, sonra GARNITURI, PLASTICE, ACCESORII
    const order = ['PROFILE_ALUMINIU', 'GARNITURI', 'PLASTICE', 'ACCESORII'];
    const seen = [...new Set(cat.profile.map((p) => p.category?.code))].filter((c) => order.includes(c));
    assert.deepEqual(seen, order.filter((c) => seen.includes(c)));
    const [fbl, gk] = await Promise.all([prod('FBL115-7016'), prod('GK15')]);
    const f = await form({
      glass: [{ productId: glass.id, en: '1000', boy: '1000', qty: '10', price: '60', cost: '41.50' }, { productId: glass.id, en: '1000', boy: '1000', qty: '10', price: '60', cost: '44' }],
      profile: [{ productId: gk.id, meters: '100', price: '1' }, { productId: fbl.id, meters: '60', price: '20' }],
    });
    const c = await svc.createOffer(db, f, A());
    assert.equal(c.ok, true, JSON.stringify(c));
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'COMMERCIAL_OFFER_CREATED', entityId: c.id } });
    assert.deepEqual(/** @type {any} */ (audit.details).costOverrides.map((x) => [x.row, x.listCost, x.cost]), [[2, '41.5', '44']]);
    const o = await db.commercialOffer.findUniqueOrThrow({ where: { id: c.id } });
    assert.equal((await svc.issueOffer(db, { offerId: c.id, editVersion: o.editVersion }, A())).ok, true);
    const v1 = await svc.offerVersion(db, { id: c.id, version: 1 }, A());
    const pdf1 = customerView({ no: v1.no, version: 1, data: v1.data, draft: false });
    assert.deepEqual(pdf1.profileGroups.map((g) => g.rows[0].code), ['FBL115-7016', 'GK15']);
    // Liste fiyatı sonradan değişir → kesin sürümün kopyası ve belgesi aynı kalır
    await db.priceTableItem.updateMany({ where: { tableId: table.id }, data: { unitPrice: '99' } });
    const again = await svc.offerVersion(db, { id: c.id, version: 1 }, A());
    assert.deepEqual(again.data.glass.map((l) => [l.listCost, l.cost, l.costSource]), [['41.5', '41.5', 'LIST'], ['41.5', '44', 'MANUAL']]);
    assert.deepEqual(customerView({ no: again.no, version: 1, data: again.data, draft: false }), pdf1);
  } finally {
    await db.priceTable.delete({ where: { id: table.id } });
  }
}));
