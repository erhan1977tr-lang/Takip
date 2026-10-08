// Müşterinin revizyon notu (karar 162–163): numaralı maddeler, saklanan çevirinin role göre görünümü.
import test from 'node:test';
import assert from 'node:assert/strict';
import { REVISION_ITEMS_MAX, REVISION_ITEM_MAX, REVISION_TEXT_MAX, cleanRevisionItem, revisionItems, revisionNote } from '../server/orders/revision-note.js';
import { drawingNoteView, drawingRevisionsFor, drawingTranslationsFor, revisionView } from '../server/notes/view.js';

test('revizyon notu: maddeler sırayla numaralanır; boş maddeler atılır; madde tek satırdır; elle yazılan numara / işaret atılır', () => {
  assert.deepEqual(revisionNote(['Kenar 5 mm daha dar', '', '  ', 'Delik Ø12 sağa\n  kaysın ']), {
    ok: true, text: '1. Kenar 5 mm daha dar\n2. Delik Ø12 sağa kaysın', items: ['Kenar 5 mm daha dar', 'Delik Ø12 sağa kaysın'],
  });
  // Müşterinin yazdığı numara / madde işareti sistemin numarasıyla çakışmaz
  assert.equal(revisionNote(['1. ilk', '2) ikinci', '- üçüncü', '• dördüncü']).text, '1. ilk\n2. ikinci\n3. üçüncü\n4. dördüncü');
  // Ölçü gibi başlayan madde bozulmaz: işaret ancak ardından boşluk gelirse atılır
  assert.equal(cleanRevisionItem('1.5 mm kenar payı'), '1.5 mm kenar payı');
  assert.equal(cleanRevisionItem('-5 mm'), '-5 mm');
  assert.equal(cleanRevisionItem('2.'), '', 'yalnızca işaret = boş madde');
  assert.equal(cleanRevisionItem(null), '');
  // Türkçe / Romence harfler aynen (NFC)
  assert.equal(revisionNote(['Ușa șifonierului: ı ğ ş ç ö ü î â ă ț']).text, '1. Ușa șifonierului: ı ğ ş ç ö ü î â ă ț');
  assert.equal(revisionNote(['á']).items[0], 'á');
});

test('revizyon notu: en az bir dolu madde; madde sayısı ve uzunluğu sınırlı (sunucuda)', () => {
  assert.deepEqual(revisionNote([]), { ok: false, code: 'EMPTY' });
  assert.deepEqual(revisionNote(['', '   ', '1.', '-']), { ok: false, code: 'EMPTY' });
  assert.deepEqual(revisionNote(null), { ok: false, code: 'EMPTY' });
  assert.ok(revisionNote(Array.from({ length: REVISION_ITEMS_MAX }, (_, i) => `madde ${i}`)).ok);
  assert.deepEqual(revisionNote(Array.from({ length: REVISION_ITEMS_MAX + 1 }, (_, i) => `madde ${i}`)), { ok: false, code: 'TOO_MANY' });
  assert.ok(revisionNote(['x'.repeat(REVISION_ITEM_MAX)]).ok);
  assert.deepEqual(revisionNote(['x'.repeat(REVISION_ITEM_MAX + 1)]), { ok: false, code: 'TOO_LONG' });
  // Toplam sınır: 20 × 500 karakter > 4000
  assert.ok(REVISION_ITEMS_MAX * REVISION_ITEM_MAX > REVISION_TEXT_MAX);
  assert.deepEqual(revisionNote(Array.from({ length: 10 }, () => 'y'.repeat(REVISION_ITEM_MAX))), { ok: false, code: 'TOO_LONG' });
  // Maddesiz eski istek: tek metin tek madde sayılır
  assert.equal(revisionNote('Serbest not').text, '1. Serbest not');
});

test('gösterim: saklanan / çevrilmiş numaralı not yeniden maddelere ayrılır; düzene uymayan eski serbest not null (olduğu gibi gösterilir)', () => {
  assert.deepEqual(revisionItems('1. Kenar 5 mm\n2. Delik sağa'), ['Kenar 5 mm', 'Delik sağa']);
  assert.deepEqual(revisionItems('1) Bir\r\n2) İki\n'), ['Bir', 'İki'], 'çeviride ")" ve CRLF de kabul');
  assert.equal(revisionItems('Eski serbest not'), null);
  assert.equal(revisionItems('1. bir\n3. üç'), null, 'sıra bozuksa liste değil');
  assert.equal(revisionItems('1.5 mm kenar'), null, 'ölçüyle başlayan serbest not liste sayılmaz');
  assert.equal(revisionItems(''), null);
  const n = revisionNote(['a', 'b', 'c']);
  assert.deepEqual(revisionItems(n.text), n.items, 'yazılan not aynen geri okunur');
});

