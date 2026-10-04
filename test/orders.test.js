import { test } from 'node:test';
import assert from 'node:assert/strict';
import tr from '../server/i18n/tr/index.js';
import ro from '../server/i18n/ro/index.js';
import { translate } from '../server/i18n/index.js';
import { ORDER_STATUS, DRAWING, OFFER, EVENTS, STAGES, availableActions, drawingFlags, customerSummary, productionBlockers, shouldAutoProduce, offerNeedsCheck, offerProblems, glassLoadingDate, parseDateOnly, slaInfo, slaDeadline, maskName, offerLineTotals, offerTotals, fileProblem, stageIndex, canSeeCustomerName, sharedOpsGlasses, splitOnePiece, atOfferPrice } from '../server/orders/rules.js';

const has = (p, a) => availableActions(p).includes(a);

test('her durumun etiketi var', () => {
  // Metinler sözlükte: her durum, olay ve aşama için iki dilde de metin olmalı
  for (const d of [tr, ro]) {
    for (const s of Object.keys(ORDER_STATUS)) assert.ok(d.status.order[s], s);
    for (const s of Object.keys(DRAWING)) assert.ok(d.status.drawing[s] && d.status.customerDrawing[s], s);
    for (const s of Object.keys(OFFER)) assert.ok(d.status.offer[s], s);
    for (const s of STAGES) assert.ok(d.status.stages[s], s);
    for (const [k, v] of Object.entries(EVENTS)) {
      assert.ok(d.events[k]?.label, k);
      assert.equal(Boolean(d.events[k].customer), v.customer, `${k}: müşteri metni`);
    }
    for (const k of ['reviewing', 'awaitingApproval', 'revision', 'drawing', 'offerReady', 'preparing', 'production', 'shipped', 'archived', 'cancelled']) {
      assert.ok(d.status.customer[k]?.label && d.status.customer[k]?.next, k);
    }
    for (const b of ['not_preparing', 'drawing_at_customer', 'drawing_not_done', 'offer_at_admin', 'offer_not_sent']) assert.ok(d.status.blockers[b], b);
  }
});

test('müşteri teklifi hiçbir durumda onaylayamaz, yalnızca çizimi onaylar', () => {
  for (const offer of [null, 'HAZIRLANIYOR', 'YONETIMDE', 'GONDERILDI']) {
    for (const drawing of ['YOK', 'GEREKLI', 'ONAY_BEKLIYOR', 'ONAYLANDI']) {
      const a = availableActions({ role: 'MUSTERI', status: 'HAZIRLANIYOR', canApprove: true, drawing, offer });
      assert.ok(!a.some((x) => /offer|production|price/.test(x)), `${drawing}/${offer}: ${a}`);
    }
  }
  assert.ok(has({ role: 'MUSTERI', status: 'HAZIRLANIYOR', canApprove: true, drawing: 'ONAY_BEKLIYOR' }, 'approve_drawing'));
  assert.ok(!has({ role: 'MUSTERI', status: 'HAZIRLANIYOR', canApprove: false, drawing: 'ONAY_BEKLIYOR' }, 'approve_drawing'));
  assert.ok(has({ role: 'MUSTERI', status: 'HAZIRLANIYOR', canApprove: true, drawing: 'ONAY_BEKLIYOR' }, 'request_revision'));
  // Onay ve revizyon aynı yetkiye bağlı (karar 84): onay yetkisi olmayan müşteri kullanıcısı ikisini de yapamaz
  assert.ok(!has({ role: 'MUSTERI', status: 'HAZIRLANIYOR', canApprove: false, drawing: 'ONAY_BEKLIYOR' }, 'request_revision'));
  assert.deepEqual(availableActions({ role: 'MUSTERI', status: 'HAZIRLANIYOR', canApprove: false, drawing: 'ONAY_BEKLIYOR' }), ['add_file']);
  // Onay kesindir: onaylanmış çizimde müşteriye onay / revizyon işlemi kalmaz
  assert.deepEqual(availableActions({ role: 'MUSTERI', status: 'HAZIRLANIYOR', canApprove: true, drawing: 'ONAYLANDI' }), ['add_file']);
  assert.deepEqual(availableActions({ role: 'MUSTERI', status: 'YENI' }), ['add_file']);
});

