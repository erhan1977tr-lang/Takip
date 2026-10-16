// Yönetici raporlarının filtreleri (3.89.0, karar 284) — TEK kural: panel, Excel ve Telegram asistanı aynı ayrıştırıcıyı
// ve aynı dönem hesabını kullanır (bağımlılıksız, saf). Bütün günler uygulamanın saat dilimindedir (Europe/Bucharest):
// "bu ay", "geçen ay", "bu yıl" … sunucunun saatine göre değil, Romanya'nın yerel gününe göre hesaplanır.

/** Rapor türleri (iç kodlar; Telegram aracı kendi Türkçe adlarını bunlara çevirir) */
export const REPORT_KINDS = Object.freeze(['orders', 'glass', 'profile', 'loading', 'finance']);
/** Hazır dönemler */
export const PERIODS = Object.freeze(['this_month', 'last_month', 'this_week', 'last_week', 'this_year', 'last_year', 'last_3_months', 'last_30_days']);
export const ORDER_TYPES = Object.freeze(['ALL', 'GLASS', 'PROFILE']);
/** Aktif raporlarda seçilebilen sipariş durumları (İPTAL raporlara hiç girmez — karar 284) */
export const REPORT_STATUSES = Object.freeze(['YENI', 'HAZIRLANIYOR', 'URETIMDE', 'YUKLENDI', 'ARSIVLENDI']);
/** Yükleme durumu: tümü, fiilen (onaylı) tamamen yüklenen, kısmen yüklenen, hiç yüklenmeyen */
export const LOADING_STATES = Object.freeze(['ALL', 'LOADED', 'PARTIAL', 'NOT_LOADED']);
/** En uzun aralık (yıllık karşılaştırma için iki yıl) */
export const MAX_RANGE_DAYS = 731;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

