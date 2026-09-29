import { test } from 'node:test';
import assert from 'node:assert/strict';
import tr from '../server/i18n/tr/index.js';
import ro from '../server/i18n/ro/index.js';
import { translate } from '../server/i18n/index.js';
import {
  ORDER_STATUS, DRAWING, OFFER, EVENTS, STAGES, availableActions, drawingFlags, customerSummary, productionBlockers, shouldAutoProduce, offerNeedsCheck, offerProblems,
  nextShipDate, parseDateOnly, slaInfo, slaDeadline, maskName, offerLineTotals, offerTotals, fileProblem, stageIndex, canSeeCustomerName,
} from '../server/orders/rules.js';

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
  assert.ok(has({ role: 'MUSTERI', status: 'HAZIRLANIYOR', canApprove: false, drawing: 'ONAY_BEKLIYOR' }, 'request_revision'));
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
  assert.equal(label({ status: 'HAZIRLANIYOR', drawing: 'ONAY_BEKLIYOR', offer: 'GONDERILDI' }), 'Onayınız bekleniyor');
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

test('tahmini yükleme: en az 14 gün sonraki ilk cuma', () => {
  assert.equal(nextShipDate(new Date('2026-09-28T10:00:00Z')).toISOString().slice(0, 10), '2026-10-16');
  assert.equal(nextShipDate(new Date('2026-10-02T09:00:00Z')).toISOString().slice(0, 10), '2026-10-16');
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
    { kind: 'CAM', description: '8mm', enMm: 1000, boyMm: 2000, adet: 3, unit: 'm2', unitPrice: '24' }, // 6 m² × 24 = 144
    { kind: 'CNC', description: '', enMm: 1000, boyMm: 2000, adet: 2, unit: 'adet', unitPrice: '15' }, // 30, metraja girmez
    { kind: 'DELIK', description: '', adet: 12, unit: 'adet', unitPrice: '2', free: true }, // bedelsiz
  ];
  assert.deepEqual(offerTotals(lines), { metraj: 6, amount: 174, adet: 3, cnc: 2, delik: 12 });
  assert.deepEqual(offerProblems(lines), []);
  const p = offerProblems([lines[0], { ...lines[1], unitPrice: '' }, { ...lines[2], free: false, unitPrice: '0' }]);
  assert.equal(p.length, 1);
  assert.deepEqual(p, [{ code: 'missing_prices', rows: [{ n: 1, kind: 'CNC' }, { n: 1, kind: 'DELIK' }] }]);
  assert.deepEqual(offerProblems([lines[1]]).map((x) => x.code), ['sub_without_glass']);
  assert.deepEqual(offerProblems([{ ...lines[0], enMm: null }]), [{ code: 'missing_dims', row: { n: 1, kind: 'CAM' } }]);
  assert.deepEqual(offerProblems([]), [{ code: 'no_lines' }]);
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
