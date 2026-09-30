// Temel veri (ADR 0004): her ortamda gerekli, tekrar tekrar çalıştırılabilir.
//   npm run db:seed
// Her adım yalnızca mevcut şemanın desteklediği tabloları doldurur (available). Yeni aşama kendi adımını ekler.
// Demo verisi ayrı: scripts/demo/seed.mjs (bu dosyayı önce çalıştırır).
import { pathToFileURL } from 'node:url';
import { rolesStep } from './steps/roles.mjs';
import { orderTypesStep } from './steps/order-types.mjs';
import { cratesStep } from './steps/crates.mjs';
import { drawingFilesStep } from './steps/drawing-files.mjs';
import { offerPricesStep } from './steps/offer-prices.mjs';
import { profileCatalogStep } from './steps/profile-catalog.mjs';

export const STEPS = [rolesStep, orderTypesStep, cratesStep, drawingFilesStep, offerPricesStep, profileCatalogStep];

/** @param {import('@prisma/client').PrismaClient} db */
export async function runBaseSeed(db, { log = console.log } = {}) {
  const done = [];
  for (const step of STEPS) {
    if (!step.available(db)) {
      log(`  – ${step.name}: tablo yok, atlandı`);
      continue;
    }
    const summary = await step.run(db);
    log(`  ✔ ${step.name}${summary ? ` (${summary})` : ''}`);
    done.push(step.name);
  }
  return done;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  try {
    console.log('Temel veriler yükleniyor…');
    await runBaseSeed(db);
    console.log('Tamam.');
  } catch (err) {
    console.error('Temel veriler yüklenemedi:', err);
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}
