// DWG kararının güvenli geri alınması (3.90.0–3.90.2, karar 285) — saf kurallar ve yapı.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { crateLockKeys, dwgUndoState, ownerBlock, productionBlock, undoReason, SHIPPED_STATUSES, UNDO_ACTIONS, UNDO_BLOCKS, UNDO_REASON_MAX } from '../server/orders/dwg-undo.js';
import { dayKey } from '../server/orders/loading.js';
import { can, ROLES } from '../server/auth/permissions.js';
import { availableActions, drawingFlags, EVENTS } from '../server/orders/rules.js';
import { REQUIRES } from '../server/orders/transitions.js';
import { STAFF_EVENT_POLICY } from '../server/orders/order-view.js';
import { drawingsView } from '../server/orders/drawing-access.js';
import tr from '../server/i18n/tr/order.js';
import ro from '../server/i18n/ro/order.js';
import trEvents from '../server/i18n/tr/events.js';
import roEvents from '../server/i18n/ro/events.js';

const rec = (status, extra = {}) => ({ id: `d-${status}`, source: 'MUSTERI_DXF_DWG', status, version: 1, decidedById: 'u-drawer', sourceFiles: [{ id: 'f1', name: 'plan.dwg', checksum: 'x' }], ...extra });
const factory = (status, version = 2) => ({ id: `f-${version}`, source: null, status, version });
const order = (o) => ({ status: 'HAZIRLANIYOR', onHold: false, removedAt: null, ...o });

test('dwgUndoState: üç karar ve geri dönülecek durum', () => {
  const ready = dwgUndoState(order({ drawingTrack: 'ONAYLANDI', drawings: [rec('ONAYLANDI')] }));
  assert.deepEqual([ready.kind, ready.variant, ready.restoreTrack, ready.block, ready.production], ['READY', 'RECORD', 'GEREKLI', null, false]);
  // 3.90.2: TAKİP'te "üretime başladı" kaydı yok — üretimdeki (URETIMDE) sipariş engel DEĞİL; geri alınınca HAZIRLANIYOR'a döner
  const prod = dwgUndoState(order({ status: 'URETIMDE', drawingTrack: 'ONAYLANDI', drawings: [rec('ONAYLANDI')] }));
  assert.deepEqual([prod.kind, prod.block, prod.production, prod.restoreStatus], ['READY', null, true, 'HAZIRLANIYOR']);
  assert.equal(dwgUndoState(order({ status: 'URETIMDE', onHold: true, drawingTrack: 'ONAYLANDI', drawings: [rec('ONAYLANDI')] })).block, 'UNDO_ON_HOLD');
  // Tamamlanmış sonraki adım: yüklendi / arşiv / gerçek yükleme tarihi → engel
  for (const status of SHIPPED_STATUSES) {
    assert.equal(dwgUndoState(order({ status, drawingTrack: 'ONAYLANDI', drawings: [rec('ONAYLANDI')] })).block, 'UNDO_SHIPPED', status);
    assert.equal(dwgUndoState(order({ status, onHold: true, drawingTrack: 'ONAYLANDI', drawings: [rec('ONAYLANDI')] })).block, 'UNDO_SHIPPED', `${status} beklemede`);
  }
  assert.equal(dwgUndoState(order({ status: 'URETIMDE', actualShipDate: new Date(), drawingTrack: 'ONAYLANDI', drawings: [rec('ONAYLANDI')] })).block, 'UNDO_SHIPPED', 'gerçek yükleme tarihi');
  const faulty = dwgUndoState(order({ drawingTrack: 'DUZELTME_BEKLIYOR', drawings: [rec('REVIZYON_ISTENDI')] }));
  assert.deepEqual([faulty.kind, faulty.variant, faulty.restoreTrack, faulty.block], ['FAULTY', 'RECORD', 'GEREKLI', null]);
  const update = dwgUndoState(order({ drawingTrack: 'YAPILIYOR', drawings: [rec('YAPILIYOR')] }));
  assert.deepEqual([update.kind, update.variant, update.restoreTrack, update.block], ['UPDATE', 'RECORD', 'GEREKLI', null]);
  // Hatalı kararından sonra verilen güncelleme: kayıt değişmez, müşterinin düzeltmesi yeniden beklenir
  const afterFaulty = dwgUndoState(order({ drawingTrack: 'YAPILIYOR', drawings: [rec('REVIZYON_ISTENDI')] }));
  assert.deepEqual([afterFaulty.kind, afterFaulty.variant, afterFaulty.restoreTrack, afterFaulty.block], ['UPDATE', 'AFTER_FAULTY', 'DUZELTME_BEKLIYOR', null]);
});

