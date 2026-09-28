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

export function fmtMonth(d: Date | string): string {
  return new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, month: 'long', year: 'numeric' }).format(new Date(d));
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
