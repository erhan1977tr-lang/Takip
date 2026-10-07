import { test, expect, type Browser, type Page } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, INSPECTOR_PW, TEAM_PW, as, createUser, firstLogin, login, outboxCodeFor } from './helpers';

// Kilit olayı = kilidi oluşturan deneme; kilitliyken gelen istek hiçbir şey yazmaz (karar 149; güvenlik denetimi 3.50.9
// AUD-11). Gerçek sunucuda, sunucu işlemlerine doğrudan (tarayıcı formu olmadan) isteklerle:
//  - giriş: aynı anda 20 yanlış şifre → LOGIN_LOCKED tam BİR satır (kullanıcı kimliği + güvenilir IP + kapsam); ardından
//    50 kilitli istek (doğru şifreyle de) → denetim kaydı, bildirim ve deneme tablosu değişmez; başka IP / hesap olağan
//  - hesabı olmayan e-posta → kullanıcıya bağlı kayıt yok
//  - davet kodu: ayrı IP'lerden aynı anda 8 yanlış kod → 5 karşılaştırma, CODE_FAILED tam 5; kilitli davette kayıt yok
//  - e-posta geneli kilit → yalnızca yöneticilere uygulama içi bildirim; aynı gün ikinci kilitte yeni bildirim yok;
//    satış / çizim / denetimci / müşteri almaz; e-posta kuyruğuna hiçbir şey yazılmaz
//  - kullanılan şifreler, kodlar ve denenen e-postalar hiçbir denetim kaydının içeriğinde yok
// Sınırlar veritabanındadır (e-posta + IP). Bu dosya kendi kullanıcılarını ve kendi IP adreslerini (X-Forwarded-For —
// testte vekil yoktur) kullanır: öteki testlerin sayaçlarını etkilemez. E-posta gönderilmez (klasöre yazılır).
test.describe.configure({ mode: 'serial' });

const USER = 'kilit@unsal.test'; // şifresi olan kullanıcı (e-posta + IP kilidi)
const MAILUSER = 'kilit-eposta@unsal.test'; // şifresi olan kullanıcı (e-posta geneli kilit + bildirim)
const INVITED = 'kilit-davet@unsal.test'; // davet bekleyen kullanıcı (kod adımı)
const GHOST = 'hayalet-kilit@yok.test'; // hesabı olmayan e-posta
const WRONG_PW = 'yanlis-kilit-sifre';
const IP_A = '203.0.113.110';
const IP_B = '203.0.113.111';
const IP_C = '203.0.113.112';
const CODE_IPS = Array.from({ length: 8 }, (_, i) => `203.0.113.${120 + i}`);
const SETUP = `/setup?email=${encodeURIComponent(INVITED)}`;
const LOCK_TITLE = 'Güvenlik: bir hesabın girişi çok sayıda hatalı deneme nedeniyle kilitlendi';
/** Bu dosyada denenen kodlar (son test denetim kayıtlarında arar) */
const usedCodes: string[] = [];

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
/** Verilen IP'den (X-Forwarded-For) gelen yeni bir tarayıcı oturumu */
async function from(browser: Browser, ip: string): Promise<Page> {
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': ip } });
  return ctx.newPage();
}
async function actionField(page: Page, url: string, marker: string): Promise<string> {
  const html = await (await page.request.get(url)).text();
  const form = html.split('<form').find((chunk) => chunk.includes(marker));
  const m = form ? /\$ACTION_ID_[0-9a-f]+/.exec(form) : null;
  expect(m, `sunucu işlemi alanı bulunamadı (${url}, ${marker})`).toBeTruthy();
  return m![0];
}
/** Sunucu işlemine doğrudan istek (tarayıcı formu olmadan), verilen IP'den; yanıtın vardığı adres döner */
async function post(page: Page, url: string, field: string, data: Record<string, string>, ip: string, extra: Record<string, string> = {}): Promise<URL> {
  const origin = new URL(page.url()).origin;
  const res = await page.request.post(url, { multipart: { [field]: '', ...data }, headers: { origin, 'x-forwarded-for': ip, ...extra } });
  return new URL(res.url());
}
const tally = (list: (string | null)[], v: string) => list.filter((x) => x === v).length;
type Row = { action: string; entityType: string; actorRole: string | null; ip: string | null; details: unknown };
/** Denetim kayıtlarının İÇERİK alanları (rastgele kimlikler ve zaman dışarıda): sır / e-posta araması bunda yapılır */
const textOf = (rows: Row[]) => JSON.stringify(rows.map((a) => [a.action, a.entityType, a.actorRole, a.ip, a.details]));

