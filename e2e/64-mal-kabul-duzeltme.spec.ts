import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, TEAM_PW, as } from './helpers';

// 3.91.0 (karar 286) — hatalı mal kabulünün düzeltmesi, gerçek sunucuda. İzole test verisi (bu dosyanın kendi tedarikçisi,
// siparişi ve ürünü RM16-7016); gerçek e-posta YOK (MAIL_OUTBOX_DIR, adresler .test), FGO / ANAF yok.
//  - 100 kabul, gerçekte 80: yönetici 20'yi düzeltir (gerekçe + onay) → stok 20 azalır, net 80, kalan 20, otomatik kapanmış
//    sipariş yeniden açılır; orijinal kabul satırı aynen, düzeltme ayrı görünür; düzeltme belgesi (PDF)
//  - işçi düzeltme e-postasını alıcı başına bir kez gönderir; orijinal kabulün e-postası yeniden gitmez
//  - eski ekran (arada başka düzeltme) → reddedilir, hiçbir şey yazılmaz; sonraki gerçek teslimat normal
//  - satışçı düzeltme belgesini açamaz; Romence arayüz
test.describe.configure({ mode: 'serial' });

const SALES = 'fiyat-satis@e2e.test';
const SUP = 'E2E Kabul Düzeltme Tedarik';
const DEPOT = ['kabul-duzeltme-depo1@e2e-depo.test', 'kabul-duzeltme-depo2@e2e-depo.test'];
const CODE = 'RM16-7016';
let orderId = '';
let orderNo = '';
let receiptId = '';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
const worker = () => execFileSync('node', ['scripts/worker.mjs', '--once'], { env: process.env, stdio: 'inherit' });
const mails = (to: string) => {
  const dir = process.env.MAIL_OUTBOX_DIR!;
  return fs.readdirSync(dir).filter((f) => f.includes(to)).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
};
async function level(db: Awaited<ReturnType<typeof prisma>>) {
  const p = await db.profileProduct.findUniqueOrThrow({ where: { code: CODE } });
  return (await db.stockMovement.aggregate({ where: { productId: p.id }, _sum: { qty: true } }))._sum.qty ?? 0;
}

