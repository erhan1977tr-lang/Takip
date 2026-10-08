// Uygulama içi bildirimler (karar 107) — saf kurallar: istemci akışı (ilk yükleme sessiz, yeni parti, tek ses, sekme
// başlığı, açılır bildirim) ve metin üretimi / alıcı kuralları (maskeleme, çizim kararlarının yönü).
import test from 'node:test';
import assert from 'node:assert/strict';
import { badgeText, ingest, safeLink, soundFor, stripCount, titleWithCount, toastFor } from '../server/notifications/feed.js';
import { AUDIENCE_ROLES, INAPP_RULES, INAPP_TYPES, createNotifications, recipientsOf, renderInApp } from '../server/notifications/inapp.js';
import { NOTIFY_RULES } from '../server/notifications/email.js';
import { NOTIFICATION_WAV_BASE64 } from '../server/notifications/sound.js';

const item = (id, minute, extra = {}) => ({ id, title: `Başlık ${id}`, body: `Gövde ${id}`, link: `/siparisler/${id}`, isRead: false, createdAt: `2026-10-03T10:${String(minute).padStart(2, '0')}:00.000Z`, ...extra });
/** Bir oturumu oynatır: her yoklamada ingest + soundFor; çalınan ses ve gösterilen açılır bildirim sayılır */
function session({ soundEnabled = true, interacted = true } = {}) {
  const s = { state: null, sounds: 0, toasts: [], stored: null, soundEnabled, interacted };
  s.poll = (items) => {
    const r = ingest(s.state, { items });
    s.state = r.state;
    const t = toastFor(r.fresh);
    if (t) s.toasts.push(t);
    const snd = soundFor({ fresh: r.fresh, soundEnabled: s.soundEnabled, interacted: s.interacted, stored: s.stored });
    if (snd.play) { s.sounds++; s.stored = snd.mark; }
    return r.fresh;
  };
  return s;
}

test('ilk yükleme sessizdir: var olan 7 okunmamış bildirim ne ses ne açılır bildirim üretir (yalnızca rozet)', () => {
  const s = session();
  const old = [7, 6, 5, 4, 3, 2, 1].map((n) => item(`o${n}`, n));
  assert.deepEqual(s.poll(old), []);
  assert.deepEqual([s.sounds, s.toasts.length], [0, 0]);
  assert.equal(badgeText(7), '7');
  // Aynı liste yeniden gelirse (sonraki yenilemeler) yine yeni yok
  assert.deepEqual(s.poll(old), []);
  assert.deepEqual([s.sounds, s.toasts.length], [0, 0]);
});

test('temelden SONRA gelen bildirim yenidir: açılır bildirim + tam bir ses; okunmuş gelen bildirim yeni sayılmaz', () => {
  const s = session();
  const old = [item('o2', 2), item('o1', 1)];
  s.poll(old);
  const fresh = s.poll([item('n1', 10), ...old]);
  assert.deepEqual(fresh.map((i) => i.id), ['n1']);
  assert.deepEqual([s.sounds, s.toasts.length], [1, 1]);
  assert.deepEqual(s.toasts[0], { single: true, id: 'n1', title: 'Başlık n1', body: 'Gövde n1', link: '/siparisler/n1' });
  // Aynı bildirim sonraki yoklamada yeniden "yeni" olmaz
  s.poll([item('n1', 10), ...old]);
  assert.deepEqual([s.sounds, s.toasts.length], [1, 1]);
  // Başka yerde okunmuş olarak gelen bildirim: ses / açılır bildirim yok
  s.poll([item('n2', 11, { isRead: true }), item('n1', 10), ...old]);
  assert.deepEqual([s.sounds, s.toasts.length], [1, 1]);
});

test('bir yoklamada birden çok yeni bildirim: TEK ses, TEK özet açılır bildirim', () => {
  const s = session();
  s.poll([item('o1', 1)]);
  const fresh = s.poll([item('n5', 15), item('n4', 14), item('n3', 13), item('n2', 12), item('n1', 11), item('o1', 1)]);
  assert.equal(fresh.length, 5);
  assert.equal(s.sounds, 1, 'bildirim başına değil, parti başına bir ses');
  assert.deepEqual(s.toasts, [{ single: false, count: 5, titles: ['Başlık n5', 'Başlık n4', 'Başlık n3'], more: 2 }]);
  // Sonraki partide yeniden bir ses
  s.poll([item('n6', 16), item('n5', 15)]);
  assert.equal(s.sounds, 2);
});

