// Banca Transilvania EUR satış kuru (vânzare) — profil siparişinde RON proforma ve fatura için (karar 38/46).
// BT'nin kur sayfası rakamları sonradan, ayrı bir adresten yükleyebilir; bu yüzden adres ayardan değiştirilebilir
// (Yönetici → Entegrasyonlar → FGO → "Kur adresi") ve okuyucu hem JSON hem HTML'den kuru bulmaya çalışır.
// Kur alınamazsa proforma beklemeye alınır; yönetici sipariş sayfasında kuru elle girer.
// Kullanılan kur, günü ve kaynağı siparişe kalıcı yazılır (fatura aynı kurla kesilir).

const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
  'accept-language': 'ro-RO,ro;q=0.9,en;q=0.8',
  'cache-control': 'no-cache',
};

// BT'nin geliştiriciler için yayımladığı resmî kur dosyası (bancatransilvania.ro → Developer Support). Web sayfası
// sunucudan gelen istekleri reddediyor (HTTP 403); bu dosya sunucular için. BT, verinin uygulamada saklanmasını ve
// gereksiz trafik yapılmamasını istiyor: kur yalnızca proforma kesilirken ve "Kuru dene"de istenir.
export const DEFAULT_FX_URL = 'https://dev.bancatransilvania.ro/exchange.xml';
/** Eski varsayılan (web sayfası; sunucudan okunamıyor) → kayıtlı ayarda görülürse yenisi kullanılır */
export const LEGACY_FX_URLS = ['https://www.bancatransilvania.ro/curs-valutar', 'https://www.bancatransilvania.ro/en/curs-valutar'];
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

// Ürün sahibinin kararı (karar 46): "În unități BT" tablosundaki EUR vânzare kuru. Sayfada başka tablolar da olabilir
// ("În cont", "Pentru carduri", çevirici); bu yüzden önce bu başlıktan sonraki tablo satırı aranır.
const UNITS_MARK = /unit(?:ă|a|&#259;|&abreve;)(?:ț|t|ţ|&#539;|&#355;)i\s*BT|BT\s*units/i;
const cellText = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/** Tablo satırları içinde EUR satırı: EUR | BNR | alış | satış → satış en büyüğüdür */
function fromTable(html) {
  const clean = String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const mark = clean.search(UNITS_MARK);
  const rows = [];
  for (const m of clean.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
    const cells = [...m[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => cellText(c[1]));
    if (!cells.some((c) => /^EUR\b/i.test(c))) continue;
    const nums = cells.map(num).filter(plausible);
    if (nums.length >= 2) rows.push({ at: m.index ?? 0, rate: Math.max(...nums) });
  }
  if (rows.length === 0) return null;
  const pick = mark >= 0 ? rows.find((r) => r.at > mark) ?? rows[0] : rows[0];
  return pick.rate;
}

/** Tablo bulunamazsa: düz metinde "EUR"dan sonraki ilk makul sayılar (en fazla üç) → en büyüğü */
function fromHtml(html) {
  const t = fromTable(html);
  if (t) return t;
  const text = String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  const mark = text.search(UNITS_MARK);
  const re = /\bEUR\b/g;
  re.lastIndex = mark >= 0 ? mark : 0;
  let m;
  while ((m = re.exec(text))) {
    const after = text.slice(m.index, m.index + 300);
    const nums = (after.match(/\d{1,2}[.,]\d{2,6}/g) ?? []).map(num).filter(plausible).slice(0, 3);
    if (nums.length >= 2) return Math.max(...nums);
  }
  return null;
}

/**
 * Yanıt gövdesinden EUR satış kuru.
 * @returns {number | null}
 */
/** BT XML: <currency name="EUR"><sell><value>5.325</value></sell>… */
function fromXml(xml) {
  const m = /<currency\s+name="EUR"\s*>([\s\S]*?)<\/currency>/i.exec(xml);
  if (!m) return null;
  const sell = /<sell>\s*<value>\s*([\d.,]+)\s*<\/value>/i.exec(m[1]);
  const n = sell ? Number(sell[1].replace(',', '.')) : NaN;
  return plausible(n) ? n : null;
}

export function parseBtRate(body, contentType = '') {
  const s = typeof body === 'string' ? body : String(body ?? '');
  if (/xml/i.test(contentType) || /<exchangeRates|<currency\s+name=/i.test(s)) {
    const r = fromXml(s);
    if (r) return Math.round(r * 10_000) / 10_000;
  }
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
    // Bankanın sitesi robot isteklerini reddedebiliyor (HTTP 403): normal bir tarayıcı gibi istenir
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: BROWSER_HEADERS });
    if (!res.ok) {
      const via = [...new Set([res.headers.get('server'), res.headers.get('cf-ray') ? 'cloudflare' : null].filter(Boolean))].join(', ');
      return { ok: false, error: `HTTP ${res.status}${via ? ` (${via})` : ''}` };
    }
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

// ---------- günün kuru (elle) ----------
// BT'nin sitesi sunucudan okunamazsa yönetici günün BT EUR satış kurunu Entegrasyonlar ekranına bir kez girer;
// o gün kesilen proformalar bu kurla kesilir (kaynak: MANUAL_DAY). Ertesi gün yeniden girilmesi gerekir.
export const FX_DAILY_KEY = 'fx.daily';

/** @returns {Promise<{ day: string, rate: number } | null>} */
export async function getDailyRate(db) {
  const row = await db.integrationSetting.findUnique({ where: { key: FX_DAILY_KEY } });
  const v = row?.value && typeof row.value === 'object' ? row.value : null;
  return v && typeof v.day === 'string' && plausible(Number(v.rate)) ? { day: v.day, rate: Number(v.rate) } : null;
}

/** Günün kuru: yalnızca bugünün kaydı geçerli */
export async function dailyRateFor(db, day) {
  const r = await getDailyRate(db);
  return r && r.day === day ? r.rate : null;
}

export async function saveDailyRate(db, { day, rate }, actor, writeAudit) {
  await db.$transaction(async (tx) => {
    const value = { day, rate };
    await tx.integrationSetting.upsert({ where: { key: FX_DAILY_KEY }, create: { key: FX_DAILY_KEY, value, updatedById: actor.id }, update: { value, updatedById: actor.id } });
    await writeAudit(tx, { action: 'FX_DAILY_RATE', entityType: 'IntegrationSetting', entityId: FX_DAILY_KEY, userId: actor.id, details: value }, actor);
    // Kur bekleyen proformalar hemen denensin (işçi bir dakika içinde keser)
    await tx.notificationOutbox.updateMany({ where: { type: 'FGO_PROFORMA', status: 'PENDING' }, data: { availableAt: new Date() } });
  });
}