/** "YYYY-MM-DD" geçerli bir takvim günü mü */
export function isDay(s) {
  if (typeof s !== 'string' || !DAY.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Verilen andaki yerel gün */
export function localDayOf(now, timeZone) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t) => p.find((x) => x.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Günü n gün kaydırır */
export const shiftDay = (key, n) => new Date(Date.parse(`${key}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Ayın son günü */
const monthEnd = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // m: 1..12
const pad = (n) => String(n).padStart(2, '0');
/** İki gün arasındaki gün sayısı (dahil) */
export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1;

/**
 * Hazır dönemin gün aralığı (yerel günle). Hafta pazartesi başlar. "Son 3 ay" = içinde bulunulan ay ve önceki iki ay
 * (bugüne kadar). Bilinmeyen dönem → null.
 * @param {string} period @param {{ now: Date, timeZone: string }} o
 * @returns {{ from: string, to: string } | null}
 */
export function periodRange(period, { now, timeZone }) {
  const today = localDayOf(now, timeZone);
  const [y, m] = today.split('-').map(Number);
  const dow = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7; // pazartesi = 0
  switch (period) {
    case 'this_month': return { from: `${y}-${pad(m)}-01`, to: today };
    case 'last_month': {
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      return { from: `${py}-${pad(pm)}-01`, to: monthEnd(py, pm) };
    }
    case 'this_week': return { from: shiftDay(today, -dow), to: shiftDay(today, 6 - dow) };
    case 'last_week': return { from: shiftDay(today, -dow - 7), to: shiftDay(today, -dow - 1) };
    case 'this_year': return { from: `${y}-01-01`, to: today };
    case 'last_year': return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    case 'last_3_months': {
      const sm = m - 2 <= 0 ? m + 10 : m - 2;
      const sy = m - 2 <= 0 ? y - 1 : y;
      return { from: `${sy}-${pad(sm)}-01`, to: today };
    }
    case 'last_30_days': return { from: shiftDay(today, -29), to: today };
    default: return null;
  }
}

/** "YYYY-MM" → ayın aralığı; geçersiz → null */
export function monthRange(s) {
  if (typeof s !== 'string' || !MONTH.test(s)) return null;
  const [y, m] = s.split('-').map(Number);
  if (m < 1 || m > 12 || y < 2000 || y > 2100) return null;
  return { from: `${y}-${pad(m)}-01`, to: monthEnd(y, m) };
}

/** Yıl → aralık; geçersiz → null */
export function yearRange(v) {
  const y = typeof v === 'number' ? v : /^\d{4}$/.test(String(v ?? '')) ? Number(v) : NaN;
  if (!Number.isInteger(y) || y < 2000 || y > 2100) return null;
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

const clean = (v, max) => {
  if (typeof v !== 'string') return '';
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s.length > max ? '' : s;
};

/**
 * Filtreleri ayrıştırır. Öncelik: başlangıç / bitiş günü → ay → yıl → hazır dönem → bu ay (varsayılan).
 * Hata kodları (errors): RANGE_INVALID (bitiş < başlangıç ya da tek uç), RANGE_TOO_LONG, DAY_INVALID, MONTH_INVALID,
 * YEAR_INVALID, PERIOD_INVALID. Hatalı alan yok sayılmaz: rapor hesaplanmaz, kullanıcıya söylenir.
 * @param {Record<string, unknown>} input
 *   { kind, period, from, to, month, year, customerId, customer (metin — Telegram), orderType, status, product, loading }
 * @param {{ now: Date, timeZone: string }} ctx
 */
export function parseReportFilters(input, { now, timeZone }) {
  const i = input ?? {};
  const errors = [];
  const kind = REPORT_KINDS.includes(/** @type {string} */ (i.kind)) ? /** @type {string} */ (i.kind) : 'orders';
  let range = null;
  let period = 'custom';
  const from = clean(i.from, 10);
  const to = clean(i.to, 10);
  const month = clean(i.month, 7);
  const year = i.year == null || i.year === '' ? '' : String(i.year);
  const per = clean(i.period, 20);
  if (from || to) {
    if ((from && !isDay(from)) || (to && !isDay(to))) errors.push('DAY_INVALID');
    else if (!from || !to || to < from) errors.push('RANGE_INVALID');
    else range = { from, to };
  } else if (month) {
    range = monthRange(month);
    if (!range) errors.push('MONTH_INVALID');
    else period = 'month';
  } else if (year) {
    range = yearRange(year);
    if (!range) errors.push('YEAR_INVALID');
    else period = 'year';
  } else if (per) {
    range = periodRange(per, { now, timeZone });
    if (!range) errors.push('PERIOD_INVALID');
    else period = per;
  } else {
    range = periodRange('this_month', { now, timeZone });
    period = 'this_month';
  }
  if (range && daysBetween(range.from, range.to) > MAX_RANGE_DAYS) {
    errors.push('RANGE_TOO_LONG');
    range = null;
  }
  const orderType = ORDER_TYPES.includes(/** @type {string} */ (i.orderType)) ? /** @type {string} */ (i.orderType) : 'ALL';
  const status = REPORT_STATUSES.includes(/** @type {string} */ (i.status)) ? /** @type {string} */ (i.status) : '';
  const loading = LOADING_STATES.includes(/** @type {string} */ (i.loading)) ? /** @type {string} */ (i.loading) : 'ALL';
  const customerId = /^[a-z0-9]{8,40}$/i.test(String(i.customerId ?? '')) ? String(i.customerId) : '';
  return {
    kind, period, from: range?.from ?? null, to: range?.to ?? null, month: period === 'month' ? month : '', year: period === 'year' ? year : '',
    customerId, customer: customerId ? '' : clean(i.customer, 60), orderType, status, product: clean(i.product, 60), loading, errors,
  };
}

/** Filtrelerin URL sorgusu (panel → Excel bağlantısı aynı filtrelerle) */
export function filterQuery(f) {
  const q = new URLSearchParams();
  q.set('tur', f.kind);
  if (f.period === 'custom') { if (f.from) q.set('bas', f.from); if (f.to) q.set('bit', f.to); }
  else if (f.period === 'month') q.set('ay', f.month);
  else if (f.period === 'year') q.set('yil', f.year);
  else q.set('donem', f.period);
  if (f.customerId) q.set('firma', f.customerId);
  if (f.orderType !== 'ALL') q.set('tip', f.orderType);
  if (f.status) q.set('durum', f.status);
  if (f.product) q.set('urun', f.product);
  if (f.loading !== 'ALL') q.set('yukleme', f.loading);
  return q.toString();
}

/** Panelin URL sorgusu → ayrıştırıcının girdisi */
export function filtersFromQuery(sp) {
  const g = (k) => (typeof sp?.[k] === 'string' ? sp[k] : undefined);
  return {
    kind: g('tur'), period: g('donem'), from: g('bas'), to: g('bit'), month: g('ay'), year: g('yil'), customerId: g('firma'),
    orderType: g('tip'), status: g('durum'), product: g('urun'), loading: g('yukleme'),
  };
}

/** Yerel günün başlangıç anı (UTC) — tarih / saat alanlarını (createdAt, approvedAt …) yerel güne göre süzmek için */
export function dayStartUtc(key, timeZone) {
  // Gün ortası UTC aynı yerel güne düşer; o andan yerel saat kadar geri gidilir. Yaz saati geçiş gününde gece yarısının
  // farkı (öğleden farklı) bir düzeltme turuyla giderilir: bulunan anın yerel saati 00:00:00 olana kadar kaydırılır.
  const clock = (d) => {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d);
    const get = (t) => p.find((x) => x.type === t)?.value ?? '0';
    return { day: `${get('year')}-${get('month')}-${get('day')}`, secs: (Number(get('hour')) * 60 + Number(get('minute'))) * 60 + Number(get('second')) };
  };
  let at = new Date(`${key}T12:00:00Z`);
  for (let i = 0; i < 3; i++) {
    const c = clock(at);
    if (c.day === key && c.secs === 0) break;
    at = new Date(at.getTime() - (c.day === key ? c.secs : c.secs - 86_400) * 1000);
  }
  return at;
}

/** Aralığın yerel günlerini kapsayan [gte, lt) anları */
export const instantRange = ({ from, to }, timeZone) => ({ gte: dayStartUtc(from, timeZone), lt: dayStartUtc(shiftDay(to, 1), timeZone) });
/** Gün alanları (@db.Date ya da gün ortası saklanan) için [gte, lt) — UTC gün */
export const dateRange = ({ from, to }) => ({ gte: new Date(`${from}T00:00:00Z`), lt: new Date(`${shiftDay(to, 1)}T00:00:00Z`) });
/** Ay anahtarı */
export const monthOf = (day) => (day ? day.slice(0, 7) : null);
