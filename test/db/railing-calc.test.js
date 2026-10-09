// Korkuluk hesaplayıcısı (karar 203–204) — veritabanıyla: varsayılan yapılandırmanın bir kez ve idempotent yazılması,
// yöneticinin kayıtlarına dokunulmaması, katalogda eksik ürün varsa hiçbir şey yazılmaması (eksik kod söylenir), müşterinin
// hesabı (örnekler, stok yalnızca okunur, kayıt / bildirim yok). Gerçek dış istek yok (ağ engeli).
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const calc = await import('../../server/profile/calc-service.js');
const { applyRailingDefaults, railingDefaultsStatus, RAILING_DEFAULTS_ACTION } = await import('../../server/profile/calc-defaults.js');
const { applyCalc } = await import('../../server/profile/calculator.js');

let db;
const counts = async () => [await db.profileSystem.count(), await db.profileCalcItem.count(), await db.profileGlassThickness.count(), await db.auditLog.count({ where: { action: RAILING_DEFAULTS_ACTION } })];
const packOf = async (code) => (await db.profileProduct.findUniqueOrThrow({ where: { code } })).packContent?.toString() ?? null;
const ids = async () => {
  const systems = await db.profileSystem.findMany({ where: { code: { in: ['FBL90', 'FBL115', 'MR23', 'RM29'] } } });
  const ths = await db.profileGlassThickness.findMany({ orderBy: { mm: 'asc' } });
  const by = (c) => systems.find((s) => s.code === c)?.id ?? '';
  return { FBL90: by('FBL90'), FBL115: by('FBL115'), MR23: by('MR23'), RM29: by('RM29'), G12: ths.find((t) => t.mm.toString() === '12.76')?.id ?? '', G16: ths.find((t) => t.mm.toString() === '16.76')?.id ?? '' };
};
const qtys = (r) => (r.ok ? Object.fromEntries(r.lines.map((l) => [l.code, l.qty])) : r.errors);
after(closeDb);

dbTest('varsayılanlar (karar 203): temel veriyle bir kez yazılır — 4 sistem türüyle, 6+6 / 8+8, 6 m boy, poşetler; ikinci çalıştırma hiçbir şey yazmaz', offline(async () => {
  db = await getDb();
  await resetDb(db);
  const systems = await db.profileSystem.findMany({ orderBy: { sortOrder: 'asc' }, include: { items: { include: { product: true, thickness: true }, orderBy: { sortOrder: 'asc' } } } });
  assert.deepEqual(systems.map((s) => [s.code, s.kind, s.isActive, s.items.length]), [['FBL90', 'PROFILE', true, 5], ['FBL115', 'PROFILE', true, 5], ['MR23', 'HANDRAIL', true, 4], ['RM29', 'HANDRAIL', true, 4]]);
  assert.deepEqual(systems[2].items.map((i) => [i.slot, i.product?.code, i.color, i.thickness?.label ?? null, i.perMeter?.toString()]), [
    ['Profil', 'MR23-7016', 'RAL7016', null, '1'], ['Profil', 'MR23-ELX', 'ELOXAT', null, '1'], ['Conta', 'MC12', null, '6+6', '1'], ['Conta', 'MC16', null, '8+8', '1'],
  ]);
  assert.deepEqual((await db.profileGlassThickness.findMany({ orderBy: { mm: 'asc' } })).map((t) => [t.mm.toString(), t.label]), [['12.76', '6+6'], ['16.76', '8+8']]);
  for (const code of ['FBL90-7016', 'FBL115-ELX', 'MR23-7016', 'RM12-ELX', 'RM16-7016', 'PANA-L90', 'PANA-115-16']) assert.equal(await packOf(code), '6', code);
  assert.deepEqual([await packOf('MC12'), await packOf('MC16'), await packOf('GK15'), await packOf('AD45')], ['27', '43', '137', '24']);
  const before = await counts();
  assert.equal(before[3], 1, 'tek işaret');
  assert.deepEqual(await applyRailingDefaults(db), { state: 'already' });
  assert.deepEqual(await counts(), before);
  assert.deepEqual(await railingDefaultsStatus(db), { applied: true, missing: [], wrongUnit: [] });
  // Yönetici sonradan değiştirir / pasif yapar: yeniden çalıştırma geri getirmez
  await db.profileProduct.update({ where: { code: 'FBL90-7016' }, data: { packContent: '6.5' } });
  await db.profileSystem.update({ where: { code: 'RM29' }, data: { isActive: false } });
  assert.deepEqual(await applyRailingDefaults(db), { state: 'already' });
  assert.equal(await packOf('FBL90-7016'), '6.5');
  assert.equal((await db.profileSystem.findUniqueOrThrow({ where: { code: 'RM29' } })).isActive, false);
}));

