// Tarihler Romanya saatine göre gösterilir (sunucu UTC'de çalışsa da).
const TZ = process.env.APP_TIMEZONE || 'Europe/Bucharest';

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '—';
  return new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(d));
}

export function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return '—';
  return new Intl.DateTimeFormat('tr-TR', {
    timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(d));
}

/** "Eylül 2026" / "septembrie 2026" (dile göre) */
export function fmtMonth(d: Date | string, locale: 'ro' | 'tr'): string {
  return new Intl.DateTimeFormat(locale === 'ro' ? 'ro-RO' : 'tr-TR', { timeZone: TZ, month: 'long', year: 'numeric' }).format(new Date(d));
}

/** Kısa gün adları, pazartesiden başlayarak: Pzt…Paz / lun.…dum. */
export function weekdayNames(locale: 'ro' | 'tr'): string[] {
  const f = new Intl.DateTimeFormat(locale === 'ro' ? 'ro-RO' : 'tr-TR', { weekday: 'short', timeZone: 'UTC' });
  return Array.from({ length: 7 }, (_, i) => f.format(new Date(Date.UTC(2024, 0, 1 + i)))); // 1 Ocak 2024 pazartesi
}

/** <input type="date"> için YYYY-MM-DD */
export function isoDay(d: Date | string | null | undefined): string {
  if (!d) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
}

export function fmtNum(n: number | string | { toString(): string } | null | undefined, digits = 2): string {
  const v = Number(n ?? 0);
  return new Intl.NumberFormat('tr-TR', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number.isFinite(v) ? v : 0);
}

export function fmtMoney(n: number | string | { toString(): string } | null | undefined, currency = 'EUR'): string {
  return `${fmtNum(n)} ${currency}`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}
