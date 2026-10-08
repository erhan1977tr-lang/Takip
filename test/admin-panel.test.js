// Fonksiyonel paket 4 — yönetici paneli: mali kilit kuralı (fiyat değişikliği ve silme), müşteri fiyatı değişikliği kaydı,
// sandık bedeli satırı. Saf kurallar + yapı denetimi (veritabanıyla: test/db/admin-panel.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BUSY_JOBS, LOCK_CODES, busyOf, lockReasons } from '../server/orders/financial-lock.js';
import { priceChanges } from '../server/orders/price-changes.js';
import { CRATE_LINE, availableActions, isCrateText } from '../server/orders/rules.js';
import { DICTS } from '../server/i18n/index.js';

const src = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const facts = (extra = {}) => ({ status: 'URETIMDE', orderTypeCode: 'GLASS_ORDER', documents: [], batches: [], jobs: [], loadingDays: [], profile: null, ...extra });

test('mali kilit: temiz sipariş kilitli değil; FGO belgesi, müşteri belgesi, bekleyen belge ve onaylı yükleme fiyatı da silmeyi de kilitler', () => {
  for (const purpose of ['price', 'remove']) assert.deepEqual(lockReasons(facts(), purpose), [], purpose);
  const f = facts({
    documents: [{ kind: 'PROFORMA', series: 'PRF', number: '0012' }, { kind: 'ADVANCE', series: 'GKH', number: '0100' }, { kind: 'BILINMEYEN', series: 'X', number: '1' }],
    batches: [{ kind: 'INVOICE', status: 'ISSUED', document: { series: 'GKH', number: '0200' } }, { kind: 'PROFORMA', status: 'FAILED', document: null }, { kind: 'PROFORMA', status: 'PENDING', document: null }],
    jobs: ['FGO_GLASS'],
    loadingDays: [new Date('2026-09-20T00:00:00Z'), '2026-09-12', new Date('2026-09-20T00:00:00Z')],
  });
  const want = [
    { code: 'FGO_DOCUMENT', kind: 'PROFORMA', ref: 'PRF0012' },
    { code: 'FGO_DOCUMENT', kind: 'ADVANCE', ref: 'GKH0100' },
    { code: 'FGO_DOCUMENT', kind: 'PROFORMA', ref: 'X1' }, // bilinmeyen tür proforma sayılır (ekranda sabit metin)
    { code: 'BILLING_BATCH', kind: 'INVOICE', ref: 'GKH0200' },
  ];
  // En çok 8 neden: aynı gün iki kez sayılmaz, günler sıralıdır
  const price = lockReasons(f, 'price');
  assert.deepEqual(price.slice(0, 4), want);
  assert.deepEqual(price.slice(4), [
    { code: 'BILLING_BATCH', kind: 'PROFORMA', ref: null }, // sonuçlanmamış (FAILED) parti kapsamı korur
    { code: 'PENDING_DOCUMENT', kind: 'PROFORMA', ref: null },
    { code: 'PENDING_DOCUMENT', kind: null, ref: null },
    { code: 'CONFIRMED_LOADING', ref: '2026-09-12' },
  ]);
  assert.equal(price.length, 8);
  assert.equal(lockReasons(facts({ loadingDays: ['2026-09-20', new Date('2026-09-20T00:00:00Z'), '2026-09-12'] }), 'price').length, 2, 'aynı gün bir kez');
  for (const r of lockReasons(f, 'remove')) assert.ok(LOCK_CODES.includes(r.code), r.code);
});