test('hazırlık: tedarikçi, depo alıcıları (.test), onaylanmış sipariş (100) ve tam mal kabulü (100) — sipariş otomatik kapandı', async () => {
  const db = await prisma();
  try {
    const svc = await import('../server/suppliers/service.js');
    const recv = await import('../server/suppliers/receipt.js');
    const { saveWarehouseSettings } = await import('../server/profile/warehouse.js');
    const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
    const actor = { id: admin.id, role: admin.appRole, ip: '127.0.0.1' };
    // Önceki dosyaların kuyruktaki mal kabulü işleri bu dosyanın e-posta sayımına karışmasın
    worker();
    await saveWarehouseSettings(db, { recipients: DEPOT }, actor);
    const s = await svc.saveSupplier(db, { name: SUP, email: 'siparis@e2e-kabul-duzeltme.test', currency: 'EUR' }, actor);
    expect(s.ok).toBe(true);
    const c = await svc.createDraftOrder(db, { supplierId: (s as { id: string }).id }, actor, { timeZone: 'Europe/Bucharest' });
    orderId = (c as { id: string }).id;
    const pid = (await db.profileProduct.findUniqueOrThrow({ where: { code: CODE } })).id;
    let o = await db.supplierOrder.findUniqueOrThrow({ where: { id: orderId } });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest' }).format(new Date());
    expect((await svc.saveDraft(db, { orderId, version: o.version, orderDate: today, note: '', lines: [{ productId: pid, qty: 100, unitPrice: '', color: '' }] }, actor, { timeZone: 'Europe/Bucharest' })).ok).toBe(true);
    o = await db.supplierOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect((await svc.approveAndSend(db, { orderId, version: o.version }, actor)).ok).toBe(true);
    orderNo = o.orderNo;
    worker(); // sipariş e-postası tedarikçiye gider (gerçek akış: mal, sipariş gönderildikten sonra gelir)
    expect((await db.supplierOrder.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('GONDERILDI');
    const rev = await db.supplierOrderRevision.findFirstOrThrow({ where: { orderId, finalizedAt: { not: null } }, include: { lines: true } });
    const r = await recv.receiveGoods(db, { orderId, receivedOn: today, reference: 'AVZ-DUZ-1', requestKey: randomUUID().replace(/-/g, ''), quantities: { [rev.lines[0].id]: '100' } }, actor, { timeZone: 'Europe/Bucharest' });
    expect(r.ok && r.complete).toBe(true);
    receiptId = (r as { receiptId: string }).receiptId;
    worker(); // kabulün depo e-postası (alıcı başına bir)
    for (const to of DEPOT) expect(mails(to)).toHaveLength(1);
  } finally {
    await db.$disconnect();
  }
});

test('kısmi düzeltme (100 → 80): gerekçe + onay; stok −20, net 80, kalan 20, sipariş yeniden açılır; orijinal kabul aynen; belge PDF', async ({ browser }) => {
  const db = await prisma();
  const admin = await as(browser, ADMIN, ADMIN_PW);
  try {
    const before = await level(db);
    await admin.goto(`/siparisler/tedarik/${orderId}`);
    await expect(admin.locator('[data-supplier-status="TESLIM_ALINDI"]')).toBeVisible();
    const item = admin.locator('#kabuller [data-receipt="1"]');
    const form = item.locator('[data-correct-receipt="1"]');
    await form.locator('summary').click();
    const reason = form.locator('textarea[name=reason]');
    await expect(reason).toHaveAttribute('required', '');
    const row = form.locator(`tr[data-correct-line="${CODE}"]`);
    await expect(row.locator('input[type="number"]')).toHaveAttribute('max', '100');
    await row.locator('input[type="number"]').fill('20');
    await reason.fill('Avizde 100 yazıyor, gerçekte 80 bar geldi');
    await form.getByRole('button', { name: 'Düzeltmeyi kaydet' }).click();
    await expect(admin).toHaveURL(/ok=correctedReopened/);
    await expect(admin.getByText('Mal kabulü düzeltildi: miktar stoktan düşüldü')).toBeVisible();
    expect(await level(db)).toBe(before - 20);
    // Orijinal kabul satırı 100 olarak kalır; düzeltilen ve net ayrıca
    const line = admin.locator(`#kabuller [data-receipt="1"] [data-receipt-row="${CODE}"]`);
    await expect(line).toHaveAttribute('data-accepted', '100');
    await expect(line).toHaveAttribute('data-corrected', '20');
    await expect(line).toHaveAttribute('data-net', '80');
    const fix = admin.locator('#kabuller [data-correction="1"]');
    await expect(fix).toContainText('Düzeltme #1');
    await expect(fix).toContainText('Kabul #1 için');
    await expect(fix.locator(`[data-correction-line="${CODE}"]`)).toContainText('−20');
    await expect(fix.locator('[data-correction-reason]')).toHaveText('Avizde 100 yazıyor, gerçekte 80 bar geldi');
    await expect(fix).toContainText('Sipariş yeniden açıldı');
    // Sipariş yeniden açık: mal kabulü bölümünde net 80, kalan 20
    await expect(admin.locator('[data-supplier-status="TESLIM_ALINDI"]')).toHaveCount(0);
    await expect(admin.locator('[data-supplier-status="GONDERILDI"]')).toBeVisible();
    const rx = admin.locator(`#mal-kabul tr[data-receipt-line="${CODE}"]`);
    await expect(rx.locator('[data-received]')).toHaveText('80');
    await expect(rx.locator('[data-remaining]')).toHaveText('20');
    // Geçmiş: kullanıcı, ürün, adet, önceki → yeni stok, gerekçe
    await expect(admin.locator('[data-history="SUPPLIER_RECEIPT_CORRECTED"]')).toContainText(`${CODE} −20`);
    await expect(admin.locator('[data-history="SUPPLIER_RECEIPT_CORRECTED"]')).toContainText(`(${before} → ${before - 20})`);
    // Kayıt: orijinal satır değişmedi, ters hareket ayrı
    expect((await db.supplierReceiptLine.findFirstOrThrow({ where: { receiptId } })).qty).toBe(100);
    const moves = await db.stockMovement.findMany({ where: { OR: [{ supplierReceiptId: receiptId }, { supplierCorrection: { receiptId } }] }, orderBy: { createdAt: 'asc' } });
    expect(moves.map((m) => [m.kind, m.qty])).toEqual([['GIRIS', 100], ['KABUL_DUZELTME', -20]]);
    // Düzeltme belgesi (PDF) — yeniden indirilebilir; orijinal belge de açılır
    const href = await fix.locator('[data-correction-pdf]').getAttribute('href');
    for (const h of [href!, `/siparisler/tedarik/${orderId}/kabul/${receiptId}`]) {
      const res = await admin.request.get(h);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toBe('application/pdf');
      expect((await res.body()).subarray(0, 5).toString()).toBe('%PDF-');
    }
  } finally {
    await db.$disconnect();
    await admin.context().close();
  }
});

test('depo e-postası: düzeltme alıcı başına bir kez, açıkça CORECȚIE; orijinal kabulün e-postası yeniden gitmez', async () => {
  worker();
  worker();
  for (const to of DEPOT) {
    const sent = mails(to);
    expect(sent).toHaveLength(2);
    expect(sent.filter((m) => /Intrare marfă/.test(m.subject))).toHaveLength(1);
    const fix = sent.find((m) => /CORECȚIE/.test(m.subject));
    expect(fix.subject).toBe(`GKH Trading Invest – CORECȚIE recepție – ${orderNo} – recepția nr. 1 – corecția nr. 1 – ${SUP}`);
    expect(fix.attachments.map((a: { filename: string }) => a.filename)).toContain(`Corectie-Receptie-${orderNo.replace(/[^A-Za-z0-9_]+/g, '-')}-1-1.pdf`);
    expect(fix.text).toContain('Motiv: Avizde 100 yazıyor, gerçekte 80 bar geldi');
    expect(fix.html).not.toContain('EUR');
  }
});

test('eski ekran: arada başka bir düzeltme kaydedildiyse form reddedilir, hiçbir şey yazılmaz; sonraki teslimat normal kabul edilir', async ({ browser }) => {
  const db = await prisma();
  const admin = await as(browser, ADMIN, ADMIN_PW);
  try {
    await admin.goto(`/siparisler/tedarik/${orderId}`);
    const form = admin.locator('#kabuller [data-correct-receipt="1"]');
    await form.locator('summary').click();
    await form.locator(`tr[data-correct-line="${CODE}"] input[type="number"]`).fill('5');
    await form.locator('textarea[name=reason]').fill('Eski ekrandan');
    // Bu arada başka bir yönetici 1 bar düzeltir
    const recv = await import('../server/suppliers/receipt.js');
    const user = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
    const o = await db.supplierOrder.findUniqueOrThrow({ where: { id: orderId } });
    const rl = await db.supplierReceiptLine.findFirstOrThrow({ where: { receiptId } });
    const other = await recv.correctReceipt(db, { orderId, receiptId, reason: 'Başka ekran', requestKey: randomUUID().replace(/-/g, ''), expectedVersion: String(o.version), quantities: { [rl.id]: '1' } }, { id: user.id, role: user.appRole, ip: '127.0.0.1' });
    expect(other.ok).toBe(true);
    const stock = await level(db);
    await form.getByRole('button', { name: 'Düzeltmeyi kaydet' }).click();
    await expect(admin).toHaveURL(/error=CORRECTION_STALE/);
    await expect(admin.getByText('Sipariş bu ekran açıldıktan sonra değişti')).toBeVisible();
    expect(await level(db)).toBe(stock);
    expect(await db.supplierReceiptCorrection.count({ where: { orderId } })).toBe(2);
    // Sonraki gerçek teslimat: kalan 21 (100 − 79)
    const rx = admin.locator(`#mal-kabul tr[data-receipt-line="${CODE}"]`);
    await expect(rx.locator('[data-remaining]')).toHaveText('21');
    await rx.locator('input[type="number"]').fill('21');
    await admin.locator('#mal-kabul').getByRole('button', { name: 'Mal kabulünü kaydet' }).click();
    await expect(admin).toHaveURL(/ok=receivedAll/);
    await expect(admin.locator('[data-supplier-status="TESLIM_ALINDI"]')).toBeVisible();
    expect(await level(db)).toBe(stock + 21);
  } finally {
    await db.$disconnect();
    await admin.context().close();
  }
});

test('yetki ve Romence: satışçı düzeltme belgesini ve formu göremez; Romence metinler', async ({ browser }) => {
  const db = await prisma();
  const sales = await as(browser, SALES, TEAM_PW);
  const admin = await as(browser, ADMIN, ADMIN_PW);
  try {
    const fix = await db.supplierReceiptCorrection.findFirstOrThrow({ where: { orderId, seq: 1 } });
    const res = await sales.request.get(`/siparisler/tedarik/${orderId}/duzeltme/${fix.id}`);
    expect(res.status()).toBe(404);
    expect((await res.body()).subarray(0, 5).toString()).not.toBe('%PDF-');
    await sales.goto(`/siparisler/tedarik/${orderId}`);
    await expect(sales.locator('[data-correct-receipt]')).toHaveCount(0);
    // Başka siparişin yolu altında düzeltme belgesi açılmaz
    const other = await db.supplierOrder.findFirstOrThrow({ where: { id: { not: orderId } } });
    expect((await admin.request.get(`/siparisler/tedarik/${other.id}/duzeltme/${fix.id}`)).status()).toBe(404);
    await admin.goto(`/dil?l=ro&next=${encodeURIComponent(`/siparisler/tedarik/${orderId}`)}`);
    await expect(admin.locator('#kabuller [data-correction="1"]')).toContainText('Corecția nr. 1');
    await expect(admin.locator('#kabuller [data-correct-receipt="1"] summary')).toHaveText('Corectează recepția');
    await admin.goto(`/dil?l=tr&next=${encodeURIComponent(`/siparisler/tedarik/${orderId}`)}`);
  } finally {
    await db.$disconnect();
    await sales.context().close();
    await admin.context().close();
  }
});
