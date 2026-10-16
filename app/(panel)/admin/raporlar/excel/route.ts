import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT, type MsgKey } from '@/lib/i18n';
import { getEnv } from '@/lib/env';
import { audit } from '@/lib/audit';
import { actorOf } from '@/lib/actor';
import { fmtDateTime } from '@/lib/format';
import { downloadHeaders, exportName, exportSubtitle } from '@/lib/exports';
import { writeReportXlsx } from '@/server/files/xlsx-report.js';
import { runReport } from '@/server/reports/service.js';
import { filtersFromQuery } from '@/server/reports/filters.js';
import { reportSheets } from '@/server/reports/present.js';

export const dynamic = 'force-dynamic';

// Yönetici raporunun Excel'i (3.89.0, karar 284): panelle AYNI servis ve aynı filtreler (adres sorgusu) — hücreler ekrandaki
// değerlerdir. Yalnızca REPORT_VIEW (yönetici ve yönetici yardımcısı); diğer herkese 404. Panel dilinde.
export async function GET(req: Request) {
  const user = await getCurrentUser();
  const { t } = await getT();
  if (!user) return new Response(t('common.fileLoginRequired'), { status: 401 });
  if (!userCan(user, 'REPORT_VIEW')) return new Response(t('common.fileNotFound'), { status: 404 });
  const sp = Object.fromEntries(new URL(req.url).searchParams.entries());
  const now = new Date();
  const r = await runReport(db, filtersFromQuery(sp), { actor: await actorOf(user), now, timeZone: getEnv().APP_TIMEZONE });
  if (!r.ok) return new Response(t(`reports.errors.${r.code === 'INVALID_FILTERS' ? (r.errors?.[0] ?? 'DAY_INVALID') : r.code}` as MsgKey, { names: (r.candidates ?? []).join(', ') }), { status: r.code === 'FORBIDDEN' ? 404 : 400 });
  const tt = (key: string, p?: Record<string, unknown>) => t(key as MsgKey, p as Record<string, string | number>);
  const sheets = reportSheets(r.report, tt, { subtitle: exportSubtitle(t), generatedText: fmtDateTime(now) });
  const buf = writeReportXlsx({ sheets });
  await audit('REPORT_EXPORT', 'Report', r.report.kind, user.id, { kind: r.report.kind, from: r.report.range.from, to: r.report.range.to, customerId: r.report.filters.customer?.id ?? null });
  const name = exportName(t, 'report', [tt(`reports.kinds.${r.report.kind}`), r.report.range.from, r.report.range.to], 'xlsx');
  return new Response(new Uint8Array(buf), { headers: downloadHeaders(name, 'xlsx') });
}
