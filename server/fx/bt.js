// Banca Transilvania EUR satış kuru (vânzare) — profil siparişinde RON proforma ve fatura için (karar 38/46).
// BT'nin kur sayfası rakamları sonradan, ayrı bir adresten yükleyebilir; bu yüzden adres ayardan değiştirilebilir
// (Yönetici → Entegrasyonlar → FGO → "Kur adresi") ve okuyucu hem JSON hem HTML'den kuru bulmaya çalışır.
// Kur alınamazsa proforma beklemeye alınır; yönetici sipariş sayfasında kuru elle girer.
// Kullanılan kur, günü ve kaynağı siparişe kalıcı yazılır (fatura aynı kurla kesilir).

export const DEFAULT_FX_URL = 'https://www.bancatransilvania.ro/curs-valutar';
// Makul aralık: bunun dışındaki sayı kur sayılmaz (yanlış alanı okumaya karşı)
export const FX_MIN = 3.5;
export const FX_MAX = 8;

const num = (v) => {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim().replace(/\s/g, '');
  if (!/^\d{1,2}[.,]\d{2,6}$/.test(s)) return NaN;
  return Number(s.replace(',', '.'));
};
const plausible = (n) => Number.isFinite(n) && n >= FX_MIN && n <= FX_MAX;
const SELL_KEYS = /^(vanzare|vânzare|sell|selling|sale|vz|vanzareBanca|sellRate)$/i;
const BUY_KEYS = /^(cumparare|cumpărare|buy|buying|cb|buyRate)$/i;

/** JSON içinde EUR satırını bulur: { currency|code|moneda: 'EUR', vanzare|sell: 4.98 } */
function fromJson(data) {
  const stack = [data];
  while (stack.length) {
    const x = stack.pop();
    if (Array.isArray(x)) { stack.push(...x); continue; }
    if (!x || typeof x !== 'object') continue;
    const vals = Object.entries(x);
    const isEur = vals.some(([k, v]) => /^(currency|code|moneda|valuta|symbol|cod|name|iso)$/i.test(k) && String(v).trim().toUpperCase() === 'EUR');
    if (isEur) {
      const sell = vals.find(([k]) => SELL_KEYS.test(k));
      if (sell && plausible(num(sell[1]))) return num(sell[1]);
      // Satış alanı adı bilinmiyorsa: alış dışındaki en büyük makul sayı (banka satış kuru alıştan büyüktür)
      const cands = vals.filter(([k]) => !BUY_KEYS.test(k)).map(([, v]) => num(v)).filter(plausible);
      if (cands.length) return Math.max(...cands);
    }
    for (const [, v] of vals) if (v && typeof v === 'object') stack.push(v);
  }
  return null;
}

/** HTML'de "EUR"dan sonraki ilk makul iki-üç sayı: alış / satış → büyük olan satış */
function fromHtml(html) {
  const text = String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  const re = /\bEUR\b/g;
  let m;
  while ((m = re.exec(text))) {
    const after = text.slice(m.index, m.index + 300);
    const nums = (after.match(/\d{1,2}[.,]\d{2,6}/g) ?? []).map(num).filter(plausible).slice(0, 3);
    if (nums.length >= 2) return Math.max(...nums.slice(0, 2));
  }
  return null;
}

/**
 * Yanıt gövdesinden EUR satış kuru.
 * @returns {number | null}
 */
export function parseBtRate(body, contentType = '') {
  const s = typeof body === 'string' ? body : String(body ?? '');
  if (/json/i.test(contentType) || /^\s*[[{]/.test(s)) {
    try {
      const r = fromJson(JSON.parse(s));
      if (r) return Math.round(r * 10_000) / 10_000;
    } catch {
      // JSON değil; HTML olarak denenir
    }
  }
  const r = fromHtml(s);
  return r ? Math.round(r * 10_000) / 10_000 : null;
}

/**
 * BT'den güncel EUR satış kuru.
 * @returns {Promise<{ ok: true, rate: number, source: string } | { ok: false, error: string }>}
 */
export async function fetchBtEurSell({ url = DEFAULT_FX_URL, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'Mozilla/5.0 (Takip)', accept: 'application/json,text/html' } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.text();
    const rate = parseBtRate(body, res.headers.get('content-type') ?? '');
    return rate ? { ok: true, rate, source: url } : { ok: false, error: 'EUR satış kuru sayfada bulunamadı' };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** Elle girilen kur: "4,9765" → 4.9765; geçersiz → null */
export function parseManualRate(v) {
  const n = num(v);
  return plausible(n) ? Math.round(n * 10_000) / 10_000 : null;
}