test('çevirinin görünümü (karar 163 = not kuralı): iç ekip Türkçe çeviriyi alır; müşteri kendi talebinin Türkçesini almaz; denetimci çeviri alanı almaz', () => {
  const at = new Date('2026-10-08T08:00:00Z');
  const done = { id: 'r1', comment: '1. Kenar', translation: '1. Margine', translationLang: 'tr', translationStatus: 'DONE', translationError: null, translationAt: at };
  for (const role of ['ADMIN', 'SATIS', 'CIZIM']) {
    const v = revisionView(role, done);
    assert.deepEqual([v.translation, v.translationStatus, v.comment], ['1. Margine', 'DONE', '1. Kenar'], role);
  }
  for (const role of ['MUSTERI', 'DENETIMCI']) {
    const v = revisionView(role, done);
    assert.deepEqual([v.translation, v.translationLang, v.translationStatus, v.translationError, v.translationAt, v.comment], [null, null, null, null, null, '1. Kenar'], role);
  }
  // Başarısız: iç ekip durumu ve güvenli kodu görür (çeviri metni yok); müşteri hiçbir şey görmez
  const failed = { ...done, translation: null, translationStatus: 'FAILED', translationError: 'TIMEOUT' };
  assert.deepEqual([revisionView('ADMIN', failed).translationStatus, revisionView('ADMIN', failed).translationError], ['FAILED', 'TIMEOUT']);
  assert.deepEqual([revisionView('MUSTERI', failed).translationStatus, revisionView('MUSTERI', failed).translationError], [null, null]);
  // Girdi değişmez; sürümlerin talepleri topluca
  const drawings = [{ id: 'd1', revisions: [done, failed] }, { id: 'd2' }];
  const out = drawingRevisionsFor('MUSTERI', drawings);
  assert.deepEqual(out[0].revisions.map((r) => r.translation), [null, null]);
  assert.equal(drawings[0].revisions[0].translation, '1. Margine');
  assert.deepEqual(out[1], { id: 'd2' });
});

test('çizim alanının iç ekip notları (karar 168): "çizim hatalı" açıklaması ve sürümün müşteri notu → müşteri Romence çeviriyi alır, iç ekip yalnızca özgün notu (+ başarısız durum), denetimci yalnızca özgün notu', () => {
  const at = new Date('2026-10-08T08:00:00Z');
  // Çizimcinin "hatalı" açıklaması (DrawingRevision, tür HATALI) — iç ekip yazar → Romence
  const faulty = { id: 'r9', kind: 'HATALI', comment: 'Ölçü katmanı eksik', translation: 'Lipsește stratul de cote', translationLang: 'ro', translationStatus: 'DONE', translationError: null, translationAt: at };
  assert.deepEqual([revisionView('MUSTERI', faulty).translation, revisionView('MUSTERI', faulty).translationLang], ['Lipsește stratul de cote', 'ro']);
  assert.equal(revisionView('MUSTERI', faulty).translationError, null);
  for (const role of ['ADMIN', 'SATIS', 'CIZIM', 'DENETIMCI']) {
    const v = revisionView(role, faulty);
    assert.deepEqual([v.translation, v.translationStatus, v.comment], [null, null, 'Ölçü katmanı eksik'], role);
  }
  const faultyFailed = { ...faulty, translation: null, translationStatus: 'FAILED', translationError: 'QUOTA' };
  assert.deepEqual([revisionView('CIZIM', faultyFailed).translationStatus, revisionView('CIZIM', faultyFailed).translationError], ['FAILED', 'QUOTA'], 'iç ekip yeniden deneyebilsin');
  assert.deepEqual([revisionView('MUSTERI', faultyFailed).translationStatus, revisionView('MUSTERI', faultyFailed).translationError], [null, null]);
  assert.deepEqual([revisionView('DENETIMCI', faultyFailed).translationStatus, revisionView('DENETIMCI', faultyFailed).translationError], [null, null]);

  // Sürümün müşteri notu (Drawing.noteCustomer + aynı beş alan)
  const version = { id: 'd1', status: 'ONAY_BEKLIYOR', noteCustomer: 'Kenar 5 mm düzeltildi', translation: 'Marginea corectată cu 5 mm', translationLang: 'ro', translationStatus: 'DONE', translationError: null, translationAt: at, revisions: [faulty] };
  assert.equal(drawingNoteView('MUSTERI', version).translation, 'Marginea corectată cu 5 mm');
  for (const role of ['ADMIN', 'SATIS', 'CIZIM', 'DENETIMCI']) assert.equal(drawingNoteView(role, version).translation, null, role);
  assert.equal(drawingNoteView('MUSTERI', version).noteCustomer, 'Kenar 5 mm düzeltildi', 'notun kendisi değişmez');
  // Çeviri alanı olmayan satır (ör. içeriği kapalı geri çekilmiş sürüm değil — alan hiç yüklenmemiş) olduğu gibi döner
  assert.deepEqual(drawingNoteView('MUSTERI', { id: 'x' }), { id: 'x' });
  // Toplu: sürüm notu + revizyon kayıtları; girdi değişmez
  const out = drawingTranslationsFor('CIZIM', [version]);
  assert.deepEqual([out[0].translation, out[0].revisions[0].translation], [null, null]);
  assert.equal(version.translation, 'Marginea corectată cu 5 mm');
  const cust = drawingTranslationsFor('MUSTERI', [version]);
  assert.deepEqual([cust[0].translation, cust[0].revisions[0].translation], ['Marginea corectată cu 5 mm', 'Lipsește stratul de cote']);
});