test('ses kapalı: ses yok ama açılır bildirim ve sayaç sürer; ses yalnızca kullanıcı etkileşiminden sonra', () => {
  const off = session({ soundEnabled: false });
  off.poll([]);
  assert.equal(off.poll([item('n1', 10)]).length, 1);
  assert.deepEqual([off.sounds, off.toasts.length], [0, 1], 'ses tercihi yalnızca sesi kapatır');
  // Tercih oturum içinde açılınca (çıkış gerekmez) sonraki parti çalınır
  off.soundEnabled = true;
  off.poll([item('n2', 11), item('n1', 10)]);
  assert.equal(off.sounds, 1);
  // Tarayıcı henüz etkileşim almadıysa ses başlatılmaz (otomatik oynatma politikası); bildirim yine görünür
  const idle = session({ interacted: false });
  idle.poll([]);
  idle.poll([item('n1', 10)]);
  assert.deepEqual([idle.sounds, idle.toasts.length], [0, 1]);
});

test('birden çok sekme: aynı parti bir kez çalınır (ortak işaret); daha yeni parti yeniden çalınır', () => {
  const fresh = [item('n2', 12), item('n1', 11)];
  const first = soundFor({ fresh, soundEnabled: true, interacted: true, stored: null });
  assert.deepEqual(first, { play: true, mark: '2026-10-03T10:12:00.000Z' });
  // İkinci sekme aynı partiyi görür: işaret zaten yazılmış → çalmaz
  assert.deepEqual(soundFor({ fresh, soundEnabled: true, interacted: true, stored: first.mark }), { play: false, mark: null });
  assert.equal(soundFor({ fresh: [item('n3', 13)], soundEnabled: true, interacted: true, stored: first.mark }).play, true);
  assert.deepEqual(soundFor({ fresh: [], soundEnabled: true, interacted: true }), { play: false, mark: null });
});

test('rozet ve sekme başlığı: sayaç eklenir, güncellenir, geri alınır; sayfanın kendi başlığı korunur', () => {
  assert.deepEqual([badgeText(0), badgeText(1), badgeText(9), badgeText(99), badgeText(100), badgeText(1234)], ['', '1', '9', '99', '99+', '99+']);
  assert.equal(titleWithCount('TAKİP', 3), '(3) TAKİP');
  assert.equal(titleWithCount('(3) TAKİP', 4), '(4) TAKİP', 'eski sayaç değişir, üst üste binmez');
  assert.equal(titleWithCount('(4) TAKİP', 0), 'TAKİP', 'okunmamış kalmayınca başlık geri gelir');
  assert.equal(titleWithCount('Siparişler — TAKİP', 3), '(3) Siparişler — TAKİP', 'sayfa başlığı bozulmaz');
  assert.equal(titleWithCount('TAKİP', 250), '(99+) TAKİP');
  assert.equal(titleWithCount('(99+) TAKİP', 0), 'TAKİP');
  assert.deepEqual([stripCount('(12) Siparişler'), stripCount('Siparişler')], ['Siparişler', 'Siparişler']);
  assert.equal(titleWithCount('Rapor (3)', 0), 'Rapor (3)', 'yalnızca baştaki sayaç öneki sayaçtır');
});

test('bağlantı yalnızca uygulama içi yol olabilir', () => {
  assert.equal(safeLink('/siparisler/abc#finans'), '/siparisler/abc#finans');
  for (const bad of ['https://kotu.example/x', '//kotu.example', 'javascript:alert(1)', '', null, undefined, 5]) assert.equal(safeLink(bad), null);
  // Karar 145: tarayıcının "//kotu.example" diye çözeceği biçimler de bağlantı değildir (ters bölü, sekme, satır sonu) —
  // kuralın tamamı test/internal-path.test.js'te; bildirimlerin gerçek bağlantı biçimleri aynen kalır
  for (const bad of ['/\\kotu.example', '/\t/kotu.example', '/\t\\kotu.example', '/\n/kotu.example', '/\r\n\\kotu.example', '/.//kotu.example', '/siparisler/abc\t#finans', '/siparisler/a b']) {
    assert.equal(safeLink(bad), null, JSON.stringify(bad));
  }
  for (const ok of ['/siparisler/abc', '/siparisler/abc#kararlar', '/yuklemeler?gun=2026-10-06', '/yuklemeler?gun=2026-10-06#yuklenmeyen', '/yuklemeler?gun=2026-10-06#faturalama',
    '/belgeler#doc-abc', '/admin/muhasebe/cam#fatura-bekliyor', '/admin/muhasebe/cam/proforma#partiler', '/admin/muhasebe/cam/proforma?musteri=abc#partiler']) {
    assert.equal(safeLink(ok), ok);
  }
});