test('satış yeni siparişte karar verir: çizime gönder ya da çizimsiz teklif', () => {
  const a = availableActions({ role: 'SATIS', status: 'YENI' });
  assert.ok(a.includes('send_to_drawing') && a.includes('no_drawing') && a.includes('hold'));
  assert.ok(!a.includes('edit_offer'));
});

test('çizim sürerken satış teklifi yazabilir (hatlar bağımsız)', () => {
  for (const drawing of ['GEREKLI', 'YAPILIYOR', 'ONAY_BEKLIYOR', 'REVIZYON_ISTENDI']) {
    assert.ok(has({ role: 'SATIS', status: 'HAZIRLANIYOR', drawing, offer: 'HAZIRLANIYOR' }, 'submit_offer'), drawing);
  }
  // teklif müşteriye gitmişken de çizim sürebilir
  assert.ok(has({ role: 'CIZIM', status: 'HAZIRLANIYOR', drawing: 'YAPILIYOR', offer: 'GONDERILDI' }, 'upload_drawing'));
  assert.ok(has({ role: 'MUSTERI', status: 'HAZIRLANIYOR', canApprove: true, drawing: 'ONAY_BEKLIYOR', offer: 'GONDERILDI' }, 'approve_drawing'));
});

test('çizimsiz başlayan siparişe sonradan çizim istenebilir', () => {
  assert.ok(has({ role: 'SATIS', status: 'HAZIRLANIYOR', drawing: 'YOK', offer: 'HAZIRLANIYOR' }, 'send_to_drawing'));
  assert.ok(!has({ role: 'SATIS', status: 'HAZIRLANIYOR', drawing: 'YAPILIYOR' }, 'send_to_drawing'));
  assert.ok(!has({ role: 'SATIS', status: 'HAZIRLANIYOR', drawing: 'YOK', offer: 'YONETIMDE' }, 'send_to_drawing'));
  assert.ok(has({ role: 'ADMIN', status: 'HAZIRLANIYOR', drawing: 'YOK', offer: 'YONETIMDE' }, 'send_to_drawing'));
});

test('fiyat onayını yalnızca yönetici verir', () => {
  assert.ok(has({ role: 'ADMIN', status: 'HAZIRLANIYOR', offer: 'YONETIMDE' }, 'approve_price'));
  assert.ok(!has({ role: 'SATIS', status: 'HAZIRLANIYOR', offer: 'YONETIMDE' }, 'approve_price'));
  assert.ok(!has({ role: 'SATIS', status: 'HAZIRLANIYOR', offer: 'YONETIMDE' }, 'edit_offer'));
});

test('teklif satıştan çıktıktan sonra satış değişiklik yapamaz; müşterideki teklifi yalnızca yönetici günceller', () => {
  for (const offer of ['YONETIMDE', 'GONDERILDI']) {
    for (const drawing of ['YOK', 'GEREKLI', 'YAPILIYOR', 'ONAY_BEKLIYOR', 'REVIZYON_ISTENDI']) {
      const a = availableActions({ role: 'SATIS', status: 'HAZIRLANIYOR', drawing, offer });
      assert.ok(!a.some((x) => /offer|undo|send_to_drawing/.test(x)), `${drawing}/${offer}: ${a}`);
    }
  }
  assert.ok(has({ role: 'ADMIN', status: 'HAZIRLANIYOR', drawing: 'ONAY_BEKLIYOR', offer: 'GONDERILDI' }, 'update_offer'));
  assert.ok(has({ role: 'ADMIN', status: 'URETIMDE', drawing: 'ONAYLANDI', offer: 'GONDERILDI' }, 'update_offer'));
  assert.ok(!has({ role: 'ADMIN', status: 'HAZIRLANIYOR', offer: 'YONETIMDE' }, 'update_offer'));
  assert.ok(!has({ role: 'ADMIN', status: 'YUKLENDI', offer: 'GONDERILDI' }, 'update_offer'));
  assert.ok(!has({ role: 'SATIS', status: 'URETIMDE', offer: 'GONDERILDI' }, 'update_offer'));
});

