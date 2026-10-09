// Paket 9 (kararlar 198–202): dil ayarı, müşteri e-posta dili, sipariş mesajı sayaçları / bildirimi, tekilleştirme,
// anlık arama ve oturum kuralı — saf kurallar ve yapı denetimleri. Veritabanı davranışı: test/db/package9.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import { CUSTOMER_DEFAULT_LANG, customerMailLang, snapshotLang } from '../server/notifications/lang.js';
import { UNREAD_WINDOW_DAYS, countText, isUnreadNote, unreadSince, seesInternal, NOTE_EVENT } from '../server/notes/unread.js';
import { INAPP_RULES, renderInApp } from '../server/notifications/inapp.js';
import { NOTIFY_RULES } from '../server/notifications/email.js';
import { addNote, noteRequestKey } from '../server/notes/translation.js';
import { notesFor } from '../server/notes/view.js';
import { enqueueOutbox } from '../server/orders/journal.js';
import { createNoteLimits } from '../server/notes/limits.js';
import { SESSION_IDLE_MS, sessionState } from '../server/auth/session-policy.js';
import { renderSupplierOrderEmail } from '../server/mail/templates/supplier-order.js';
import { translate } from '../server/i18n/index.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const MIN = 60_000;
const DAY = 86_400_000;

test('müşteri e-posta dili (karar 200): kayıtlı tercih → Otomatik\'te son giriş dili → varsayılan Romence; geçersiz değer yok sayılır', () => {
  assert.equal(CUSTOMER_DEFAULT_LANG, 'ro');
  assert.equal(customerMailLang({ fixedLanguage: 'tr', language: 'ro' }), 'tr', 'sabit dil kazanır');
  assert.equal(customerMailLang({ fixedLanguage: null, language: 'tr' }), 'tr', 'Otomatik: algılanan / son giriş dili');
  assert.equal(customerMailLang({ fixedLanguage: 'en', language: 'xx' }), 'ro', 'desteklenmeyen dil → varsayılan');
  assert.equal(customerMailLang(null), 'ro');
  assert.equal(snapshotLang({ lang: 'tr' }), 'tr');
  assert.equal(snapshotLang({ lang: 'en' }), null);
  assert.equal(snapshotLang(null), null);
});

test('e-posta dili olay yazılırken saklanır: e-posta giden sipariş olayına lang yazılır (siparişi açan müşterinin tercihi); e-postası olmayan olaya ve verilmiş dile dokunulmaz', async () => {
  const written = [];
  const orders = {
    o1: { customerId: 'A', createdBy: { fixedLanguage: 'tr', language: 'ro', customerId: 'A' } },
    o2: { customerId: 'A', createdBy: { fixedLanguage: null, language: 'tr', customerId: 'A' } },
    // Siparişi iç ekip açtıysa (başka firmanın kullanıcısı) onun dili kullanılmaz → müşteri varsayılanı
    o3: { customerId: 'A', createdBy: { fixedLanguage: null, language: 'tr', customerId: 'FACTORY' } },
  };
  const tx = {
    order: { async findUnique({ where }) { return orders[where.id] ?? null; } },
    notificationOutbox: { async create({ data }) { written.push(data); return { id: `ob${written.length}`, ...data }; } },
  };
  await enqueueOutbox(tx, { type: 'ORDER_OFFER_SENT', orderId: 'o1', payload: { actorId: 'x' } });
  await enqueueOutbox(tx, { type: 'ORDER_SHIP_DATE', orderId: 'o2', payload: {} });
  await enqueueOutbox(tx, { type: 'ORDER_OFFER_SENT', orderId: 'o3' });
  await enqueueOutbox(tx, { type: NOTE_EVENT, orderId: 'o1', payload: { noteId: 'n1' } });
  await enqueueOutbox(tx, { type: 'ORDER_OFFER_SENT', orderId: 'o1', payload: { lang: 'ro' } });
  assert.deepEqual(written.map((w) => w.payload?.lang ?? null), ['tr', 'tr', 'ro', null, 'ro']);
  assert.ok(Object.keys(NOTIFY_RULES).every((t) => t.startsWith('ORDER_')), 'e-posta kuralı yalnızca sipariş olaylarında');
  // Gönderim tarafı olaydaki dili kullanır (eski olayda kural gönderim anında)
  const email = strip(read('server/notifications/email.js'));
  // (karar 218: aynı çağrı işlemi yapanı da verir — yöneticiye kendi işlemi e-postalanmaz)
  assert.ok(email.includes("recipientsFor(db, row.type, order, { lang: snapshotLang(payload), actorId: typeof payload.actorId === 'string' ? payload.actorId : null })"));
  assert.ok(email.includes('const lang = snapshot ?? customerMailLang(creator);'));
});