test('veri: şifresi olan iki kullanıcı ve davet bekleyen bir kullanıcı', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await createUser(admin, { email: USER, name: 'Kilit Kişi', role: 'Müşteri', firm: 'Ünsal Cam' });
  await createUser(admin, { email: MAILUSER, name: 'Kilit Eposta', role: 'Müşteri', firm: 'Ünsal Cam' });
  await createUser(admin, { email: INVITED, name: 'Kilit Davetli', role: 'Müşteri', firm: 'Ünsal Cam' });
  await admin.context().close();
  for (const email of [USER, MAILUSER]) {
    const fresh = await (await browser.newContext()).newPage();
    await firstLogin(fresh, email, outboxCodeFor(email), TEAM_PW);
    await fresh.context().close();
  }
});

test('giriş: aynı anda 20 yanlış şifre → LOGIN_LOCKED tam 1; ardından 50 kilitli istek hiçbir şey yazmaz; doğru şifre açmaz; başka IP / hesap olağan', async ({ browser }) => {
  const db = await prisma();
  const user = await db.user.findUniqueOrThrow({ where: { email: USER } });
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  const field = await actionField(page, '/login', 'name="password"');
  // Aynı anda 20 istek, hepsi yanlış şifre; istemci sahte IP başlıkları da gönderir (sayılmaz, kayda girmez — karar 116)
  const forged = { 'cf-connecting-ip': '10.7.0.9', 'x-real-ip': '10.7.1.9', 'true-client-ip': '10.7.2.9' };
  const urls = await Promise.all(Array.from({ length: 20 }, (_, i) => post(page, '/login', field, { email: USER, password: `${WRONG_PW}-${i}`, lang: 'tr' }, IP_A, forged)));
  const errors = urls.map((u) => u.searchParams.get('error'));
  expect([tally(errors, 'invalid'), tally(errors, 'locked')], 'yalnızca 5 istek şifreyi denedi').toEqual([5, 15]);
  // Kilit kaydı: TEK satır — kilidi oluşturan (5.) başarısız denemeden; reddedilen 15 istek kayıt üretmedi
  const locks = await db.auditLog.findMany({ where: { action: 'LOGIN_LOCKED', entityId: user.id } });
  expect(locks.map((a) => [a.userId, a.entityType, a.actorRole, a.ip, a.details])).toEqual([[user.id, 'User', 'MUSTERI', IP_A, { ip: IP_A, kind: 'LOGIN', scopes: ['account'] }]]);
  expect(await db.auditLog.count({ where: { action: 'LOGIN_FAILED', entityId: user.id, ip: IP_A } })).toBe(5);
  expect(await db.auditLog.count({ where: { ip: { startsWith: '10.7.' } } }), 'sahte IP başlıkları kayda girmez').toBe(0);
  expect(await db.notification.count({ where: { type: 'AUTH_LOCKED', dedupeKey: { startsWith: `auth-lock:${user.id}:` } } }), 'e-posta + IP kilidi yöneticiye bildirilmez').toBe(0);

  // Zaten kilitli: aynı anda 50 istek daha (yarısı DOĞRU şifreyle) → hepsi kilitli; hiçbir tablo değişmez
  const counts = async () => [await db.auditLog.count(), await db.notification.count(), await db.authFailure.count(), await db.notificationOutbox.count(), await db.session.count({ where: { userId: user.id } })];
  const before = await counts();
  const more = await Promise.all(Array.from({ length: 50 }, (_, i) => post(page, '/login', field, { email: USER, password: i % 2 ? TEAM_PW : `${WRONG_PW}-x${i}`, lang: 'tr' }, IP_A, forged)));
  expect(more.map((u) => [u.pathname, u.searchParams.get('error')])).toEqual(Array(50).fill(['/login', 'locked']));
  expect(await counts(), 'kilitli istek denetim kaydı / bildirim / deneme satırı / oturum yazmaz').toEqual(before);
  expect((await db.authFailure.findMany({ where: { email: USER, ip: IP_A } })).map((r) => r.kind)).toEqual(Array(5).fill('LOGIN'));
  // Oturum açılmadı
  await page.goto('/siparisler');
  await expect(page).toHaveURL(/\/login/);
  await page.context().close();

  // Başka IP'den aynı hesap ve aynı IP'den başka hesap olağan çalışır (ekrandan); kilit kaydı yine tek
  const other = await from(browser, IP_B);
  await login(other, USER, TEAM_PW);
  await other.context().close();
  const neighbour = await from(browser, IP_A);
  await login(neighbour, CUSTOMER, CUST_PW);
  await neighbour.context().close();
  expect(await db.auditLog.count({ where: { action: 'LOGIN_LOCKED', entityId: user.id } })).toBe(1);
  expect(await db.auditLog.count({ where: { action: 'LOGIN_LOCKED', ip: { in: [IP_A, IP_B] } } })).toBe(1);
  await db.$disconnect();
});

