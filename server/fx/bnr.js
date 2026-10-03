// BNR (Banca Națională a României) resmî kuru — müşteri kur politikası BNR / BNR + % için (karar 95).
// Kaynak yalnızca BNR'nin kendi XML dosyasıdır (curs.bnr.ro → "Utilizarea fișierelor XML pentru preluare curs valutar");
// üçüncü taraf kur sağlayıcısı kullanılmaz. Dosya günde bir kez (iş günleri ~13:00) yenilenir; bu yüzden yanıt
// süreç içinde 30 dakika saklanır ve BNR'ye gereksiz istek yapılmaz.
// Kur metin olarak taşınır ("5.0934"): ondalık hesap server/fx/decimal.js'te, kayan noktasız yapılır.

import { dec, fmt } from './decimal.js';

/** Resmî adresler (sırayla denenir); yalnızca bnr.ro alan adı kabul edilir. */
export const BNR_URLS = ['https://curs.bnr.ro/nbrfxrates.xml', 'https://www.bnr.ro/nbrfxrates.xml'];
export const BNR_TTL_MS = 30 * 60_000;
/** Kaynak günü belge gününden en çok bu kadar eski olabilir (uzun tatiller); daha eskisi "kur yok" sayılır */
export const BNR_MAX_AGE_DAYS = 10;

const isBnrHost = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'bnr.ro' || u.hostname.endsWith('.bnr.ro'));
  } catch {
    return false;
  }
};

/**
 * BNR XML'i: <DataSet xmlns="http://www.bnr.ro/xsd"><Header><Publisher>National Bank of Romania</Publisher>…
 * <Body><OrigCurrency>RON</OrigCurrency><Cube date="2026-10-02"><Rate currency="EUR">5.0934</Rate>
 * <Rate currency="HUF" multiplier="100">1.3204</Rate>…
 * Yapı beklenen gibi değilse kur okunmaz (yanlış alanı okumaktansa "kur yok").
 * Birden çok birim için verilen kurlar (multiplier) 1 birime çevrilir: HUF 100 = 1.3204 → 0.013204.
 * @returns {{ ok: true, date: string, rates: Record<string, string> } | { ok: false, error: string }}
 */
export function parseBnr(xml) {
  const s = String(xml ?? '');
  if (!/<DataSet\b[^>]*xmlns="http:\/\/www\.bnr\.ro\/xsd"/.test(s)) return { ok: false, error: 'BNR yapısı beklenen gibi değil (DataSet)' };
  if (!/<Publisher>\s*National Bank of Romania\s*<\/Publisher>/.test(s)) return { ok: false, error: 'BNR yapısı beklenen gibi değil (Publisher)' };
  if (!/<OrigCurrency>\s*RON\s*<\/OrigCurrency>/.test(s)) return { ok: false, error: 'BNR yapısı beklenen gibi değil (OrigCurrency)' };
  // Birden çok gün varsa (10 günlük dosya) en yenisi
  let cube = null;
  for (const m of s.matchAll(/<Cube\s+date="(\d{4}-\d{2}-\d{2})"\s*>([\s\S]*?)<\/Cube>/g)) {
    if (!cube || m[1] > cube.date) cube = { date: m[1], body: m[2] };
  }
  if (!cube || Number.isNaN(Date.parse(`${cube.date}T00:00:00Z`))) return { ok: false, error: 'BNR kur günü okunamadı' };
  /** @type {Record<string, string>} */
  const rates = {};
  for (const m of cube.body.matchAll(/<Rate\s+currency="([A-Z]{3})"(?:\s+multiplier="(\d+)")?\s*>\s*(\d+(?:\.\d+)?)\s*<\/Rate>/g)) {
    const d = dec(m[3]);
    const mult = m[2] ?? '1';
    // multiplier yalnızca 10'un kuvveti olabilir (1, 10, 100…): bölme ondalık kaydırmadır, yuvarlama olmaz
    if (!d || d.n <= 0n || !/^10*$/.test(mult)) continue;
    const scale = d.s + mult.length - 1;
    rates[m[1]] = fmt(d.n, scale, Math.max(scale, 4));
  }
  if (Object.keys(rates).length === 0) return { ok: false, error: 'BNR dosyasında kur yok' };
  return { ok: true, date: cube.date, rates };
}