test('mali kilit: depo e-postası fiyatı kilitlemez, silmeyi geçici olarak engeller (BUSY); yüklendi / profil geçmişi yalnızca silmeyi', () => {
  const warehouse = facts({ jobs: ['WAREHOUSE_EMAIL'] });
  assert.deepEqual(lockReasons(warehouse, 'price'), []);
  assert.deepEqual(lockReasons(warehouse, 'remove'), [{ code: 'PENDING_DOCUMENT', kind: null, ref: null }]);
  assert.equal(busyOf(warehouse), true);
  assert.equal(busyOf(facts({ batches: [{ kind: 'PROFORMA', status: 'PENDING', document: null }] })), true);
  assert.equal(busyOf(facts({ batches: [{ kind: 'PROFORMA', status: 'ISSUED', document: null }] })), false);
  assert.equal(busyOf(facts({ jobs: ['FGO_DOC_EMAIL', 'ORDER_OFFER_SENT'] })), false, 'e-posta / bildirim işi silmeyi bekletmez');
  assert.deepEqual([...BUSY_JOBS].sort(), ['FGO_GLASS', 'FGO_INVOICE', 'FGO_PROFORMA', 'WAREHOUSE_EMAIL']);
  // Yüklendi / arşivlendi olarak işaretlenmiş cam siparişi: fiyat (onaylı yükleme / belge yoksa) değişebilir, sipariş silinmez
  for (const status of ['YUKLENDI', 'ARSIVLENDI']) {
    assert.deepEqual(lockReasons(facts({ status }), 'price'), [], status);
    assert.deepEqual(lockReasons(facts({ status }), 'remove'), [{ code: 'SHIPPED', ref: null }], status);
  }
  for (const status of ['YENI', 'HAZIRLANIYOR', 'URETIMDE', 'IPTAL']) assert.deepEqual(lockReasons(facts({ status }), 'remove'), [], status);
  // Profil: proforma / ödeme / fatura ve depo / stok / teslim kaydı silmeyi engeller
  const profile = (p) => facts({ orderTypeCode: 'PROFILE_ORDER', status: 'URETIMDE', profile: p });
  assert.deepEqual(lockReasons(profile({ proformaNo: 'PRF0003' }), 'remove'), [{ code: 'PROFILE_FINANCE', ref: 'PRF0003' }]);
  assert.deepEqual(lockReasons(profile({ paidAt: new Date() }), 'remove'), [{ code: 'PROFILE_FINANCE', ref: null }]);
  assert.deepEqual(lockReasons(profile({ invoiceNo: 'GKH0009', proformaNo: 'PRF0003' }), 'remove'), [{ code: 'PROFILE_FINANCE', ref: 'GKH0009' }]);
  assert.deepEqual(lockReasons(profile({ stockDeducted: true }), 'remove'), [{ code: 'PROFILE_WAREHOUSE', ref: null }]);
  assert.deepEqual(lockReasons(profile({ deliveredAt: new Date(), warehouseSentAt: new Date() }), 'remove'), [{ code: 'PROFILE_WAREHOUSE', ref: null }]);
  assert.deepEqual(lockReasons(profile({ stockDeducted: false, proformaNo: null }), 'remove'), []);
  assert.deepEqual(lockReasons(profile({ proformaNo: 'PRF0003' }), 'price'), [], 'profil geçmişi fiyat kilidinde sayılmaz (profil fiyatı kendi akışında)');
});

test('fiyat değişikliği kaydı: satır kimliğiyle eşlenir; değişen, eklenen ve kaldırılan fiyatlı satırlar; ayırma ve ölçü değişikliği fiyat değişikliği değildir', () => {
  const glass = (id, offerPrice, extra = {}) => ({ id, kind: 'CAM', unit: 'm2', description: 'Temper 8mm', enMm: 1000, boyMm: 2000, adet: 2, offerPrice, ...extra });
  const before = [glass('a', '50'), glass('b', '40.5'), { id: 'c', kind: 'CNC', unit: 'adet', description: '', adet: 1, offerPrice: '8' }, glass('d', null)];
  // Değişiklik yok: fiyatın yazılışı (50 / 50.00 / sayı) ve ölçü / adet farkı değişiklik sayılmaz
  assert.deepEqual(priceChanges(before, [glass('a', 50, { adet: 7, enMm: 999 }), glass('b', '40.50'), before[2], glass('d', '')]), { changes: [], more: 0 });

  const after = [
    glass('a', '55'),
    glass('b', null, { free: true }), // bedelsiz yapıldı
    // c kaldırıldı; d hâlâ fiyatsız
    glass('d', null),
    glass(null, '30', { kind: 'CAM', unit: 'adet', description: 'Sandık parası', enMm: null, boyMm: null, crateFee: true }), // yeni, fiyatlı
    glass(null, null, { description: 'Fiyatsız yeni' }), // yeni ama fiyatsız: kaydedilecek fiyat değişikliği yok
    glass(null, '50', { from: 'a', adet: 1 }), // a'dan ayrılmış cam: a'nın ESKİ fiyatı 50 → yeni satırda 50 (ayırma)
  ];
  const { changes, more } = priceChanges(before, after);
  assert.equal(more, 0);
  assert.deepEqual(changes.map((c) => [c.no, c.change, c.old, c.new, c.crateFee]), [
    [1, 'PRICE', '50.00', '55.00', false],
    [2, 'PRICE', '40.50', 'FREE', false],
    [4, 'ADDED', null, '30.00', true],
    [3, 'REMOVED', '8.00', null, false],
  ]);
  assert.deepEqual([changes[2].unit, changes[2].enMm, changes[2].boyMm, changes[3].enMm, changes[3].kind], ['adet', null, null, null, 'CNC'], 'ölçüsüz satır ve işlem satırının ölçüsü yazılmaz');
  // Ayrılan cam kaynağından farklı fiyatla gelirse eklenmiş sayılır (eski = kaynağın fiyatı)
  assert.deepEqual(priceChanges(before, [glass('a', '50'), glass(null, '60', { from: 'a' })]).changes.map((c) => [c.change, c.old, c.new]), [['ADDED', '50.00', '60.00'], ['REMOVED', '40.50', null], ['REMOVED', '8.00', null]]);
  // Uzun liste: en çok 50 satır + kalanın sayısı; açıklama 120 karakterde kesilir
  const many = Array.from({ length: 60 }, (_, i) => glass(`x${i}`, '10', { description: 'Ç'.repeat(200) }));
  const big = priceChanges(many, many.map((l) => ({ ...l, offerPrice: '11' })));
  assert.deepEqual([big.changes.length, big.more, big.changes[0].description.length], [50, 10, 120]);
  assert.deepEqual(priceChanges(undefined, undefined), { changes: [], more: 0 });
});