test('dwgUndoState: sonraki bağımlı işlem / kapanmış sipariş → engel ya da geri alınacak karar yok', () => {
  // Karar bekleyen kayıt, hiç kayıt yok, yalnızca fabrika sürümü → geri alınacak karar yok
  assert.equal(dwgUndoState(order({ drawingTrack: 'GEREKLI', drawings: [rec('BEKLIYOR')] })), null);
  assert.equal(dwgUndoState(order({ drawingTrack: 'GEREKLI', drawings: [] })), null);
  assert.equal(dwgUndoState(order({ drawingTrack: 'ONAY_BEKLIYOR', drawings: [factory('ONAY_BEKLIYOR', 1)] })), null);
  // Zaten geri alınmış karar (GERI_CEKILDI + yeni BEKLIYOR kaydı) ikinci kez geri alınamaz
  assert.equal(dwgUndoState(order({ drawingTrack: 'GEREKLI', drawings: [rec('GERI_CEKILDI'), rec('BEKLIYOR', { id: 'd2', version: 2 })] })), null);
  // Müşteri düzeltilmiş dosya gönderdi: hatalı kararının yerini yeni karar kaydı aldı
  assert.equal(dwgUndoState(order({ drawingTrack: 'GEREKLI', drawings: [rec('REVIZYON_ISTENDI'), rec('BEKLIYOR', { id: 'd2', version: 2 })] })), null);
  // Müşteri fabrikadan çizim istedi
  assert.equal(dwgUndoState(order({ drawingTrack: 'GEREKLI', drawings: [rec('REVIZYON_ISTENDI')] })).block, 'UNDO_CUSTOMER_ANSWERED');
  // Güncellemeden sonra fabrika sürümü (taslak / gönderilmiş / onaylı) → güncelleme geri alınmaz
  for (const st of ['TASLAK', 'ONAY_BEKLIYOR', 'ONAYLANDI']) {
    const s = dwgUndoState(order({ drawingTrack: st === 'TASLAK' ? 'YAPILIYOR' : st, drawings: [rec('YAPILIYOR'), factory(st)] }));
    assert.deepEqual([s.kind, s.block], ['UPDATE', 'UNDO_LATER_DRAWING'], st);
  }
  // Yüklendi / arşiv → üretim geri alınmaz; iptal / silinmiş / beklemede → kapalı
  assert.equal(dwgUndoState(order({ status: 'IPTAL', drawingTrack: 'ONAYLANDI', drawings: [rec('ONAYLANDI')] })).block, 'UNDO_CLOSED');
  assert.equal(dwgUndoState(order({ removedAt: new Date(), drawingTrack: 'DUZELTME_BEKLIYOR', drawings: [rec('REVIZYON_ISTENDI')] })).block, 'UNDO_CLOSED');
  assert.equal(dwgUndoState(order({ onHold: true, drawingTrack: 'ONAYLANDI', drawings: [rec('ONAYLANDI')] })).block, 'UNDO_ON_HOLD');
  // Hatalı / güncelleme yalnızca hazırlanırken (üretim yalnızca "üretime hazır" kararından)
  assert.equal(dwgUndoState(order({ status: 'URETIMDE', drawingTrack: 'DUZELTME_BEKLIYOR', drawings: [rec('REVIZYON_ISTENDI')] })).block, 'UNDO_CLOSED');
  assert.equal(dwgUndoState(order({ status: 'URETIMDE', drawingTrack: 'DUZELTME_BEKLIYOR', drawings: [rec('REVIZYON_ISTENDI')] })).production, false);
});

