import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, TEAM_PW, as } from './helpers';

// 3.87.0 (karar 282) — tedarikçi siparişi mal kabulü, gerçek sunucuda: yönetici kısmi teslimatı girer → yalnızca girilen
// miktar stoğa eklenir, kalan / önceki görünür; INTRAREA MARFĂ belgesi indirilir (PDF); işçi depo alıcılarına alıcı başına
// tek e-posta yazar (gerçek e-posta YOK: MAIL_OUTBOX_DIR, adresler .test); kalan da gelince sipariş "Teslim alındı" olur ve
// mal kabulü kapanır. Satışçı sipariş ekranını / belgeyi açamaz. Tedarikçi siparişi test sürecinde servislerle hazırlanır.
test.describe.configure({ mode: 'serial' });

const SALES = 'fiyat-satis@e2e.test'; // 08'de açılan satışçı
const SUP = 'E2E Mal Kabul Tedarik';
const DEPOT = ['mal-kabul-depo1@e2e-depo.test', 'mal-kabul-depo2@e2e-depo.test'];
let orderId = '';
let orderNo = '';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
const worker = () => execFileSync('node', ['scripts/worker.mjs', '--once'], { env: process.env, stdio: 'inherit' });
const mails = (to: string) => {
  const dir = process.env.MAIL_OUTBOX_DIR!;
  return fs.readdirSync(dir).filter((f) => f.includes(to)).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
};
async function level(db: Awaited<ReturnType<typeof prisma>>, code: string) {
  const p = await db.profileProduct.findUniqueOrThrow({ where: { code } });
  const r = await db.stockMovement.aggregate({ where: { productId: p.id }, _sum: { qty: true } });
  return r._sum.qty ?? 0;
}

test('hazırlık: tedarikçi, depo alıcıları (.test) ve onaylanmış tedarikçi siparişi (stok değişmez)', async () => {
  const db = await prisma();
  try {
    const svc = await import('../server/suppliers/service.js');
    const { saveWarehouseSettings } = await import('../server/profile/warehouse.js');
    const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
    const actor = { id: admin.id, role: admin.appRole, ip: '127.0.0.1' };
    await saveWarehouseSettings(db, { recipients: DEPOT }, actor);
    const s = await svc.saveSupplier(db, { name: SUP, email: 'siparis@e2e-mal-kabul.test', currency: 'EUR' }, actor);
    expect(s.ok).toBe(true);
    const c = await svc.createDraftOrder(db, { supplierId: (s as { id: string }).id }, actor, { timeZone: 'Europe/Bucharest' });
    expect(c.ok).toBe(true);
    orderId = (c as { id: string }).id;
    const ids = await Promise.all(['RM12-7016', 'GK15'].map(async (code) => (await db.profileProduct.findUniqueOrThrow({ where: { code } })).id));
    let o = await db.supplierOrder.findUniqueOrThrow({ where: { id: orderId } });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest' }).format(new Date());
    const saved = await svc.saveDraft(db, { orderId, version: o.version, orderDate: today, note: '', lines: [{ productId: ids[0], qty: 10, unitPrice: '11.5', color: 'RAL 7016' }, { productId: ids[1], qty: 4, unitPrice: '', color: '' }] }, actor, { timeZone: 'Europe/Bucharest' });
    expect(saved.ok).toBe(true);
    o = await db.supplierOrder.findUniqueOrThrow({ where: { id: orderId } });
    const stock = await level(db, 'RM12-7016');
    expect((await svc.approveAndSend(db, { orderId, version: o.version }, actor)).ok).toBe(true);
    orderNo = o.orderNo;
    expect(await level(db, 'RM12-7016')).toBe(stock); // onay / gönderim stoğu değiştirmez
  } finally {
    await db.$disconnect();
  }
});

