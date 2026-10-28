// Müşteri teklif revizyonu (4.2.10, karar 306): açık revizyonun veriden türetilmesi, satış listesine giriş ve yetki matrisi
// (server/orders/offer-revision.js, server/orders/rules.js → availableActions). Saf kurallar — veritabanı yok.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awaitingSalesRevision, customerRevision, revisionCandidateWhere, revisionStage } from '../server/orders/offer-revision.js';
import { availableActions } from '../server/orders/rules.js';
import { offerChangeView, offersChangeFor } from '../server/notes/view.js';
import { offerPeopleView } from '../server/orders/order-view.js';

const at = new Date('2026-10-20T10:00:00Z');
const sent = (o = {}) => ({ id: 's', status: 'GONDERILDI', changeRequestedAt: at, ...o });
const order = (offers, o = {}) => ({ productionApprovalRequired: true, orderTypeCode: 'GLASS_ORDER', status: 'URETIMDE', offers, ...o });

test('açık revizyon veriden: talepli son gönderilmiş sürüm + (varsa) taslağın aşaması; sürüm numarası', () => {
  // Taslak yok (4.2.10 öncesi üretimdeki talep — ALE81)
  const legacy = order([sent(), { id: 'v1', status: 'GONDERILDI' }]);
  assert.deepEqual({ ...customerRevision(legacy), sent: undefined }, { stage: 'NO_DRAFT', sent: undefined, draft: null, version: 2 });
  // Taslak satışta / yöneticide
  assert.equal(customerRevision(order([{ id: 'd', status: 'HAZIRLANIYOR' }, sent()])).stage, 'SALES');
  assert.equal(customerRevision(order([{ id: 'd', status: 'YONETIMDE' }, sent()])).stage, 'ADMIN');
  assert.equal(customerRevision(order([{ id: 'd', status: 'HAZIRLANIYOR' }, sent(), { id: 'v1', status: 'GONDERILDI' }])).version, 2);
  // Yeni sürüm gönderildi → talep kapandı (son gönderilmiş sürümde talep yok)
  assert.equal(customerRevision(order([sent({ id: 'v3', changeRequestedAt: null }), sent()])), null);
  // Onaylanmış / talepsiz sürüm, gönderilmiş sürüm yok, kapsam dışı ve profil siparişi: revizyon yok
  assert.equal(customerRevision(order([sent({ changeRequestedAt: null })])), null);
  assert.equal(customerRevision(order([{ id: 'd', status: 'HAZIRLANIYOR' }])), null);
  assert.equal(customerRevision(order([{ id: 'd', status: 'HAZIRLANIYOR' }, sent()], { productionApprovalRequired: false })), null);
  assert.equal(customerRevision(order([{ id: 'd', status: 'HAZIRLANIYOR' }, sent()], { orderTypeCode: 'PROFILE_ORDER' })), null);
  assert.equal(customerRevision({}), null);
  assert.equal(revisionStage(null), null);
});

test('satış listesi (awaitingSalesRevision): taslak satışta ya da açılmamış; yöneticide ve kapanmış siparişte değil', () => {
  const draft = (st, status = 'URETIMDE') => order([{ id: 'd', status: st }, sent()], { status });
  assert.equal(awaitingSalesRevision(draft('HAZIRLANIYOR')), true);
  assert.equal(awaitingSalesRevision(draft('HAZIRLANIYOR', 'HAZIRLANIYOR')), true);
  assert.equal(awaitingSalesRevision(order([sent()])), true, 'eski talep: taslak bekleniyor');
  assert.equal(awaitingSalesRevision(draft('YONETIMDE')), false, 'yöneticiye gönderilince listeden çıkar');
  for (const status of ['YUKLENDI', 'ARSIVLENDI', 'IPTAL', 'YENI']) assert.equal(awaitingSalesRevision(draft('HAZIRLANIYOR', status)), false, status);
  // Sorgu ön süzgeci yalnızca kapsamdaki cam siparişlerini ve talepli gönderilmiş sürümü olanları getirir
  assert.deepEqual(revisionCandidateWhere(), {
    orderTypeCode: 'GLASS_ORDER', productionApprovalRequired: true, status: { in: ['HAZIRLANIYOR', 'URETIMDE'] },
    offers: { some: { status: 'GONDERILDI', changeRequestedAt: { not: null } } },
  });
});

