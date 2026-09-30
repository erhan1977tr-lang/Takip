// Arka plan işçisi (sunucuda "worker" servisi olarak sürekli çalışır; docker compose).
//   - Taranmamış (PENDING) dosyaları antivirüsten geçirir: tarayıcıya yüklemede ulaşılamadıysa ya da eski dosyalar.
//   - Durumunu yönetici → Entegrasyonlar sayfası için kaydeder.
//   - Profil siparişi (Aşama 6): kuyruktaki depo e-postalarını (Comanda Depozit PDF'i + depo bağlantısı) gönderir; olmazsa yeniden dener.
// Diğer bildirimlerin gönderimi Aşama 8'de.
//   node scripts/worker.mjs          → her dakika
//   node scripts/worker.mjs --once   → bir tur (testler)
import { PrismaClient } from '@prisma/client';
import { AV_STATUS_KEY, getAvSettings, scanPending } from '../server/files/antivirus.js';
import { dispatchWarehouseEmails } from '../server/profile/warehouse.js';
import { readMailConfig } from '../server/mail/config.js';
import { createTransport } from '../server/mail/transport.js';
import { outboxTransport } from '../server/mail/outbox-transport.js';
import { getEnv } from '../server/env.js';

const once = process.argv.includes('--once');
const INTERVAL_MS = 60_000;
const db = new PrismaClient();
let stopping = false;
let wake = () => {};
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    stopping = true;
    wake();
  });
}
const log = (...a) => console.log(new Date().toISOString(), ...a);

// SMTP ayarlı değilse depo e-postaları kuyrukta bekler (yönetici sipariş sayfasında görür).
// MAIL_OUTBOX_DIR (yalnızca geliştirme/test/demo): e-postalar gönderilmez, klasöre yazılır.
let mail = null;
if (process.env.MAIL_OUTBOX_DIR) {
  mail = {
    transport: outboxTransport(process.env.MAIL_OUTBOX_DIR),
    from: process.env.MAIL_FROM || 'Takip <noreply@localhost>',
    appUrl: (process.env.APP_URL || '').replace(/\/+$/, ''),
  };
} else {
  try {
    const cfg = readMailConfig(process.env);
    mail = { transport: createTransport(cfg), from: cfg.from, appUrl: cfg.appUrl };
  } catch (e) {
    log('e-posta ayarlı değil; depo e-postaları kuyrukta bekleyecek:', e?.message ?? e);
  }
}

async function profileTick() {
  const now = new Date();
  if (!mail) return;
  const r = await dispatchWarehouseEmails(db, { ...mail, now, timeZone: getEnv().APP_TIMEZONE, log });
  if (r.sent || r.failed) log('depo e-postası:', JSON.stringify(r));
}

async function tick() {
  const settings = await getAvSettings(db);
  const r = await scanPending(db, settings, { log });
  const value = { lastRun: new Date().toISOString(), enabled: settings.enabled, ...r };
  await db.integrationSetting.upsert({ where: { key: AV_STATUS_KEY }, create: { key: AV_STATUS_KEY, value }, update: { value } });
  if (r.scanned || r.missing || (r.stopped && r.stopped !== 'disabled')) log('tarama:', JSON.stringify(r));
}

log('işçi başladı');
while (!stopping) {
  try {
    await tick();
  } catch (e) {
    log('hata:', e?.message ?? e);
  }
  try {
    await profileTick();
  } catch (e) {
    log('profil hatası:', e?.message ?? e);
  }
  if (once) break;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, INTERVAL_MS);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}
await db.$disconnect();
log('işçi durdu');
