// Müşterinin DWG/DXF çizimi için çizimci kararı — saf kurallar (karar 167; server/orders/dwg-review.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOMER_DRAWING_EXT, DWG_DECISION_STATUS, DWG_NOTE_MAX, DWG_RESUBMITTED, DWG_SOURCE, customerDrawingFiles, dwgNote, dwgReview,
  hasCustomerDrawingFile, isCustomerDrawingFile, isCustomerDrawingRecord, lastProductionDrawing, sourceFilesOf, sourceFilesSnapshot,
} from '../server/orders/dwg-review.js';

const file = (name, extra = {}) => ({ id: `f-${name}`, name, kind: 'CUSTOMER', scanStatus: 'CLEAN', checksum: `sum-${name}`, ...extra });
const order = (extra = {}) => ({ status: 'HAZIRLANIYOR', drawingTrack: 'GEREKLI', onHold: false, files: [file('plan.dwg')], drawings: [], ...extra });

test('müşteri çizimi: yalnızca DWG / DXF uzantısı, büyük-küçük harf fark etmez; iç ve virüslü dosya sayılmaz', () => {
  assert.deepEqual([...CUSTOMER_DRAWING_EXT], ['dwg', 'dxf']);
  for (const n of ['a.dwg', 'A.DWG', 'plan.v2.Dxf']) assert.equal(isCustomerDrawingFile(n), true, n);
  for (const n of ['a.pdf', 'dwg', '.dwg', 'a.dwg.pdf', 'a.dwgx', '', null, undefined, 7]) assert.equal(isCustomerDrawingFile(n), false, String(n));
  const files = [file('a.dwg'), file('b.pdf'), file('c.dxf', { kind: 'INTERNAL' }), file('d.dxf', { scanStatus: 'INFECTED' }), file('e.DXF', { scanStatus: 'PENDING' })];
  assert.deepEqual(customerDrawingFiles(files).map((f) => f.name), ['a.dwg', 'e.DXF']);
  assert.deepEqual(customerDrawingFiles(null), []);
  assert.equal(hasCustomerDrawingFile([{ name: 'x.pdf' }, { name: 'y.DWG' }]), true);
  assert.equal(hasCustomerDrawingFile([{ name: 'x.pdf' }]), false);
  assert.equal(hasCustomerDrawingFile(null), false);
});

test('kararın dosyaları değişmez kopyadır; bozuk kayıt boş liste olur', () => {
  const snap = sourceFilesSnapshot([file('a.dwg'), { id: 7, name: 'b.dxf' }]);
  assert.deepEqual(snap, [{ id: 'f-a.dwg', name: 'a.dwg', checksum: 'sum-a.dwg' }, { id: '7', name: 'b.dxf', checksum: null }]);
  assert.deepEqual(sourceFilesOf(snap), snap);
  assert.deepEqual(sourceFilesOf([{ id: 'x' }, null, { id: 'y', name: 'y.dwg', checksum: 5 }, 'z']), [{ id: 'y', name: 'y.dwg', checksum: null }]);
  for (const bad of [null, undefined, {}, 'x', 3]) assert.deepEqual(sourceFilesOf(bad), []);
  assert.equal(isCustomerDrawingRecord({ source: DWG_SOURCE }), true);
  assert.equal(isCustomerDrawingRecord({ source: 'FABRIKA' }), false);
  assert.equal(isCustomerDrawingRecord(null), false);
});