test('hesabı olmayan e-posta: kilitlenir ama kullanıcıya bağlı kayıt (ve hiçbir denetim satırı) yazılmaz', async ({ browser }) => {
  const db = await prisma();
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  const field = await actionField(page, '/login', 'name="password"');
  const urls = await Promise.all(Array.from({ length: 8 }, (_, i) => post(page, '/login', field, { email: GHOST, password: `${WRONG_PW}-g${i}`, lang: 'tr' }, IP_C)));
  const errors = urls.map((u) => u.searchParams.get('error'));
  expect([tally(errors, 'invalid'), tally(errors, 'locked')]).toEqual([5, 3]);
  expect((await db.authFailure.findMany({ where: { email: GHOST } })).length).toBe(5);
  expect(await db.auditLog.count({ where: { ip: IP_C } }), 'hesabı olmayan e-posta için kayıt yok').toBe(0);
  await page.context().close();
  await db.$disconnect();
});

test('davet kodu: aynı anda 8 yanlış kod → 5 karşılaştırma, CODE_FAILED tam 5; kilitli davette doğru kod kayıt üretmez', async ({ browser }) => {
  const db = await prisma();
  const user = await db.user.findUniqueOrThrow({ where: { email: INVITED } });
  const invite = () => db.userInvite.findFirstOrThrow({ where: { userId: user.id, usedAt: null }, orderBy: { createdAt: 'desc' } });
  const code = outboxCodeFor(INVITED);
  const wrong: string[] = [];
  for (let i = 0; wrong.length < 8; i++) { const c = String(200000 + i * 7919).slice(0, 6); if (c !== code) wrong.push(c); }
  usedCodes.push(code, ...wrong);
  const page = await (await browser.newContext()).newPage();
  await page.goto(SETUP);
  const field = await actionField(page, SETUP, 'name="code"');
  const urls = await Promise.all(wrong.map((c, i) => post(page, '/setup', field, { email: INVITED, code: c }, CODE_IPS[i])));
  expect(urls.map((u) => u.searchParams.get('error'))).toEqual(Array(8).fill('wrong_code'));
  expect((await invite()).attempts, 'davet başına en çok 5 karşılaştırma').toBe(5);
  // Yalnızca gerçekten karşılaştırılan 5 yanlış kod kayıtta: kullanıcı kimliği + IP; kodun kendisi yok
  const rows = await db.auditLog.findMany({ where: { action: 'CODE_FAILED', entityId: user.id } });
  expect(rows.length).toBe(5);
  for (const a of rows) {
    expect([a.userId, a.entityType, a.actorRole]).toEqual([user.id, 'User', 'MUSTERI']);
    expect(CODE_IPS).toContain(a.ip);
    expect(a.details).toEqual({ ip: a.ip });
  }
  expect(new Set(rows.map((a) => a.ip)).size, 'her kayıt ayrı bir denemeye ait').toBe(5);
  // Kilitli davet: doğru kod da karşılaştırılmaz → kayıt yok; hiçbir sınır dolmadı → kilit kaydı yok
  const correct = await post(page, '/setup', field, { email: INVITED, code }, '203.0.113.128');
  expect(correct.searchParams.get('error')).toBe('wrong_code');
  expect([await db.auditLog.count({ where: { action: 'CODE_FAILED', entityId: user.id } }), await db.auditLog.count({ where: { action: 'LOGIN_LOCKED', entityId: user.id } }), (await invite()).attempts]).toEqual([5, 0, 5]);
  // Daveti olmayan e-posta: kod karşılaştırılmaz → kayıt yok
  const none = await post(page, '/setup', field, { email: GHOST, code: wrong[0] }, '203.0.113.129');
  expect(none.searchParams.get('error')).toBe('wrong_code');
  expect(await db.auditLog.count({ where: { ip: '203.0.113.129' } })).toBe(0);
  await page.context().close();
  await db.$disconnect();
});

