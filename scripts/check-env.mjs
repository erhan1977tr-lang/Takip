// Ortam değişkenlerini doğrular (sunucu açılışındaki kontrolün aynısı).
//   npm run env:check               → geçerli ortam
//   node --env-file=.env scripts/check-env.mjs
// Değerleri asla yazdırmaz; yalnızca eksik/hatalı değişken adlarını.
import { validateEnv, formatEnvReport } from '../server/env.js';

const result = validateEnv(process.env);
const report = formatEnvReport(result);
if (report) console.log(report);
if (result.errors.length) process.exit(1);
console.log(`✔ Ortam değişkenleri geçerli${result.warnings.length ? ` (${result.warnings.length} uyarı)` : ''}.`);
