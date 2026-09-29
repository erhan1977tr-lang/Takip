// RIPE NCC'nin herkese açık dağıtım istatistiklerinden Türkiye, Romanya ve Moldova IP aralıklarını çıkarır
// ve server/geo/ranges.js dosyasını yazar. Giriş sayfasının dili bu veriye göre seçilir.
// Kullanım: node scripts/geo/update-ranges.mjs [--if-older-than=30]
import fs from 'node:fs';
import { parseDelegated } from '../../server/geo/ripe.js';
import current from '../../server/geo/ranges.js';

const SOURCE = 'https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-extended-latest';
const OUT = new URL('../../server/geo/ranges.js', import.meta.url);

const maxAge = Number((process.argv.find((a) => a.startsWith('--if-older-than=')) ?? '').split('=')[1] || 0);
if (maxAge && current.generated && (Date.now() - Date.parse(current.generated)) / 86_400_000 < maxAge) {
  console.log(`IP aralıkları güncel (${current.generated}).`);
  process.exit(0);
}

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`RIPE verisi indirilemedi: HTTP ${res.status}`);
const d = parseDelegated(await res.text());
const byCountry = d.countries.map((c, i) => `${c}: ${d.v4.filter((r) => r[2] === i).length} IPv4 / ${d.v6.filter((r) => r[2] === i).length} IPv6`);
if (d.v4.length < 500 || d.v6.length < 500) throw new Error(`Beklenenden az aralık: ${byCountry.join(', ')}`);

const rows = (arr) => `[\n${arr.map((r) => JSON.stringify(r)).join(',\n')}\n]`;
fs.writeFileSync(OUT, `// Otomatik üretilir: node scripts/geo/update-ranges.mjs (CI, veri 30 günden eskiyse yeniler). Elle düzenlemeyin.
// Kaynak: RIPE NCC dağıtım istatistikleri. ${byCountry.join(' · ')}
export default {
generated: ${JSON.stringify(new Date().toISOString().slice(0, 10))},
source: ${JSON.stringify(SOURCE)},
countries: ${JSON.stringify(d.countries)},
v4: ${rows(d.v4)},
v6: ${rows(d.v6)},
};
`);
console.log(`IP aralıkları yazıldı: ${byCountry.join(' · ')}`);
