// Günün BT kurunun OTOMATİK alınması (4.2.30, ürün sahibinin talimatı 26.11.2026).
//
// Kaynak: BT web sayfası https://www.bancatransilvania.ro/curs-valutar — varsayılan sekme "În unitățile BT"dir ve tablo
// sayfada HTML olarak durur (div tablo `.bt-exhange-rate-table`): başlık "… efectuate în unitățile BT.", "Actualizare:
// GG-AA-YYYY", satır EUR | Curs BNR | Cumpărare | Vânzare. Belgeye giren değer EUR satırının VÂNZARE hücresidir. Ekran resmi +
// yazı tanıma yerine sayfanın kendi metni okunur: rakam birebir gelir.
//
// Kim okur: BT (Akamai) sunucumuzun IPv4 ve IPv6 adresini engelliyor (26.11.2026: "Acces blocat", HTTP 403). Bu yüzden sayfayı
// ürün sahibinin bilgisayarındaki zamanlanmış görev (deploy/bt-kur/) 07:00, 12:30, 15:00'te alır ve olduğu gibi
// POST /kur/bt'ye gönderir (gizli anahtarla). Bütün doğrulama burada, sunucuda yapılır; görev hiçbir şeye karar vermez.
// Sunucu BT'ye hiçbir istek göndermez.
//
// Ne yapar, ne yapmaz:
//   - Kur, yöneticinin elle girdiği "Günün BT kuru" ile AYNI kayda (IntegrationSetting 'fx.daily') yazılır, kaynağı AUTO.
//     Çözücü (server/fx/resolve.js), belge hesabı, kesilmiş belgelerin kur kaydı DEĞİŞMEZ; BNR müşterilerine dokunulmaz.
//   - Yöneticinin o gün elle girdiği kur önceliklidir: otomatik kur onu ezmez.
//   - Her doğrulama tutmalıdır; biri tutmazsa HİÇBİR ŞEY yazılmaz. Başka kaynağa sessizce geçilmez.
//   - Gözetim (işçi): bir okuma saatinin bir saatlik penceresi bitti, o saat için kur gelmedi ve bugün hiç kur yoksa
//     yöneticilere uygulama içi bildirim (gün + saat başına bir kez). Yedek kural (son doğru kur ≤ 3 gün): server/fx/bt.js.
import crypto from 'node:crypto';
import { FX_AUTO_ON_KEY, FX_MAX, FX_MIN, getDailyRate, saveDailyRate } from './bt.js';
import { notifyStaff } from '../notifications/inapp.js';

export const BT_PAGE_URL = 'https://www.bancatransilvania.ro/curs-valutar';
/** Okuma saatleri (Europe/Bucharest) */
export const BT_AUTO_SLOTS = /** @type {const} */ (['07:00', '12:30', '15:00']);
/** Bir saatin penceresi: görev bu sürede yeniden dener; bitince gözetim bakar */
export const BT_AUTO_WINDOW_MS = 60 * 60_000;
/** Vânzare, BNR kurundan bu orandan fazla sapamaz (yanlış hücreyi okumaya karşı; BT farkı ~%2) */
export const BT_MAX_BNR_GAP = 0.06;
/** Sayfadaki "Actualizare" tarihi en çok bu kadar gün eski olabilir (hafta sonu / tatil) */
export const BT_MAX_PAGE_AGE_DAYS = 4;
export const BT_AUTO_STATE_KEY = 'fx.btAuto';
/** Kaynak işareti ('fx.daily' kaydında) */
export const BT_AUTO_SOURCE = 'AUTO';
/** Gönderilen sayfanın üst sınırı (bugün ~256 KB; vekil sunucunun genel sınırı 2 MB) */
export const BT_PAGE_MAX_BYTES = 1_900_000;

/** Sonucun sabit kodları (ekranda tr / ro metne çevrilir; gönderilen metin saklanmaz) */
export const BT_AUTO_ERRORS = /** @type {const} */ ([
  'NOT_UNITS_TAB', 'NO_TABLE', 'NO_DATE', 'OLD_DATE', 'NO_EUR_ROW', 'BAD_NUMBERS', 'SELL_NOT_ABOVE_BUY', 'FAR_FROM_BNR',
  'OUT_OF_RANGE', 'TOO_LARGE', 'EMPTY',
]);

// ---------- ayrıştırma (saf) ----------

