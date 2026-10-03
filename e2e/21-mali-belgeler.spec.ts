import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, TEAM_PW, as } from './helpers';

// Mali belgeler (karar 111):
//  - müşteri: "Documente financiare" — kendi firmasının FGO'da kesilmiş proforma / avans faturası / faturaları, ödeme
//    durumuyla; başka firmanın belgesi listede yok ve PDF adresi "bulunamadı" döner (adres değiştirerek ulaşılamaz)
//  - yönetici: Muhasebe → Cam Tahsilat satırında müşteri e-postasının durumu (Gönderildi / Bekliyor / Başarısız /
//    Email yok) ve "E-postayı tekrar gönder" — yalnızca TAKİP e-postası; FGO'da belge kesilmez
//  - işçi: e-postayı TAKİP gönderir (outbox klasörüne), müşteriye "Proforma este disponibilă." bildirimi düşer
// FGO bu veritabanında KAPALIDIR: hiçbir belge kesilmez, FGO'ya hiçbir istek gitmez (belgeler doğrudan veritabanına yazılır).
test.describe.configure({ mode: 'serial' });

const BETA = 'beta@betacam.test';
const SALES = 'fiyat-satis@e2e.test'; // 08'de açılan satışçı (satis@e2e.test 05'te bilerek kilitleniyor)
const INSPECTOR = 'denetim@e2e.test';
const FIRM_MAIL = 'contabil@unsal-belge.test';
const ids: Record<string, string> = {};
let betaDoc = '', orderId = '';

async function shot(page: Page, name: string) {
  const dir = process.env.SCREENSHOT_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const before = page.viewportSize();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, `masaustu-${name}.png`), fullPage: true });
  if (before) await page.setViewportSize(before);
}
async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
const romanian = (page: Page) => page.context().addCookies([{ name: 'takip_lang', value: 'ro', url: new URL(page.url()).origin }]);
const worker = () => execFileSync('node', ['scripts/worker.mjs', '--once'], { env: process.env, stdio: 'inherit' });
function mailsTo(email: string): { subject: string; text: string; to: string; attachments: unknown[] }[] {
  const dir = process.env.MAIL_OUTBOX_DIR!;
  return fs.readdirSync(dir).filter((f) => f.includes(email)).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

test('veri: müşterinin proforma / avans faturası / faturası, e-posta durumları ve başka firmanın belgesi', async () => {
  const db = await prisma();
  const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
  const u = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER }, include: { customer: true } });
  const beta = await db.user.findUniqueOrThrow({ where: { email: BETA }, include: { customer: true } });
  await db.customer.update({ where: { id: u.customer!.id }, data: { email: FIRM_MAIL } });
  const order = (firm: { id: string; prefix: string | null }, no: number) => db.order.create({
    data: { orderNo: `${firm.prefix}${no}`, customerOrderNo: no, title: `Belge e2e ${no}`, orderTypeCode: 'GLASS_ORDER', customerId: firm.id, createdById: admin.id, status: 'URETIMDE', estimatedShipDate: new Date('2026-12-10T12:00:00Z') },
  });
  const doc = async (key: string, o: { id: string }, kind: string, series: string, number: string, total: string, paid: string, minutesAgo: number) => {
    const d = await db.fgoDocument.create({ data: { orderId: o.id, kind, series, number, total, paid, issuedAt: new Date(Date.now() - minutesAgo * 60_000), checkedAt: new Date() } });
    ids[key] = d.id;
    return d;
  };
  const o1 = await order(u.customer!, 8101), o2 = await order(u.customer!, 8102), o3 = await order(u.customer!, 8103);
  orderId = o1.id;
  await doc('PRF81001', o1, 'PROFORMA', 'PRF', '81001', '605.00', '300.00', 50);
  await doc('GKH81002', o1, 'ADVANCE', 'GKH', '81002', '300.00', '300.00', 40);
  await doc('PRF81003', o2, 'PROFORMA', 'PRF', '81003', '726.00', '0', 30);
  await doc('PRF81005', o3, 'PROFORMA', 'PRF', '81005', '121.00', '0', 20);
  await doc('GKH81004', o3, 'INVOICE', 'GKH', '81004', '121.00', '0', 10);
  // Müşteri partisi belgesi (birden çok sipariş, tek belge): parti + belge kaydı — yalnızca veritabanı
  const o4 = await order(u.customer!, 8104);
  const day = new Date('2026-12-10T00:00:00Z');
  const batch = await db.billingBatch.create({
    data: {
      customerId: u.customer!.id, kind: 'PROFORMA', status: 'ISSUED', currency: 'EUR', loadingDays: [day], selectionKey: 'e2e-belge', sourceTotal: '200.00', ronNet: '1000.00',
      fxRate: '5.0000', fxDate: day, fxSource: 'MANUAL_DAY', fxPolicy: 'BT_UNIT_SELL', fxCurrency: 'EUR', fxBaseRate: '5.0000', fxSourceDate: day, fxResolvedAt: new Date(), fxManual: true,
      createdById: admin.id, issuedAt: new Date(),
      orders: { create: [o2, o4].map((o) => ({ orderId: o.id, orderNo: o.orderNo, offerId: 'e2e', loadingDay: day, sourceAmount: '100.00' })) },
      lines: { create: [o2, o4].map((o, i) => ({ orderId: o.id, sortOrder: i, name: `Comanda ${o.orderNo} — Sticlă securizată 10 mm`, unit: 'mp', quantity: '2', unitPrice: '50.00', amount: '100.00' })) },
    },
  });
  ids.PRF81006 = (await db.fgoDocument.create({ data: { batchId: batch.id, kind: 'PROFORMA', series: 'PRF', number: '81006', issuedAt: new Date(Date.now() - 8 * 60_000), total: '1210.00', paid: '1210.00', checkedAt: new Date() } })).id;
  const ob = await order(beta.customer!, 8109);
  betaDoc = (await doc('PRF81009', ob, 'PROFORMA', 'PRF', '81009', '999.00', '0', 5)).id;
  // E-posta işleri: gönderildi / başarısız / e-posta yok; PRF81005 kuyrukta (iki PDF denemesi yapılmış: sıradaki tur gönderir)
  await db.notificationOutbox.create({ data: { type: 'FGO_DOC_EMAIL', orderId: o1.id, status: 'SENT', sentAt: new Date(), inAppAt: new Date(), payload: { docId: ids.PRF81001, to: FIRM_MAIL, attached: true } } });
  await db.notificationOutbox.create({ data: { type: 'FGO_DOC_EMAIL', orderId: o2.id, status: 'FAILED', lastError: 'SMTP 550 mailbox unavailable', inAppAt: new Date(), payload: { docId: ids.PRF81003 } } });
  await db.notificationOutbox.create({ data: { type: 'FGO_DOC_EMAIL', orderId: o3.id, status: 'SKIPPED', lastError: 'NO_EMAIL', inAppAt: new Date(), payload: { docId: ids.GKH81004 } } });
  await db.notificationOutbox.create({ data: { type: 'FGO_DOC_EMAIL', orderId: o3.id, attempts: 2, lastError: 'PDF alınamadı: PDF bağlantısı yok', payload: { docId: ids.PRF81005 } } });
  await db.$disconnect();
});

