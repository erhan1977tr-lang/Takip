import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ORDER_STATUS, DRAWING, OFFER, EVENTS, availableActions, customerSummary, customerDrawingLabel, productionBlockers, shouldAutoProduce,
  nextShipDate, parseDateOnly, slaInfo, slaDeadline, maskName, offerLineTotals, offerTotals, fileProblem, stageIndex,
} from '../server/orders/rules.js';

const has = (p, a) => availableActions(p).includes(a);

test('her durumun etiketi var', () => {
  for (const s of ['YENI', 'HAZIRLANIYOR', 'URETIMDE', 'YUKLENDI', 'ARSIVLENDI', 'IPTAL']) assert.ok(ORDER_STATUS[s]?.label, s);
  for (const s of ['YOK', 'GEREKLI', 'YAPILIYOR', 'ONAY_BEKLIYOR', 'REVIZYON_ISTENDI', 'ONAYLANDI']) assert.ok(DRAWING[s]?.label, s);
  for (const s of ['NONE', 'HAZIRLANIYOR', 'YONETIMDE', 'GONDERILDI']) assert.ok(OFFER[s]?.label, s);
  for (const [k, v] of Object.entries(EVENTS)) assert.ok(v.label, k);
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
});

test('fiyat onayını yalnızca yönetici verir', () => {
  assert.ok(has({ role: 'ADMIN', status: 'HAZIRLANIYOR', offer: 'YONETIMDE' }, 'approve_price'));
  assert.ok(!has({ role: 'SATIS', status: 'HAZIRLANIYOR', offer: 'YONETIMDE' }, 'approve_price'));
  assert.ok(!has({ role: 'SATIS', status: 'HAZIRLANIYOR', offer: 'YONETIMDE' }, 'edit_offer'));
  assert.ok(has({ role: 'SATIS', status: 'HAZIRLANIYOR', offer: 'GONDERILDI' }, 'revise_offer'));
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
  assert.deepEqual(productionBlockers({ status: 'HAZIRLANIYOR', drawing: 'ONAY_BEKLIYOR', offer: 'YONETIMDE' }), ['Çizim müşteri onayında', 'Teklif yönetici onayında']);
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
  assert.deepEqual(availableActions({ role: 'CIZIM', status: 'HAZIRLANIYOR', drawing: 'GEREKLI' }), ['start_drawing', 'add_file']);
  assert.ok(has({ role: 'CIZIM', status: 'HAZIRLANIYOR', drawing: 'REVIZYON_ISTENDI' }, 'upload_drawing'));
  assert.ok(!has({ role: 'CIZIM', status: 'HAZIRLANIYOR', drawing: 'ONAY_BEKLIYOR' }, 'upload_drawing'));
  assert.ok(!has({ role: 'CIZIM', status: 'YENI' }, 'send_to_drawing'));
});

test('beklemede yalnızca beklemeden çıkarılabilir; kapanmış siparişte işlem yok', () => {
  assert.deepEqual(availableActions({ role: 'SATIS', status: 'HAZIRLANIYOR', onHold: true, drawing: 'GEREKLI' }), ['unhold']);
  assert.deepEqual(availableActions({ role: 'CIZIM', status: 'HAZIRLANIYOR', onHold: true, drawing: 'GEREKLI' }), []);
  assert.deepEqual(availableActions({ role: 'ADMIN', status: 'ARSIVLENDI' }), []);
  assert.deepEqual(availableActions({ role: 'SATIS', status: 'YUKLENDI' }), ['archive']);
  assert.ok(has({ role: 'SATIS', status: 'URETIMDE' }, 'mark_shipped'));
});

test('müşterinin gördüğü durum', () => {
  assert.equal(customerSummary({ status: 'HAZIRLANIYOR', drawing: 'ONAY_BEKLIYOR', offer: 'GONDERILDI' }).label, 'Onayınız bekleniyor');
  assert.equal(customerSummary({ status: 'HAZIRLANIYOR', drawing: 'ONAYLANDI', offer: 'GONDERILDI' }).label, 'Teklifiniz hazır');
  assert.equal(customerSummary({ status: 'HAZIRLANIYOR', drawing: 'YOK', offer: 'YONETIMDE' }).label, 'Hazırlanıyor');
  assert.equal(customerSummary({ status: 'URETIMDE' }).label, 'Onaylandı, üretimde');
  assert.equal(customerDrawingLabel('ONAYLANDI'), 'Onaylandı');
  assert.equal(customerDrawingLabel('YAPILIYOR'), 'Hazırlanıyor');
  assert.equal(customerDrawingLabel('ONAY_BEKLIYOR'), 'Onayınız bekleniyor');
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
  assert.equal(slaInfo(new Date('2026-09-29T01:00:00Z'), now).text, '15.0 sa kaldı');
  const late = slaInfo(new Date('2026-09-26T19:54:00Z'), now);
  assert.equal(late.text, '38.1 sa gecikme');
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
  assert.deepEqual(offerTotals([{ enMm: 1000, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: 10 }, { adet: 1, unit: 'adet', unitPrice: 5 }]), { metraj: 2, amount: 25, adet: 3 });
});

test('dosya kontrolü', () => {
  assert.equal(fileProblem('Darius.dwg', 38000), null);
  assert.match(fileProblem('virus.exe', 10), /desteklenmeyen/);
  assert.match(fileProblem('buyuk.zip', 101 * 1024 * 1024), /100 MB/);
});

test('adım çubuğu', () => {
  assert.equal(stageIndex('YENI'), 1);
  assert.equal(stageIndex('HAZIRLANIYOR'), 2);
  assert.equal(stageIndex('ARSIVLENDI'), 5);
});
