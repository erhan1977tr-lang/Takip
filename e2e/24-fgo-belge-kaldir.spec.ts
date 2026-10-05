import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, INSPECTOR_PW, TEAM_PW, as, login } from './helpers';
import { fakeFgo } from './fake-fgo';

// "TAKİP'ten kaldır" (karar 132) — tarayıcıda: yöneticinin FGO'da ELLE sildiği belgenin TAKİP'teki kaydı.
//  - düğme yalnızca son FGO kontrolünde "belge yok" denen satırda ve yalnızca yöneticinin muhasebe ekranında
//  - onay penceresi: "yalnızca TAKİP'ten kaldırılır; FGO'da duran belgeler silinemez"
//  - FGO doğrulanamazsa hiçbir şey değişmez; belge FGO'da duruyorsa kaldırılmaz; kesin "belge yok"ta kayıt kalkar ve
//    siparişte "Proforma" yeniden istenebilir
//  - müşteri, satış, çizim ve denetimci işlemi taklit istekle de çalıştıramaz
// FGO bu veritabanında KAPALIDIR ve kapalı kalır: tarayıcıdan basılan düğme "doğrulanamadı" ile durur. FGO'nun yanıtına
// bağlı adımlar uygulamanın gerçek servisiyle, SAHTE FGO durum yanıtıyla sınanır (e2e/fake-fgo.ts) — gerçek FGO'ya
// hiçbir istek gitmez, hiçbir belge kesilmez / silinmez.
test.describe.configure({ mode: 'serial' });

const SALES2 = 'fiyat-satis@e2e.test';
const INSPECTOR = 'denetim@e2e.test';
const RECEIVABLES = '/admin/muhasebe/cam';
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000);
// Belge no → kayıt kimliği / sipariş kimliği
const docs: Record<string, { id: string; orderId: string }> = {};
let adminId = '';

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
async function actionField(page: Page, url: string, marker: string): Promise<string> {
  const html = await (await page.request.get(url)).text();
  const form = html.split('<form').find((chunk) => chunk.includes(marker));
  const m = form ? /\$ACTION_ID_[0-9a-f]+/.exec(form) : null;
  expect(m, `sunucu işlemi alanı bulunamadı (${url}, ${marker})`).toBeTruthy();
  return m![0];
}
async function forge(page: Page, url: string, field: string, data: Record<string, string>) {
  const origin = new URL(page.url()).origin;
  return page.request.post(url, { multipart: { [field]: '', ...data }, headers: { origin } });
}
const row = (page: Page, doc: string) => page.locator(`tr[data-doc="${doc}"]`);
const removeButton = (page: Page, doc: string) => row(page, doc).getByRole('button', { name: "TAKİP'ten kaldır" });

test('veri: FGO\'da silinmiş görünen iki proforma, sağlam bir proforma, başka bir kontrol hatası olan belge', async () => {
  const db = await prisma();
  const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
  adminId = admin.id;
  const cust = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER } });
  const firm = await db.customer.findUniqueOrThrow({ where: { id: cust.customerId! } });
  const make = async (no: number, number: string, checkError: string | null) => {
    const o = await db.order.create({
      data: {
        orderNo: `${firm.prefix}${no}`, customerOrderNo: no, title: 'Belge kaldırma e2e', orderTypeCode: 'GLASS_ORDER', customerId: firm.id, createdById: admin.id,
        status: 'URETIMDE', estimatedShipDate: day(30),
        offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '120.00', offerAmount: '200.00', createdById: admin.id, sentAt: new Date(),
          lines: { create: [{ sortOrder: 0, description: 'Temper', descriptionRo: 'Securizat', enMm: 1000, boyMm: 2000, adet: 1, unit: 'm2', unitPrice: '60', offerPrice: '100', kind: 'CAM' }] } } },
      },
    });
    const d = await db.fgoDocument.create({ data: { orderId: o.id, kind: 'PROFORMA', series: 'PRF', number, total: '300.00', paid: '0', issuedAt: day(-3), checkedAt: new Date(), checkError } });
    docs[`PRF${number}`] = { id: d.id, orderId: o.id };
  };
  await make(9801, '98563', 'Factura nu exista'); // yönetici FGO'da elle silmiş
  await make(9802, '98564', 'Factura nu exista');
  await make(9803, '98570', null); // sağlam
  await make(9804, '98571', 'Hash invalid'); // kontrol hatası var ama "belge yok" değil
  await db.$disconnect();
});

