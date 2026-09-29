// Arka plan işçisi (sunucuda "worker" servisi olarak sürekli çalışır; docker compose).
//   - Taranmamış (PENDING) dosyaları antivirüsten geçirir: tarayıcıya yüklemede ulaşılamadıysa ya da eski dosyalar.
//   - Durumunu yönetici → Entegrasyonlar sayfası için kaydeder.
// İleride bildirim kuyruğunun (NotificationOutbox) gönderimi de burada yapılacak (Aşama 8).
//   node scripts/worker.mjs          → her dakika
//   node scripts/worker.mjs --once   → bir tur (testler)
import { PrismaClient } from '@prisma/client';
import { AV_STATUS_KEY, getAvSettings, scanPending } from '../server/files/antivirus.js';

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