test('kısmi mal kabulü: önceki / yeni / kalan; yalnızca girilen miktar stoğa; belge PDF; depo e-postası alıcı başına bir kez', async ({ browser }) => {
  const db = await prisma();
  const admin = await as(browser, ADMIN, ADMIN_PW);
  try {
    const before = [await level(db, 'RM12-7016'), await level(db, 'GK15')];
    await admin.goto(`/siparisler/tedarik/${orderId}`);
    const box = admin.locator('#mal-kabul');
    await expect(box).toBeVisible();
    const rm = box.locator('tr[data-receipt-line="RM12-7016"]');
    await expect(rm.locator('[data-ordered]')).toHaveText('10');
    await expect(rm.locator('[data-received]')).toHaveText('0');
    await expect(rm.locator('[data-remaining]')).toHaveText('10');
    await expect(rm).toContainText('6 m'); // profil uzunluğu (bar boyu)
    await expect(box).not.toContainText('11,5'); // alış fiyatı mal kabulünde yok
    await rm.locator('input[type="number"]').fill('6');
    await box.locator('#rc-ref').fill('AVZ-E2E-1');
    admin.once('dialog', (d) => d.accept());
    await box.getByRole('button', { name: 'Mal kabulünü kaydet' }).click();
    await expect(admin).toHaveURL(/ok=receivedPart/);
    await expect(admin.getByText('Mal kabulü kaydedildi: miktarlar stoğa eklendi')).toBeVisible();
    await expect(rm.locator('[data-received]')).toHaveText('6');
    await expect(rm.locator('[data-remaining]')).toHaveText('4');
    expect([await level(db, 'RM12-7016'), await level(db, 'GK15')]).toEqual([before[0] + 6, before[1]]);
    const item = admin.locator('#kabuller [data-receipt="1"]');
    await expect(item).toContainText('AVZ-E2E-1');
    await expect(item).toContainText('Kısmi teslimat');
    await expect(item).toContainText('Stoğa eklendi');
    // INTRAREA MARFĂ belgesi (yeniden indirilebilir)
    const href = await item.locator('[data-receipt-pdf]').getAttribute('href');
    for (let i = 0; i < 2; i++) {
      const res = await admin.request.get(href!);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toBe('application/pdf');
      expect((await res.body()).subarray(0, 5).toString()).toBe('%PDF-');
    }
    // İşçi: depo alıcılarına alıcı başına tek e-posta (PDF ekli); tekrar çalışınca ikinci ileti yok
    worker();
    worker();
    for (const to of DEPOT) {
      const sent = mails(to);
      expect(sent).toHaveLength(1);
      expect(sent[0].subject).toBe(`GKH Trading Invest – Intrare marfă – ${orderNo} – recepția nr. 1 – ${SUP}`);
      expect(sent[0].attachments.map((a: { filename: string }) => a.filename)).toContain(`Intrare-Marfa-${orderNo.replace(/[^A-Za-z0-9_]+/g, '-')}-1.pdf`);
      expect(sent[0].text).toContain('6 bare');
      expect(sent[0].html).not.toContain('11,5');
      expect(sent[0].html).not.toContain('EUR');
    }
    await admin.reload();
    await expect(admin.locator('#kabuller [data-receipt="1"]')).toContainText('Depo e-postası gönderildi');
  } finally {
    await db.$disconnect();
    await admin.context().close();
  }
});

test('satışçı tedarikçi siparişini ve mal kabulü belgesini açamaz', async ({ browser }) => {
  const db = await prisma();
  const sales = await as(browser, SALES, TEAM_PW);
  try {
    const receipt = await db.supplierReceipt.findFirstOrThrow({ where: { orderId } });
    const res = await sales.request.get(`/siparisler/tedarik/${orderId}/kabul/${receipt.id}`);
    expect(res.status()).toBe(404);
    expect((await res.body()).subarray(0, 5).toString()).not.toBe('%PDF-');
    await sales.goto(`/siparisler/tedarik/${orderId}`);
    await expect(sales.locator('#mal-kabul')).toHaveCount(0);
  } finally {
    await db.$disconnect();
    await sales.context().close();
  }
});

test('kalan teslimat siparişi tamamlar: "Teslim alındı", mal kabulü kapanır, toplam sipariş edileni geçmez', async ({ browser }) => {
  const db = await prisma();
  const admin = await as(browser, ADMIN, ADMIN_PW);
  try {
    const before = [await level(db, 'RM12-7016'), await level(db, 'GK15')];
    await admin.goto(`/siparisler/tedarik/${orderId}`);
    const box = admin.locator('#mal-kabul');
    await box.locator('tr[data-receipt-line="RM12-7016"] input[type="number"]').fill('4');
    await box.locator('tr[data-receipt-line="GK15"] input[type="number"]').fill('4');
    admin.once('dialog', (d) => d.accept());
    await box.getByRole('button', { name: 'Mal kabulünü kaydet' }).click();
    await expect(admin).toHaveURL(/ok=receivedAll/);
    await expect(admin.locator('[data-supplier-status="TESLIM_ALINDI"]')).toBeVisible();
    await expect(admin.locator('#mal-kabul')).toHaveCount(0);
    await expect(admin.locator('#kabuller [data-receipt="2"]')).toContainText('Sipariş tamamlandı');
    expect([await level(db, 'RM12-7016'), await level(db, 'GK15')]).toEqual([before[0] + 4, before[1] + 4]);
    const got = await db.supplierReceiptLine.aggregate({ where: { receipt: { orderId } }, _sum: { qty: true } });
    expect(got._sum.qty).toBe(14);
  } finally {
    await db.$disconnect();
    await admin.context().close();
  }
});