test('satış kararını geri alma: teklif satıştayken ve çizim müşteriye gitmeden', () => {
  for (const drawing of ['GEREKLI', 'YAPILIYOR']) {
    for (const offer of [null, 'HAZIRLANIYOR']) assert.ok(has({ role: 'SATIS', status: 'HAZIRLANIYOR', drawing, offer }, 'undo_drawing'), `${drawing}/${offer}`);
  }
  for (const drawing of ['ONAY_BEKLIYOR', 'REVIZYON_ISTENDI', 'ONAYLANDI']) {
    assert.ok(!has({ role: 'SATIS', status: 'HAZIRLANIYOR', drawing, offer: 'HAZIRLANIYOR' }, 'undo_drawing'), drawing);
  }
  assert.ok(has({ role: 'SATIS', status: 'HAZIRLANIYOR', drawing: 'YOK', offer: 'HAZIRLANIYOR' }, 'undo_no_drawing'));
  assert.ok(!has({ role: 'SATIS', status: 'HAZIRLANIYOR', drawing: 'GEREKLI', offer: 'HAZIRLANIYOR' }, 'undo_no_drawing'));
  assert.ok(!has({ role: 'SATIS', status: 'YENI' }, 'undo_drawing'));
  assert.ok(!has({ role: 'CIZIM', status: 'HAZIRLANIYOR', drawing: 'GEREKLI' }, 'undo_drawing'));
  assert.ok(!has({ role: 'SATIS', status: 'HAZIRLANIYOR', onHold: true, drawing: 'GEREKLI' }, 'undo_drawing'));
});

test('teklif gönderildikten sonra yüklenen revize çizim teklif kontrolü ister', () => {
  const sentAt = new Date('2026-09-28T10:00:00Z');
  const v2 = { version: 2, createdAt: new Date('2026-09-28T12:00:00Z') };
  assert.equal(offerNeedsCheck({ offer: 'GONDERILDI', sentAt, lastDrawing: v2 }), true);
  assert.equal(offerNeedsCheck({ offer: 'GONDERILDI', sentAt, lastDrawing: { ...v2, version: 1 } }), false); // ilk çizim
  assert.equal(offerNeedsCheck({ offer: 'GONDERILDI', sentAt, lastDrawing: { version: 3, createdAt: new Date('2026-09-28T09:00:00Z') } }), false);
  assert.equal(offerNeedsCheck({ offer: 'GONDERILDI', sentAt, lastDrawing: v2, checkedAt: new Date('2026-09-28T13:00:00Z') }), false);
  assert.equal(offerNeedsCheck({ offer: 'YONETIMDE', sentAt, lastDrawing: v2 }), false);
  assert.equal(offerNeedsCheck({ offer: 'GONDERILDI', sentAt, lastDrawing: null }), false);
});

test('otomatik üretim: çizim onaylı ya da gereksiz + teklif müşteride; beklemede geçmez', () => {
  const auto = (drawing, offer, onHold = false) => shouldAutoProduce({ status: 'HAZIRLANIYOR', onHold, drawing, offer });
  assert.equal(auto('YOK', 'GONDERILDI'), true);
  assert.equal(auto('ONAYLANDI', 'GONDERILDI'), true);
  assert.equal(auto('ONAYLANDI', 'GONDERILDI', true), false);
  assert.equal(auto('ONAY_BEKLIYOR', 'GONDERILDI'), false);
  assert.equal(auto('YAPILIYOR', 'GONDERILDI'), false);
  assert.equal(auto('ONAYLANDI', 'YONETIMDE'), false);
  assert.equal(auto('ONAYLANDI', null), false);
  assert.equal(shouldAutoProduce({ status: 'YENI', drawing: 'YOK', offer: 'GONDERILDI' }), false);
  assert.equal(shouldAutoProduce({ status: 'URETIMDE', drawing: 'ONAYLANDI', offer: 'GONDERILDI' }), false);
  assert.deepEqual(productionBlockers({ status: 'HAZIRLANIYOR', drawing: 'ONAY_BEKLIYOR', offer: 'YONETIMDE' }), ['drawing_at_customer', 'offer_at_admin']);
});

test('elle üretime alma ve satışın reddetmesi yok; iptal yalnızca yönetici', () => {
  for (const role of ['SATIS', 'ADMIN', 'CIZIM', 'MUSTERI']) {
    const a = availableActions({ role, status: 'HAZIRLANIYOR', drawing: 'ONAYLANDI', offer: 'GONDERILDI', canApprove: true });
    assert.ok(!a.includes('mark_production'), role);
    assert.ok(!a.some((x) => /reject/.test(x)), role);
    assert.equal(a.includes('cancel'), role === 'ADMIN', role);
  }
  assert.ok(!availableActions({ role: 'SATIS', status: 'YENI' }).includes('cancel'));
});

