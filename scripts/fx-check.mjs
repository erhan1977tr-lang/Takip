// BT kur sayfası sunucudan okunabiliyor mu? (takip kur [ADRES])
// Durum kodunu, sunucu başlıklarını ve bulunan EUR satış kurunu yazar; gizli bilgi göstermez.
import { DEFAULT_FX_URL, fetchBtEurSell, parseBtRate } from '../server/fx/bt.js';

const urls = process.argv.slice(2).length ? process.argv.slice(2) : [DEFAULT_FX_URL, 'https://www.bancatransilvania.ro/en/curs-valutar'];
for (const url of urls) {
  console.log(`\n== ${url}`);
  const r = await fetchBtEurSell({ url });
  console.log(r.ok ? `✔ EUR satış kuru: ${r.rate}` : `✘ ${r.error}`);
  if (!r.ok) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36' } });
      const body = await res.text();
      console.log(`HTTP ${res.status} · ${['server', 'content-type', 'cf-ray', 'x-cdn', 'x-iinfo'].map((h) => `${h}=${res.headers.get(h) ?? '-'}`).join(' · ')}`);
      console.log(`uzunluk ${body.length} · kur: ${parseBtRate(body, res.headers.get('content-type') ?? '') ?? 'yok'}`);
      const i = body.indexOf('EUR');
      console.log(body.slice(Math.max(0, i - 100), i + 300).replace(/\s+/g, ' ').slice(0, 400));
    } catch (e) {
      console.log(`istek olmadı: ${e?.message ?? e}`);
    }
  }
}