test('productionBlock / ownerBlock: tamamlanmış sonraki işlemler ve yetki; okunamayan değer engeldir', () => {
  const f = (x) => productionBlock({ lock: [], crates: 0, compensations: 0, ...x });
  assert.equal(f({}), null);
  // Fiilî üretim başlangıcı aranmaz (3.90.2): üretim olayı sayısı girdi değil
  assert.equal(f({ productionEvents: 5 }), null);
  assert.equal(f({ lock: [{ code: 'CONFIRMED_LOADING' }, { code: 'FGO_DOCUMENT' }] }), 'UNDO_LOADED');
  for (const code of ['FGO_DOCUMENT', 'BILLING_BATCH', 'PENDING_DOCUMENT']) assert.equal(f({ lock: [{ code }] }), 'UNDO_DOCUMENTS');
  assert.equal(f({ crates: 1 }), 'UNDO_CRATES');
  assert.equal(f({ compensations: 2 }), 'UNDO_COMPENSATION');
  // Eksik veri güvenli tarafta: bilinmeyen sayı / okunamayan kilit "üretim başlamadı" sayılmaz
  for (const bad of [{ crates: null }, { compensations: NaN }, { lock: undefined }, { crates: -1 }]) assert.notEqual(f(bad), null, JSON.stringify(bad));
  const ready = { kind: 'READY' };
  // "Üretime almayı geri al" (3.90.2): kararı veren çizimci, yönetici, yardımcı; başka çizimci yapamaz
  assert.equal(ownerBlock(ready, { id: 'a', role: 'ADMIN' }, 'u1'), null);
  assert.equal(ownerBlock(ready, { id: 'y', role: 'YONETICI_YARDIMCISI' }, 'u1'), null);
  assert.equal(ownerBlock(ready, { id: 'u1', role: 'CIZIM' }, 'u1'), null, 'kararı veren çizimci');
  assert.equal(ownerBlock(ready, { id: 'u2', role: 'CIZIM' }, 'u1'), 'UNDO_NOT_OWNER', 'başka çizimci');
  assert.equal(ownerBlock(ready, { id: 'u2', role: 'CIZIM' }, null), 'UNDO_NOT_OWNER', 'kararı vereni bilinmeyen kayıt');
  assert.deepEqual(ROLES.filter((r) => can(r, 'DRAWING_PRODUCTION_UNDO')), ['ADMIN', 'YONETICI_YARDIMCISI', 'CIZIM']);
  const prep = { kind: 'FAULTY' };
  assert.equal(ownerBlock(prep, { id: 'u1', role: 'CIZIM' }, 'u1'), null, 'kararı veren çizimci');
  assert.equal(ownerBlock(prep, { id: 'u2', role: 'CIZIM' }, 'u1'), 'UNDO_NOT_OWNER', 'başka çizimci');
  assert.equal(ownerBlock(prep, { id: 'u2', role: 'CIZIM' }, null), 'UNDO_NOT_OWNER');
  assert.equal(ownerBlock(prep, { id: 'a', role: 'ADMIN' }, 'u1'), null);
  assert.equal(ownerBlock(prep, { id: 'y', role: 'YONETICI_YARDIMCISI' }, 'u1'), null);
  // Hatalı / güncelleme: değişmedi (kararı veren çizimci, yönetici, yardımcı)
  assert.equal(ownerBlock({ kind: 'UPDATE' }, { id: 'u1', role: 'CIZIM' }, 'u1'), null);
  assert.equal(ownerBlock({ kind: 'UPDATE' }, { id: 'y', role: 'YONETICI_YARDIMCISI' }, 'u1'), null);
});

