import { test, expect, type Page } from '@playwright/test';
import { ADMIN, ADMIN_PW, TEAM_PW, as, firstLogin, login, outboxCodeFor, seeSections } from './helpers';

// Paket A (3.64.0, kararlar 219–225):
//  - Yönetici Yardımcısı: kendi hesabıyla girer; menüde Kullanıcılar yok; kullanıcı sayfası ve Giriş Logları açılmaz (sunucu
//    yönlendirir); Ayarlar'da yalnızca operasyonel bölümler (BT kuru, fatura uyarısı, depo alıcıları) — FGO bağlantısı, not
//    çevirisi anahtarı ve antivirüs yok; müşteri firmasını silebilir (önizleme + elle yazılan ad), resmî belgesi olan firmayı silemez
//  - yönetici: Giriş Logları (başarılı / başarısız; bilinmeyen hesap adı yazılmaz), kullanıcının e-postasını değiştirir (eski
//    oturum düşer, kod yalnızca yeni adreste ve tek kullanımlık), kullanıcıyı siler (anonimleştirme)
//  - sipariş uyarısı: listede mavi sayaç; sipariş açılınca yalnızca açan kullanıcının uyarısı okunur
// Gerçek SMTP / FGO / ANAF / Google isteği yok: e-postalar outbox klasörüne yazılır; FGO belgesi yalnızca veritabanı kaydıdır.
test.describe.configure({ mode: 'serial' });

const RUN = Date.now().toString(36);
const YY = `yardimci-${RUN}@e2e.test`;
const VICTIM = `degisecek-${RUN}@e2e.test`;
const NEW_MAIL = `yeni-adres-${RUN}@e2e.test`;
const TEST_FIRM = `Silinecek Test ${RUN} SRL`;
const DOC_FIRM = `Belgeli Test ${RUN} SRL`;

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
async function createStaff(admin: Page, email: string, name: string, chip: RegExp) {
  await admin.goto('/admin/users');
  await admin.fill('#u-email', email);
  await admin.fill('#u-name', name);
  await admin.locator('label.chip', { hasText: chip }).click();
  await admin.selectOption('#u-firm', { label: 'GKH Trading (fabrika)' });
  await admin.click('form.card button[type=submit]');
  await expect(admin.getByText(`${email} → GKH Trading firmasına atandı ve davet e-postası gönderildi.`)).toBeVisible();
}