test('yönetici: düğme yalnızca FGO\'da "yok" görünen satırda; onay penceresi; FGO doğrulanamazsa hiçbir şey değişmez', async ({ page }) => {
  const db = await prisma();
  await login(page, ADMIN, ADMIN_PW);
  await page.goto(RECEIVABLES);
  // Üstte uyarı: hangi belgeler, satıra bağlantıyla
  const banner = page.locator('#fgo-absent');
  await expect(banner).toContainText('Son kontrolde 2 belge FGO\'da bulunamadı');
  await expect(banner.getByRole('link', { name: 'PRF98563' })).toHaveAttribute('href', `${RECEIVABLES}#doc-${docs.PRF98563.id}`);
  await expect(banner.getByRole('link', { name: 'PRF98564' })).toBeVisible();
  await expect(banner).not.toContainText('PRF98570');
  await expect(banner).not.toContainText('PRF98571');
  // Satırda: "FGO'da artık yok" + düğme. Sağlam belgede ve başka hatada düğme YOK (her satır kalabalıklaşmaz).
  await expect(row(page, 'PRF98563')).toContainText("FGO'da artık yok");
  await expect(removeButton(page, 'PRF98563')).toBeVisible();
  await expect(removeButton(page, 'PRF98564')).toBeVisible();
  await expect(removeButton(page, 'PRF98570')).toHaveCount(0);
  await expect(removeButton(page, 'PRF98571')).toHaveCount(0);
  await expect(row(page, 'PRF98571')).toContainText('son kontrol olmadı');
  await expect(page.getByRole('button', { name: "TAKİP'ten kaldır" })).toHaveCount(2);
  await shot(page, 'fgo-belge-kaldir');

  const before = JSON.stringify(await db.fgoDocument.findUniqueOrThrow({ where: { id: docs.PRF98563.id } }));
  // Onay penceresi: yalnızca TAKİP'ten kaldırılır. Vazgeçilirse istek gönderilmez.
  let message = '';
  page.once('dialog', (d) => { message = d.message(); void d.dismiss(); });
  await removeButton(page, 'PRF98563').click();
  expect(message).toBe("PRF98563 belgesi yalnızca TAKİP'ten kaldırılacak. FGO'da duran belgeler bu işlemle silinemez. Devam edilsin mi?");
  await expect(page).toHaveURL(new RegExp(`${RECEIVABLES}$`));
  expect(await db.auditLog.count({ where: { action: 'FGO_DOC_REMOVE_REQUEST', entityId: docs.PRF98563.id } })).toBe(0);

  // Onaylanırsa: FGO kapalı olduğundan belge doğrulanamaz → açık bir hata, hiçbir değişiklik
  page.once('dialog', (d) => void d.accept());
  await removeButton(page, 'PRF98563').click();
  await expect(page.locator('#doc-remove-error')).toHaveText("PRF98563 belgesi FGO'da doğrulanamadı. Hiçbir değişiklik yapılmadı.");
  await expect(removeButton(page, 'PRF98563')).toBeVisible();
  expect(JSON.stringify(await db.fgoDocument.findUniqueOrThrow({ where: { id: docs.PRF98563.id } }))).toBe(before);
  const audit = await db.auditLog.findMany({ where: { action: 'FGO_DOC_REMOVE_REQUEST', entityId: docs.PRF98563.id } });
  expect(audit.map((a) => [a.userId, (a.details as { result: string }).result])).toEqual([[adminId, 'FGO_DISABLED']]);
  expect(await db.auditLog.count({ where: { action: 'FGO_DOC_REMOVED' } })).toBe(0);
  // Ham FGO hatası / anahtar ekranda yok
  await expect(page.locator('#doc-remove-error')).not.toContainText(/hash|cheie|FGO_DISABLED/i);

  // Romence arayüz: düğme ve onay metni
  await page.goto(`/dil?l=ro&next=${RECEIVABLES}`);
  await expect(row(page, 'PRF98563').getByRole('button', { name: 'Șterge din TAKİP' })).toBeVisible();
  page.once('dialog', (d) => { message = d.message(); void d.dismiss(); });
  await row(page, 'PRF98563').getByRole('button', { name: 'Șterge din TAKİP' }).click();
  expect(message).toBe('Documentul PRF98563 va fi eliminat doar din TAKİP. Documentele existente în FGO nu pot fi șterse prin această acțiune. Continuăm?');
  await page.goto(`/dil?l=tr&next=${RECEIVABLES}`);
  await expect(removeButton(page, 'PRF98563')).toBeVisible();
  await db.$disconnect();
});