/** Başarısız denemeden sonra bu süre içinde BNR'ye yeniden gidilmez (sayfa her açılışta beklemesin, BNR yorulmasın) */
export const BNR_FAIL_TTL_MS = 60_000;
/** Süreç içi saklama: { at, data } başarılı yanıt; { failAt, error } son başarısız deneme */
const memory = { at: 0, data: null, failAt: 0, error: '' };
export const clearBnrCache = () => Object.assign(memory, { at: 0, data: null, failAt: 0, error: '' });

/**
 * BNR'nin son yayımladığı kurlar (saklanmış ya da yeniden alınmış).
 * @param {{ urls?: string[], fetchImpl?: typeof fetch, timeoutMs?: number, now?: Date, cache?: { at: number, data: any, failAt?: number, error?: string } }} [o]
 * @returns {Promise<{ ok: true, date: string, rates: Record<string, string>, url: string } | { ok: false, error: string }>}
 */
export async function fetchBnr({ urls, fetchImpl = fetch, timeoutMs = 10_000, now = new Date(), cache = memory } = {}) {
  const t = now.getTime();
  if (cache.data && t >= cache.at && t - cache.at < BNR_TTL_MS) return cache.data;
  if (cache.failAt && t >= cache.failAt && t - cache.failAt < BNR_FAIL_TTL_MS) return { ok: false, error: cache.error || 'BNR alınamadı' };
  const list = (urls ?? BNR_URLS).filter(isBnrHost);
  let error = 'BNR adresi yok';
  for (const url of list) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5' } });
      if (!res.ok) { error = `HTTP ${res.status}`; continue; }
      // Yönlendirme başka bir alan adına gittiyse yanıt BNR'nin sayılmaz
      if (res.url && !isBnrHost(res.url)) { error = 'BNR dışı adrese yönlendirildi'; continue; }
      const parsed = parseBnr(await res.text());
      if (!parsed.ok) { error = parsed.error; continue; }
      const data = { ...parsed, url };
      Object.assign(cache, { at: t, data, failAt: 0, error: '' });
      return data;
    } catch (e) {
      error = String(e?.message ?? e).slice(0, 200);
    }
  }
  Object.assign(cache, { failAt: t, error });
  return { ok: false, error };
}

const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);

/**
 * Belge günü için BNR kuru: BNR'nin o an yayımlamış olduğu son kur. Kaynak günü ileri bir gün olamaz ve belge
 * gününden BNR_MAX_AGE_DAYS'ten eski olamaz.
 * @param {{ currency: string, day: string, fetchImpl?: typeof fetch, now?: Date, urls?: string[], timeoutMs?: number, cache?: { at: number, data: any, failAt?: number, error?: string } }} o  day: YYYY-AA-GG
 * @returns {Promise<{ ok: true, rate: string, date: string, url: string } | { ok: false, error: string }>}
 */
export async function bnrRate({ currency, day, ...rest }) {
  const r = await fetchBnr(rest);
  if (!r.ok) return r;
  const rate = r.rates[currency];
  if (!rate) return { ok: false, error: `BNR dosyasında ${currency} kuru yok` };
  const age = (dayMs(day) - dayMs(r.date)) / 86_400_000;
  if (!(age >= 0)) return { ok: false, error: `BNR kur günü (${r.date}) belge gününden (${day}) sonra` };
  if (age > BNR_MAX_AGE_DAYS) return { ok: false, error: `BNR kuru eski (${r.date})` };
  return { ok: true, rate, date: r.date, url: r.url };
}