test('e-posta geneli kilit → yalnızca yöneticilere uygulama içi bildirim; aynı gün ikinci kilitte yeni bildirim yok; öteki roller almaz', async ({ browser }) => {
  const db = await prisma();
  const user = await db.user.findUniqueOrThrow({ where: { email: MAILUSER } });
  const adminIds = (await db.user.findMany({ where: { appRole: 'ADMIN', isActive: true }, select: { id: true } })).map((u) => u.id).sort();
  expect(adminIds.length).toBeGreaterThan(0);
  const notices = () => db.notification.findMany({ where: { type: 'AUTH_LOCKED', dedupeKey: { startsWith: `auth-lock:${user.id}:` } } });
  const locks = () => db.auditLog.findMany({ where: { action: 'LOGIN_LOCKED', entityId: user.id } });
  const outbox = await db.notificationOutbox.count();
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  const field = await actionField(page, '/login', 'name="password"');
  /** 4 IP'den 5'er yanlış şifre, aynı anda: 20 deneme → e-posta geneli sınır dolar */
  const burst = async (base: number) => {
    const urls = await Promise.all(Array.from({ length: 20 }, (_, i) => post(page, '/login', field, { email: MAILUSER, password: `${WRONG_PW}-m${base}-${i}`, lang: 'tr' }, `203.0.113.${base + (i % 4)}`)));
    expect(urls.map((u) => u.searchParams.get('error'))).toEqual(Array(20).fill('invalid'));
  };
  await burst(130);
  // Kilit kayıtları: her IP'nin 5. denemesi çifti doldurur (4 kayıt); bunlardan TAM BİRİ e-posta genelini de doldurur
  const first = await locks();
  expect(first.length).toBe(4);
  expect(first.filter((a) => ((a.details as { scopes: string[] }).scopes).includes('email')).length).toBe(1);
  expect(first.every((a) => (a.details as { kind: string }).kind === 'LOGIN' && a.userId === user.id)).toBe(true);
  // Bildirim: etkin yöneticilerin her birine tam bir satır; içerik: kullanıcının adı + kayıtlı e-postası
  const sent = await notices();
  expect(sent.map((n) => n.userId).sort()).toEqual(adminIds);
  expect(new Set(sent.map((n) => n.dedupeKey)).size).toBe(1);
  for (const n of sent) expect([n.link, n.orderId, n.params]).toEqual(['/admin/users', null, { user: `Kilit Eposta · ${MAILUSER}`, aud: 'staff' }]);

  // Kilitliyken başka IP'lerden 30 istek (doğru şifreyle): hepsi kilitli; kayıt ve bildirim değişmez
  const counts = async () => [await db.auditLog.count(), await db.notification.count(), await db.authFailure.count()];
  const before = await counts();
  const more = await Promise.all(Array.from({ length: 30 }, (_, i) => post(page, '/login', field, { email: MAILUSER, password: TEAM_PW, lang: 'tr' }, `203.0.113.${140 + i}`)));
  expect(more.map((u) => u.searchParams.get('error'))).toEqual(Array(30).fill('locked'));
  expect(await counts()).toEqual(before);

  // Aynı gün ikinci e-posta geneli kilit (pencerenin dolmasını beklemek yerine deneme satırları silinir — deneme tablosu
  // denetim kaydı değildir): yeni kilit kayıtları yazılır, bildirim YENİDEN gitmez
  await db.authFailure.deleteMany({ where: { email: MAILUSER } });
  await burst(134);
  const second = await locks();
  expect([second.length, second.filter((a) => ((a.details as { scopes: string[] }).scopes).includes('email')).length]).toEqual([8, 2]);
  expect((await notices()).map((n) => n.userId).sort(), 'aynı kullanıcı için günde en çok bir bildirim').toEqual(adminIds);
  await page.context().close();

  // Yönetici bildirimi zilde görür (kendi diliyle)
  const admin = await as(browser, ADMIN, ADMIN_PW);
  const feed = await (await admin.request.get('/bildirimler/akis')).json() as { items: { title: string; body: string; link: string | null }[] };
  const mine = feed.items.filter((i) => i.title === LOCK_TITLE);
  expect(mine.map((i) => [i.body, i.link])).toEqual([[`Kilit Eposta · ${MAILUSER}`, '/admin/users']]);
  await admin.context().close();
  // Satış, çizim, denetimci ve müşteri almaz (akışlarında yok; veritabanında da tek alıcı türü yönetici)
  for (const [email, pw] of [['fiyat-satis@e2e.test', TEAM_PW], [DRAWER, TEAM_PW], ['denetim@e2e.test', INSPECTOR_PW], [CUSTOMER, CUST_PW]] as const) {
    const p = await as(browser, email, pw);
    const f = await (await p.request.get('/bildirimler/akis')).json() as { items: { title: string; body: string }[] };
    expect(f.items.filter((i) => i.title === LOCK_TITLE || i.body.includes(MAILUSER)), email).toEqual([]);
    await p.context().close();
  }
  expect(await db.notification.count({ where: { type: 'AUTH_LOCKED', user: { appRole: { not: 'ADMIN' } } } })).toBe(0);
  expect(await db.notification.count({ where: { type: 'AUTH_LOCKED', user: { isActive: false } } })).toBe(0);
  // E-posta kanalı yok: e-postaların kaynağı olan kuyruğa bu olaylar için hiçbir şey yazılmadı
  expect(await db.notificationOutbox.count()).toBe(outbox);
  await db.$disconnect();
});

