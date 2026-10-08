import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT, type MsgKey, type T } from '@/lib/i18n';
import { ConfirmButton } from '@/components/ConfirmButton';
import { Badge } from '@/components/StatusBadge';
import { loadOverrides } from '@/server/calendar/service.js';
import {
  CALENDARS, CALENDAR_KEYS, addDaysKey, calendarToday, coverageGaps, dataYears, holidaysBetween, isCalendar, monthDays, weekdayOf,
} from '@/server/calendar/rules.js';
import { HOLIDAY_DATA_VERSION } from '@/server/calendar/holidays.js';
import { SettingsTabs } from '../SettingsTabs';
import { setOverrideAction } from './actions';

export const dynamic = 'force-dynamic';

const ERR = ['CALENDAR', 'DAY', 'MODE', 'FORBIDDEN'];
const dmy = (day: string) => day.split('-').reverse().join('.');
const monthOf = (s: string | undefined) => (s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s) ? s : null);
const shiftMonth = (month: string, n: number) => {
  const d = new Date(`${month}-01T12:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
};
type Holiday = { day: string; names: readonly string[]; half: boolean };
const holidayName = (t: T, country: string, h: Holiday) => h.names.map((k) => t(`calendar.holiday.${country}.${k}` as MsgKey)).join(' / ');

/**
 * Ayarlar → Çalışma Takvimleri (Paket 8, karar 192–193): Romanya deposu ve Türkiye fabrikası takvimleri — ayrı ayrı. Ay
 * görünümünde her günün durumu (açık, hafta sonu, resmî tatil, yarım gün, elle açık / kapalı); bir günü elle işaretleme;
 * yaklaşan resmî tatiller; elle verilen kararlar. Tatil verisi kodla gelir (server/calendar/holidays.js; sayfa dış servise
 * bağlanmaz); verisi olmayan yıl açık uyarıyla gösterilir. Yalnızca SETTINGS_MANAGE.
 */
export default async function CalendarsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePermission('SETTINGS_MANAGE');
  const { t, intl } = await getT();
  const sp = await searchParams;
  const calendar = isCalendar(sp.takvim) ? (sp.takvim as keyof typeof CALENDARS) : 'RO_DEPOT';
  const cfg = CALENDARS[calendar];
  const today = calendarToday(calendar);
  const month = monthOf(sp.ay) ?? today.slice(0, 7);
  const overrides = await loadOverrides(db, calendar, addDaysKey(`${month}-01`, -400), addDaysKey(today, 800));
  const days = monthDays(calendar, month, overrides);
  const offset = (weekdayOf(`${month}-01`) + 6) % 7; // pazartesi ilk sütun
  const gaps = coverageGaps(calendar, today);
  const years = dataYears(calendar);
  const upcoming = holidaysBetween(calendar, today, addDaysKey(today, 365));
  const manual = [...overrides.entries()].filter(([d]) => d >= addDaysKey(today, -30)).sort(([a], [b]) => a.localeCompare(b));
  const monthLabel = new Intl.DateTimeFormat(intl, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T12:00:00.000Z`));
  const okText = sp.ok === 'saved' ? t('calendar.ok.saved') : sp.ok === 'unchanged' ? t('calendar.ok.unchanged') : null;
  const errText = sp.error ? t(`calendar.errors.${ERR.includes(sp.error) ? sp.error : 'DAY'}` as MsgKey) : null;
  const href = (cal: string, m: string) => `/admin/entegrasyonlar/takvimler?takvim=${cal}&ay=${m}`;
  const stateText = (st: (typeof days)[number]) => {
    const parts: string[] = [];
    if (st.holiday) parts.push(`${holidayName(t, cfg.country, st.holiday)}${st.half ? ` (${t('calendar.half')})` : ''}`);
    parts.push(t(`calendar.reason.${st.reason}` as MsgKey));
    if (st.note) parts.push(st.note);
    return parts.join(' · ');
  };
  const cls = (st: (typeof days)[number]) => [
    'cal-cell',
    st.reason === 'MANUAL_OPEN' ? 'manual-open' : st.reason === 'MANUAL_CLOSED' ? 'manual-closed'
      : st.reason === 'HOLIDAY' ? 'holiday' : st.reason === 'WEEKEND' ? 'closed' : st.half ? 'half' : '',
    st.day === today ? 'today' : '',
  ].filter(Boolean).join(' ');

  return (
    <>
      <div className="page-head">
        <h1>{t('supplier.settingsTabs.title')}</h1>
        <p className="muted">{t('calendar.intro')}</p>
      </div>
      <SettingsTabs user={user} active="calendars" />
      {okText && <div className="alert alert-ok">{okText}</div>}
      {errText && <div className="alert alert-error" role="alert">{errText}</div>}

      <div className="card" id="takvim" data-calendar={calendar}>
        <div className="cal-nav">
          <div className="row" role="group" aria-label={t('calendar.title')}>
            {CALENDAR_KEYS.map((c) => (
              <Link key={c} href={href(c, month)} className={`btn${c === calendar ? ' btn-primary' : ''}`} aria-current={c === calendar ? 'page' : undefined} data-calendar-tab={c}>
                {t(`calendar.calendars.${c}` as MsgKey)}
              </Link>
            ))}
          </div>
          <div className="row">
            <Link className="btn btn-link" href={href(calendar, shiftMonth(month, -1))}>{t('calendar.month.prev')}</Link>
            <b data-month={month}>{monthLabel}</b>
            <Link className="btn btn-link" href={href(calendar, shiftMonth(month, 1))}>{t('calendar.month.next')}</Link>
            {month !== today.slice(0, 7) && <Link className="btn btn-link" href={href(calendar, today.slice(0, 7))}>{t('calendar.month.current')}</Link>}
          </div>
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>{t(`calendar.usedFor.${calendar}` as MsgKey)} {t('calendar.zone', { tz: cfg.timeZone })}</p>
        <p className="small" data-holiday-data>{t('calendar.data', { years: years.join(', ') || '—', version: HOLIDAY_DATA_VERSION })}</p>
        {gaps.length > 0 && <div className="alert alert-warn" data-holiday-gap>{t('calendar.missing', { years: gaps.join(', ') })}</div>}

        <div className="cal-month" role="grid" aria-label={monthLabel}>
          {[1, 2, 3, 4, 5, 6, 0].map((w) => <div key={`h${w}`} className="cal-head" role="columnheader">{t(`calendar.weekdays.${w}` as MsgKey)}</div>)}
          {Array.from({ length: offset }, (_, i) => <div key={`b${i}`} className="cal-blank" aria-hidden />)}
          {days.map((st) => (
            <div key={st.day} className={cls(st)} role="gridcell" data-day={st.day} data-open={st.open ? '1' : '0'} data-reason={st.reason}
              title={t('calendar.dayTitle', { date: dmy(st.day), state: stateText(st) })}>
              <span className="cal-num">{Number(st.day.slice(8))}</span>
              {st.holiday && <span className="cal-tag">{holidayName(t, cfg.country, st.holiday)}</span>}
              {st.manual && <span className="cal-tag">{t(`calendar.reason.${st.reason}` as MsgKey)}</span>}
            </div>
          ))}
        </div>
        <div className="cal-legend">
          <span className="lg-open">{t('calendar.legend.open')}</span>
          <span className="lg-weekend">{t('calendar.legend.weekend')}</span>
          <span className="lg-holiday">{t('calendar.legend.holiday')}</span>
          {cfg.country === 'TR' && <span className="lg-half">{t('calendar.legend.half')}</span>}
          <span className="lg-manual-open">{t('calendar.legend.manualOpen')}</span>
          <span className="lg-manual-closed">{t('calendar.legend.manualClosed')}</span>
        </div>
      </div>

      <form action={setOverrideAction} className="card" id="isaretle">
        <h2>{t('calendar.form.title')} — {t(`calendar.calendars.${calendar}` as MsgKey)}</h2>
        <input type="hidden" name="calendar" value={calendar} />
        <input type="hidden" name="month" value={month} />
        <div className="cal-form">
          <div>
            <label htmlFor="ov-day">{t('calendar.form.day')}</label>
            <input id="ov-day" name="day" type="date" required defaultValue={today} />
          </div>
          <div>
            <label htmlFor="ov-mode">{t('calendar.form.mode')}</label>
            <select id="ov-mode" name="mode" defaultValue="CLOSED">
              <option value="CLOSED">{t('calendar.form.CLOSED')}</option>
              <option value="OPEN">{t('calendar.form.OPEN')}</option>
              <option value="AUTO">{t('calendar.form.AUTO')}</option>
            </select>
          </div>
          <div className="cal-note">
            <label htmlFor="ov-note">{t('calendar.form.note')}</label>
            <input id="ov-note" name="note" maxLength={200} />
          </div>
          <button className="btn btn-primary">{t('calendar.form.save')}</button>
        </div>
      </form>

      <div className="card" id="elle">
        <h2>{t('calendar.overrides.title')}</h2>
        {manual.length === 0 ? <p className="muted">{t('calendar.overrides.none')}</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t('calendar.overrides.colDay')}</th><th>{t('calendar.overrides.colState')}</th><th>{t('calendar.overrides.colNote')}</th><th /></tr></thead>
              <tbody>
                {manual.map(([day, ov]) => (
                  <tr key={day} data-override={day}>
                    <td className="mono">{dmy(day)}</td>
                    <td>{ov.open ? <Badge tone="ok">{t('calendar.reason.MANUAL_OPEN')}</Badge> : <Badge tone="muted">{t('calendar.reason.MANUAL_CLOSED')}</Badge>}</td>
                    <td className="muted">{ov.note ?? ''}</td>
                    <td className="actions">
                      <form action={setOverrideAction}>
                        <input type="hidden" name="calendar" value={calendar} />
                        <input type="hidden" name="month" value={month} />
                        <input type="hidden" name="day" value={day} />
                        <input type="hidden" name="mode" value="AUTO" />
                        <ConfirmButton message={t('calendar.overrides.removeConfirm')}>{t('calendar.overrides.remove')}</ConfirmButton>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" id="tatiller">
        <h2>{t('calendar.upcoming')}</h2>
        {upcoming.length === 0 ? <p className="muted">{t('calendar.upcomingNone')}</p> : (
          <ul className="plain-list" data-upcoming>
            {upcoming.map((h) => (
              <li key={h.day} data-holiday={h.day}>
                <span className="mono">{dmy(h.day)}</span> — {holidayName(t, cfg.country, h)}{h.half ? ` (${t('calendar.half')})` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