test('müşteri: "Documente financiare" — kendi belgeleri, ödeme durumu, PDF; başka firmanın belgesi yok ve adresle de açılamaz', async ({ browser }) => {
  const page = await as(browser, CUSTOMER, CUST_PW);
  await romanian(page);
  await page.goto('/siparisler');
  await page.getByRole('link', { name: 'Documente financiare' }).click();
  await expect(page).toHaveURL(/\/belgeler$/);
  await expect(page.locator('h1')).toHaveText('Documente financiare');
  const row = (ref: string) => page.locator(`tr[data-doc="${ref}"]`);
  for (const [ref, kind, total, status, order] of [
    ['PRF81001', 'Proformă', '605,00', 'Plătit parțial', 'UNS8101'],
    ['GKH81002', 'Factură de avans', '300,00', 'Plătit', 'UNS8101'],
    ['PRF81003', 'Proformă', '726,00', 'Neplătit', 'UNS8102'],
    ['GKH81004', 'Factură', '121,00', 'Neplătit', 'UNS8103'],
    ['PRF81005', 'Proformă', '121,00', 'Facturată', 'UNS8103'],
  ] as const) {
    const r = row(ref);
    await expect(r).toHaveCount(1);
    await expect(r.locator('td').nth(0)).toHaveText(kind);
    await expect(r.locator('td').nth(1)).toHaveText(ref);
    await expect(r.locator('td').nth(3)).toContainText(order);
    await expect(r.locator('td').nth(4)).toHaveText(total);
    await expect(r.locator('td').nth(5)).toHaveText('RON');
    await expect(r.locator('td').nth(6)).toHaveText(status);
    await expect(r.getByRole('link', { name: 'Vezi PDF' })).toHaveAttribute('href', `/belgeler/${ids[ref]}/pdf`);
  }
  // Müşteri partisi belgesi: tek satır, kaynak sipariş numaralarıyla
  await expect(row('PRF81006').locator('td').nth(3)).toHaveText('UNS8102, UNS8104');
  await expect(row('PRF81006').locator('td').nth(4)).toHaveText('1.210,00');
  await expect(row('PRF81006').locator('td').nth(6)).toHaveText('Plătit');
  // Başka firmanın belgesi, e-posta hataları, yönetici düğmeleri yok
  const html = await page.content();
  for (const hidden of ['PRF81009', 'BET8109', 'Retrimite', 'tekrar gönder', 'SMTP 550']) expect(html, hidden).not.toContain(hidden);
  await shot(page, 'mali-belgeler');
  // Sipariş numarası sipariş sayfasının bağlantısıdır
  await expect(row('PRF81001').getByRole('link', { name: 'UNS8101' })).toHaveAttribute('href', `/siparisler/${orderId}`);

  // PDF adresi: kendi belgesi sunucudan istenir (FGO kapalı ve bağlantı yok → "şu an açılamıyor"); başkasının belgesi,
  // sipariş kimliği ya da uydurma kimlik → bulunamadı
  const own = await page.request.get(`/belgeler/${ids.PRF81001}/pdf`);
  expect(own.status()).toBe(503);
  expect(await own.text()).toContain('Documentul nu este disponibil momentan');
  for (const forged of [betaDoc, orderId, 'yok']) expect((await page.request.get(`/belgeler/${forged}/pdf`)).status(), forged).toBe(404);
  await page.context().close();
});