test('Yönetici Yardımcısı: hesap açılır; menüde Kullanıcılar yok; kullanıcı sayfası ve Giriş Logları açılmaz; Ayarlar yalnızca operasyonel', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await createStaff(admin, YY, 'E2E Yardımcı', /Yönetici Yardımcısı/);
  await admin.context().close();
  const ctx = await browser.newContext();
  const yy = await ctx.newPage();
  await firstLogin(yy, YY, outboxCodeFor(YY), TEAM_PW);
  const side = yy.locator('.sidebar');
  await expect(side.getByRole('link', { name: 'Siparişler', exact: true })).toBeVisible();
  await expect(side.getByRole('link', { name: 'Müşteriler' })).toBeVisible();
  await expect(side.locator('a[href="/admin/users"]')).toHaveCount(0);
  // Sunucu yetkisi: adres yazılsa da açılmaz
  await yy.goto('/admin/users');
  await expect(yy).toHaveURL(/\/siparisler/);
  await yy.goto('/admin/entegrasyonlar/giris-loglari');
  await expect(yy).toHaveURL(/\/siparisler/);
  await yy.goto('/admin/entegrasyonlar');
  await expect(yy).toHaveURL(/\/admin\/entegrasyonlar$/);
  for (const id of ['#kur', '#muhasebe', '#depo']) await expect(yy.locator(id)).toBeVisible();
  for (const id of ['#fgo', '#ceviri', '#antivirus', '#ortam-uyarilari']) await expect(yy.locator(id)).toHaveCount(0);
  await expect(yy.locator('[data-settings-tabs]')).not.toContainText('Giriş Logları');
  await expect(yy.locator('[data-settings-tabs]')).toContainText('Çalışma Takvimleri');
  // Operasyonel yönetim: teklifler, yüklemeler, kararlar açılır
  for (const url of ['/teklifler', '/yuklemeler', '/admin/kararlar', '/admin/firms']) {
    await yy.goto(url);
    await expect(yy, url).toHaveURL(new RegExp(url.replace(/\//g, '\\/')));
  }
  await ctx.close();
});

test('Giriş Logları (yalnızca yönetici): başarılı ve başarısız girişler; bilinmeyen hesabın denenen adresi yazılmaz; süzgeç', async ({ browser }) => {
  const ghost = `yok-${RUN}@hic-yok.test`;
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto('/login');
  await p.fill('#email', ghost);
  await p.fill('#password', 'yanlis-sifre-123');
  await p.click('button[type=submit]');
  await expect(p).toHaveURL(/error=invalid/);
  await ctx.close();
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/admin/entegrasyonlar');
  await admin.locator('[data-settings-tabs]').getByRole('link', { name: 'Giriş Logları' }).click();
  await expect(admin).toHaveURL(/giris-loglari/);
  const table = admin.locator('#giris-loglari');
  await expect(table.locator('tr[data-login-event=ok]').first()).toBeVisible();
  await expect(table.locator('[data-login-unknown]').first()).toBeVisible();
  expect(await admin.content()).not.toContain(ghost);
  await admin.selectOption('#gl-result', 'basarisiz');
  await admin.locator('#giris-suzgec').getByRole('button', { name: 'Süz' }).click();
  await expect(admin).toHaveURL(/sonuc=basarisiz/);
  await expect(table.locator('tr[data-login-event=ok]')).toHaveCount(0);
  await admin.context().close();
});

test('e-posta değişikliği (yalnızca yönetici): eski oturum düşer; kod yeni adreste ve tek kullanımlık; sonra kullanıcı silinir (anonimleştirme)', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await createStaff(admin, VICTIM, 'E2E Değişecek', /^Satış$/);
  const uctx = await browser.newContext();
  const user = await uctx.newPage();
  await firstLogin(user, VICTIM, outboxCodeFor(VICTIM), TEAM_PW);

  const db = await prisma();
  try {
    const row = await db.user.findUniqueOrThrow({ where: { email: VICTIM } });
    // Yönetici hesabının satırında e-posta değiştir / sil bağlantısı yok
    await admin.goto('/admin/users');
    const adminRow = admin.locator('tr', { hasText: ADMIN });
    await expect(adminRow.locator('[data-action=change-email], [data-action=delete-user]')).toHaveCount(0);
    // Başka kullanıcının adresi alınamaz
    await admin.goto(`/admin/users?eposta=${row.id}`);
    await admin.fill('#new-email', ADMIN);
    await admin.locator('#eposta-degistir').getByRole('button', { name: 'E-postayı değiştir ve kod gönder' }).click();
    await expect(admin.getByText('Bu e-posta adresi başka bir kullanıcıda kayıtlı.')).toBeVisible();
    // Değişiklik
    await admin.goto(`/admin/users?eposta=${row.id}`);
    await admin.fill('#new-email', NEW_MAIL);
    await admin.locator('#eposta-degistir').getByRole('button', { name: 'E-postayı değiştir ve kod gönder' }).click();
    await expect(admin).toHaveURL(/ok=emailChanged/);
    expect(await db.session.count({ where: { userId: row.id } })).toBe(0);
    // Eski oturum artık geçersiz
    await user.goto('/siparisler');
    await expect(user).toHaveURL(/\/login/);
    await uctx.close();
    // Eski adresle şifre girişi olmaz; kod yalnızca yeni adreste
    const code = outboxCodeFor(NEW_MAIL);
    const c2 = await browser.newContext();
    const p2 = await c2.newPage();
    await firstLogin(p2, NEW_MAIL, code, `${TEAM_PW}Yeni`);
    await c2.close();
    // Aynı kod ikinci kez kullanılamaz
    const c3 = await browser.newContext();
    const p3 = await c3.newPage();
    await p3.goto(`/setup?email=${encodeURIComponent(NEW_MAIL)}`);
    await p3.fill('#code', code);
    await p3.click('button[type=submit]');
    await expect(p3).toHaveURL(/error=wrong_code/);
    await c3.close();
    expect(await db.auditLog.count({ where: { action: 'USER_EMAIL_CHANGED', entityId: row.id } })).toBe(1);

    // Silme: önizleme → e-posta adresini yazarak onay
    await admin.goto('/admin/users');
    await admin.locator('tr', { hasText: NEW_MAIL }).locator('[data-action=delete-user]').click();
    await expect(admin.locator('#kullanici-sil [data-delete-kept]')).toBeVisible();
    await admin.fill('#sil-onay', NEW_MAIL);
    await admin.locator('#kullanici-sil').getByRole('button', { name: 'Kullanıcıyı kalıcı olarak sil' }).click();
    await expect(admin).toHaveURL(/ok=deleted/);
    await expect(admin.locator('tr', { hasText: NEW_MAIL })).toHaveCount(0);
    const gone = await db.user.findUniqueOrThrow({ where: { id: row.id } });
    expect([gone.isActive, gone.passwordHash, !!gone.deletedAt, gone.email.endsWith('.invalid')]).toEqual([false, null, true, true]);
    const c4 = await browser.newContext();
    const p4 = await c4.newPage();
    await p4.goto('/login');
    await p4.fill('#email', NEW_MAIL);
    await p4.fill('#password', `${TEAM_PW}Yeni`);
    await p4.click('button[type=submit]');
    await expect(p4).toHaveURL(/error=invalid/);
    await c4.close();
  } finally {
    await db.$disconnect();
    await admin.context().close();
  }
});

test('müşteri silme (Yönetici Yardımcısı): yalnızca o firmanın kayıtları; resmî belgesi olan firma silinemez; başka firmalar etkilenmez', async ({ browser }) => {
  const db = await prisma();
  try {
    const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
    const mkFirm = async (name: string, prefix: string) => {
      const f = await db.customer.create({ data: { name, prefix } });
      const u = await db.user.create({ data: { email: `m-${prefix.toLowerCase()}-${RUN}@e2e.test`, name: 'Test Müşteri', type: 'CUSTOMER', appRole: 'MUSTERI', customerId: f.id } });
      const o = await db.order.create({ data: { orderNo: `${prefix}1`, customerOrderNo: 1, title: 'Test', orderTypeCode: 'GLASS_ORDER', customerId: f.id, createdById: u.id, status: 'YENI' } });
      await db.orderNote.create({ data: { orderId: o.id, userId: u.id, text: 'test notu' } });
      await db.notification.create({ data: { userId: admin.id, message: 'x', type: 'ORDER_CREATED', orderId: o.id } });
      return { f, u, o };
    };
    const letters = (n: number) => String.fromCharCode(65 + (n % 26));
    const seed = Date.now();
    const t1 = await mkFirm(TEST_FIRM, `Q${letters(seed)}${letters(seed >> 5)}`);
    const t2 = await mkFirm(DOC_FIRM, `Z${letters(seed >> 3)}${letters(seed >> 7)}`);
    await db.fgoDocument.create({ data: { orderId: t2.o.id, kind: 'PROFORMA', series: 'PRF', number: `E2E${RUN}`, issuedAt: new Date() } });
    const others = await db.order.count({ where: { customerId: { notIn: [t1.f.id, t2.f.id] } } });

    const yy = await as(browser, YY, TEAM_PW);
    // Resmî belge: engel gösterilir, silme düğmesi yok
    await yy.goto(`/admin/firms/${t2.f.id}?sil=1`);
    await expect(yy.locator('#firma-sil [data-blocker=FGO_DOCUMENT]')).toBeVisible();
    await expect(yy.locator('#firma-sil').getByRole('button', { name: 'Firmayı ve kayıtlarını kalıcı olarak sil' })).toHaveCount(0);
    // Test firması: önizleme → yanlış ad reddedilir → doğru ad
    await yy.goto(`/admin/firms/${t1.f.id}`);
    await yy.locator('[data-action=delete-firm]').click();
    await expect(yy.locator('#firma-sil [data-delete-counts]')).toContainText('1 sipariş');
    await yy.fill('#firma-onay', 'Başka Firma');
    await yy.locator('#firma-sil').getByRole('button', { name: 'Firmayı ve kayıtlarını kalıcı olarak sil' }).click();
    await expect(yy.getByText('Onay için firma adını aynen yazın.')).toBeVisible();
    await yy.fill('#firma-onay', TEST_FIRM);
    await yy.locator('#firma-sil').getByRole('button', { name: 'Firmayı ve kayıtlarını kalıcı olarak sil' }).click();
    await expect(yy).toHaveURL(/\/admin\/firms\?deleted=/);
    await expect(yy.locator('[data-firm-deleted]')).toBeVisible();
    expect(await db.customer.findUnique({ where: { id: t1.f.id } })).toBeNull();
    expect(await db.order.findUnique({ where: { id: t1.o.id } })).toBeNull();
    expect(await db.notification.count({ where: { orderId: t1.o.id } })).toBe(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: t1.u.id } })).deletedAt).not.toBeNull();
    // Başka firmalar ve belgeli firma yerinde
    expect(await db.order.count({ where: { customerId: { notIn: [t1.f.id, t2.f.id] } } })).toBe(others);
    expect(await db.order.findUnique({ where: { id: t2.o.id } })).not.toBeNull();
    expect(await db.auditLog.count({ where: { action: 'CUSTOMER_DELETED', entityId: t1.f.id } })).toBe(1);
    await yy.context().close();
    // Belgeli test firması temizlenir (yalnızca test verisi; FGO belgesi gerçek değil)
    await db.fgoDocument.deleteMany({ where: { orderId: t2.o.id } });
  } finally {
    await db.$disconnect();
  }
});