test('karar bekleniyor mu: ilk karar (hiç sürüm yok + DWG/DXF), düzeltilmiş dosya (son kayıt BEKLIYOR); öbür her durumda hayır', () => {
  const first = dwgReview(order());
  assert.equal(first.pending, true);
  assert.equal(first.record, null);
  assert.deepEqual(first.files.map((f) => f.name), ['plan.dwg']);
  assert.equal(dwgReview(order({ drawingTrack: 'YAPILIYOR' })).pending, true, 'çizimci üstlendi ama sürüm yüklemedi');
  for (const track of ['YOK', 'ONAY_BEKLIYOR', 'REVIZYON_ISTENDI', 'ONAYLANDI', 'DUZELTME_BEKLIYOR']) assert.equal(dwgReview(order({ drawingTrack: track })).pending, false, track);
  for (const status of ['YENI', 'URETIMDE', 'YUKLENDI', 'ARSIVLENDI', 'IPTAL']) assert.equal(dwgReview(order({ status })).pending, false, status);
  assert.equal(dwgReview(order({ onHold: true })).pending, false, 'beklemede karar verilmez');
  assert.equal(dwgReview(order({ files: [file('plan.pdf')] })).pending, false, 'DWG/DXF yok');
  assert.equal(dwgReview(null).pending, false);
  // Herhangi bir sürüm (fabrika taslağı dahil) varsa ilk karar verilmiş / çizim olağan akışta
  assert.equal(dwgReview(order({ drawings: [{ id: 'd1', source: 'FABRIKA', status: 'TASLAK' }] })).pending, false);
  assert.equal(dwgReview(order({ drawings: [{ id: 'd1', source: DWG_SOURCE, status: 'YAPILIYOR' }] })).pending, false);
  // Liste sorgusu taslakları getirmez: bütün sürümlerin sayısı drawingCount ya da Prisma'nın _count.drawings alanından
  assert.equal(dwgReview(order({ drawings: [], drawingCount: 1 })).pending, false);
  assert.equal(dwgReview(order({ drawings: [], _count: { drawings: 1 } })).pending, false);
  assert.equal(dwgReview(order({ drawings: [], _count: { drawings: 0 } })).pending, true);
  // Düzeltilmiş dosya: kararın dosyaları kaydın değişmez kopyasından (sipariş dosyası sonradan değişse de)
  const resent = { id: 'd2', version: 2, source: DWG_SOURCE, status: DWG_RESUBMITTED, sourceFiles: [{ id: 'f9', name: 'plan-v2.dxf', checksum: 'c' }] };
  const r = dwgReview(order({ drawingTrack: 'GEREKLI', files: [], drawings: [{ id: 'd1', source: DWG_SOURCE, status: 'REVIZYON_ISTENDI' }, resent] }));
  assert.equal(r.pending, true);
  assert.equal(r.record, resent);
  assert.deepEqual(r.files, [{ id: 'f9', name: 'plan-v2.dxf', checksum: 'c' }]);
  // Açık kayıt son sürüm değilse (sonra fabrika sürümü açılmış) karar beklenmez
  assert.equal(dwgReview(order({ drawings: [resent, { id: 'd3', source: 'FABRIKA', status: 'TASLAK' }] })).pending, false);
  assert.deepEqual(DWG_DECISION_STATUS, { READY: 'ONAYLANDI', FAULTY: 'REVIZYON_ISTENDI', UPDATE: 'YAPILIYOR' });
});

test('"Çizim hatalı" açıklaması: zorunlu, satırlar korunur, boşluklar sadeleşir, en çok 2000 karakter', () => {
  assert.deepEqual(dwgNote('  Ölçü   katmanı eksik \r\n\r\n\r\n kapı yüksekliği okunmuyor  '), { ok: true, text: 'Ölçü katmanı eksik\n\nkapı yüksekliği okunmuyor' });
  for (const empty of ['', '   ', '\n\n', null, undefined]) assert.deepEqual(dwgNote(empty), { ok: false, code: 'DWG_NOTE' });
  assert.equal(dwgNote('x'.repeat(DWG_NOTE_MAX)).ok, true);
  assert.deepEqual(dwgNote('x'.repeat(DWG_NOTE_MAX + 1)), { ok: false, code: 'DWG_NOTE_LONG' });
});

test('teklif kontrolünün üretim çizimi: fabrika sürümü (taslak değil) ya da "üretime hazır" müşteri çizimi; sırası 1 = teklifle aynı', () => {
  const at = (h) => new Date(Date.UTC(2026, 9, 8, h));
  const f = (version, status, extra = {}) => ({ version, status, source: 'FABRIKA', createdAt: at(version), sentAt: status === 'TASLAK' ? null : at(version + 1), decidedAt: null, ...extra });
  const c = (version, status, extra = {}) => ({ version, status, source: DWG_SOURCE, createdAt: at(version), sentAt: null, decidedAt: at(version + 2), ...extra });
  // Yalnızca fabrika sürümü olan siparişte sıra = sürüm no (eski davranış)
  assert.deepEqual(lastProductionDrawing([f(1, 'REVIZYON_ISTENDI'), f(2, 'ONAY_BEKLIYOR')]), { drawing: f(2, 'ONAY_BEKLIYOR'), ordinal: 2, at: at(3) });
  assert.equal(lastProductionDrawing([f(1, 'GERI_CEKILDI'), f(2, 'TASLAK')]).ordinal, 1, 'taslak sayılmaz; geri çekilen (eski kural gibi) sayılır');
  assert.equal(lastProductionDrawing([]), null);
  assert.equal(lastProductionDrawing([f(1, 'TASLAK')]), null);
  // Müşterinin kararı "güncelle": kayıt sayılmaz → ilk fabrika çizimi v2 olsa da sırası 1
  assert.equal(lastProductionDrawing([c(1, 'YAPILIYOR'), f(2, 'ONAY_BEKLIYOR')]).ordinal, 1);
  // Hatalı → düzeltilmiş dosya → üretime hazır: üretim çizimi müşterinin kaydı, anı kararın anı
  const ready = lastProductionDrawing([c(1, 'REVIZYON_ISTENDI'), c(2, 'ONAYLANDI')]);
  assert.equal(ready.ordinal, 1);
  assert.equal(ready.drawing.version, 2);
  assert.deepEqual(ready.at, at(4));
  assert.equal(lastProductionDrawing([c(1, 'BEKLIYOR')]), null, 'karar bekleyen kayıt çizim değildir');
  // Üretime hazır kabul edildikten sonra fabrika revizyonu: ikinci üretim çizimi → teklif kontrolü gerekebilir
  assert.equal(lastProductionDrawing([c(1, 'ONAYLANDI'), f(2, 'ONAY_BEKLIYOR')]).ordinal, 2);
});