test('gizlilik ve yetki: öbür müşteri yalnızca kendi belgesini görür; iç roller müşteri ekranını açamaz; oturumsuz istek reddedilir', async ({ browser }) => {
  const beta = await as(browser, BETA, TEAM_PW);
  await beta.goto('/belgeler');
  await expect(beta.locator('tr[data-doc="PRF81009"]')).toHaveCount(1);
  const html = await beta.content();
  for (const ref of ['PRF81001', 'GKH81002', 'PRF81003', 'GKH81004', 'PRF81005', 'UNS8101']) expect(html, ref).not.toContain(ref);
  for (const ref of ['PRF81001', 'GKH81002', 'GKH81004']) expect((await beta.request.get(`/belgeler/${ids[ref]}/pdf`)).status(), ref).toBe(404);
  expect((await beta.request.get(`/belgeler/${betaDoc}/pdf`)).status()).toBe(503);
  await beta.context().close();

  for (const [email, pw] of [[SALES, TEAM_PW], [DRAWER, TEAM_PW], [INSPECTOR, 'Denet1']] as const) {
    const p = await as(browser, email, pw);
    await expect(p.getByRole('link', { name: /Mali belgeler|Documente financiare/ })).toHaveCount(0);
    await p.goto('/belgeler');
    await expect(p.locator('#belgeler')).toHaveCount(0); // yetkisi yok: kendi ana sayfasına döner
    expect((await p.request.get(`/belgeler/${ids.PRF81001}/pdf`)).status(), email).toBe(404);
    await p.context().close();
  }
  const anon = await browser.newContext();
  expect((await anon.request.get(`/belgeler/${ids.PRF81001}/pdf`, { maxRedirects: 0 })).status()).toBe(401);
  await anon.close();
});