test('undoReason: zorunlu, en çok 1000 karakter, boşluklar düzenlenir', () => {
  assert.deepEqual(undoReason('  '), { ok: false, code: 'UNDO_REASON' });
  assert.deepEqual(undoReason(null), { ok: false, code: 'UNDO_REASON' });
  assert.deepEqual(undoReason('x'.repeat(UNDO_REASON_MAX + 1)), { ok: false, code: 'UNDO_REASON_LONG' });
  assert.deepEqual(undoReason('  Yanlış   sipariş \r\n\n\n\n ikinci  '), { ok: true, text: 'Yanlış sipariş\n\nikinci' });
  assert.equal(undoReason('x'.repeat(UNDO_REASON_MAX)).ok, true);
});

test('availableActions: geri alma yalnızca çizim yetkisiyle; müşteri, satış, denetimci göremez', () => {
  const base = { status: 'HAZIRLANIYOR', drawing: 'ONAYLANDI', offer: 'GONDERILDI' };
  const flags = drawingFlags({ status: 'HAZIRLANIYOR', drawingTrack: 'ONAYLANDI', onHold: false, drawings: [rec('ONAYLANDI')] });
  assert.equal(flags.dwgUndo, 'READY');
  // "Üretime almayı geri al": yönetici, yardımcı, çizimci (sahiplik işlemde)
  for (const role of ['ADMIN', 'YONETICI_YARDIMCISI', 'CIZIM']) assert.ok(availableActions({ role, ...base, ...flags }).includes('dwg_ready_undo'), role);
  // Hatalı / güncelleme geri alması çizimciye ve yardımcıya açık kalır (değişmedi)
  const fFlags = drawingFlags({ status: 'HAZIRLANIYOR', drawingTrack: 'DUZELTME_BEKLIYOR', onHold: false, drawings: [rec('REVIZYON_ISTENDI')] });
  for (const role of ['CIZIM', 'ADMIN', 'YONETICI_YARDIMCISI']) assert.ok(availableActions({ role, ...base, drawing: 'DUZELTME_BEKLIYOR', ...fFlags }).includes('dwg_faulty_undo'), role);
  for (const role of ['SATIS', 'MUSTERI', 'DENETIMCI']) assert.ok(!availableActions({ role, ...base, ...flags, canApprove: true }).some((a) => a.endsWith('_undo')), role);
  // Engelli durumda bayrak yok → düğme yok (sunucu ayrıca reddeder)
  assert.equal(drawingFlags({ status: 'YUKLENDI', drawingTrack: 'ONAYLANDI', onHold: false, drawings: [rec('ONAYLANDI')] }).dwgUndo, null);
  const prodFlags = drawingFlags({ status: 'URETIMDE', drawingTrack: 'ONAYLANDI', onHold: false, drawings: [rec('ONAYLANDI')] });
  assert.equal(prodFlags.dwgUndo, 'READY', 'üretimdeki sipariş: geri alınabilir (3.90.2)');
  for (const role of ['ADMIN', 'CIZIM']) assert.ok(availableActions({ role, ...base, status: 'URETIMDE', ...prodFlags }).includes('dwg_ready_undo'), role);
  for (const [kind, action] of Object.entries(UNDO_ACTIONS)) assert.deepEqual(REQUIRES[action], [action], kind);
});