test('çizim ekibi', () => {
  assert.deepEqual(availableActions({ role: 'CIZIM', status: 'HAZIRLANIYOR', drawing: 'GEREKLI' }), ['start_drawing', 'upload_drawing', 'add_file']);
  // Atanmışsa (tek çizimci → otomatik) üstlenmeye gerek yok
  assert.deepEqual(availableActions({ role: 'CIZIM', status: 'HAZIRLANIYOR', drawing: 'GEREKLI', assigned: true }), ['upload_drawing', 'add_file']);
  assert.ok(has({ role: 'CIZIM', status: 'HAZIRLANIYOR', drawing: 'REVIZYON_ISTENDI' }, 'upload_drawing'));
  // Taslak varsa: gönder / dosya çıkar; yoksa gönderilecek bir şey yok
  assert.ok(has({ role: 'CIZIM', status: 'HAZIRLANIYOR', drawing: 'YAPILIYOR', draft: true }, 'send_drawing'));
  assert.ok(has({ role: 'CIZIM', status: 'HAZIRLANIYOR', drawing: 'YAPILIYOR', draft: true }, 'remove_drawing_file'));
  assert.ok(!has({ role: 'CIZIM', status: 'HAZIRLANIYOR', drawing: 'YAPILIYOR' }, 'send_drawing'));
  // Müşteri onayındayken yeni yükleme yok; gönderilen sürüm geri çekilebilir
  assert.ok(!has({ role: 'CIZIM', status: 'HAZIRLANIYOR', drawing: 'ONAY_BEKLIYOR' }, 'upload_drawing'));
  assert.ok(has({ role: 'CIZIM', status: 'HAZIRLANIYOR', drawing: 'ONAY_BEKLIYOR' }, 'withdraw_drawing'));
  assert.ok(!has({ role: 'SATIS', status: 'HAZIRLANIYOR', drawing: 'ONAY_BEKLIYOR' }, 'withdraw_drawing'));
  assert.ok(!has({ role: 'MUSTERI', status: 'HAZIRLANIYOR', drawing: 'ONAY_BEKLIYOR' }, 'withdraw_drawing'));
  assert.deepEqual(drawingFlags({ assignedDrawerId: 'u', drawings: [{ status: 'REVIZYON_ISTENDI' }, { status: 'TASLAK' }] }), { draft: true, assigned: true });
  assert.deepEqual(drawingFlags({ assignedDrawerId: null, drawings: [] }), { draft: false, assigned: false });
  assert.ok(!has({ role: 'CIZIM', status: 'YENI' }, 'send_to_drawing'));
});

test('beklemede yalnızca beklemeden çıkarılabilir; kapanmış siparişte işlem yok', () => {
  assert.deepEqual(availableActions({ role: 'SATIS', status: 'HAZIRLANIYOR', onHold: true, drawing: 'GEREKLI' }), ['unhold']);
  assert.deepEqual(availableActions({ role: 'CIZIM', status: 'HAZIRLANIYOR', onHold: true, drawing: 'GEREKLI' }), []);
  assert.deepEqual(availableActions({ role: 'ADMIN', status: 'ARSIVLENDI' }), []);
  // Sandıklar sipariş sayfasında değil, yükleme sekmesinde girilir (server/loading/crates.js)
  assert.deepEqual(availableActions({ role: 'SATIS', status: 'YUKLENDI' }), ['archive']);
  assert.ok(has({ role: 'SATIS', status: 'URETIMDE' }, 'mark_shipped'));
});

test('müşterinin gördüğü durum', () => {
  const label = (p) => tr.status.customer[customerSummary(p).key].label;
  assert.equal(label({ status: 'HAZIRLANIYOR', drawing: 'ONAY_BEKLIYOR', offer: 'GONDERILDI' }), 'Çizim onay bekliyor');
  assert.equal(label({ status: 'HAZIRLANIYOR', drawing: 'ONAYLANDI', offer: 'GONDERILDI' }), 'Teklifiniz hazır');
  assert.equal(label({ status: 'HAZIRLANIYOR', drawing: 'YOK', offer: 'YONETIMDE' }), 'Hazırlanıyor');
  assert.equal(label({ status: 'URETIMDE' }), 'Onaylandı, üretimde');
  assert.equal(customerSummary({ status: 'HAZIRLANIYOR', drawing: 'ONAY_BEKLIYOR' }).tone, 'warn');
  assert.equal(ro.status.customer[customerSummary({ status: 'URETIMDE' }).key].label, 'Aprobată, în producție');
});

