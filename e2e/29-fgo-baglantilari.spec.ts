import { test, expect, type Page } from '@playwright/test';
import type { PrismaClient } from '@prisma/client';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, INSPECTOR_PW, as, newOrder } from './helpers';

// FGO'nun verdiği belge bağlantısı dış veridir (güvenlik denetimi AUD-7, karar 144): ekranda yalnızca FGO'nun kendi
// adresiyse tıklanabilir gösterilir. Değilse belge bilgisi (numara, tarih) bağlantısız yazılır ve reddedilen adres sayfanın
// kaynağına hiç girmez; PDF yolu da oraya yönlendirmez.
// Belge kayıtları bu testte doğrudan veritabanına yazılır (FGO bu veritabanında kapalıdır ve hiçbir istek gitmez): geçerli
// bağlantının PDF'i İSTENMEZ (yalnızca sayfadaki bağlantının kendisine bakılır) — gerçek FGO adresine ağ isteği yapılmaz.
test.describe.configure({ mode: 'serial' });

const INSPECTOR = 'denetim@e2e.test';
const EVIL = 'https://evil.example/fatura.pdf';
const TRICK = 'https://www.fgo.ro@evil.example/fatura.pdf';
const GOOD = 'https://www.fgo.ro/facturi/TST90002.pdf';
const GOOD_PROFILE = 'https://www.fgo.ro/facturi/TST90003.pdf';

let db: PrismaClient;
test.beforeAll(async () => {
  const { PrismaClient: Client } = await import('@prisma/client');
  db = new Client();
});
test.afterAll(async () => { await db.$disconnect(); });

/** Sayfada reddedilen adresin izi yok: ne bağlantı olarak ne de kaynakta (sunucu bileşeni verisi dahil) */
async function noTrace(page: Page, where: string) {
  await expect(page.locator('a[href*="evil.example"]'), where).toHaveCount(0);
  expect(await page.content(), where).not.toContain('evil.example');
}

test('cam siparişi belgeleri: FGO adresi tıklanabilir; FGO dışı adres bağlantısız yazılır (sipariş sayfası, Tahsilat, PDF yolu)', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const bad = await newOrder(cust, 'Belge bağlantısı — FGO dışı', 'baglanti-1.pdf');
  const good = await newOrder(cust, 'Belge bağlantısı — FGO', 'baglanti-2.pdf');
  const trick = await newOrder(cust, 'Belge bağlantısı — benzer ad', 'baglanti-3.pdf');
  const docs = await Promise.all([
    db.fgoDocument.create({ data: { orderId: bad, kind: 'PROFORMA', series: 'TST', number: '90001', issuedAt: new Date(), link: EVIL, total: '121.00', paid: '0.00' } }),
    db.fgoDocument.create({ data: { orderId: good, kind: 'PROFORMA', series: 'TST', number: '90002', issuedAt: new Date(), link: GOOD, total: '121.00', paid: '0.00' } }),
    db.fgoDocument.create({ data: { orderId: trick, kind: 'PROFORMA', series: 'TST', number: '90004', issuedAt: new Date(), link: TRICK, total: '121.00', paid: '0.00' } }),
  ]);
  try {
    const admin = await as(browser, ADMIN, ADMIN_PW);
    const insp = await as(browser, INSPECTOR, INSPECTOR_PW);
    for (const [who, page] of [['müşteri', cust], ['yönetici', admin], ['denetimci', insp]] as const) {
      // FGO dışı adres: belge numarası yazılı, bağlantı yok, adresin izi yok
      for (const [id, ref] of [[bad, 'TST90001'], [trick, 'TST90004']] as const) {
        await page.goto(`/siparisler/${id}`);
        await expect(page.getByText(ref).first(), `${who} ${ref}`).toBeVisible();
        await noTrace(page, `${who} /siparisler (${ref})`);
        await expect(page.locator('a[href*="fgo.ro"]'), `${who} ${ref}`).toHaveCount(0);
      }
      // FGO adresi: bağlantı tıklanabilir, yeni sekmede, güvenli rel ile
      await page.goto(`/siparisler/${good}`);
      await expect(page.getByText('TST90002').first(), who).toBeVisible();
      const link = page.locator(`a[href="${GOOD}"]`).first();
      await expect(link, who).toBeVisible();
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    // Muhasebe → Cam Tahsilat: üç belge de listede; yalnızca FGO adresli olan bağlantılı
    await admin.goto('/admin/muhasebe/cam');
    for (const ref of ['TST90001', 'TST90002', 'TST90004']) await expect(admin.getByText(ref).first()).toBeVisible();
    await noTrace(admin, 'Cam Tahsilat');
    await expect(admin.locator(`a[href="${GOOD}"]`)).toHaveCount(1);
    await expect(admin.getByRole('link', { name: 'TST90001' })).toHaveCount(0);
    await expect(admin.getByRole('link', { name: 'TST90004' })).toHaveCount(0);
    // Müşterinin belge dolabı: belgeler listede; "Vezi PDF" uygulamanın kendi yoludur (FGO adresi sayfada yok)
    await cust.goto('/belgeler');
    await expect(cust.getByText('TST90001').first()).toBeVisible();
    await noTrace(cust, '/belgeler');
    await expect(cust.locator('a[href*="fgo.ro"]')).toHaveCount(0);
    // PDF yolu: FGO dışı bağlantıya YÖNLENDİRMEZ (FGO kapalı → 503); sahiplik denetimi aynı
    for (const d of [docs[0], docs[2]]) {
      const res = await cust.request.get(`/belgeler/${d.id}/pdf`, { maxRedirects: 0 });
      expect(res.status(), d.number).toBe(503);
      expect(res.headers().location, d.number).toBeUndefined();
    }
    await admin.context().close();
    await insp.context().close();
  } finally {
    await db.fgoDocument.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } });
    await cust.context().close();
  }
});

