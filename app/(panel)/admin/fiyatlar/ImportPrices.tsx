'use client';

import { useActionState } from 'react';
import type { Dict } from '@/lib/i18n';
import { interpolate } from '@/server/i18n/interpolate.js';
import { confirmPriceImportAction, previewPriceImportAction, type PriceImportPreview } from './actions';

/** Fiyat Excel'i: önce önizleme (değişecek / aynı / katalogda olmayan / hatalı), sonra onay. */
export function ImportPrices({ tableId, m }: { tableId: string; m: Dict['pricing']['import'] }) {
  const [state, action, pending] = useActionState<PriceImportPreview, FormData>(previewPriceImportAction, {});
  const p = state.preview;
  const has = p ? p.set.length > 0 || !!p.fixed : false;
  return (
    <div className="card" id="excel">
      <h2>{m.title}</h2>
      <p className="muted small">{m.intro}</p>
      <form action={action} className="row" style={{ marginTop: 8 }}>
        <input type="hidden" name="tableId" value={tableId} />
        <input type="file" name="file" accept=".xlsx" required aria-label={m.file} style={{ flex: 1 }} />
        <button type="submit" className="btn" disabled={pending}>{pending ? m.reading : m.preview}</button>
      </form>
      {state.error && <div className="alert alert-error" style={{ marginTop: 12 }}>{state.error}</div>}
      {p && (
        <div style={{ marginTop: 12 }}>
          <p><b>{p.fileName}</b></p>
          <ul className="small">
            <li>{interpolate(m.summary.set, { n: p.set.length })}</li>
            <li>{interpolate(m.summary.unchanged, { n: p.unchanged })}</li>
            {p.blank > 0 && <li>{interpolate(m.summary.blank, { n: p.blank })}</li>}
            {p.fixed && <li>{interpolate(m.summary.fixed, { what: p.fixed })}</li>}
            {p.unknown.length > 0 && <li className="danger">{interpolate(m.summary.unknown, { n: p.unknown.length })}</li>}
            {p.errors.length > 0 && <li className="danger">{interpolate(m.summary.errors, { n: p.errors.length })}</li>}
          </ul>
          {p.errors.length > 0 && (
            <details open>
              <summary>{m.errorsTitle}</summary>
              <ul className="small">
                {p.errors.map((e) => <li key={e.row}>{interpolate(m.row, { n: e.row })}{e.label ? ` (${e.label})` : ''}: {e.problems.join(', ')}</li>)}
              </ul>
            </details>
          )}
          {p.unknown.length > 0 && (
            <details open>
              <summary>{m.unknownTitle}</summary>
              <ul className="small">{p.unknown.map((u) => <li key={u.row}>{interpolate(m.row, { n: u.row })}: {u.label}</li>)}</ul>
            </details>
          )}
          {p.set.length > 0 && (
            <details>
              <summary>{m.changesTitle}</summary>
              <ul className="small">{p.set.map((s) => <li key={s.label}>{s.label}: {s.before ?? '—'} → {s.after}</li>)}</ul>
            </details>
          )}
          {has ? (
            <form action={confirmPriceImportAction} className="row" style={{ marginTop: 12 }}>
              <input type="hidden" name="tableId" value={tableId} />
              <input type="hidden" name="payload" value={p.payload} />
              <button type="submit" className="btn btn-primary">{m.confirm}</button>
            </form>
          ) : (
            <div className="alert" style={{ marginTop: 12 }}>{m.nothing}</div>
          )}
        </div>
      )}
    </div>
  );
}