test('SLA: en yakın son tarih; beklemede ve müşteri onayında işlemez', () => {
  const t = new Date('2026-09-28T10:00:00Z');
  assert.equal(slaDeadline({ status: 'YENI', createdAt: t }).toISOString(), '2026-09-29T10:00:00.000Z');
  assert.equal(slaDeadline({ status: 'YENI', createdAt: t, onHold: true }), null);
  const d = slaDeadline({ status: 'HAZIRLANIYOR', createdAt: t, drawing: 'YAPILIYOR', drawingSince: t, offer: 'HAZIRLANIYOR', offerSince: new Date('2026-09-28T12:00:00Z') });
  assert.equal(d.toISOString(), '2026-09-29T12:00:00.000Z'); // teklif 24 sa < çizim 48 sa
  assert.equal(slaDeadline({ status: 'HAZIRLANIYOR', createdAt: t, drawing: 'ONAY_BEKLIYOR', drawingSince: t, offer: 'GONDERILDI', offerSince: t }), null);
  assert.equal(slaDeadline({ status: 'URETIMDE', createdAt: t }), null);
});

test('SLA metni', () => {
  const now = new Date('2026-09-28T10:00:00Z');
  const soon = slaInfo(new Date('2026-09-29T01:00:00Z'), now);
  assert.equal(soon.h, '15.0');
  assert.equal(translate('tr', soon.over ? 'status.sla.late' : 'status.sla.left', { h: soon.h }), '15.0 sa kaldı');
  const late = slaInfo(new Date('2026-09-26T19:54:00Z'), now);
  assert.equal(late.h, '38.1');
  assert.equal(translate('tr', 'status.sla.late', { h: late.h }), '38.1 sa gecikme');
  assert.equal(translate('ro', 'status.sla.late', { h: late.h }), '38.1 h întârziere');
  assert.equal(late.over, true);
  assert.equal(slaInfo(new Date('2026-09-28T13:00:00Z'), now).risk, true);
  assert.equal(slaInfo(null), null);
});

test('CAM tahmini yükleme: Çarşamba–Salı dönemi → kesin örnekler; Çarşamba yeni dönem, Salı dönemin son günü', () => {
  const day = (iso, tz) => glassLoadingDate(new Date(iso), tz).toISOString().slice(0, 10);
  for (const d of ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06']) {
    assert.equal(day(`${d}T10:00:00Z`), '2026-10-23', d);
  }
  for (const d of ['2026-10-07', '2026-10-10', '2026-10-13']) assert.equal(day(`${d}T10:00:00Z`), '2026-10-30', d);
  assert.equal(day('2026-09-29T10:00:00Z'), '2026-10-16', 'Salı: önceki dönemin son günü');
  // Saat dilimi sınırı: Bükreş'te Çarşamba 00:30 (UTC Salı 21:30) yeni dönemdir
  assert.equal(day('2026-10-06T21:30:00Z', 'Europe/Bucharest'), '2026-10-30');
  assert.equal(day('2026-10-06T20:30:00Z', 'Europe/Bucharest'), '2026-10-23', 'Salı 23:30 hâlâ eski dönem');
  assert.equal(glassLoadingDate(new Date('2026-10-01T10:00:00Z')).getUTCDay(), 5, 'Cuma');
});

test('tarih ayrıştırma', () => {
  assert.equal(parseDateOnly('2026-10-16').toISOString(), '2026-10-16T12:00:00.000Z');
  assert.equal(parseDateOnly('2026-02-30'), null);
  assert.equal(parseDateOnly('16.10.2026'), null);
});

test('müşteri adı maskeleme', () => {
  assert.equal(maskName('Mirela Construct'), 'Mir**********');
});

test('teklif satırı: m² ve adet', () => {
  assert.deepEqual(offerLineTotals({ enMm: 1000, boyMm: 2000, adet: 3, unit: 'm2', unitPrice: '41,5' }), { metraj: 6, amount: 249 });
  assert.deepEqual(offerLineTotals({ adet: 4, unit: 'adet', unitPrice: 12.5 }), { metraj: 0, amount: 50 });
  assert.deepEqual(offerTotals([{ enMm: 1000, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: 10 }, { adet: 1, unit: 'adet', unitPrice: 5 }]), { metraj: 2, amount: 25, adet: 3, cnc: 0, delik: 0 });
});