test('profil siparişi belgeleri (proformaLink / invoiceLink — yalnızca FGO işçisi yazar): FGO dışı adres sayfaya hiç taşınmaz', async ({ browser }) => {
  // Proforması kesilmiş, silinmemiş bir profil siparişi (11-profil testinden); bağlantı alanları test sonunda eski değerine döner
  const p = await db.profileOrder.findFirst({ where: { proformaAt: { not: null }, order: { removedAt: null } }, orderBy: { proformaAt: 'desc' }, select: { orderId: true, proformaNo: true, proformaLink: true, invoiceLink: true, invoicedAt: true } });
  expect(p, 'proforması olan profil siparişi').toBeTruthy();
  const admin = await as(browser, ADMIN, ADMIN_PW);
  try {
    for (const evil of [EVIL, TRICK, 'http://www.fgo.ro/facturi/x.pdf', 'https://www.fgo.ro:8443/facturi/x.pdf', 'javascript:alert(1)']) {
      await db.profileOrder.update({ where: { orderId: p!.orderId }, data: { proformaLink: evil, invoiceLink: evil } });
      await admin.goto(`/siparisler/${p!.orderId}`);
      await expect(admin.locator('h1').first()).toBeVisible();
      if (p!.proformaNo) await expect(admin.getByText(p!.proformaNo).first(), evil).toBeVisible();
      await noTrace(admin, `profil (${evil})`);
      await expect(admin.locator('a[href*="fgo.ro"], a[href^="javascript:"]'), evil).toHaveCount(0);
      expect(await admin.content(), evil).not.toContain(evil);
    }
    // FGO adresi: bağlantı görünür
    await db.profileOrder.update({ where: { orderId: p!.orderId }, data: { proformaLink: GOOD_PROFILE, invoiceLink: p!.invoicedAt ? GOOD_PROFILE : null } });
    await admin.goto(`/siparisler/${p!.orderId}`);
    const links = admin.locator(`a[href="${GOOD_PROFILE}"]`);
    await expect(links.first()).toBeVisible();
    await expect(links).toHaveCount(p!.invoicedAt ? 2 : 1);
    await expect(links.first()).toHaveAttribute('rel', 'noopener noreferrer');
  } finally {
    await db.profileOrder.update({ where: { orderId: p!.orderId }, data: { proformaLink: p!.proformaLink, invoiceLink: p!.invoiceLink } });
    await admin.context().close();
  }
});