test('tedarikçi sipariş e-postası her zaman Türkçedir (karar 181) — dil tercihi şablona girmez', () => {
  const src = strip(read('server/mail/templates/supplier-order.js'));
  assert.ok(!/fixedLanguage|customerMailLang|translate\(\s*['"]ro/.test(src));
  const mail = renderSupplierOrderEmail({
    orderNo: 'TS-2026-001', supplierName: 'Furnizor SRL', orderDate: '2026-10-01', revision: 1, currency: 'EUR', showPrices: true, total: '10.00',
    lines: [{ code: 'GK15', description: 'Garnitura', color: null, qty: 2, unit: 'kutu', unitPrice: '5.00', lineTotal: '10.00' }],
  });
  assert.equal(mail.subject, 'GKH Trading Invest – Sipariş TS-2026-001 – Furnizor SRL');
  assert.match(mail.html, /Ürün Kodu/);
  assert.match(mail.text, /İyi çalışmalar dileriz\./);
});

test('okunmamış mesaj kuralı (karar 199): başkasının yazdığı, okunma anından sonraki not; pencere 180 gün; sayaç metni 1…99 / 99+', () => {
  const now = new Date('2026-10-09T12:00:00Z');
  assert.equal(UNREAD_WINDOW_DAYS, 180);
  assert.equal(unreadSince({ createdAt: new Date('2026-10-01T00:00:00Z') }, now).toISOString(), '2026-10-01T00:00:00.000Z', 'yeni kullanıcı: oluşturulma anından');
  assert.equal(unreadSince({ createdAt: new Date('2020-01-01T00:00:00Z') }, now).getTime(), now.getTime() - 180 * DAY, 'en çok 180 gün geriye');
  assert.equal(unreadSince({}, now).getTime(), now.getTime() - 180 * DAY);
  const me = { id: 'u1' };
  const since = new Date('2026-10-09T10:00:00Z');
  assert.equal(isUnreadNote({ userId: 'u2', createdAt: '2026-10-09T10:00:01Z' }, me, since), true);
  assert.equal(isUnreadNote({ userId: 'u2', createdAt: '2026-10-09T10:00:00Z' }, me, since), false, 'okunma anındaki not okunmuştur');
  assert.equal(isUnreadNote({ userId: 'u1', createdAt: '2026-10-09T11:00:00Z' }, me, since), false, 'kendi notu sayılmaz');
  assert.deepEqual([0, 1, 9, 99, 100, 5000].map(countText), ['0', '1', '9', '99', '99+', '99+']);
  assert.equal(seesInternal({ appRole: 'MUSTERI' }), false, 'müşteri iç notu hiç saymaz');
  for (const r of ['ADMIN', 'SATIS', 'CIZIM', 'DENETIMCI']) assert.equal(seesInternal({ appRole: r }), true, r);
});

test('mesaj bildirimi (karar 199): müşterinin mesajı yönetici + ilgili satışçı + atanmış çizimciye; profil siparişinde yalnızca yöneticiye; iç ekibin mesajı müşteriye; bağlantı #notlar; metin bildirime girmez', () => {
  const glass = { id: 'o1', orderTypeCode: 'GLASS_ORDER' }, profile = { id: 'o2', orderTypeCode: 'PROFILE_ORDER' };
  const rule = INAPP_RULES[NOTE_EVENT];
  assert.deepEqual(rule.to(glass, { fromCustomer: true }), ['admin', 'orderSales', 'drawer']);
  assert.deepEqual(rule.to(profile, { fromCustomer: true }), ['admin'], 'profil siparişi satışa / çizime uğramaz');
  assert.deepEqual(rule.to(glass, { fromCustomer: false }), ['customer']);
  assert.equal(rule.link(glass, {}), '/siparisler/o1#notlar');
  assert.ok(!(NOTE_EVENT in NOTIFY_RULES), 'mesaj e-postası yok');
  assert.deepEqual(renderInApp('tr', { type: NOTE_EVENT, params: { aud: 'staff', orderNo: 'UNS12', firm: 'UNS**********' } }), { title: 'Siparişte yeni mesaj', body: 'UNS12 · UNS**********' });
  assert.deepEqual(renderInApp('ro', { type: NOTE_EVENT, params: { aud: 'customer', orderNo: 'UNS12' } }), { title: 'Aveți un mesaj nou la comandă', body: 'Comanda UNS12' });
  // Olay verisinde not METNİ yok
  const svc = strip(read('server/notes/translation.js'));
  assert.match(svc, /payload: \{ noteId: note\.id, fromCustomer: !can\(actor\.role, 'NOTE_INTERNAL_VIEW'\), actorId: actor\.id \}/);
});

/** Not servisinin sahte veritabanı: kilit, tek kullanımlık anahtar, kuyruk */
function fakeDb() {
  const notes = [];
  const outbox = [];
  const model = {
    order: {
      async findFirst({ where }) { return ['o1', 'o2'].includes(where.id) && (where.customerId === undefined || where.customerId === 'A') ? { id: where.id } : null; },
    },
    integrationSetting: { async findUnique() { return null; } },
    orderNote: {
      async count({ where }) { return notes.filter((n) => n.orderId === where.orderId).length; },
      async findFirst({ where }) { const n = notes.find((x) => x.requestKey === where.requestKey && x.orderId === where.orderId && x.userId === where.userId); return n ? { ...n } : null; },
      async create({ data }) {
        if (data.requestKey && notes.some((n) => n.requestKey === data.requestKey)) throw Object.assign(new Error('unique'), { code: 'P2002' });
        const n = { id: `n${notes.length + 1}`, translationStatus: null, ...data };
        notes.push(n);
        return { ...n };
      },
    },
    notificationOutbox: { async create({ data }) { const r = { id: `ob${outbox.length + 1}`, ...data }; outbox.push(r); return r; } },
  };
  let chain = Promise.resolve();
  return {
    ...model, notes, outbox,
    async $transaction(fn) {
      // Sipariş not kilidi: işlemler sırayla
      const run = chain.then(() => fn({ ...model, async $executeRaw() { return 1; } }));
      chain = run.catch(() => {});
      return run;
    },
  };
}
const KEY = 'k'.repeat(10) + '0123456789abcdef';
const cust = { id: 'c1', role: 'MUSTERI', customerId: 'A' };
const sales = { id: 's1', role: 'SATIS', customerId: null };

test('tek kullanımlık anahtar (karar 199): aynı form iki kez (çift tıklama / paralel istek) → tek not, tek olay; yeni form yeni mesajdır; iç not olay yazmaz', async () => {
  assert.equal(noteRequestKey('short'), null);
  assert.equal(noteRequestKey('x'.repeat(65)), null);
  assert.equal(noteRequestKey('a b'.repeat(8)), null);
  assert.equal(noteRequestKey(KEY), KEY);
  const db = fakeDb();
  const limits = createNoteLimits();
  const add = (actor, o = {}) => addNote(db, { orderId: 'o1', actor, text: 'Merhaba', limits, ...o });
  const [a, b] = await Promise.all([add(cust, { requestKey: KEY }), add(cust, { requestKey: KEY })]);
  assert.equal(a.ok && b.ok, true);
  assert.equal(db.notes.length, 1, 'tek not');
  assert.equal(db.outbox.length, 1, 'tek olay');
  assert.equal(a.ok && b.ok && a.noteId === b.noteId, true);
  assert.deepEqual([a, b].map((r) => (r.ok ? r.duplicate === true : null)).sort(), [false, true]);
  assert.deepEqual(db.outbox[0].payload, { noteId: db.notes[0].id, fromCustomer: true, actorId: 'c1' });
  // Aynı anahtar başka bir kullanıcıdan / siparişten: başka notu döndürmez, yeni not da yazılmaz
  assert.deepEqual(await add(sales, { requestKey: KEY }), { ok: false, code: 'NOT_FOUND' });
  // Yeni form (yeni anahtar) = yeni mesaj = yeni olay
  const c = await add(cust, { requestKey: `${KEY}x` });
  assert.equal(c.ok && !c.duplicate, true);
  assert.equal(db.outbox.length, 2);
  // İç ekibin müşteriye açık mesajı → müşteri yönünde olay; iç not → olay yok
  await add(sales, { requestKey: `${KEY}y` });
  assert.equal(db.outbox.at(-1).payload.fromCustomer, false);
  const before = db.outbox.length;
  const internal = await add(sales, { requestKey: `${KEY}z`, internal: true });
  assert.equal(internal.ok && internal.outboxId, null);
  assert.equal(db.outbox.length, before, 'iç not olay yazmaz');
  // Anahtarsız (eski form) not yine yazılır
  assert.equal((await add(cust)).ok, true);
});

test('formun anahtarı hiçbir role dönmez; not ekranı ve liste aynı okunmamış kuralını kullanır; okundu işareti geri gitmez ve kapsam dışında yazılmaz', () => {
  const notes = [{ id: 'n1', internal: false, requestKey: KEY, text: 'x' }, { id: 'n2', internal: true, requestKey: KEY, text: 'y' }];
  for (const r of ['ADMIN', 'SATIS', 'CIZIM', 'DENETIMCI', 'MUSTERI']) {
    for (const n of notesFor(r, notes)) assert.ok(!('requestKey' in n), r);
  }
  assert.deepEqual(notesFor('MUSTERI', notes).map((n) => n.id), ['n1'], 'müşteri iç notu almaz (değişmedi)');
  const svc = strip(read('server/notes/unread.js'));
  assert.match(svc, /WHERE "OrderNoteRead"\."lastReadAt" < EXCLUDED\."lastReadAt"/, 'okunma anı yalnızca ileri gider');
  assert.match(svc, /orderScope\(user\)/, 'kapsam denetimi');
  assert.match(svc, /\(\$\{internal\} OR n\."internal" = false\)/, 'iç not yalnızca görebilene');
  assert.ok(!/session|recordActivity|lastSeenAt/.test(svc), 'okundu işareti oturuma dokunmaz');
  const page = strip(read('app/(panel)/siparisler/[id]/page.tsx'));
  assert.ok(page.includes('isUnreadNote(n, user, since)') && page.includes('unreadThreshold(db, user, order.id)'));
  const list = strip(read('app/(panel)/siparisler/page.tsx'));
  assert.equal((list.match(/unreadNotesFor\(user, /g) ?? []).length, 2, 'müşteri ve iç liste');
  const layout = strip(read('app/(panel)/layout.tsx'));
  assert.ok(layout.includes('unreadTotal(db, user)'));
  // Okundu (karar 205): yalnızca mesaj ekranda GERÇEKTEN görülünce — okunmamış varsa liste kapalı başlar; açıkken notun
  // kendisi görünür sekmede belirli oranla ve süreyle görünmeli; sayfa açılışı / yenileme / yoklama okumaz
  const mark = read('components/NotesList.tsx');
  assert.ok(mark.includes('useState(unread === 0)'), 'okunmamış varsa kapalı başlar');
  assert.ok(mark.includes('new IntersectionObserver(') && mark.includes("document.visibilityState !== 'visible'") && mark.includes('SEEN_MS'));
  assert.ok(mark.includes("if (!open || !root"), 'kapalı liste hiçbir şey okumaz');
  assert.ok(!/fetch\(|setInterval/.test(mark), 'ayrı yoklama yok');
  assert.ok(!fs.existsSync(new URL('../components/MarkNotesRead.tsx', import.meta.url)), 'sayfa açılınca okuyan eski bileşen kaldırıldı');
});

test('dil ayarı (karar 198): bütün roller için (kendi kaydı); e-posta tercihi yalnızca müşteri hesabında; seçenekler Otomatik / Türkçe / Română', () => {
  const page = strip(read('app/(panel)/ayarlar/page.tsx'));
  const action = strip(read('app/(panel)/ayarlar/actions.ts'));
  assert.ok(page.includes('await requireUser()') && action.includes('await requireUser()'));
  assert.ok(!page.includes("requirePermission('ACCOUNT_SETTINGS')") && !action.includes("requirePermission('ACCOUNT_SETTINGS')"));
  assert.ok(action.includes("customerAccount ? formData.get('emailNotifications') === 'on' : user.emailNotifications"));
  assert.ok(action.includes('where: { id: user.id }'), 'yalnızca oturumdaki kullanıcı');
  assert.deepEqual([...page.matchAll(/<option value="([a-z]*)"/g)].map((m) => m[1]), ['', 'tr', 'ro'], 'İngilizce yok (karar 9)');
  assert.equal(translate('tr', 'settings.languageNone'), 'Otomatik');
  assert.equal(translate('ro', 'settings.languageNone'), 'Automat');
  const roles = read('lib/roles.ts');
  assert.equal((roles.match(/\{ href: '\/ayarlar', key: 'nav\.mySettings' \}/g) ?? []).length, 4, 'yönetici, satış, çizim, denetimci');
  // Belgeler sayfası müşteriye özel kalır (ACCOUNT_SETTINGS iç ekibe verilmedi)
  assert.ok(read('server/auth/permissions.js').includes("const CUSTOMER_ONLY = ['ORDER_CREATE', 'DRAWING_APPROVE', 'OFFER_APPROVE', 'ACCOUNT_SETTINGS'];"));
});

test('anlık arama (karar 201): bekleme süresi (yalnızca son değer gider), adres parametreleri korunur, kutu sunucudan ezilmez, firma adıyla arama yok', () => {
  const src = strip(read('components/LiveSearch.tsx'));
  assert.ok(src.includes('setTimeout(() => go(v), delay)') && src.includes('delay = 300'));
  assert.ok(src.includes('if (timer.current) clearTimeout(timer.current);'), 'her tuşta önceki zamanlayıcı iptal');
  assert.ok(src.includes('router.replace(') && !/setValue\(defaultValue|useEffect\(\(\) => \{[^}]*setValue/.test(src), 'kutunun değeri sunucudan gelen değerle ezilmez');
  assert.ok(src.includes('new URLSearchParams(window.location.search)'));
  assert.ok(src.includes('params.delete(name)'), 'boş arama normal liste');
  assert.ok(!/fetch\(|setInterval/.test(src), 'ayrı istek / yoklama yok: sayfa sunucuda süzülür');
  const list = strip(read('app/(panel)/siparisler/page.tsx'));
  const where = list.slice(list.indexOf('function searchWhere('), list.indexOf('async function Sla('));
  assert.ok(!/customer\s*:|\bname\b/.test(where), 'firma adı aranmaz (maskeli rol firma adını tahmin edemez)');
  assert.ok(list.includes('take: 300'), 'liste sınırlı');
});

test('30 dakika kuralı: 29. dakikada açık, 30. dakikada kapalı; otomatik istekler oturumu uzatmaz (karar 135 değişmedi)', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const s = (idleMin) => ({ expiresAt: now + DAY, lastSeenAt: now - idleMin * MIN });
  assert.equal(SESSION_IDLE_MS, 30 * MIN);
  assert.equal(sessionState(s(29), now), 'ok');
  assert.equal(sessionState({ expiresAt: now + DAY, lastSeenAt: now - 30 * MIN + 1 }, now), 'ok');
  assert.equal(sessionState(s(30), now), 'idle');
  // Bu paketteki yeni sunucu kodu oturuma yazmaz
  for (const f of ['server/notes/unread.js', 'components/NotesList.tsx', 'components/LiveSearch.tsx', 'app/(panel)/ayarlar/actions.ts']) {
    assert.ok(!/recordActivity|reportSessionActivity|lastSeenAt/.test(strip(read(f))), f);
  }
});

test('okundu düzeltmesi (karar 205): mesaj bildirimi tıklanınca okunmaz (yalnızca mesaj görülünce); öbür bildirim türleri eskisi gibi tıklanınca okunur', async () => {
  const { toastFor } = await import('../server/notifications/feed.js');
  const lib = readFileSync('lib/notifications.ts', 'utf8');
  assert.match(lib, /readOnView: n\.type === NOTE_EVENT/, 'akış: yalnızca sipariş mesajı bildirimi "görülünce okunur"');
  assert.equal(NOTE_EVENT, 'ORDER_NOTE_ADDED');
  const center = readFileSync('components/NotificationCenter.tsx', 'utf8');
  const open = center.slice(center.indexOf('const openItem'), center.indexOf('const badge'));
  assert.match(open, /if \(!readOnView\) \{ markRead\(id, link\); return; \}/, 'öbür türler: tıklama okur (değişmedi)');
  assert.equal(open.match(/markRead\(/g)?.length, 1, 'mesaj bildirimi yolunda okuma isteği yok');
  assert.match(center, /openItem\(e, n\.id, n\.link, n\.readOnView\)/);
  assert.match(center, /readOnView/);
  // Açılır bildirim de aynı bilgiyi taşır
  const one = { id: 'n1', title: 't', body: '', link: '/siparisler/x#notlar', createdAt: '2026-10-09T10:00:00.000Z' };
  assert.equal(toastFor([{ ...one, readOnView: true }])?.readOnView, true);
  assert.equal(toastFor([one])?.readOnView, false);
  // Sipariş sayfası açılınca okuma yok: okuma yalnızca liste açık + görünürlük gözlemiyle (NotesList), sayfada başka çağrı yok
  const page = readFileSync('app/(panel)/siparisler/[id]/page.tsx', 'utf8');
  assert.equal(page.match(/markNotesReadAction/g)?.length, 2, 'içe aktarma + NotesList\'e verilen işlev — sayfa kendisi çağırmaz');
  assert.doesNotMatch(page, /markNotesReadAction\(/);
  const list = readFileSync('components/NotesList.tsx', 'utf8');
  assert.match(list, /useState\(unread === 0\)/, 'okunmamış varsa liste kapalı başlar');
  assert.doesNotMatch(list, /setInterval|takip:poll|AutoRefresh/, 'yoklama okumaz');
});
