'use client';

import { useActionState, useEffect, useMemo, useState } from 'react';
import type { Dict } from '@/lib/i18n';
import { interpolate } from '@/server/i18n/interpolate.js';
import { savePricesAction, type SavePricesState } from './actions';

type Row = { id: string; label: string; price: number | null };

const norm = (s: string) => s.toLocaleLowerCase('tr-TR');
const toText = (p: number | null) => (p == null ? '' : String(p));

/** Bir tablonun cam fiyatları: arama, "yalnız fiyatsızlar", yalnızca değişen satırlar kaydedilir. */
export function PricesEditor({ tableId, currency, rows, m }: { tableId: string; currency: string; rows: Row[]; m: Dict['pricing']['edit'] }) {
  const [state, action, pending] = useActionState<SavePricesState, FormData>(savePricesAction, {});
  const [base, setBase] = useState(() => Object.fromEntries(rows.map((r) => [r.id, toText(r.price)])));
  const [values, setValues] = useState(base);
  const [q, setQ] = useState('');
  const [onlyMissing, setOnlyMissing] = useState(false);

  // Kayıt başarılıysa ekrandaki değerler yeni başlangıç olur
  useEffect(() => {
    if (state.savedAt) setBase((b) => ({ ...b, ...values }));
  }, [state.savedAt]);

  const changed = useMemo(() => Object.keys(values).filter((id) => values[id].trim() !== (base[id] ?? '').trim()), [values, base]);
  const missing = rows.filter((r) => !(values[r.id] ?? '').trim()).length;
  const shown = rows.filter((r) => (!q || norm(r.label).includes(norm(q))) && (!onlyMissing || !(values[r.id] ?? '').trim()));
  const payload = JSON.stringify(Object.fromEntries(changed.map((id) => [id, values[id].trim().replace(',', '.')])));

  return (
    <form action={action}>
      <input type="hidden" name="tableId" value={tableId} />
      <input type="hidden" name="changes" value={payload} />
      <div className="row" style={{ justifyContent: 'space-between', margin: '8px 0' }}>
        <span className={missing ? 'badge badge-warn' : 'badge badge-ok'}>{interpolate(m.missing, { n: missing })}</span>
        <div className="row">
          {changed.length > 0 && <span className="muted small">{interpolate(m.unsaved, { n: changed.length })}</span>}
          <button type="submit" className="btn btn-primary" disabled={pending || changed.length === 0}>{pending ? m.saving : m.save}</button>
        </div>
      </div>
      {state.error && <div className="alert alert-error">{state.error}</div>}
      {state.ok && !changed.length && <div className="alert alert-ok">{state.ok}</div>}
      <div className="row" style={{ marginBottom: 8 }}>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={m.search} aria-label={m.search} style={{ flex: 1 }} />
        <label className="row small"><input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} /> {m.onlyMissing}</label>
        <span className="muted small">{interpolate(m.rows, { n: shown.length })}</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>{m.colGlass}</th><th className="num">{interpolate(m.colPrice, { cur: currency })}</th></tr></thead>
          <tbody>
            {shown.map((r) => {
              const dirty = (values[r.id] ?? '').trim() !== (base[r.id] ?? '').trim();
              return (
                <tr key={r.id}>
                  <td>{r.label}</td>
                  <td className="num">
                    <input
                      inputMode="decimal" value={values[r.id] ?? ''} aria-label={`${r.label} — ${interpolate(m.colPrice, { cur: currency })}`}
                      className={dirty ? 'input-changed' : !(values[r.id] ?? '').trim() ? 'input-missing' : undefined}
                      onChange={(e) => setValues((v) => ({ ...v, [r.id]: e.target.value.replace(/[^\d.,]/g, '') }))}
                      style={{ width: 110, textAlign: 'right' }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </form>
  );
}