const decode = (s) => String(s)
  .replace(/&nbsp;/g, ' ').replace(/&#259;|&abreve;/g, 'ă').replace(/&#539;|&#355;/g, 'ț').replace(/&#537;|&#351;/g, 'ș')
  .replace(/&amp;/g, '&');
const textOf = (h) => decode(String(h).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
/** "în unitățile BT" (ț / ţ / t, ă / a, büyük-küçük harf) */
const UNITS_TEXT = /unit[ăa][țţt]ile\s+BT/i;
const NUM = /^\d{1,2}[.,]\d{2,6}$/;
const toNum = (s) => (NUM.test(s) ? Number(s.replace(',', '.')) : NaN);

/** Takvim günü farkı (b − a), YYYY-AA-GG */
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * BT kur sayfasından "În unitățile BT" EUR satırı. Hata fırlatmaz.
 * @param {string} html
 * @param {{ today: string }} o  bugün (YYYY-AA-GG, Bükreş)
 * @returns {{ ok: true, sell: number, buy: number, bnr: number, pageDay: string } | { ok: false, code: typeof BT_AUTO_ERRORS[number] }}
 */
export function parseBtUnitsPage(html, { today }) {
  const s = String(html ?? '');
  if (!s.trim()) return { ok: false, code: 'EMPTY' };
  if (s.length > BT_PAGE_MAX_BYTES) return { ok: false, code: 'TOO_LARGE' };
  // 1) Seçili sekme "În unitățile BT" olmalı (sayfanın varsayılanı; değişirse başka bir tablo okunmaz)
  const opt = /<option\b[^>]*\bvalue="in-unitatile-bt"[^>]*>/i.exec(s);
  if (!opt || !/\sselected\b/i.test(opt[0])) return { ok: false, code: 'NOT_UNITS_TAB' };
  // 2) Tablo: `.bt-exhange-rate-table` (sitedeki yazım: "exhange"), başlığı "în unitățile BT"
  const start = s.search(/class="bt-exhange-rate-table"/);
  if (start < 0) return { ok: false, code: 'NO_TABLE' };
  // Tablo "Vezi toate monedele" düğmesinden (ya da bölüm sonundan) önce biter; çeviricideki EUR buraya girmez
  const ends = [s.indexOf('bt-exhange-rate-table-actions', start), s.indexOf('</section>', start)].filter((i) => i > start);
  const table = s.slice(start, ends.length ? Math.min(...ends) : start + 60_000);
  const header = /class="bt-exhange-rate-table-header"[^>]*>([\s\S]{0,600}?)<\/div>/.exec(table);
  if (!header || !UNITS_TEXT.test(textOf(header[1]))) return { ok: false, code: 'NOT_UNITS_TAB' };
  // 3) Güncelleme tarihi: bugün ya da en çok BT_MAX_PAGE_AGE_DAYS gün önce (gelecek tarih kabul edilmez)
  const dm = /Actualizare:\s*(\d{2})[-.](\d{2})[-.](\d{4})/.exec(textOf(table));
  if (!dm) return { ok: false, code: 'NO_DATE' };
  const pageDay = `${dm[3]}-${dm[2]}-${dm[1]}`;
  const age = dayDiff(pageDay, today);
  if (!Number.isFinite(age) || age < 0 || age > BT_MAX_PAGE_AGE_DAYS) return { ok: false, code: 'OLD_DATE' };
  // 4) Sütun sırası başlık satırından doğrulanır: Valuta | Curs BNR | Cumpărare | Vânzare
  const heading = /bt-exhange-rate-table-body-row-heading">([\s\S]*?)<\/div><\/div>/.exec(table);
  const cols = heading ? [...`${heading[1]}<`.matchAll(/-row-cell">([^<]*)</g)].map((c) => textOf(c[1]).toLowerCase()) : [];
  if (cols.length !== 4 || !/bnr/.test(cols[1]) || !/cump/.test(cols[2]) || !/v[âa]nz/.test(cols[3])) return { ok: false, code: 'NO_TABLE' };
  // 5) EUR satırı: para birimi hücresi tam "EUR"; aynı satırdaki (sonraki satır başlangıcına kadar) sayı hücreleri
  const i = table.search(/table-body-row-cell-currency-text">\s*EUR\s*</);
  if (i < 0) return { ok: false, code: 'NO_EUR_ROW' };
  const next = table.indexOf('class="bt-exhange-rate-table-body-row"', i);
  const rest = table.slice(i, next > i ? next : undefined);
  const cells = [...rest.matchAll(/<div class="bt-exhange-rate-table-body-row-cell">([^<]*)<\/div>/g)].map((c) => textOf(c[1]).replace(/\s/g, ''));
  if (cells.length !== 3) return { ok: false, code: 'BAD_NUMBERS' };
  const [bnr, buy, sell] = cells.map(toNum);
  if (![bnr, buy, sell].every(Number.isFinite)) return { ok: false, code: 'BAD_NUMBERS' };
  if (![bnr, buy, sell].every((n) => n >= FX_MIN && n <= FX_MAX)) return { ok: false, code: 'OUT_OF_RANGE' };
  if (!(sell > buy)) return { ok: false, code: 'SELL_NOT_ABOVE_BUY' };
  if (Math.abs(sell / bnr - 1) > BT_MAX_BNR_GAP) return { ok: false, code: 'FAR_FROM_BNR' };
  const r4 = (n) => Math.round(n * 10_000) / 10_000;
  return { ok: true, sell: r4(sell), buy: r4(buy), bnr: r4(bnr), pageDay };
}

// ---------- saat (saf) ----------

/** Yerel gün ve günün dakikası */
export function localClock(now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
const slotMinutes = (slot) => Number(slot.slice(0, 2)) * 60 + Number(slot.slice(3));
const WINDOW_MIN = BT_AUTO_WINDOW_MS / 60_000;

/**
 * Gelen bir sayfanın ait olduğu okuma saati: başlamış olan en son saat (07:00'dan önce → null).
 * Bilgisayar geç açılırsa (ör. 08:40) sayfa yine 07:00'a sayılır.
 * @returns {string | null}
 */
export function slotFor(now, timeZone) {
  const { minutes } = localClock(now, timeZone);
  return [...BT_AUTO_SLOTS].reverse().find((s) => minutes >= slotMinutes(s)) ?? null;
}

/**
 * Penceresi biten en son okuma saati (gözetim için; yoksa null).
 * @returns {{ key: string, slot: string, day: string } | null}
 */
export function endedSlot(now, timeZone) {
  const { day, minutes } = localClock(now, timeZone);
  const slot = [...BT_AUTO_SLOTS].reverse().find((s) => minutes >= slotMinutes(s) + WINDOW_MIN);
  return slot ? { key: `${day}@${slot}`, slot, day } : null;
}

// ---------- anahtar ----------

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

/** Yeni gizli anahtar (yalnızca bir kez gösterilir; veritabanında yalnızca özeti durur) */
export const newBtToken = () => `btk_${crypto.randomBytes(32).toString('base64url')}`;

/**
 * Otomatik kur ayarı: açık mı, anahtar var mı. Anahtarın kendisi hiçbir zaman saklanmaz / döndürülmez.
 * @returns {Promise<{ enabled: boolean, hasToken: boolean, tokenSetAt: string | null, tokenHash: string | null }>}
 */
export async function getBtAutoSettings(db) {
  const row = await db.integrationSetting.findUnique({ where: { key: FX_AUTO_ON_KEY } });
  const v = row?.value && typeof row.value === 'object' ? row.value : {};
  const tokenHash = typeof v.tokenHash === 'string' && /^[0-9a-f]{64}$/.test(v.tokenHash) ? v.tokenHash : null;
  return { enabled: v.enabled === true, hasToken: tokenHash != null, tokenSetAt: typeof v.tokenSetAt === 'string' ? v.tokenSetAt : null, tokenHash };
}

/**
 * Açık / kapalı ve (istenirse) yeni anahtar. Yeni anahtar yalnızca dönüş değerinde bir kez verilir.
 * @param {any} db @param {{ enabled: boolean, rotate?: boolean }} o @param {{ id: string }} actor
 * @returns {Promise<{ token: string | null }>}
 */
export async function saveBtAutoSettings(db, { enabled, rotate = false }, actor, writeAudit, now = new Date()) {
  const cur = await getBtAutoSettings(db);
  const token = rotate ? newBtToken() : null;
  const value = {
    enabled: enabled === true,
    tokenHash: token ? sha256(token) : cur.tokenHash,
    tokenSetAt: token ? now.toISOString() : cur.tokenSetAt,
  };
  await db.$transaction(async (tx) => {
    await tx.integrationSetting.upsert({ where: { key: FX_AUTO_ON_KEY }, create: { key: FX_AUTO_ON_KEY, value, updatedById: actor.id }, update: { value, updatedById: actor.id } });
    // Denetim kaydında anahtar ya da özeti yer almaz
    await writeAudit(tx, { action: 'FX_AUTO_SETTING', entityType: 'IntegrationSetting', entityId: FX_AUTO_ON_KEY, userId: actor.id, details: { enabled: value.enabled, tokenRotated: Boolean(token) } }, actor);
  });
  return { token };
}

/** Gelen anahtar kayıtlı olanla aynı mı (sabit süreli karşılaştırma) */
export function tokenMatches(given, tokenHash) {
  if (typeof given !== 'string' || !given.startsWith('btk_') || given.length > 200 || !tokenHash) return false;
  const a = Buffer.from(sha256(given), 'hex');
  const b = Buffer.from(tokenHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- durum ----------

async function readState(db) {
  const row = await db.integrationSetting.findUnique({ where: { key: BT_AUTO_STATE_KEY } });
  const v = row?.value && typeof row.value === 'object' ? row.value : {};
  return { slots: v.slots && typeof v.slots === 'object' ? v.slots : {}, last: v.last ?? null, lastError: v.lastError ?? null };
}
async function writeState(db, state, day) {
  // Yalnızca bugünün ve dünün saatleri tutulur (kayıt büyümez)
  const slots = Object.fromEntries(Object.entries(state.slots).filter(([k]) => dayDiff(k.slice(0, 10), day) <= 1));
  const value = { ...state, slots };
  await db.integrationSetting.upsert({ where: { key: BT_AUTO_STATE_KEY }, create: { key: BT_AUTO_STATE_KEY, value }, update: { value } });
}

/** Ekran için son durum */
export const getBtAutoState = (db) => readState(db);

// ---------- gelen sayfa ----------

/**
 * Bilgisayardaki görevin gönderdiği BT sayfasını işler (anahtar ve "açık" çağıranda doğrulanmıştır).
 * @param {any} db
 * @param {{ html: string, now?: Date, timeZone: string, writeAudit: Function }} o
 * @returns {Promise<{ ok: true, rate: number, applied: boolean, reason?: 'MANUAL' | 'SAME' } | { ok: false, code: string }>}
 */
export async function applyBtPage(db, { html, now = new Date(), timeZone, writeAudit }) {
  const { day } = localClock(now, timeZone);
  const slot = slotFor(now, timeZone);
  const key = slot ? `${day}@${slot}` : null;
  const state = await readState(db);
  const r = parseBtUnitsPage(html, { today: day });
  if (!r.ok) {
    state.lastError = { code: r.code, day, slot, at: now.toISOString() };
    if (key) state.slots[key] = { ...(state.slots[key] ?? {}), lastAt: now.toISOString(), code: r.code };
    await writeState(db, state, day);
    return { ok: false, code: r.code };
  }
  const current = await getDailyRate(db);
  let applied = false;
  let reason;
  if (current && current.day === day && current.source !== BT_AUTO_SOURCE) {
    reason = 'MANUAL'; // yöneticinin bugün elle girdiği kur önceliklidir
  } else if (current && current.day === day && current.rate === r.sell) {
    reason = 'SAME';
  } else {
    await saveDailyRate(db, { day, rate: r.sell, source: BT_AUTO_SOURCE, at: now.toISOString(), slot: slot ?? 'erken', pageDay: r.pageDay }, null, writeAudit);
    applied = true;
  }
  state.last = { rate: r.sell, buy: r.buy, bnr: r.bnr, pageDay: r.pageDay, day, slot, at: now.toISOString(), applied, reason: reason ?? null };
  state.lastError = null;
  if (key) state.slots[key] = { ...(state.slots[key] ?? {}), lastAt: now.toISOString(), ok: true, rate: r.sell, code: null };
  await writeState(db, state, day);
  return { ok: true, rate: r.sell, applied, ...(reason ? { reason } : {}) };
}

// ---------- gözetim (işçi) ----------

/**
 * İşçi her turda çağırır; yalnızca veritabanı (dış istek yok). Otomatik kur açıkken penceresi biten en son okuma saati için
 * kur gelmediyse ve bugün hiç kur yoksa yöneticilere bir kez bildirim gider.
 * @param {any} db @param {{ now?: Date, timeZone: string, log?: (...a: unknown[]) => void }} o
 * @returns {Promise<{ alerted: boolean, slot?: string }>}
 */
export async function btAutoWatchTick(db, { now = new Date(), timeZone, log = () => {} }) {
  const settings = await getBtAutoSettings(db);
  if (!settings.enabled) return { alerted: false };
  const ended = endedSlot(now, timeZone);
  if (!ended) return { alerted: false };
  const state = await readState(db);
  const s = state.slots[ended.key] ?? {};
  if (s.ok || s.alerted) return { alerted: false };
  const current = await getDailyRate(db);
  if (current && current.day === ended.day) return { alerted: false };
  state.slots[ended.key] = { ...s, alerted: true };
  await writeState(db, state, ended.day);
  await notifyStaff(db, {
    audience: 'admin', key: `fx-auto:${ended.key}`, type: 'FX_AUTO_FAILED', params: { day: ended.day, ref: ended.slot },
    link: '/admin/entegrasyonlar#kur',
  }).catch(() => 0);
  log(`BT kuru ${ended.slot} okumasında gelmedi; yöneticilere bildirildi`);
  return { alerted: true, slot: ended.slot };
}