dbTest('yöneticinin önceden kurduğu kayıt korunur: aynı kodlu sistemin satırlarına ve dolu paket içeriğine dokunulmaz; boş tür / ad tamamlanır', offline(async () => {
  await resetDb(db, { calcDefaults: false });
  const th = await db.profileGlassThickness.create({ data: { mm: '12.76' } });
  const own = await db.profileSystem.create({ data: { code: 'MR23', nameRo: 'Mâna mea', nameTr: 'Benim MR23', items: { create: [{ slot: 'Benim kalemim', productId: (await db.profileProduct.findUniqueOrThrow({ where: { code: 'GK15' } })).id, perMeter: '2' }] } } });
  await db.profileProduct.update({ where: { code: 'MR23-ELX' }, data: { packContent: '5.8', packMeasure: 'M' } });
  const r = await applyRailingDefaults(db);
  assert.deepEqual([r.state, r.created, r.kept], ['done', ['FBL90', 'FBL115', 'RM29'], ['MR23']]);
  const mr = await db.profileSystem.findUniqueOrThrow({ where: { id: own.id }, include: { items: true } });
  assert.deepEqual([mr.nameTr, mr.kind, mr.items.map((i) => i.slot)], ['Benim MR23', 'HANDRAIL', ['Benim kalemim']], 'satırlar aynen; yalnızca boş tür yazıldı');
  assert.equal(await packOf('MR23-ELX'), '5.8');
  assert.equal((await db.profileGlassThickness.findUniqueOrThrow({ where: { id: th.id } })).label, '6+6', 'aynı mm yeniden oluşturulmadı, adı tamamlandı');
  assert.equal(await db.profileGlassThickness.count(), 2);
}));

dbTest('katalogda gereken ürün yoksa / birimi farklıysa: HİÇBİR şey yazılmaz, eksik kod açıkça söylenir; ürün tamamlanınca yazılır (ürün oluşturulmaz)', offline(async () => {
  await resetDb(db, { calcDefaults: false });
  const products = await db.profileProduct.count();
  await db.profileProduct.update({ where: { code: 'PANA-L115' }, data: { code: 'PANA-L115-ESKI' } });
  await db.profileProduct.update({ where: { code: 'MC16' }, data: { unitCode: 'BUCATI' } });
  const r = await applyRailingDefaults(db);
  assert.deepEqual(r, { state: 'blocked', missing: ['PANA-L115'], wrongUnit: [{ code: 'MC16', unit: 'BUCATI', expected: 'CUTII' }] });
  assert.deepEqual(await counts(), [0, 0, 0, 0]);
  assert.equal(await packOf('FBL90-7016'), null, 'paket içeriği de yazılmadı');
  assert.deepEqual(await railingDefaultsStatus(db), { applied: false, missing: ['PANA-L115'], wrongUnit: [{ code: 'MC16', unit: 'BUCATI', expected: 'CUTII' }] });
  assert.equal(await db.profileProduct.count(), products, 'ürün oluşturulmadı');
  await db.profileProduct.update({ where: { code: 'PANA-L115-ESKI' }, data: { code: 'PANA-L115' } });
  await db.profileProduct.update({ where: { code: 'MC16' }, data: { unitCode: 'CUTII' } });
  assert.equal((await applyRailingDefaults(db)).state, 'done');
  assert.deepEqual((await counts()).slice(0, 2), [4, 18]);
}));

