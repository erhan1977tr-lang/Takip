import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT, type MsgKey } from '@/lib/i18n';
import { fmtDateTime } from '@/lib/format';
import { roleText } from '@/lib/labels';
import { LOGIN_LOG_PAGE, LOGIN_LOG_RETENTION_DAYS, loginWhere, parseLoginFilter } from '@/server/auth/login-log.js';
import { SettingsTabs } from '../SettingsTabs';

export const dynamic = 'force-dynamic';

const ROLES = ['ADMIN', 'YONETICI_YARDIMCISI', 'SATIS', 'CIZIM', 'MUSTERI', 'DENETIMCI'] as const;
const KINDS = ['LOGIN', 'CODE', 'SETUP'] as const;

/**
 * Ayarlar → Giriş Logları (Paket A, karar 223): yalnızca gerçek yönetici (AUDIT_VIEW — Yönetici Yardımcısında yok; sayfa
 * sunucuda denetler). Kullanıcı, rol, tarih / saat, IP, sonuç. Süzgeçler adres satırındadır (GET form) ve sunucuda
 * doğrulanır (server/auth/login-log.js → parseLoginFilter); sayfalama sabit boyutludur. Kayıtlarda şifre / kod / belirteç /
 * denenen e-posta YOKTUR; kimliği kesin olmayan başarısız deneme "Bilinmeyen hesap" olarak gösterilir.
 */
export default async function LoginLogsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePermission('AUDIT_VIEW');
  const { t } = await getT();
  const sp = await searchParams;
  const f = parseLoginFilter(sp);
  const where = loginWhere(f);
  const [rows, people] = await Promise.all([
    db.loginEvent.findMany({
      where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (f.page - 1) * LOGIN_LOG_PAGE, take: LOGIN_LOG_PAGE + 1,
      select: { id: true, kind: true, success: true, locked: true, role: true, ip: true, createdAt: true, user: { select: { id: true, name: true, email: true, deletedAt: true } } },
    }),
    db.user.findMany({ where: { deletedAt: null }, orderBy: [{ name: 'asc' }, { email: 'asc' }], select: { id: true, name: true, email: true } }),
  ]);
  const more = rows.length > LOGIN_LOG_PAGE;
  const list = rows.slice(0, LOGIN_LOG_PAGE);
  const pageHref = (page: number) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== 'sayfa') q.set(k, v);
    if (page > 1) q.set('sayfa', String(page));
    const s = q.toString();
    return `/admin/entegrasyonlar/giris-loglari${s ? `?${s}` : ''}`;
  };

  return (
    <>
      <div className="page-head">
        <h1>{t('supplier.settingsTabs.title')}</h1>
        <p className="muted">{t('loginLog.intro', { days: LOGIN_LOG_RETENTION_DAYS })}</p>
      </div>
      <SettingsTabs user={user} active="logins" />
      <form method="get" className="card" id="giris-suzgec">
        <h2>{t('loginLog.title')}</h2>
        <div className="grid">
          <div>
            <label htmlFor="gl-user">{t('loginLog.filter.user')}</label>
            <select id="gl-user" name="kullanici" defaultValue={f.unknown ? 'bilinmeyen' : f.userId ?? ''}>
              <option value="">{t('loginLog.filter.all')}</option>
              <option value="bilinmeyen">{t('loginLog.unknown')}</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name ? `${p.name} · ${p.email}` : p.email}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="gl-role">{t('loginLog.filter.role')}</label>
            <select id="gl-role" name="rol" defaultValue={f.role ?? ''}>
              <option value="">{t('loginLog.filter.all')}</option>
              {ROLES.map((r) => <option key={r} value={r}>{roleText(t, r)}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="gl-result">{t('loginLog.filter.result')}</label>
            <select id="gl-result" name="sonuc" defaultValue={f.result === true ? 'basarili' : f.result === false ? 'basarisiz' : ''}>
              <option value="">{t('loginLog.filter.all')}</option>
              <option value="basarili">{t('loginLog.success')}</option>
              <option value="basarisiz">{t('loginLog.failure')}</option>
            </select>
          </div>
          <div>
            <label htmlFor="gl-kind">{t('loginLog.filter.kind')}</label>
            <select id="gl-kind" name="tur" defaultValue={f.kind ?? ''}>
              <option value="">{t('loginLog.filter.all')}</option>
              {KINDS.map((k) => <option key={k} value={k}>{t(`loginLog.kind.${k}` as MsgKey)}</option>)}
            </select>
          </div>
          <div><label htmlFor="gl-from">{t('loginLog.filter.from')}</label><input id="gl-from" name="bas" type="date" defaultValue={f.from ?? ''} /></div>
          <div><label htmlFor="gl-to">{t('loginLog.filter.to')}</label><input id="gl-to" name="bit" type="date" defaultValue={f.to ?? ''} /></div>
          <div><label htmlFor="gl-ip">{t('loginLog.filter.ip')}</label><input id="gl-ip" name="ip" maxLength={64} defaultValue={f.ip ?? ''} /></div>
        </div>
        <div className="row end" style={{ marginTop: 12 }}>
          <Link href="/admin/entegrasyonlar/giris-loglari" className="btn">{t('loginLog.filter.clear')}</Link>
          <button type="submit" className="btn btn-primary">{t('loginLog.filter.apply')}</button>
        </div>
      </form>

      <div className="card card-flush" id="giris-loglari">
        <div className="card-head"><h2 style={{ margin: 0 }}>{t('loginLog.listTitle', { page: f.page })}</h2></div>
        {list.length === 0 ? <div className="empty">{t('loginLog.empty')}</div> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>{t('loginLog.col.time')}</th><th>{t('loginLog.col.user')}</th><th>{t('loginLog.col.role')}</th><th>{t('loginLog.col.kind')}</th><th>{t('loginLog.col.result')}</th><th>{t('loginLog.col.ip')}</th></tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.id} data-login-event={r.success ? 'ok' : 'fail'}>
                    <td className="nowrap">{fmtDateTime(r.createdAt)}</td>
                    <td>
                      {r.user ? (
                        <>
                          <b>{r.user.deletedAt ? t('admin.users.deletedName') : r.user.name || r.user.email}</b>
                          {!r.user.deletedAt && r.user.name && <div className="muted small">{r.user.email}</div>}
                        </>
                      ) : <span className="muted" data-login-unknown>{t('loginLog.unknown')}</span>}
                    </td>
                    <td>{r.role ? roleText(t, r.role) : '—'}</td>
                    <td>{t(`loginLog.kind.${r.kind}` as MsgKey)}</td>
                    <td>
                      {r.success ? <span className="badge badge-ok">{t('loginLog.success')}</span> : <span className="badge badge-danger">{t('loginLog.failure')}</span>}
                      {r.locked && <> <span className="badge badge-warn">{t('loginLog.locked')}</span></>}
                    </td>
                    <td className="mono small">{r.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(f.page > 1 || more) && (
          <div className="row" style={{ justifyContent: 'space-between', padding: 12 }} data-login-pager>
            {f.page > 1 ? <Link href={pageHref(f.page - 1)} className="btn">{t('loginLog.prev')}</Link> : <span />}
            {more ? <Link href={pageHref(f.page + 1)} className="btn">{t('loginLog.next')}</Link> : <span />}
          </div>
        )}
      </div>
    </>
  );
}