/** availableActions — URETIMDE siparişinde teklif işlemleri yalnızca açık revizyonda */
const acts = (role, o = {}) => availableActions({ role, status: 'URETIMDE', offer: 'GONDERILDI', ...o });
const offerActs = (list) => list.filter((a) => ['edit_offer', 'submit_offer', 'approve_price', 'return_offer', 'withdraw_offer', 'open_revision_draft', 'update_offer'].includes(a)).sort();

test('yetki: üretimdeki siparişte satış YALNIZCA açık müşteri revizyonunun taslağını düzenler / gönderir; öteki kısıtlar aynen', () => {
  // Revizyon yok: satış hiçbir teklif işlemi yapamaz, yönetici yalnızca "Teklifi güncelle" (4.2.9 davranışı)
  assert.deepEqual(offerActs(acts('SATIS')), []);
  assert.deepEqual(offerActs(acts('ADMIN')), ['update_offer']);
  assert.deepEqual(offerActs(acts('SATIS', { offer: 'HAZIRLANIYOR' })), [], 'revizyon olmadan üretimdeki taslak düzenlenmez');
  // Revizyon taslağı satışta: satış ve yönetici düzenler / gönderir; "Teklifi güncelle" yok (son sürüm taslak)
  assert.deepEqual(offerActs(acts('SATIS', { offer: 'HAZIRLANIYOR', revision: 'SALES' })), ['edit_offer', 'submit_offer']);
  assert.deepEqual(offerActs(acts('ADMIN', { offer: 'HAZIRLANIYOR', revision: 'SALES' })), ['edit_offer', 'submit_offer']);
  // Yöneticide: yönetici onaylar / geri gönderir, satış geri alabilir; satış müşteriye gönderemez
  assert.deepEqual(offerActs(acts('SATIS', { offer: 'YONETIMDE', revision: 'ADMIN' })), ['withdraw_offer']);
  assert.deepEqual(offerActs(acts('ADMIN', { offer: 'YONETIMDE', revision: 'ADMIN' })), ['approve_price', 'return_offer']);
  assert.equal(acts('SATIS', { offer: 'YONETIMDE', revision: 'ADMIN' }).includes('approve_price'), false, 'satış fiyatı onaylayıp müşteriye gönderemez');
  // Eski talep (taslak yok): satış ve yönetici tek seferlik taslak açabilir
  assert.deepEqual(offerActs(acts('SATIS', { revision: 'NO_DRAFT' })), ['open_revision_draft']);
  assert.deepEqual(offerActs(acts('ADMIN', { revision: 'NO_DRAFT' })), ['open_revision_draft', 'update_offer']);
  assert.deepEqual(offerActs(acts('YONETICI_YARDIMCISI', { revision: 'NO_DRAFT' })), ['open_revision_draft', 'update_offer']);
  // Müşteri, çizim ekibi ve denetimci hiçbir revizyon işlemi yapamaz
  for (const role of ['MUSTERI', 'CIZIM', 'DENETIMCI']) {
    for (const [offer, revision] of [['HAZIRLANIYOR', 'SALES'], ['YONETIMDE', 'ADMIN'], ['GONDERILDI', 'NO_DRAFT']]) {
      assert.deepEqual(offerActs(acts(role, { offer, revision, canApprove: true })), [], `${role} ${revision}`);
    }
  }
  // Beklemedeki ve kapanmış sipariş: revizyon işlemi yok
  assert.deepEqual(offerActs(acts('SATIS', { offer: 'HAZIRLANIYOR', revision: 'SALES', onHold: true })), []);
  for (const status of ['YUKLENDI', 'ARSIVLENDI', 'IPTAL']) {
    assert.deepEqual(offerActs(acts('SATIS', { status, offer: 'HAZIRLANIYOR', revision: 'SALES' })), [], status);
    assert.deepEqual(offerActs(acts('SATIS', { status, revision: 'NO_DRAFT' })), [], status);
  }
  // Hazırlanan siparişte (HAZIRLANIYOR) davranış değişmedi: revizyon parametresi işlem kümesini değiştirmez
  for (const offer of ['HAZIRLANIYOR', 'YONETIMDE']) {
    for (const role of ['SATIS', 'ADMIN']) {
      const base = offerActs(availableActions({ role, status: 'HAZIRLANIYOR', offer }));
      assert.deepEqual(offerActs(availableActions({ role, status: 'HAZIRLANIYOR', offer, revision: offer === 'YONETIMDE' ? 'ADMIN' : 'SALES' })), base, `${role} ${offer}`);
    }
  }
});