test('güvenlik verisi: kullanılan şifreler, davet kodları ve denenen e-postalar hiçbir denetim kaydının içeriğinde yok; kayıt alanları sabit', async () => {
  const db = await prisma();
  // Bu veritabanındaki BÜTÜN giriş / kod güvenlik kayıtları (öteki testlerin ürettikleri dahil)
  const auth = await db.auditLog.findMany({ where: { action: { in: ['LOGIN_LOCKED', 'LOGIN_FAILED', 'CODE_FAILED'] } } });
  expect(auth.filter((a) => a.action === 'LOGIN_LOCKED').length).toBeGreaterThan(0);
  expect(auth.filter((a) => a.action === 'CODE_FAILED').length).toBeGreaterThanOrEqual(5);
  for (const a of auth) {
    expect(a.entityType).toBe('User');
    expect(a.entityId, 'kayıt hesabı yalnızca kullanıcı kimliğiyle gösterir').toBe(a.userId);
    expect(Object.keys(a.details as object).sort(), a.action).toEqual(a.action === 'LOGIN_LOCKED' ? ['ip', 'kind', 'scopes'] : ['ip']);
    expect((a.details as { ip: string }).ip).toBe(a.ip);
    if (a.action === 'LOGIN_LOCKED') {
      const d = a.details as { kind: string; scopes: string[] };
      expect(['LOGIN', 'CODE']).toContain(d.kind);
      expect(d.scopes).toEqual(['account', 'email', 'ip'].filter((s) => d.scopes.includes(s)));
      expect(d.scopes.length).toBeGreaterThan(0);
      if (a.userId === null) expect(d.scopes).toEqual(['ip']);
    } else {
      expect(a.userId).toBeTruthy();
    }
  }
  const authText = textOf(auth);
  // Denenen e-postalar (hesabı olan ve olmayan), şifreler, kodlar: giriş / kod kayıtlarının içeriğinde yok
  for (const s of [USER, MAILUSER, INVITED, GHOST, '@', WRONG_PW, TEAM_PW, CUST_PW, ...usedCodes]) expect(authText.includes(s), `giriş / kod kayıtlarında "${s}" yok`).toBe(false);
  // Şifreler ve hesabı olmayan e-posta: veritabanındaki HİÇBİR denetim kaydının içeriğinde yok
  const all = await db.auditLog.findMany({ select: { action: true, entityType: true, actorRole: true, ip: true, details: true } });
  const allText = textOf(all);
  for (const s of [WRONG_PW, TEAM_PW, CUST_PW, ADMIN_PW, INSPECTOR_PW, GHOST]) expect(allText.includes(s), `denetim kayıtlarında "${s}" yok`).toBe(false);
  // Bildirimlerde de yok (yalnızca kullanıcının adı + kayıtlı e-postası vardır)
  const notes = JSON.stringify(await db.notification.findMany({ where: { type: 'AUTH_LOCKED' }, select: { params: true, message: true, link: true } }));
  for (const s of [WRONG_PW, TEAM_PW, GHOST, ...usedCodes, '203.0.113.']) expect(notes.includes(s), `bildirimlerde "${s}" yok`).toBe(false);
  await db.$disconnect();
});
