import { test, expect, type Page, type Request } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, SALES, TEAM_PW, as } from './helpers';

// Panel AI asistanı (3.95.0, karar 290):
//  - yalnızca yönetici sağ altta düğmeyi görür; satış ve müşteri görmez; sunucu işlemi doğrudan çağrılsa da FORBIDDEN döner
//    ve işçiye / modele hiçbir istek gitmez; başka kökenden (CSRF) gelen çağrı işlenmez
//  - işçi kapısı GERÇEK (server/assistant/panel.js) ve gerçek salt okunur araçlarla bu süreçte çalışır; yalnızca OpenAI
//    sahte (fetchImpl) — ağa hiçbir istek çıkmaz
//  - en az veri: soru iletişim bilgisini anmıyorsa model iletisim=true istese bile firmanın e-postası modele GİTMEZ
//  - yanıt güvenilmeyen metindir: HTML / script çalışmaz; sipariş numarası iç bağlantı olur; tablo okunur
//  - sayfa bağlamı: sipariş sayfasında sipariş no'su veritabanından modele bağlam olarak gider
//  - sayfa açılışı / yenileme AI isteği yapmaz; sohbet bu sekmede kalır; tam ekran; telefon genişliğinde tam ekran
//  - asistan hiçbir tabloyu değiştirmez
test.describe.configure({ mode: 'serial' });

type Body = { messages: { role: string; content?: string | null; tool_calls?: unknown[] }[] };
const bodies: Body[] = [];
let server: { close: () => Promise<void> } | null = null;
let firm = { prefix: '', email: '' as string | null, name: '' };
let order = { id: '', orderNo: '' };

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
const MODELS = ['order', 'offer', 'offerLine', 'loadingConfirmationItem', 'stockMovement', 'fgoDocument', 'manualPayment', 'notificationOutbox', 'notification', 'orderNote', 'customer'] as const;
async function counts() {
  const db = await prisma();
  try {
    return Object.fromEntries(await Promise.all(MODELS.map(async (m) => [m, await (db as unknown as Record<string, { count: () => Promise<number> }>)[m].count()])));
  } finally {
    await db.$disconnect();
  }
}

/** Sahte model: ilk turda iki araç çağırır (iletişim bayrağı açık!), sonra tablo + zararlı HTML içeren yanıt yazar */
function fakeOpenAi() {
  return (async (url: unknown, init?: { body?: unknown }) => {
    if (String(url) !== 'https://api.openai.com/v1/chat/completions') throw new Error('beklenmeyen adres');
    const body = JSON.parse(String(init?.body)) as Body;
    bodies.push(body);
    const hasTool = body.messages.some((m) => m.role === 'tool');
    const message = hasTool
      ? {
          role: 'assistant',
          content: [
            `**${order.orderNo}** durumu:`,
            '| Sipariş | Durum |',
            '|---|---|',
            `| ${order.orderNo} | <img src=x onerror="window.__asstXss=1"> |`,
            '<script>window.__asstXss=2</script> [tıkla](javascript:window.__asstXss=3)',
          ].join('\n'),
        }
      : {
          role: 'assistant', content: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'musteri_bilgi', arguments: JSON.stringify({ firma: firm.prefix, iletisim: true }) } },
            { id: 'c2', type: 'function', function: { name: 'genel_ozet', arguments: '{}' } },
          ],
        };
    return new Response(JSON.stringify({ choices: [{ message }], usage: { total_tokens: 10 } }), { status: 200 });
  }) as unknown as typeof fetch;
}

test.beforeAll(async () => {
  const db = await prisma();
  const user = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER }, include: { customer: true } });
  firm = { prefix: user.customer!.prefix ?? '', email: user.customer!.email, name: user.customer!.name };
  const o = await db.order.findFirstOrThrow({ where: { customerId: user.customerId!, removedAt: null }, orderBy: { createdAt: 'asc' } });
  order = { id: o.id, orderNo: o.orderNo };
  const { createPanelServer } = await import('../server/assistant/panel.js');
  // Gerçek kapı + gerçek salt okunur araçlar (test veritabanı); yalnızca model sahte. Uygulama ASSISTANT_PANEL_URL ile buraya gelir.
  const s = createPanelServer({ db, env: { OPENAI_API_KEY: 'sk-e2e_' + 'x'.repeat(30), AUTH_SECRET: process.env.AUTH_SECRET, APP_TIMEZONE: 'Europe/Bucharest' }, fetchImpl: fakeOpenAi(), host: '127.0.0.1' });
  expect(s.enabled).toBe(true);
  await s.listen(3331, '127.0.0.1');
  server = { close: async () => { await s.close(); await db.$disconnect(); } };
});
test.afterAll(async () => { await server?.close(); });

async function ask(page: Page, question: string) {
  await page.locator('[data-assistant-input]').fill(question);
  await page.locator('[data-assistant-send]').click();
  await expect(page.locator('[data-assistant-pending]')).toHaveCount(0, { timeout: 30_000 });
}

let captured: { url: string; headers: Record<string, string>; body: string } | null = null;

