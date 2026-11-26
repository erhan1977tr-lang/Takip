'use client';

import { useActionState } from 'react';
import { saveBtAutoAction, type BtAutoState } from './actions';

type M = {
  enabled: string; save: string; rotate: string; rotateConfirm: string; saved: string;
  tokenTitle: string; tokenHint: string; tokenNone: string; tokenSet: string;
};

/**
 * Günün BT kurunun otomatik alınması (4.2.30): açık / kapalı + gönderen görevin anahtarı. Yeni anahtar yalnızca bu
 * ekranda, eylemin yanıtında bir kez görünür (adrese yazılmaz); sayfa yenilenince bir daha gösterilmez.
 */
export function BtAutoForm({ enabled, hasToken, tokenSetAt, m }: { enabled: boolean; hasToken: boolean; tokenSetAt: string | null; m: M }) {
  const [state, action, pending] = useActionState<BtAutoState, FormData>(saveBtAutoAction, {});
  return (
    <form action={action} id="kur-otomatik">
      <div className="row">
        <label style={{ margin: 0 }}><input type="checkbox" name="enabled" defaultChecked={enabled} /> {m.enabled}</label>
        <button className="btn btn-primary" disabled={pending}>{m.save}</button>
        <button
          className="btn" name="rotate" value="1" disabled={pending}
          onClick={(e) => { if (hasToken && !window.confirm(m.rotateConfirm)) e.preventDefault(); }}
        >{m.rotate}</button>
        <span className="muted small">{hasToken ? m.tokenSet.replace('{at}', tokenSetAt ?? '—') : m.tokenNone}</span>
      </div>
      {state.ok === 'saved' && <div className="alert alert-ok">{m.saved}</div>}
      {state.ok === 'token' && state.token && (
        <div className="alert alert-ok">
          <b>{m.tokenTitle}</b>
          <div className="mono" style={{ wordBreak: 'break-all', userSelect: 'all', margin: '6px 0' }}>{state.token}</div>
          <div className="small">{m.tokenHint}</div>
        </div>
      )}
    </form>
  );
}