test('metin: sipariş olayı mevcut olay metninden; müşteriye firma / iç bilgi yok; iç ekibe firma (alıcıya göre saklanan değer)', () => {
  const customer = renderInApp('ro', { type: 'ORDER_OFFER_SENT', params: { aud: 'customer', orderNo: 'GLA68', firm: 'SIZMAMALI' } });
  assert.deepEqual(customer, { title: 'Oferta dvs. este gata', body: 'Comanda GLA68' });
  assert.deepEqual(renderInApp('tr', { type: 'ORDER_CREATED', params: { aud: 'staff', orderNo: 'GLA68', firm: 'GLA**********' } }), { title: 'Yeni sipariş', body: 'GLA68 · GLA**********' });
  assert.deepEqual(renderInApp('tr', { type: 'ORDER_REVISION_REQUESTED', params: { aud: 'staff', orderNo: 'GLA68', firm: 'GLA**********' } }).title, 'Müşteri revizyon istedi');
  assert.deepEqual(renderInApp('ro', { type: 'LOADING_REPLANNED', params: { aud: 'customer', orderNo: 'GLA68', qty: 2, day: '2026-10-23' } }),
    { title: 'Sticla neîncărcată a fost replanificată la o nouă zi de încărcare', body: 'Comanda GLA68 · 2 buc. → 23.10.2026' });
  assert.match(renderInApp('ro', { type: 'ACCOUNTING_ACTION', params: { aud: 'staff', orderNo: 'GLA68', firm: 'Glass', day: '2026-10-16', ref: 'GKH77' } }).body, /^GLA68 · Glass · încărcarea din 16\.10\.2026 · factura GKH77$/);
  // Bilinmeyen tür: saklanan yedek metin
  assert.deepEqual(renderInApp('ro', { type: 'BILINMEYEN', message: 'Mesaj', params: {} }), { title: 'Mesaj', body: '' });
});

test('alıcı kuralları: çizim kararları yalnızca atanmış çizimci + ilgili satışçı; profil satışa gitmez; muhasebe olayları yalnızca muhasebe yetkisine', () => {
  const glass = { orderTypeCode: 'GLASS_ORDER' }, profile = { orderTypeCode: 'PROFILE_ORDER' };
  assert.deepEqual(INAPP_RULES.ORDER_CREATED.to(glass), ['sales', 'admin']);
  assert.deepEqual(INAPP_RULES.ORDER_CREATED.to(profile), ['admin'], 'profil siparişi satışa bildirilmez');
  for (const t of ['ORDER_REVISION_REQUESTED', 'ORDER_DRAWING_APPROVED']) assert.deepEqual(INAPP_RULES[t].to(glass), ['drawer', 'orderSales'], `${t}: yöneticiye / müşteriye değil`);
  assert.deepEqual(INAPP_RULES.ORDER_SENT_TO_DRAWING.to(glass), ['drawer']);
  assert.deepEqual(INAPP_RULES.ORDER_DRAWING_UPLOADED.to(glass), ['customer']);
  assert.deepEqual(INAPP_RULES.ORDER_OFFER_SUBMITTED.to(glass), ['admin'], 'satışın teklifi yöneticiye — müşteriye değil');
  // Yönetici teklifi müşteriye gönderince (ilk gönderim / yeni sürüm) yalnızca müşteri bilgilendirilir — satışa ne zil ne
  // e-posta (Paket 4). Satışın öbür olayları değişmedi: geri gönderilen teklif, revizyon, onay.
  for (const t of ['ORDER_OFFER_SENT', 'ORDER_OFFER_UPDATED']) {
    assert.deepEqual(INAPP_RULES[t].to(glass), ['customer'], `${t}: zil yalnızca müşteriye`);
    assert.deepEqual(NOTIFY_RULES[t](glass), ['customer'], `${t}: e-posta yalnızca müşteriye`);
  }
  assert.deepEqual(INAPP_RULES.ORDER_OFFER_RETURNED.to(glass), ['orderSales'], 'geri gönderilen teklif satışa bildirilir');
  assert.deepEqual([INAPP_RULES.ACCOUNTING_ACTION.to(glass), INAPP_RULES.ACCOUNTING_ACTION.includeActor], [['accounting'], true]);
  assert.deepEqual(AUDIENCE_ROLES, { admin: ['ADMIN'], sales: ['SATIS'], accounting: ['ADMIN'], loading: ['ADMIN'] });
  // E-posta giden her olayın uygulama içi karşılığı var (kanal ayrı; kural tablosu e-postayı değiştirmez)
  for (const t of Object.keys(NOTIFY_RULES)) assert.ok(INAPP_TYPES.includes(t), t);
});