test('yönetici: düğme, soru, araçlar salt okunur, en az veri, güvenli yanıt, bağlantı, tablo', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  await page.goto('/siparisler');
  const before = await counts();
  const fab = page.locator('[data-assistant-open]');
  await expect(fab).toBeVisible();
  await expect(fab).toHaveText(/Asistan/);
  // Sayfa açılışı / yenileme model isteği yapmaz
  await page.reload();
  await page.waitForTimeout(500);
  expect(bodies.length).toBe(0);

  await fab.click();
  const panel = page.locator('[data-assistant-panel]');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'TAKİP Asistanı' })).toBeVisible();
  const reqWait = page.waitForRequest((r: Request) => r.method() === 'POST' && !!r.headers()['next-action']);
  await ask(page, `${firm.prefix} firmasının durumu ve genel özet nedir?`);
  const req = await reqWait;
  captured = { url: req.url(), headers: await req.allHeaders(), body: req.postData() ?? '' };

  // Model iki tur çağrıldı; ikinci turda araç sonuçları var
  expect(bodies.length).toBe(2);
  const toolMsgs = bodies[1].messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
  expect(toolMsgs.length).toBe(2);
  // En az veri: soru iletişim bilgisi istemedi → model bayrağı açsa da e-posta / telefon modele gitmez
  expect(toolMsgs[0]).toContain('"kisitli":["iletisim"]');
  if (firm.email) expect(toolMsgs.join('\n')).not.toContain(firm.email);
  expect(toolMsgs[0]).not.toMatch(/"eposta"|"telefon"|"yetkili"/);
  // Panel yönergesi (Boss hitabı yok)
  expect(String(bodies[0].messages[0].content)).toContain('yönetici panelindeki sohbet penceresi');
  expect(String(bodies[0].messages[0].content)).not.toContain('Boss');

  // Yanıt: tablo + sipariş bağlantısı; HTML / script çalışmaz, metin olarak görünür
  const answer = panel.locator('[data-assistant-msg="bot"]').last();
  await expect(answer.locator('table.asst-table')).toBeVisible();
  await expect(answer.locator('a.asst-order').first()).toHaveAttribute('href', `/siparisler?q=${encodeURIComponent(order.orderNo)}`);
  await expect(answer.locator('img, script')).toHaveCount(0);
  await expect(answer.locator('a[href^="javascript"]')).toHaveCount(0);
  await expect(answer).toContainText('<img src=x onerror=');
  expect(await page.evaluate(() => (window as unknown as { __asstXss?: number }).__asstXss)).toBeUndefined();

  // Yenileme: sohbet bu sekmede kalır, yeni model isteği yok
  await page.reload();
  await page.locator('[data-assistant-open]').click();
  await expect(page.locator('[data-assistant-msg="user"]')).toHaveCount(1);
  await page.waitForTimeout(500);
  expect(bodies.length).toBe(2);

  // Tam ekran ve "Yeni sohbet"
  await page.locator('[data-assistant-expand]').click();
  await expect(page.locator('[data-assistant-panel].asst-full')).toBeVisible();
  await page.locator('[data-assistant-reset]').click();
  await expect(page.locator('[data-assistant-msg]')).toHaveCount(0);
  expect(bodies.length, 'sıfırlama modeli çağırmaz').toBe(2);

  expect(await counts()).toEqual(before);
});

test('yönetici: sipariş sayfasında bağlam veritabanından; telefon genişliğinde tam ekran', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  await page.goto(`/siparisler/${order.id}`);
  await page.locator('[data-assistant-open]').click();
  await expect(page.locator('[data-assistant-context]')).toBeVisible();
  const n = bodies.length;
  await ask(page, 'bu sipariş ne durumda?');
  const ctx = bodies[n].messages.find((m) => m.role === 'system' && String(m.content).startsWith('SAYFA BAĞLAMI'));
  expect(String(ctx?.content)).toContain(order.orderNo);

  await page.setViewportSize({ width: 390, height: 800 });
  const box = await page.locator('[data-assistant-panel]').boundingBox();
  expect(box?.x).toBe(0);
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(370);
  await expect(page.locator('[data-assistant-expand]')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-assistant-panel]')).toHaveCount(0);
  await expect(page.locator('[data-assistant-open]')).toBeVisible();
});

test('satış ve müşteri: düğme yok; işlemi doğrudan çağırmak FORBIDDEN; başka köken işlenmez; modele istek gitmez', async ({ browser }) => {
  expect(captured).not.toBeNull();
  const n = bodies.length;
  for (const [email, pw] of [[SALES, TEAM_PW], [CUSTOMER, CUST_PW]]) {
    const page = await as(browser, email, pw);
    await page.goto('/siparisler');
    await expect(page.locator('[data-assistant-open]')).toHaveCount(0);
    const { cookie: _c, ...headers } = captured!.headers;
    const r = await page.request.post(captured!.url, { headers, data: captured!.body });
    const text = await r.text();
    expect(text).toContain('FORBIDDEN');
    expect(text).not.toContain('asst-table');
    await page.context().close();
  }
  // Yönetici oturumu ama başka köken (CSRF): Next işlemi çalıştırmaz
  const admin = await as(browser, ADMIN, ADMIN_PW);
  const { cookie: _c, origin: _o, ...headers } = captured!.headers;
  const evil = await admin.request.post(captured!.url, { headers: { ...headers, origin: 'https://kotu.example' }, data: captured!.body });
  expect(evil.status()).toBeGreaterThanOrEqual(400);
  expect(bodies.length).toBe(n);
});
