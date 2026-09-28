import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS, availableActions, nextShipDate, parseDateOnly, slaInfo, slaDeadlineFor, maskName,
  offerLineTotals, offerTotals, fileProblem, stageIndex, whoseTurn,
} from '../server/orders/rules.js';

test('her durumun etiketi var', () => {
  for (const s of ['YENI','CIZIM_GEREKLI','CIZIM_YAPILIYOR','DXF_DWG_GELDI','ONAY_BEKLIYOR','REVIZYON_ISTENDI','TEKLIF_HAZIRLANIYOR','FIYAT_BEKLIYOR','FIYATLANDI','URETIMDE','ESKALASYON','YUKLENDI','ARSIVLENDI','IPTAL']) {
    assert.ok(STATUS[s]?.label && STATUS[s]?.customer, s);
  }
});

test('tahmini yükleme: en az 14 gün sonraki ilk cuma', () => {
  const d = nextShipDate(new Date('2026-09-28T10:00:00Z')); // pazartesi
  assert.equal(d.toISOString().slice(0, 10), '2026-10-16');
  assert.equal(d.getUTCDay(), 5);
  // tam 14 gün sonrası cumaya denk gelirse o gün
  assert.equal(nextShipDate(new Date('2026-10-02T09:00:00Z')).toISOString().slice(0, 10), '2026-10-16');
});

test('tarih ayrıştırma', () => {
  assert.equal(parseDateOnly('2026-10-16').toISOString(), '2026-10-16T12:00:00.000Z');
  assert.equal(parseDateOnly('2026-02-30'), null);
  assert.equal(parseDateOnly('16.10.2026'), null);
});

test('SLA metni', () => {
  const now = new Date('2026-09-28T10:00:00Z');
  assert.equal(slaInfo(new Date('2026-09-29T01:00:00Z'), now).text, '15.0 sa kaldı');
  const late = slaInfo(new Date('2026-09-26T19:54:00Z'), now);
  assert.equal(late.text, '38.1 sa gecikme');
  assert.equal(late.over, true);
  assert.equal(slaInfo(new Date('2026-09-28T13:00:00Z'), now).risk, true);
  assert.equal(slaInfo(null), null);
  assert.equal(slaDeadlineFor('URETIMDE'), null);
  assert.equal(slaDeadlineFor('YENI', now).toISOString(), '2026-09-29T10:00:00.000Z');
});

test('müşteri adı maskeleme', () => {
  assert.equal(maskName('Mirela Construct'), 'Mir**********');
  assert.equal(maskName('AB'), 'AB**********');
});

test('teklif satırı: m² ve adet', () => {
  assert.deepEqual(offerLineTotals({ enMm: 1000, boyMm: 2000, adet: 3, unit: 'm2', unitPrice: '41,5' }), { metraj: 6, amount: 249 });
  assert.deepEqual(offerLineTotals({ enMm: 1234, boyMm: 567, adet: 1, unit: 'm2', unitPrice: 10 }), { metraj: 0.7, amount: 7 });
  assert.deepEqual(offerLineTotals({ adet: 4, unit: 'adet', unitPrice: 12.5 }), { metraj: 0, amount: 50 });
  assert.deepEqual(offerLineTotals({ enMm: '', boyMm: '', adet: 1, unit: 'm2', unitPrice: 41.5 }), { metraj: 0, amount: 0 });
  assert.deepEqual(offerTotals([{ enMm: 1000, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: 10 }, { adet: 1, unit: 'adet', unitPrice: 5 }]), { metraj: 2, amount: 25, adet: 3 });
});

test('dosya kontrolü', () => {
  assert.equal(fileProblem('Darius.dwg', 38000), null);
  assert.equal(fileProblem('plan.PDF', 1), null);
  assert.match(fileProblem('virus.exe', 10), /desteklenmeyen/);
  assert.match(fileProblem('buyuk.zip', 101 * 1024 * 1024), /100 MB/);
  assert.match(fileProblem('bos.pdf', 0), /boş/);
});

test('yetkiler: satış yeni siparişte karar verir, müşteri veremez', () => {
  const s = availableActions({ role: 'SATIS', status: 'YENI' });
  assert.ok(s.includes('send_to_drawing') && s.includes('start_offer') && s.includes('hold'));
  assert.ok(!s.includes('approve_price'));
  const m = availableActions({ role: 'MUSTERI', status: 'YENI' });
  assert.deepEqual(m, ['add_file']);
});

test('yetkiler: fiyat onayını yalnızca yönetici verir', () => {
  assert.ok(availableActions({ role: 'ADMIN', status: 'FIYAT_BEKLIYOR' }).includes('approve_price'));
  assert.ok(!availableActions({ role: 'SATIS', status: 'FIYAT_BEKLIYOR' }).includes('approve_price'));
});

test('yetkiler: çizim onayı yalnızca onay yetkili müşteride', () => {
  assert.deepEqual(availableActions({ role: 'MUSTERI', status: 'ONAY_BEKLIYOR', canApprove: true }).slice(0, 2), ['approve_drawing', 'request_revision']);
  assert.ok(!availableActions({ role: 'MUSTERI', status: 'ONAY_BEKLIYOR', canApprove: false }).includes('approve_drawing'));
  assert.ok(availableActions({ role: 'MUSTERI', status: 'FIYATLANDI', canApprove: true }).includes('accept_offer'));
  assert.ok(!availableActions({ role: 'MUSTERI', status: 'FIYATLANDI', canApprove: false }).includes('accept_offer'));
});

test('yetkiler: çizim ekibi', () => {
  assert.deepEqual(availableActions({ role: 'CIZIM', status: 'CIZIM_GEREKLI' }), ['start_drawing', 'add_file']);
  assert.ok(availableActions({ role: 'CIZIM', status: 'REVIZYON_ISTENDI' }).includes('upload_drawing'));
  assert.ok(!availableActions({ role: 'CIZIM', status: 'YENI' }).includes('start_offer'));
});

test('yetkiler: beklemede yalnızca beklemeden çıkarılabilir', () => {
  assert.deepEqual(availableActions({ role: 'SATIS', status: 'YENI', onHold: true }), ['unhold']);
  assert.deepEqual(availableActions({ role: 'CIZIM', status: 'CIZIM_GEREKLI', onHold: true }), []);
});

test('yetkiler: kapanmış siparişte işlem yok', () => {
  assert.deepEqual(availableActions({ role: 'ADMIN', status: 'ARSIVLENDI' }), []);
  assert.deepEqual(availableActions({ role: 'SATIS', status: 'YUKLENDI' }), ['archive']);
});

test('adım çubuğu ve sıradaki taraf', () => {
  assert.equal(stageIndex('YENI'), 1);
  assert.equal(stageIndex('REVIZYON_ISTENDI'), 2);
  assert.equal(stageIndex('FIYATLANDI'), 3);
  assert.equal(stageIndex('ARSIVLENDI'), 6);
  assert.equal(whoseTurn('FIYAT_BEKLIYOR'), 'Sistem yöneticisi');
  assert.equal(whoseTurn('YENI', true), 'Beklemede');
});