test('müşteri bildirimleri (karar 166): müşteriye yalnızca kendi siparişinin müşteri olayları gider — iç olaylar (teklifin yöneticiye gitmesi, revizyon / onayın çizimciye gitmesi, muhasebe, yükleme) müşteri alıcı kümesinde yok; bağlantı ilgili bölüme iner', () => {
  const glass = { orderTypeCode: 'GLASS_ORDER', id: 'o1' }, profile = { orderTypeCode: 'PROFILE_ORDER', id: 'o2' };
  const toCustomer = INAPP_TYPES.filter((t) => [glass, profile].some((o) => INAPP_RULES[t].to(o, {}).includes('customer'))).sort();
  // Yeni bir olay müşteriye açılacaksa bilerek buraya eklenmelidir. ORDER_DWG_FAULTY (karar 167): çizimci müşterinin DWG/DXF
  // çizimini hatalı buldu — müşterinin yanıtı bekleniyor
  assert.deepEqual(toCustomer, [
    'LOADING_REPLANNED', 'ORDER_DRAWING_UPLOADED', 'ORDER_DWG_FAULTY', 'ORDER_INVOICED', 'ORDER_OFFER_SENT', 'ORDER_OFFER_UPDATED', 'ORDER_PROFILE_OFFER_SENT',
    'ORDER_PROFORMA', 'ORDER_SHIPPED', 'ORDER_SHIP_DATE',
  ]);
  // Müşterinin yanıtı ve çizimcinin öbür kararları iç olaydır (çizimci / ilgili satışçı)
  for (const t of ['ORDER_OFFER_SUBMITTED', 'ORDER_OFFER_RETURNED', 'ORDER_REVISION_REQUESTED', 'ORDER_DRAWING_APPROVED', 'ORDER_SENT_TO_DRAWING', 'ACCOUNTING_ACTION', 'LOADING_NOT_LOADED', 'ORDER_CREATED', 'ORDER_PROFILE_APPROVED',
    'ORDER_DWG_READY', 'ORDER_DWG_RESUBMITTED', 'ORDER_DWG_FACTORY_REQUESTED']) {
    assert.ok(!toCustomer.includes(t), `${t}: iç olay müşteriye gitmez`);
  }
  // Bağlantılar: yeni çizim → kırmızı bilgilendirme (#cizim-onay); teklif → #teklif; çizim kararları → #cizim (iç ekip)
  const link = (t, o = glass) => (INAPP_RULES[t].link ? INAPP_RULES[t].link(o, {}) : `/siparisler/${o.id}`);
  assert.equal(link('ORDER_DRAWING_UPLOADED'), '/siparisler/o1#cizim-onay');
  assert.equal(link('ORDER_OFFER_SENT'), '/siparisler/o1#teklif');
  assert.equal(link('ORDER_OFFER_UPDATED'), '/siparisler/o1#teklif');
  assert.equal(link('ORDER_PROFILE_OFFER_SENT', profile), '/siparisler/o2#teklif');
  assert.equal(link('ORDER_REVISION_REQUESTED'), '/siparisler/o1#cizim');
  // Onay (Paket 3): olayın kuyruktaki drawingId'si varsa onaylanan SÜRÜMÜN ekranı; yoksa (eski olay) çizim bölümü; kimlik
  // biçimine uymayan değer bağlantıya girmez
  assert.equal(link('ORDER_DRAWING_APPROVED'), '/siparisler/o1#cizim');
  assert.equal(INAPP_RULES.ORDER_DRAWING_APPROVED.link(glass, { drawingId: 'cmdraw0001abc' }), '/siparisler/o1/cizim/cmdraw0001abc');
  for (const bad of ['../x', 'a/b', '', 'x'.repeat(41), 7, null, '//evil.example']) {
    assert.equal(INAPP_RULES.ORDER_DRAWING_APPROVED.link(glass, { drawingId: bad }), '/siparisler/o1#cizim', String(bad));
  }
  assert.equal(link('ORDER_DWG_FAULTY'), '/siparisler/o1#cizim-hatali');
  for (const t of ['ORDER_DWG_READY', 'ORDER_DWG_RESUBMITTED', 'ORDER_DWG_FACTORY_REQUESTED']) assert.equal(link(t), '/siparisler/o1#cizim', t);
  assert.deepEqual(INAPP_RULES.ORDER_DWG_RESUBMITTED.to(glass, {}), ['drawer', 'orderSales']);
  assert.deepEqual(INAPP_RULES.ORDER_DWG_FACTORY_REQUESTED.to(glass, {}), ['drawer', 'orderSales']);
  assert.deepEqual(INAPP_RULES.ORDER_DRAWING_APPROVED.to(glass, {}), ['drawer', 'orderSales']);
  for (const t of INAPP_TYPES) {
    const l = INAPP_RULES[t].link?.({ id: 'o1' }, { day: '2026-10-08' });
    if (l != null) assert.equal(safeLink(l), l, `${t}: bağlantı uygulama içi yol kuralından geçer`);
  }
});