test('CNC / delik satırları ve bedelsiz', () => {
  const lines = [
    { kind: 'CAM', description: '8mm', enMm: 1000, boyMm: 2000, adet: 1, unit: 'm2', unitPrice: '24' }, // 2 m² × 24 = 48 (işlemli cam tek adettir)
    { kind: 'CNC', description: '', enMm: 1000, boyMm: 2000, adet: 2, unit: 'adet', unitPrice: '15' }, // 30, metraja girmez
    { kind: 'DELIK', description: '', adet: 12, unit: 'adet', unitPrice: '2', free: true }, // bedelsiz
  ];
  assert.deepEqual(offerTotals(lines), { metraj: 2, amount: 78, adet: 1, cnc: 2, delik: 12 });
  assert.deepEqual(offerProblems(lines), []);
  const p = offerProblems([lines[0], { ...lines[1], unitPrice: '' }, { ...lines[2], free: false, unitPrice: '0' }]);
  assert.equal(p.length, 1);
  assert.deepEqual(p, [{ code: 'missing_prices', rows: [{ n: 1, kind: 'CNC' }, { n: 1, kind: 'DELIK' }] }]);
  assert.deepEqual(offerProblems([lines[1]]).map((x) => x.code), ['sub_without_glass']);
  assert.deepEqual(offerProblems([{ ...lines[0], enMm: null }]), [{ code: 'missing_dims', row: { n: 1, kind: 'CAM' } }]);
  assert.deepEqual(offerProblems([]), [{ code: 'no_lines' }]);
});

// Karar 113: CNC / delik TEK bir fiziksel cama aittir
test('işlem sahipliği: adedi 1\'den büyük cam satırına bağlı CNC / delik belirsizdir; işlemsiz camlar adetle durabilir', () => {
  const glass = (adet, extra = {}) => ({ kind: 'CAM', description: 'Temper', enMm: 1000, boyMm: 2000, adet, unit: 'm2', unitPrice: '24', offerPrice: '40', ...extra });
  const hole = (adet = 2) => ({ kind: 'DELIK', description: '', adet, unit: 'adet', unitPrice: '2', offerPrice: '3' });
  const cnc = (adet = 1) => ({ kind: 'CNC', description: 'Kulp', adet, unit: 'adet', unitPrice: '15', offerPrice: '20' });
  // "5 cam + 3 delik": hangi camda hangi delik olduğu bilinmez
  const bad = [glass(5), hole(3)];
  assert.deepEqual(sharedOpsGlasses(bad), [0]);
  assert.deepEqual(offerProblems(bad), [{ code: 'ops_multi_glass', rows: [{ n: 1, kind: 'CAM', desc: 'Temper' }] }]);
  // İşlemsiz camlar adetle; işlemli cam tek adet: sorun yok. Excel'den aktarılan satır da olağan cam satırıdır.
  const imported = { ...glass(12), description: 'Lamine', enMm: 800, boyMm: 600 };
  const good = [glass(4), glass(1), cnc(), hole(), imported];
  assert.deepEqual([sharedOpsGlasses(good), offerProblems(good)], [[], []]);
  // Birden çok belirsiz satır: her biri bir kez; metin biçiminde gelen adet de sayılır; adetli (m² olmayan) satır da cam satırıdır
  assert.deepEqual(sharedOpsGlasses([glass('3'), cnc(), hole(), glass(1), hole(), { ...glass(2), unit: 'adet' }, cnc()]), [0, 5]);
  assert.deepEqual(sharedOpsGlasses([hole(), glass(1)]), [], 'üstünde cam olmayan işlem ayrı bir sorundur (sub_without_glass)');
});