test('yetki: müşteri, satış, çizim ve denetimci düğmeyi göremez, işlemi taklit istekle de çalıştıramaz; onaysız istek işlenmez', async ({ browser }) => {
  const db = await prisma();
  const admin = await as(browser, ADMIN, ADMIN_PW);
  const field = await actionField(admin, RECEIVABLES, 'doc-absent');
  const target = docs.PRF98564;
  const before = JSON.stringify(await db.fgoDocument.findUniqueOrThrow({ where: { id: target.id } }));
  const requests = () => db.auditLog.count({ where: { action: 'FGO_DOC_REMOVE_REQUEST', entityId: target.id } });
  const users: [string, string][] = [[CUSTOMER, CUST_PW], [SALES2, TEAM_PW], [DRAWER, TEAM_PW], [INSPECTOR, INSPECTOR_PW]];
  for (const [email, pw] of users) {
    const p = await as(browser, email, pw);
    await p.goto(RECEIVABLES);
    await expect(p, email).toHaveURL(/\/siparisler$/);
    const body = await (await p.request.get(RECEIVABLES)).text();
    for (const s of ['PRF98564', "TAKİP'ten kaldır", 'doc-absent']) expect(body.includes(s), `${email} → ${s}`).toBe(false);
    // Sipariş sayfasında da (görebilen roller için) böyle bir düğme yok
    const orderPage = await (await p.request.get(`/siparisler/${target.orderId}`)).text();
    expect(orderPage.includes("TAKİP'ten kaldır"), email).toBe(false);
    await forge(p, RECEIVABLES, field, { type: 'GLASS_ORDER', docId: target.id, confirmed: '1' });
    expect(JSON.stringify(await db.fgoDocument.findUniqueOrThrow({ where: { id: target.id } })), `${email}: kayıt aynen`).toBe(before);
    expect(await requests(), `${email}: hizmete ulaşmadı`).toBe(0);
    await p.context().close();
  }
  // Yönetici, onay alanı olmadan (onay penceresi atlanmış istek): işlenmez
  const noConfirm = await forge(admin, RECEIVABLES, field, { type: 'GLASS_ORDER', docId: target.id });
  expect(noConfirm.url()).toContain('docError=CONFIRM');
  expect(await requests()).toBe(0);
  expect(JSON.stringify(await db.fgoDocument.findUniqueOrThrow({ where: { id: target.id } }))).toBe(before);
  await admin.context().close();
  await db.$disconnect();
});