test('sipariş uyarısı: listede sayaç; bölüm görülünce yalnızca gören kullanıcının uyarısı okunur', async ({ browser }) => {
  const db = await prisma();
  try {
    const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
    const yyUser = await db.user.findUniqueOrThrow({ where: { email: YY } });
    const order = await db.order.findFirstOrThrow({ where: { orderTypeCode: 'GLASS_ORDER', removedAt: null }, orderBy: { createdAt: 'desc' } });
    await db.notification.updateMany({ where: { userId: { in: [admin.id, yyUser.id] }, orderId: order.id }, data: { isRead: true } });
    for (const u of [admin, yyUser]) {
      await db.notification.create({ data: { userId: u.id, type: 'ORDER_DRAWING_UPLOADED', message: 'x', params: { aud: 'staff', orderNo: order.orderNo }, link: `/siparisler/${order.id}`, orderId: order.id, dedupeKey: `e2e:pa:${u.id}:${RUN}` } });
    }
    const page = await as(browser, ADMIN, ADMIN_PW);
    await page.goto(`/siparisler?view=all&q=${encodeURIComponent(order.orderNo)}`);
    const row = page.locator('tr', { has: page.locator(`a.order-no[href="/siparisler/${order.id}"]`) });
    await expect(row.locator('.order-alert')).toHaveText('1');
    await page.goto(`/siparisler/${order.id}`);
    // Paket B (karar 228): çizim uyarısı, çizim bölümü ekranda görülünce okunur (sayfayı açmak tek başına okumaz)
    await seeSections(page, ['.page-head', '#cizim']);
    await expect.poll(() => db.notification.count({ where: { userId: admin.id, orderId: order.id, isRead: false } })).toBe(0);
    expect(await db.notification.count({ where: { userId: yyUser.id, orderId: order.id, isRead: false } }), 'başka kullanıcının uyarısı kalır').toBe(1);
    await page.goto(`/siparisler?view=all&q=${encodeURIComponent(order.orderNo)}`);
    await expect(row.locator('.order-alert')).toHaveCount(0);
    await page.context().close();
  } finally {
    await db.$disconnect();
  }
});

test('giriş: Yönetici Yardımcısının girişi giriş loguna kendi adı ve rolüyle yazılır', async ({ browser }) => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await login(p, YY, TEAM_PW);
  await ctx.close();
  const db = await prisma();
  try {
    const u = await db.user.findUniqueOrThrow({ where: { email: YY } });
    const ev = await db.loginEvent.findFirstOrThrow({ where: { userId: u.id, success: true, kind: 'LOGIN' }, orderBy: { createdAt: 'desc' } });
    expect(ev.role).toBe('YONETICI_YARDIMCISI');
  } finally {
    await db.$disconnect();
  }
});
