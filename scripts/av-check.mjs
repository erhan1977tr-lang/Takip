// Antivirüs kontrolü: ayarlar, tarayıcıya erişim, sürüm ve zararsız EICAR test dosyasının yakalanması.
//   node scripts/av-check.mjs     (sunucuda: takip antivirus)
// Çıkış kodu: 0 → tarayıcı çalışıyor ve test virüsünü yakalıyor; 1 → sorun var.
import { PrismaClient } from '@prisma/client';
import { avHealth, getAvSettings } from '../server/files/antivirus.js';
import { eicar, scanBuffer } from '../server/files/clamav.js';

const db = new PrismaClient();
try {
  const s = await getAvSettings(db);
  console.log(`Antivirüs: ${s.enabled ? 'açık' : 'KAPALI'} · ${s.host}:${s.port} · ulaşılamazsa: ${s.onUnavailable === 'accept' ? 'kabul et, sonra tara' : 'reddet'}`);
  const h = await avHealth(s);
  if (!h.reachable) {
    console.log(`✘ Tarayıcıya ulaşılamıyor (${s.host}:${s.port}). ClamAV ilk açılışta birkaç dakika virüs tanımlarını yükler.`);
    process.exitCode = 1;
  } else {
    console.log(`✔ ${h.raw ?? h.engine}`);
    const r = await scanBuffer(eicar(), { host: s.host, port: s.port, timeoutMs: 30_000 });
    if (r.status === 'infected') console.log(`✔ Test virüsü (EICAR) yakalandı: ${r.signature}`);
    else {
      console.log(`✘ Test virüsü yakalanmadı: ${r.status === 'error' ? r.error : 'temiz dendi'}`);
      process.exitCode = 1;
    }
  }
  const pending = (await db.orderFile.count({ where: { scanStatus: 'PENDING' } })) + (await db.drawing.count({ where: { scanStatus: 'PENDING' } }));
  const infected = (await db.orderFile.count({ where: { scanStatus: 'INFECTED' } })) + (await db.drawing.count({ where: { scanStatus: 'INFECTED' } }));
  console.log(`Taranmayı bekleyen: ${pending} · karantinada: ${infected}`);
} finally {
  await db.$disconnect();
}