test('sandık bedeli satırı: adı Türkçe ya da Romence (boşluk / büyük-küçük harf farkı yok sayılır); başka metin sandık değildir', () => {
  for (const s of [CRATE_LINE.tr, CRATE_LINE.ro, '  sandık   PARASI ', 'SANDIK PARASI', 'ambalaj (LADĂ)']) assert.equal(isCrateText(s), true, s);
  for (const s of ['Sandık', 'Sandık parası 2', 'Ambalaj', '', null, undefined, 'Temper 8mm']) assert.equal(isCrateText(s), false, String(s));
  // Ekrandaki metinler kuralın adlarıyla aynı (yönetici sandık satırını eklerken bu adı yazar)
  assert.equal(DICTS.tr.offer.editor.crateLine, CRATE_LINE.tr);
  assert.equal(DICTS.ro.offer.editor.crateLine, CRATE_LINE.ro);
});

test('yetki: müşterideki teklifi yalnızca yönetici günceller; satış hiçbir durumda müşteriye fiyatlı teklif gönderemez', () => {
  for (const status of ['YENI', 'HAZIRLANIYOR', 'URETIMDE', 'YUKLENDI', 'ARSIVLENDI']) {
    for (const offer of [null, 'HAZIRLANIYOR', 'YONETIMDE', 'GONDERILDI']) {
      const a = availableActions({ role: 'SATIS', status, drawing: 'YOK', offer });
      assert.ok(!a.includes('update_offer') && !a.includes('approve_price'), `${status}/${offer}: ${a}`);
    }
  }
});

test('yapı: kilit, fiyat kaydı, sandık bedeli ve silme tek kuraldan; gizleme yalnızca ekranda değil', () => {
  const tr = src('server/orders/transitions.js');
  // Fiyat güncellemesi: mali kilit yeni sürümden ÖNCE ve yükleme onayı / belge isteğiyle aynı danışma kilitleri altında
  const upd = tr.slice(tr.indexOf('async update_offer(h)'), tr.indexOf('async check_offer(h)'));
  assert.ok(upd.indexOf('priceLock(tx, order.id)') > 0 && upd.indexOf('priceLock(tx, order.id)') < upd.indexOf('tx.offer.create'), 'kilit denetimi yeni sürümden önce');
  assert.match(upd, /recordPriceChange\(h, \{ offerId: created\.id/);
  assert.match(tr, /update_offer: \(order\) => \['loading-confirmation', `glass-billing:\$\{order\.id\}`\]/);
  assert.ok(tr.indexOf('for (const key of locks[action]') < tr.indexOf('const bumped = await tx.order.updateMany'), 'danışma kilidi sipariş satırı kilidinden önce');
  // Sandık bedeli: satışın kaydı yöneticinin satırını korur; satış açamaz
  assert.match(tr, /const input = admin \? \{ lines: adminInput\(payload\.lines, offer\.lines\), kept: \[\] \} : salesInput\(payload\.lines, offer\.lines\)/);
  assert.match(upd, /adminInput\(payload\.lines, prev\.lines\)/);
  assert.match(tr, /WorkflowError\('CRATE_FEE_ADMIN'\)/);
  // Satışa giden teklif verisinde sandık bedeli satırı yok (sunucuda — sayfa, Teklifler, yükleme verisi aynı temizlikten geçer)
  assert.match(src('lib/orders.ts'), /o\.lines\.filter\(\(l\) => !l\.crateFee\)\.map\(\(l\) => \(\{ \.\.\.l, offerPrice: null \}\)\)/);
  assert.match(src('app/(panel)/teklifler/page.tsx'), /lines: \{ where: \{ crateFee: false \} \}/);
  // "+ Sandık parası" yalnızca yönetici düzenleyicisinde
  assert.match(src('app/(panel)/siparisler/[id]/OfferEditor.tsx'), /\{adminMode && <button type="button" className="btn" onClick=\{addCrate\}>/);
  // Silme: önizleme ve son karar aynı kilit kuralından; sunucu yazılan numarayı ister
  const rm = src('server/orders/removal.js');
  assert.equal((rm.match(/lockReasons\(facts, 'remove'\)/g) ?? []).length, 2);
  assert.match(rm, /if \(!sameNo\(confirmNo, order\.orderNo\)\) return fail\('CONFIRM_REQUIRED'\)/);
  assert.match(src('app/(panel)/siparisler/[id]/compensation-actions.ts'), /requirePermission\('ORDER_CANCEL'\)[\s\S]*confirmNo: text\(formData, 'confirmNo'\)/);
  // Fiyat hareketleri yalnızca yöneticiye (denetim kaydından okunur)
  assert.match(src('lib/price-history.ts'), /if \(!userCan\(user, 'OFFER_SEND'\)\) return \[\];/);
});