test('FGO yanıtına göre: duruyorsa / doğrulanamıyorsa kayıt kalır; kesin "belge yok"ta kalkar, proforma yeniden istenebilir, uyarı kendiliğinden kalkar', async ({ page }) => {
  const db = await prisma();
  const fgo = await fakeFgo(db, 98600);
  const actor = { id: adminId, role: 'ADMIN', ip: '127.0.0.1' };
  await login(page, ADMIN, ADMIN_PW);
  const orderUrl = `/siparisler/${docs.PRF98563.orderId}`;
  const proformaForm = async () => ((await (await page.request.get(orderUrl)).text()).match(/value="PROFORMA"/g) ?? []).length;
  expect(await proformaForm(), 'proforması olan siparişte yeni proforma istenemez').toBe(0);

  // Yönetici olmayan rol (hizmet düzeyinde de): reddedilir, FGO'ya gidilmez
  for (const role of ['SATIS', 'CIZIM', 'DENETIMCI', 'MUSTERI']) {
    expect(await fgo.removeDeleted({ docId: docs.PRF98563.id, actor: { ...actor, role }, answer: 'gone' })).toEqual({ ok: false, code: 'FORBIDDEN' });
  }
  expect(fgo.statusCalls).toEqual([]);
  // FGO'ya ulaşılamıyor / kimlik hatası: kaldırılmaz
  for (const answer of ['down', 'auth'] as const) {
    expect(await fgo.removeDeleted({ docId: docs.PRF98563.id, actor, answer })).toEqual({ ok: false, code: 'UNVERIFIED', doc: 'PRF98563' });
  }
  // Belge FGO'da duruyor: kaldırılmaz (sağlam belge de, "yok" görünen belge de)
  expect(await fgo.removeDeleted({ docId: docs.PRF98570.id, actor, answer: 'exists' })).toEqual({ ok: false, code: 'EXISTS', doc: 'PRF98570' });
  expect(await fgo.removeDeleted({ docId: docs.PRF98564.id, actor, answer: 'exists' })).toEqual({ ok: false, code: 'EXISTS', doc: 'PRF98564' });
  expect(await db.fgoDocument.count({ where: { id: { in: Object.values(docs).map((d) => d.id) } } })).toBe(4);
  await page.goto(RECEIVABLES);
  // PRF98564 FGO'da duruyormuş: "yok" uyarısı ve düğmesi kalktı; PRF98563 hâlâ "yok" görünüyor
  await expect(removeButton(page, 'PRF98564')).toHaveCount(0);
  await expect(removeButton(page, 'PRF98563')).toBeVisible();
  await expect(page.locator('#fgo-absent')).toContainText('Son kontrolde 1 belge');

  // FGO kesin "belge yok" dedi: kayıt kalkar (mevcut temizlik yolu)
  expect(await fgo.removeDeleted({ docId: docs.PRF98563.id, actor, answer: 'gone' })).toEqual({ ok: true, doc: 'PRF98563', orderId: docs.PRF98563.orderId });
  expect(await db.fgoDocument.count({ where: { id: docs.PRF98563.id } })).toBe(0);
  expect(await db.fgoDocument.count({ where: { id: { in: [docs.PRF98564.id, docs.PRF98570.id, docs.PRF98571.id] } } })).toBe(3);
  expect(await db.orderEvent.count({ where: { orderId: docs.PRF98563.orderId, event: 'FGO_DOC_DELETED', note: 'PRF98563' } })).toBe(1);
  expect(await db.auditLog.count({ where: { action: 'FGO_DOC_REMOVED', entityId: docs.PRF98563.orderId } })).toBe(1);
  // FGO'ya yalnızca durum soruldu: her istek POST factura/getstatus — silme / kesme isteği yok
  expect(fgo.statusCalls).toEqual([
    'POST /factura/getstatus PRF98563', 'POST /factura/getstatus PRF98563',
    'POST /factura/getstatus PRF98570', 'POST /factura/getstatus PRF98564', 'POST /factura/getstatus PRF98563',
  ]);
  expect(fgo.calls, 'hiçbir belge kesilmedi').toEqual([]);

  // Ekran: satır ve uyarı kendiliğinden kalktı; sipariş sayfasında "Proforma" yeniden istenebilir
  await page.goto(RECEIVABLES);
  await expect(row(page, 'PRF98563')).toHaveCount(0);
  await expect(page.locator('#fgo-absent')).toHaveCount(0);
  await expect(page.getByRole('button', { name: "TAKİP'ten kaldır" })).toHaveCount(0);
  await expect(row(page, 'PRF98570')).toBeVisible();
  expect(await proformaForm(), 'belge kalkınca proforma düğmesi yeniden çıkar').toBeGreaterThan(0);
  await page.goto(orderUrl);
  await expect(page.locator('body')).toContainText("Belge FGO'da silinmiş; kaydı kaldırıldı");
  // Aynı kayıt yeniden istenirse: kayıt yok, FGO'ya gidilmez
  expect(await fgo.removeDeleted({ docId: docs.PRF98563.id, actor, answer: 'gone' })).toEqual({ ok: false, code: 'NOT_FOUND' });
  expect(fgo.statusCalls.length).toBe(5);
  await db.$disconnect();
});