test('yazım: firma adı görme yetkisi olmayan role MASKELİ saklanır; müşteriye firma yazılmaz; aynı anahtar tekrar yazılmaz (skipDuplicates)', async () => {
  const calls = [];
  const db = { notification: { createMany: async (a) => { calls.push(a); return { count: a.data.length }; } } };
  const users = [
    { id: 'u-admin', appRole: 'ADMIN', aud: 'staff' }, { id: 'u-sales', appRole: 'SATIS', aud: 'staff' }, { id: 'u-draw', appRole: 'CIZIM', aud: 'staff' },
    { id: 'u-insp', appRole: 'DENETIMCI', aud: 'staff' }, { id: 'u-cust', appRole: 'MUSTERI', aud: 'customer' },
  ];
  const n = await createNotifications(db, { key: 'outbox:r1', type: 'ORDER_OFFER_SENT', users, orderId: 'o1', orderNo: 'GLA68', firmName: 'GLASSANDMORE SRL', link: '/siparisler/o1' });
  assert.equal(n, 5);
  assert.equal(calls[0].skipDuplicates, true);
  const by = Object.fromEntries(calls[0].data.map((d) => [d.userId, d]));
  assert.equal(by['u-admin'].params.firm, 'GLASSANDMORE SRL');
  assert.equal(by['u-insp'].params.firm, 'GLASSANDMORE SRL', 'denetimci firma adını görür (karar 11)');
  for (const id of ['u-sales', 'u-draw']) {
    assert.equal(by[id].params.firm, 'GLA**********');
    assert.ok(!JSON.stringify(by[id]).includes('GLASSANDMORE'), `${id}: tam firma adı hiçbir alanda yok`);
  }
  assert.equal(by['u-cust'].params.firm, undefined);
  assert.ok(!JSON.stringify(by['u-cust']).includes('GLASSANDMORE'));
  assert.ok(calls[0].data.every((d) => d.dedupeKey === 'outbox:r1' && d.link === '/siparisler/o1' && d.orderId === 'o1'));
  assert.equal(await createNotifications(db, { key: 'k', type: 'X', users: [] }), 0);
});

test('alıcılar: işlemi yapan kullanıcıya kendi işlemi bildirilmez; müşteri kümesi yalnızca siparişin firması', async () => {
  const queries = [];
  const db = {
    user: {
      findMany: async (q) => {
        queries.push(q.where);
        if (q.where.appRole === 'MUSTERI') return [{ id: 'c1', appRole: 'MUSTERI' }, { id: 'c2', appRole: 'MUSTERI' }];
        return [{ id: 'a1', appRole: 'ADMIN' }, { id: 'a2', appRole: 'ADMIN' }];
      },
      findFirst: async () => ({ id: 'd1', appRole: 'CIZIM' }),
    },
  };
  const order = { id: 'o1', customerId: 'firmA', assignedDrawerId: 'd1' };
  const r = await recipientsOf(db, ['customer', 'admin', 'drawer'], order, { actorId: 'a1' });
  assert.deepEqual(r.map((u) => [u.id, u.aud]), [['c1', 'customer'], ['c2', 'customer'], ['a2', 'staff'], ['d1', 'staff']]);
  assert.deepEqual(queries[0], { customerId: 'firmA', appRole: 'MUSTERI', isActive: true }, 'yalnızca siparişin firmasının etkin müşteri kullanıcıları');
  assert.deepEqual(await recipientsOf(db, ['drawer'], { id: 'o2', customerId: 'firmA', assignedDrawerId: null }), [], 'atanmış çizimci yoksa kimseye gitmez');
});

test('ses varlığı: uygulamanın kendi dosyası, kısa WAV', () => {
  const b = Buffer.from(NOTIFICATION_WAV_BASE64, 'base64');
  assert.deepEqual([b.subarray(0, 4).toString(), b.subarray(8, 12).toString()], ['RIFF', 'WAVE']);
  const seconds = (b.length - 44) / (16000 * 2);
  assert.ok(seconds > 0.1 && seconds < 0.5, `kısa ses: ${seconds} sn`);
  assert.ok(b.length < 20_000);
});