test('olaylar, metinler ve müşteri görünümü (TR / RO)', () => {
  for (const kind of Object.keys(UNDO_ACTIONS)) {
    const ev = `DWG_${kind}_UNDONE`;
    assert.deepEqual(EVENTS[ev], { customer: true, note: false }, `${ev}: müşteri satırı görür, gerekçeyi görmez`);
    assert.ok(STAFF_EVENT_POLICY[ev], ev);
    for (const evs of [trEvents, roEvents]) assert.ok(evs[ev]?.label && evs[ev]?.customer, ev);
    for (const d of [tr, ro]) {
      assert.ok(d.dwg.undo.kinds[kind] && d.dwg.undo.submit[kind] && d.dwg.undo.notify[kind], kind);
      assert.ok(d.ok[`dwg_undo_${kind}`]);
    }
  }
  for (const d of [tr, ro]) assert.ok(d.ok.dwg_undo_READY_production && d.dwg.undo.targets.PRODUCTION && d.dwg.undo.targets.PENDING && d.dwg.undo.targets.FAULTY_WAIT);
  for (const d of [tr, ro]) {
    for (const b of UNDO_BLOCKS) assert.ok(d.dwg.undo.block[b], b);
    assert.ok(d.dwg.status.GERI_CEKILDI && d.errors.undoReason && d.errors.undoReasonLong);
    assert.ok(d.dwg.undo.confirm.includes('{decision}') && d.dwg.undo.confirm.includes('{target}'));
  }
  // Geri alınan karar kaydının gerekçesi müşteriye gelmez; fabrika sürümünün geri çekme gerekçesi değişmedi (karar 146)
  const undone = { ...rec('GERI_CEKILDI'), withdrawReason: 'iç gerekçe', files: [] };
  const withdrawn = { ...factory('GERI_CEKILDI', 2), withdrawReason: 'yanlış dosya', files: [{ id: 'x' }] };
  const [a, b] = drawingsView('MUSTERI', [undone, withdrawn]);
  assert.deepEqual([a.status, a.withdrawReason, a.sourceFiles], ['GERI_CEKILDI', null, null]);
  assert.deepEqual([b.withdrawReason, b.files], ['yanlış dosya', []]);
  assert.equal(drawingsView('CIZIM', [undone])[0].withdrawReason, 'iç gerekçe');
});

test('yapı: geri alma kayıt silmez; tek işlem gövdesi; bildirim kuralları', () => {
  const src = fs.readFileSync(new URL('../server/orders/transitions.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async function dwgUndo('), src.indexOf('const ACTIONS = {'));
  assert.ok(body.length > 100);
  assert.ok(!/\.delete(Many)?\(/.test(body), 'geri alma hiçbir satırı silmez');
  assert.ok(!/fgo|loadingConfirmation|crate\.(create|update)/i.test(body.replace(/priceLock/g, '')), 'üretim / yükleme / belge kaydına dokunmaz');
  assert.match(body, /status: rec\.status/, 'koşullu güncelleme: aynı karar iki kez geri alınamaz');
  assert.match(src, /dwg_ready_undo: \(order\) => \['loading-confirmation', `glass-billing:\$\{order\.id\}`, \.\.\.crateLockKeys\(order, dayKey\)\]/);
  // Sipariş durumunu yalnızca "üretimdeyse HAZIRLANIYOR'a döndür" yazar (3.90.2) — başka durum yazımı yok
  assert.match(body, /check\.production \? \{ status: check\.restoreStatus \}/);
  assert.ok(!/status:/.test(body.replace(/status: rec\.status|status: DWG_RESUBMITTED|status: 'GERI_CEKILDI'|status: created\.status|status: h\.status|status: h\.order\.status|status: check\.restoreStatus/g, '')), 'dwgUndo başka sipariş durumu yazmaz');
  // Fiilî üretim başlangıcı kaydı aranmaz (TAKİP'te yok)
  const rule = fs.readFileSync(new URL('../server/orders/dwg-undo.js', import.meta.url), 'utf8');
  assert.ok(!/orderEvent\.count|PRODUCTION_EVENTS/.test(rule));
  // Sandık kilidi = sandık yazanların anahtarı (crates:<gün>)
  const crates = fs.readFileSync(new URL('../server/loading/crates.js', import.meta.url), 'utf8');
  assert.match(crates, /crates:\$\{day\}/);
  assert.deepEqual(crateLockKeys({ estimatedShipDate: new Date('2026-11-02T00:00:00Z') }, dayKey), [`crates:${dayKey(new Date('2026-11-02T00:00:00Z'))}`]);
  assert.deepEqual(crateLockKeys({ actualShipDate: new Date('2026-11-03T00:00:00Z'), estimatedShipDate: new Date('2026-11-02T00:00:00Z') }, dayKey), [`crates:${dayKey(new Date('2026-11-03T00:00:00Z'))}`]);
  assert.deepEqual(crateLockKeys({}, dayKey), []);
});
