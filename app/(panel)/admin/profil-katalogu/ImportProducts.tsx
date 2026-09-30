'use client';

import { useActionState } from 'react';
import type { Dict } from '@/lib/i18n';
import { interpolate } from '@/server/i18n/interpolate.js';
import { confirmProductImportAction, previewProductImportAction, type ProductImportPreview } from './actions';

/** Profil kataloğu Excel'i: önce önizleme, sonra onay. */
export function ImportProducts({ m }: { m: Dict['profile']['catalog']['import'] }) {
  const [state, action, pending] = useActionState<ProductImportPreview, FormData>(previewProductImportAction, {});
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
            <li>{interpolate(m.created, { n: p.created.length })}</li>
            <li>{interpolate(m.updated, { n: p.updated.length })}</li>
            <li>{interpolate(m.unchanged, { n: p.unchanged })}</li>
            {p.badCategory.length > 0 && <li className="danger">{interpolate(m.badCategory, { n: p.badCategory.length })}: {p.badCategory.join(', ')}</li>}
            {p.errors.length > 0 && <li className="danger">{interpolate(m.errors, { n: p.errors.length })}</li>}
          </ul>
          {p.errors.length > 0 && (
            <ul className="small">
              {p.errors.map((e) => <li key={e.row}>{interpolate(m.row, { n: e.row })}{e.label ? ` (${e.label})` : ''}: {e.problems.join(', ')}</li>)}
            </ul>
          )}
          {p.updated.length > 0 && (
            <details>
              <summary>{interpolate(m.updated, { n: p.updated.length })}</summary>
              <ul className="small">{p.updated.map((u) => <li key={u.label}>{u.label}: {u.fields.join(', ')}</li>)}</ul>
            </details>
          )}
          {p.created.length > 0 && (
            <details>
              <summary>{interpolate(m.created, { n: p.created.length })}</summary>
              <ul className="small">{p.created.map((c) => <li key={c}>{c}</li>)}</ul>
            </details>
          )}
          {p.created.length + p.updated.length > 0 ? (
            <form action={confirmProductImportAction} className="row" style={{ marginTop: 12 }}>
              <input type="hidden" name="payload" value={p.payload} />
              <button type="submit" className="btn btn-primary">{m.confirm}</button>
            </form>
          ) : <div className="alert" style={{ marginTop: 12 }}>{m.nothing}</div>}
        </div>
      )}
    </div>
  );
}
