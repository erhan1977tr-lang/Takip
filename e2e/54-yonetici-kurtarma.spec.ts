import { test, expect } from '@playwright/test';
import { login } from './helpers';

// P6 — yönetici acil erişim kurtarma (karar 246), gerçek sunucu. Kurtarma bir SUNUCU KOMUTUDUR (HTTP yolu yok); burada
// komutun akışı (runRecoveryCli) test sürecinde, sahte terminalle ve yalnızca bu teste ait bir test yönetici hesabıyla
// çalıştırılır — gerçek / ortak yönetici hesabına dokunulmaz. Doğrulanan: açık oturum hemen geçersiz; eski şifreyle giriş
// olmaz; yeni şifreyle giriş olur; denetim kaydı yazılır; uygulamada kurtarma adresi yoktur.
test.describe.configure({ mode: 'serial' });

const EMAIL = 'kurtarma-yonetici@e2e.test';
const OLD = 'Kurtarma-eski-2026';
const NEW = 'kurtarma yeni uzun parola 2026';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}

test('açık oturum kapanır, eski şifre geçmez, yeni şifreyle girilir; denetim kaydı; kurtarma için HTTP adresi yok', async ({ browser }) => {
  const db = await prisma();
  try {
    const { hashPassword } = await import('../server/auth/password-hash.js');
    const factory = await db.customer.findFirstOrThrow({ where: { type: 'FACTORY' } });
    await db.user.create({ data: { email: EMAIL, name: 'Kurtarma Yönetici', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id, passwordHash: await hashPassword(OLD) } });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page, EMAIL, OLD);
    await expect(page).toHaveURL(/\/siparisler/);

    // Sunucu komutunun akışı (sahte terminal): e-posta onayı + gizli şifre iki kez
    const { runRecoveryCli } = await import('../server/auth/admin-recovery-cli.js');
    const answers = [EMAIL, NEW, NEW];
    const out: string[] = [];
    const code = await runRecoveryCli({
      argv: [EMAIL], db, operator: 'e2e',
      io: { isTTY: true, ask: async () => answers.shift() ?? '', askHidden: async () => answers.shift() ?? '', print: (s: string) => out.push(s) },
    });
    expect(code, out.join('\n')).toBe(0);
    expect(out.join('\n')).not.toContain(NEW);

    // Açık oturum hemen geçersiz: sayfa girişe döner
    await page.goto('/siparisler');
    await expect(page).toHaveURL(/\/login/);
    await ctx.close();

    // Eski şifreyle giriş olmaz, yeniyle olur
    const p2 = await (await browser.newContext()).newPage();
    await p2.goto('/login');
    await p2.fill('#email', EMAIL);
    await p2.fill('#password', OLD);
    await p2.click('button[type=submit]');
    await expect(p2).toHaveURL(/\/login/);
    await login(p2, EMAIL, NEW);
    await expect(p2).toHaveURL(/\/siparisler/);
    await p2.context().close();

    const u = await db.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(u.appRole).toBe('ADMIN');
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'ADMIN_RECOVERY', entityId: u.id } });
    expect((audit.details as { via: string }).via).toBe('SSH_CLI');
    expect(JSON.stringify(audit)).not.toContain(NEW);
  } finally {
    await db.$disconnect();
  }
});

test('uygulamada kurtarma adresi yok: tahmin edilen yollar bulunamaz', async ({ request }) => {
  for (const url of ['/admin/kurtar', '/admin/recover', '/api/admin/recover', '/kurtar', '/yonetici-kurtar']) {
    const r = await request.get(url, { maxRedirects: 0 });
    expect([404, 307, 308], url).toContain(r.status());
    expect(await r.text(), url).not.toMatch(/ADMIN_RECOVERY|yonetici-kurtar/);
  }
});