test('işlem eklenirken cam ayrılır: adet 5 → 4 + 1; toplam adet, m², birim fiyatlar ve tutarlar aynı kalır', () => {
  const g = { key: 1, id: 'L1', kind: 'CAM', description: 'Temper', enMm: 1000, boyMm: 2000, adet: 5, unit: 'm2', unitPrice: '24', offerPrice: '40' };
  const other = { key: 2, id: 'L2', kind: 'CAM', description: 'Lamine', enMm: 500, boyMm: 500, adet: 2, unit: 'm2', unitPrice: '30', offerPrice: '50' };
  const before = [g, other];
  const r = splitOnePiece(before, 0, (l) => ({ ...l, key: 9, id: '', from: l.id }));
  assert.equal(r.split, true);
  assert.deepEqual(r.lines.map((l) => [l.id, l.adet, l.unitPrice, l.offerPrice, l.from ?? null]), [['L1', 4, '24', '40', null], ['', 1, '24', '40', 'L1'], ['L2', 2, '30', '50', null]]);
  assert.equal(r.index, 1, 'işlem ayrılan tek camın altına eklenir');
  assert.equal(before[0].adet, 5, 'girdi değişmez');
  // Toplamlar: satış fiyatıyla ve müşteri fiyatıyla aynı
  assert.deepEqual(offerTotals(r.lines), offerTotals(before));
  assert.deepEqual(offerTotals(atOfferPrice(r.lines)), offerTotals(atOfferPrice(before)));
  assert.deepEqual(offerTotals(r.lines), { metraj: 10.5, amount: 255, adet: 7, cnc: 0, delik: 0 });
  // İşlem eklendikten sonra kural sağlanır
  const withOp = [...r.lines.slice(0, 2), { kind: 'DELIK', adet: 2, unit: 'adet', unitPrice: '2', offerPrice: '3' }, ...r.lines.slice(2)];
  assert.deepEqual([sharedOpsGlasses(withOp), offerProblems(withOp)], [[], []]);
  assert.equal(offerTotals(withOp).adet, 7, 'fiziksel cam adedi değişmedi');
  // Adedi 1 olan cam ayrılmaz; metin adet (form) metin kalır; ayrılan cam, satırın kendi alt satırlarının ALTINA gelir
  assert.deepEqual(splitOnePiece([{ ...g, adet: 1 }], 0), { lines: [{ ...g, adet: 1 }], index: 0, split: false });
  const text = splitOnePiece([{ ...g, adet: '3' }, { kind: 'CNC', adet: '1' }, other], 0);
  assert.deepEqual(text.lines.map((l) => [l.kind, l.adet]), [['CAM', '2'], ['CNC', '1'], ['CAM', '1'], ['CAM', 2]]);
  assert.equal(text.index, 2);
  // İşlem satırı ayrılmaz
  assert.equal(splitOnePiece([g, { kind: 'CNC', adet: 4 }], 1).split, false);
});

test('dosya kontrolü', () => {
  assert.equal(fileProblem('Darius.dwg', 38000), null);
  assert.deepEqual(fileProblem('virus.exe', 10), { code: 'type', name: 'virus.exe' });
  assert.deepEqual(fileProblem('bos.pdf', 0), { code: 'empty', name: 'bos.pdf' });
  assert.deepEqual(fileProblem('buyuk.zip', 101 * 1024 * 1024), { code: 'size', name: 'buyuk.zip' });
});

test('adım çubuğu', () => {
  assert.equal(stageIndex('YENI'), 1);
  assert.equal(stageIndex('HAZIRLANIYOR'), 2);
  assert.equal(stageIndex('ARSIVLENDI'), 5);
});

test('denetimci: hiçbir durumda işlem yapamaz (karar 8)', () => {
  for (const status of ['YENI', 'HAZIRLANIYOR', 'URETIMDE', 'YUKLENDI', 'ARSIVLENDI', 'IPTAL']) {
    for (const drawing of ['YOK', 'GEREKLI', 'YAPILIYOR', 'ONAY_BEKLIYOR', 'REVIZYON_ISTENDI', 'ONAYLANDI']) {
      for (const offer of [null, 'HAZIRLANIYOR', 'YONETIMDE', 'GONDERILDI']) {
        for (const onHold of [false, true]) {
          assert.deepEqual(availableActions({ role: 'DENETIMCI', status, drawing, offer, onHold, canApprove: true }), [], `${status}/${drawing}/${offer}/${onHold}`);
        }
      }
    }
  }
});

test('maskeleme: denetimci tam adı görür, satış ve çizim görmez', () => {
  assert.equal(canSeeCustomerName('DENETIMCI'), true);
  assert.equal(canSeeCustomerName('SATIS'), false);
  assert.equal(canSeeCustomerName('CIZIM'), false);
  assert.equal(maskName('GLASSANDMORE'), 'GLA**********');
  assert.equal(maskName('ALEGRAD'), 'ALE**********');
});
