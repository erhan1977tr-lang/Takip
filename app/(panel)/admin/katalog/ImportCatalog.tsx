'use client';

import { useActionState } from 'react';
import type { Dict } from '@/lib/i18n';
import { interpolate } from '@/server/i18n/interpolate.js';
import { confirmImportAction, previewImportAction, type ImportPreview } from './actions';

/** Excel'den yükleme: önce önizleme (eklenecek / değişecek / hatalı satırlar), sonra onay. */
export function ImportCatalog({ m }: { m: Dict['admin']['catalog']['import'] }) {
  const [state, action, pending] = useActionState<ImportPreview, FormData>(previewImportAction, {});
  const p = state.preview;
  return (
    <div className="card" id="excel">
      <h2>{m.title}</h2>
      <p className="muted small">{m.intro}</p>
      <form action={action} className="row" style={{ marginTop: 8 }}>
        <input type="file" name="file" accept=".xlsx" required aria-label={m.file} style={{ flex: 1 }} />
        <button type="submit" className="btn" disabled={pending}>{pending ? m.reading : m.preview}</button>
      </form>
      {state.error && <div className="alert alert-error" style={{ marginTop: 12 }}>{state.error}</div>}
      {p && (
        <div style={{ marginTop: 12 }}>
          <p><b>{p.fileName}</b></p>
          <ul className="small">
            <li>{interpolate(m.summary.created, { n: p.created.length })}</li>
            <li>{interpolate(m.summary.updated, { n: p.updated.length })}</li>
            <li>{interpolate(m.summary.unchanged, { n: p.unchanged })}</li>
            {p.untouched > 0 && <li>{interpolate(m.summary.untouched, { n: p.untouched })}</li>}
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
          {p.created.length > 0 && (
            <details>
              <summary>{interpolate(m.summary.created, { n: p.created.length })}</summary>
              <ul className="small">{p.created.map((c) => <li key={c}>{c}</li>)}</ul>
            </details>
          )}
          {p.updated.length > 0 && (
            <details>
              <summary>{interpolate(m.summary.updated, { n: p.updated.length })}</summary>
              <ul className="small">{p.updated.map((u) => <li key={u.label}>{u.label}: {u.fields.join(', ')}</li>)}</ul>
            </details>
          )}
          {p.created.length + p.updated.length > 0 ? (
            <form action={confirmImportAction} className="row" style={{ marginTop: 12 }}>
              <input type="hidden" name="payload" value={p.payload} />
              <button type="submit" className="btn btn-primary">{m.confirm}</button>
              {p.errors.length > 0 && <span className="muted small">{m.skipNote}</span>}
            </form>
          ) : (
            <div className="alert" style={{ marginTop: 12 }}>{m.nothing}</div>
          )}
        </div>
      )}
    </div>
  );
}