dbTest('müşterinin hesabı (karar 203–204): örnekler; seçenekler türüne göre iki ayrı liste; stok yalnızca okunur, kayıt / stok hareketi / bildirim yazılmaz; aktarım manuel değişikliği sessizce silmez', offline(async () => {
  await resetDb(db);
  const opts = await calc.loadCalcOptions(db);
  assert.deepEqual([opts.profiles.map((s) => s.code), opts.handrails.map((s) => s.code), opts.thicknesses.map((t) => t.label)], [['FBL90', 'FBL115'], ['MR23', 'RM29'], ['6+6', '8+8']]);
  const I = await ids();
  const snap = async () => [await db.stockMovement.count(), await db.notificationOutbox.count(), await db.notification.count(), await db.adminAlert.count(), await db.auditLog.count(), await db.order.count()];
  const before = await snap();
  const A = await calc.runRailingCalc(db, { profileId: I.FBL90, handrailId: I.MR23, color: 'RAL7016', thicknessId: I.G16, meters: '20' });
  assert.deepEqual(qtys(A), { 'FBL90-7016': 4, 'PANA-L90': 4, 'PANA-90-16': 4, 'MR23-7016': 4, MC16: 1 });
  assert.deepEqual(A.systems.map((s) => s.code), ['FBL90', 'MR23']);
  assert.deepEqual(qtys(await calc.runRailingCalc(db, { profileId: I.FBL115, handrailId: I.RM29, color: 'RAL7016', thicknessId: I.G12, meters: '25' })), { 'FBL115-7016': 5, 'PANA-L115': 5, 'PANA-115-12': 5, 'RM12-7016': 5 });
  assert.deepEqual(qtys(await calc.runRailingCalc(db, { profileId: I.FBL90, handrailId: '', color: 'ELOXAT', thicknessId: I.G12, meters: '50' })), { 'FBL90-ELX': 9, 'PANA-L90': 9, 'PANA-90-12': 9 });
  assert.deepEqual(qtys(await calc.runRailingCalc(db, { profileId: I.FBL115, handrailId: I.MR23, color: 'RAL7016', thicknessId: I.G12, meters: '60' })), { 'FBL115-7016': 10, 'PANA-L115': 10, 'PANA-115-12': 10, 'MR23-7016': 10, MC12: 3 });
  // Küpeşte, profil yerine verilemez; başka bir id küpeşte olarak verilemez
  assert.deepEqual((await calc.runRailingCalc(db, { profileId: I.MR23, color: 'RAL7016', thicknessId: I.G12, meters: '10' })).errors, [{ code: 'SYSTEM_INACTIVE' }]);
  assert.deepEqual((await calc.runRailingCalc(db, { profileId: I.FBL90, handrailId: I.FBL115, color: 'RAL7016', thicknessId: I.G12, meters: '10' })).errors, [{ code: 'SYSTEM_INACTIVE' }]);
  assert.deepEqual((await calc.runRailingCalc(db, { profileId: I.FBL90, handrailId: 'yok', color: 'RAL7016', thicknessId: I.G12, meters: '10' })).errors, [{ code: 'SYSTEM_INACTIVE' }]);
  assert.deepEqual(await snap(), before, 'hesap yalnızca okur');
  // Stok yetmeyen ürün: yalnızca o ürün için gereken / mevcut / eksik
  await db.stockMovement.create({ data: { productId: (await db.profileProduct.findUniqueOrThrow({ where: { code: 'PANA-L90' } })).id, qty: 100, kind: 'GIRIS', note: 'test' } });
  const S = await calc.runRailingCalc(db, { profileId: I.FBL90, color: 'RAL7016', thicknessId: I.G12, meters: '12' });
  assert.deepEqual(S.lines.map((l) => [l.code, l.qty, l.stock]), [['FBL90-7016', 2, { available: 0, missing: 2 }], ['PANA-L90', 2, null], ['PANA-90-12', 2, { available: 0, missing: 2 }]]);
  // Forma aktarım: elle değiştirilen farklı adet ÖNCE gösterilir (sessizce silinmez); öbür ürünlere dokunulmaz
  const ID = Object.fromEntries(S.lines.map((l) => [l.code, l.productId]));
  const t = applyCalc({ [ID['FBL90-7016']]: '3', SPIGOT: '12' }, S.lines);
  assert.deepEqual(t.overwrites, [{ productId: ID['FBL90-7016'], from: '3', to: '2' }]);
  assert.equal(t.next.SPIGOT, '12');
}));