test('yönetici: e-posta durumu; "E-postayı tekrar gönder" yalnızca TAKİP e-postasını kuyruğa alır — belge kesilmez; işçi e-postayı gönderir', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/admin/muhasebe/cam');
  const cell = (ref: string) => admin.locator('table.acc-table tr', { hasText: ref }).locator('td.doc-mail');
  await expect(cell('PRF81001')).toHaveAttribute('data-mail', 'SENT');
  await expect(cell('PRF81001')).toContainText('Gönderildi');
  await expect(cell('PRF81003')).toContainText('Başarısız');
  await expect(cell('GKH81004')).toContainText('Email yok');
  await expect(cell('PRF81005')).toContainText('Bekliyor');
  await expect(cell('PRF81005').getByRole('button')).toHaveCount(0); // kuyrukta beklerken ikinci istek yok
  await expect(cell('GKH81002')).toContainText('gönderilmedi');
  await shot(admin, 'tahsilat-eposta');

  const db = await prisma();
  const docsBefore = await db.fgoDocument.count();
  const jobs = { type: { in: ['FGO_GLASS', 'FGO_BATCH', 'FGO_PROFORMA', 'FGO_INVOICE'] } };
  const jobsBefore = await db.notificationOutbox.count({ where: jobs });
  await cell('GKH81002').getByRole('button', { name: 'E-postayı tekrar gönder' }).click();
  await expect(admin.locator('.alert-ok', { hasText: 'E-posta yeniden gönderilmek üzere kuyruğa alındı' })).toBeVisible();
  await expect(cell('GKH81002')).toContainText('Bekliyor');
  const manual = await db.notificationOutbox.findFirstOrThrow({ where: { type: 'FGO_DOC_EMAIL', status: 'PENDING', payload: { path: ['docId'], equals: ids.GKH81002 } } });
  expect((manual.payload as { manual?: boolean }).manual).toBe(true);
  expect(await db.fgoDocument.count()).toBe(docsBefore);
  expect(await db.notificationOutbox.count({ where: jobs })).toBe(jobsBefore); // FGO işi kuyruğa girmedi
  expect(await db.auditLog.count({ where: { action: 'FGO_DOC_EMAIL_RESEND', entityId: ids.GKH81002 } })).toBe(1);

  // Satış aynı sunucu işlemini taklit ederse (yöneticinin formundaki işlem kimliğiyle) hiçbir iş yazılmaz
  const page = await (await admin.request.get('/admin/muhasebe/cam')).text();
  const form = page.split('<form').find((chunk) => chunk.includes(`value="${ids.PRF81003}"`));
  const field = form ? /\$ACTION_ID_[0-9a-f]+/.exec(form) : null;
  expect(field, 'yeniden gönderme işlemi bulunamadı').toBeTruthy();
  const sales = await as(browser, SALES, TEAM_PW);
  await sales.request.post('/admin/muhasebe/cam', { multipart: { [field![0]]: '', type: 'GLASS_ORDER', docId: ids.PRF81003 }, headers: { origin: new URL(sales.url()).origin } });
  expect(await db.notificationOutbox.count({ where: { type: 'FGO_DOC_EMAIL', payload: { path: ['docId'], equals: ids.PRF81003 } } })).toBe(1);
  await sales.context().close();

  // İşçi: bekleyen iki e-postayı TAKİP gönderir (PDF alınamadığı için — FGO kapalı — eksiz; belge TAKİP'te)
  await db.notificationOutbox.update({ where: { id: manual.id }, data: { attempts: 2 } });
  worker();
  const docMails = () => mailsTo(FIRM_MAIL).filter((m) => /^(Proformă|Factură)/.test(m.subject));
  const mails = docMails();
  expect(mails.map((m) => m.subject).sort()).toEqual(['Factură de avans GKH81002 — comanda UNS8101', 'Proformă PRF81005 — comanda UNS8103']);
  const mail = mails.find((m) => m.subject.startsWith('Proformă'))!;
  for (const part of ['Tip document: Proformă', 'Număr document: PRF81005', 'Data emiterii:', 'Comanda: UNS8103', 'Total: 121,00 RON (cu TVA)', '/belgeler']) expect(mail.text).toContain(part);
  expect(mail.to).toBe(FIRM_MAIL);
  expect(await db.fgoDocument.count()).toBe(docsBefore);
  expect(await db.notificationOutbox.count({ where: jobs })).toBe(jobsBefore);
  // İşçi yeniden çalışınca aynı e-postalar bir daha gitmez
  worker();
  expect(docMails().length).toBe(2);
  await db.$disconnect();
  await admin.reload();
  await expect(cell('GKH81002')).toContainText('Gönderildi');
  await expect(cell('PRF81005')).toContainText('Gönderildi');
  await admin.context().close();
});

test('müşteri: "Proforma este disponibilă." bildirimi belgeye götürür', async ({ browser }) => {
  const db = await prisma();
  const u = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER } });
  const notes = await db.notification.findMany({ where: { userId: u.id, type: { in: ['DOC_PROFORMA', 'DOC_ADVANCE', 'DOC_INVOICE'] } } });
  await db.$disconnect();
  // Yalnızca otomatik (belge kesilince yazılan) iş bildirim üretir: PRF81005. Elle yeniden gönderme (GKH81002) üretmez.
  expect(notes.map((x) => x.link)).toEqual([`/belgeler#doc-${ids.PRF81005}`]);
  const page = await as(browser, CUSTOMER, CUST_PW);
  await romanian(page);
  await page.goto('/siparisler');
  await page.locator('.notif-bell').click();
  const item = page.locator('.notif-panel .notif-item', { hasText: 'Proforma este disponibilă.' });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('PRF81005');
  await item.locator('a.notif-main').click();
  await expect(page).toHaveURL(new RegExp(`/belgeler#doc-${ids.PRF81005}$`));
  await expect(page.locator(`#doc-${ids.PRF81005}`)).toBeVisible();
  await expect(page.locator(`#doc-${ids.PRF81005}`)).toContainText('PRF81005');
  await page.context().close();
});