test('görünürlük: değişiklik notunun Türkçe çevirisi iç ekibe; müşteri ve denetimci yalnızca özgün; kimlikler hiçbir role', () => {
  const o = { id: 'x', changeNote: 'Lățimea 1200 mm, scrieți la a@b.ro', changeRequestedById: 'u1', approvedById: null, translation: 'Genişlik 1200 mm', translationLang: 'tr', translationStatus: 'DONE', translationError: null, translationAt: at };
  for (const role of ['ADMIN', 'YONETICI_YARDIMCISI', 'SATIS']) assert.equal(offerChangeView(role, o).translation, 'Genişlik 1200 mm', role);
  for (const role of ['MUSTERI', 'DENETIMCI']) {
    const v = offerChangeView(role, o);
    assert.equal(v.translation, null, role);
    assert.equal(v.translationStatus, null, role);
    assert.equal(v.changeNote, o.changeNote, 'not değişmez');
  }
  // Başarısız çeviri: iç ekip durumu ve kodu görür (yeniden dene); müşteri / denetimci hiçbir durum almaz
  const failed = { ...o, translation: null, translationStatus: 'FAILED', translationError: 'TIMEOUT' };
  assert.equal(offerChangeView('SATIS', failed).translationError, 'TIMEOUT');
  assert.equal(offerChangeView('MUSTERI', failed).translationError, null);
  assert.equal(offerChangeView('DENETIMCI', failed).translationStatus, null);
  // Çeviri alanı seçilmemiş teklif olduğu gibi; liste işlevi her sürüme uygular
  const plain = { id: 'p', status: 'HAZIRLANIYOR' };
  assert.equal(offerChangeView('MUSTERI', plain), plain);
  assert.deepEqual(offersChangeFor('DENETIMCI', [o, plain]).map((x) => x.translation ?? null), [null, null]);
  // Kimlikler hiçbir role gitmez; satışta not içindeki e-posta adresi maskeli (sipariş ayrıntısı ve listeler aynı kural)
  assert.equal(offerPeopleView('ADMIN', o).changeRequestedById, null);
  assert.equal(offerPeopleView('SATIS', o).changeNote, 'Lățimea 1200 mm, scrieți la ***');
  assert.equal(offerPeopleView('ADMIN', o).changeNote, o.changeNote);
  assert.equal(offerPeopleView('MUSTERI', o).changeNote, o.changeNote);
});

test('e-posta (4.2.10 → 4.2.11): talep bütün satış ekibine; sürüm, not ve (Türkçe okuyana) Türkçe çeviri; satışa e-posta adresi ve firma maskeli', async () => {
  const { NOTIFY_RULES, renderNotification } = await import('../server/notifications/email.js');
  assert.deepEqual(NOTIFY_RULES.ORDER_OFFER_CHANGE_REQUESTED({}), ['sales']);
  const order = { id: 'o1', orderNo: 'ALE81', customer: { name: 'Alegrad Sticla' } };
  const change = { note: 'Lățimea 1200 mm — ofis@ale.test', translation: '[tr] Genişlik 1200 mm — ofis@ale.test', version: 3 };
  const mail = (recipient, c = change) => renderNotification({ type: 'ORDER_OFFER_CHANGE_REQUESTED', order, createdAt: at, recipient, appUrl: 'https://takip.test', timeZone: 'Europe/Bucharest', change: c });
  const sales = mail({ locale: 'tr', role: 'SATIS' });
  assert.match(sales.text, /Teklif sürümü: v3/);
  assert.match(sales.text, /Müşterinin notu: Lățimea 1200 mm — \*\*\*/);
  assert.match(sales.text, /Türkçe çeviri \(otomatik\): \[tr\] Genişlik 1200 mm — \*\*\*/);
  assert.ok(!sales.text.includes('ofis@ale.test') && !sales.html.includes('ofis@ale.test'));
  assert.ok(!sales.text.includes('Alegrad Sticla'), 'firma adı maskeli');
  // Romence okuyan alıcıya Türkçe çeviri satırı yazılmaz; çeviri yoksa satır yok
  assert.ok(!mail({ locale: 'ro', role: 'SATIS' }).text.includes('[tr]'));
  assert.ok(!mail({ locale: 'tr', role: 'SATIS' }, { ...change, translation: null }).text.includes('Türkçe çeviri'));
  // Firma adını gören rol (yönetici) notu maskesiz alır
  assert.match(mail({ locale: 'tr', role: 'ADMIN' }).text, /ofis@ale\.test/);
});
