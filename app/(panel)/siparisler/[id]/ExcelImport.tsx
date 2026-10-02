'use client';

import { useMemo, useRef, useState } from 'react';
import type { Dict } from '@/lib/i18n';
import { interpolate } from '@/server/i18n/interpolate.js';
import { looksLikeHeader, validateImportRows } from '@/server/orders/excel-import.js';
import { readOfferExcelAction } from './actions';

/**
 * "Excel'den Aktar" (satış teklif tablosu): müşterinin yüklediği .xlsx önce ön izlemede açılır; satış Genişlik /
 * Yükseklik / Adet sütunlarını seçer, geçersiz satırlar işaretlenir, geçerli/geçersiz sayısı görünür. "Teklif
 * Tablosuna Aktar" yalnızca geçerli satırları onImport'a verir (satır modeline OfferEditor çevirir; cam tipi siparişin camı).
 */
export function ExcelImport({ orderId, files, glass, onImport, m }: {
  orderId: string;
  files: { id: string; name: string }[];
  glass: string;
  onImport: (rows: { en: number; boy: number; adet: number }[]) => void;
  m: Dict['offer']['import'];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [fileId, setFileId] = useState(files[0]?.id ?? '');
  const [rows, setRows] = useState<string[][] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [map, setMap] = useState({ width: -1, height: -1, qty: -1 });
  const [skipHeader, setSkipHeader] = useState(true);

  const cols = useMemo(() => Math.max(0, ...(rows ?? []).slice(0, 50).map((r) => r.length)), [rows]);
  const mapped = map.width >= 0 && map.height >= 0 && map.qty >= 0;
  const result = useMemo(() => (rows && mapped ? validateImportRows(rows, map, { skipHeader }) : null), [rows, map, skipHeader, mapped]);
  const bad = useMemo(() => new Map((result?.rows ?? []).filter((r) => r.errors.length).map((r) => [r.line, r.errors])), [result]);
  const colName = (i: number) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : '');

  const load = async (id: string) => {
    setLoading(true); setError(''); setRows(null);
    const res = await readOfferExcelAction(orderId, id);
    setLoading(false);
    if (!res.ok) return setError(res.error);
    setRows(res.rows);
    setMap({ width: -1, height: -1, qty: -1 });
  };
  const open = () => {
    dialog.current?.showModal();
    if (!rows && fileId) void load(fileId);
  };
  const choose = (k: keyof typeof map, v: string) => {
    const next = { ...map, [k]: Number(v) };
    setMap(next);
    if (rows && next.width >= 0 && next.height >= 0 && next.qty >= 0) setSkipHeader(looksLikeHeader(rows, next));
  };
  const apply = () => {
    if (!result) return;
    onImport(result.rows.filter((r) => r.errors.length === 0).map((r) => ({ en: r.en!, boy: r.boy!, adet: r.adet! })));
    dialog.current?.close();
  };

  return (
    <>
      <button type="button" className="btn" onClick={open}>{m.button}</button>
      <dialog ref={dialog} className="modal" aria-label={m.title} style={{ maxWidth: 900, width: 'calc(100% - 32px)' }}>
        <h2 style={{ marginTop: 0 }}>{m.title}</h2>
        <p className="muted small">{interpolate(m.intro, { glass: glass || '—' })}</p>
        {files.length > 1 && (
          <div className="field">
            <label htmlFor="xl-file">{m.file}</label>
            <select id="xl-file" value={fileId} onChange={(e) => { setFileId(e.target.value); void load(e.target.value); }}>
              {files.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>
        )}
        {loading && <p className="muted">{m.loading}</p>}
        {error && <div className="alert alert-error">{error}</div>}
        {rows && (
          <>
            <div className="grid-3" style={{ gap: 8 }}>
              {(['width', 'height', 'qty'] as const).map((k) => (
                <div key={k}>
                  <label htmlFor={`xl-${k}`}>{m.map[k]}</label>
                  <select id={`xl-${k}`} value={String(map[k])} onChange={(e) => choose(k, e.target.value)}>
                    <option value="-1">{m.pickColumn}</option>
                    {Array.from({ length: cols }, (_, i) => <option key={i} value={i}>{interpolate(m.column, { c: colName(i), v: (rows[0]?.[i] ?? '').slice(0, 20) })}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <label className="check small" style={{ marginTop: 8 }}>
              <input type="checkbox" checked={skipHeader} onChange={(e) => setSkipHeader(e.target.checked)} /> {m.skipHeader}
            </label>
            {result && (
              <p style={{ margin: '8px 0' }}>
                <span className="badge badge-ok">{interpolate(m.valid, { n: result.valid })}</span>{' '}
                {result.invalid > 0 && <span className="badge badge-danger">{interpolate(m.invalid, { n: result.invalid })}</span>}
              </p>
            )}
            <div className="table-wrap" style={{ maxHeight: 360, overflow: 'auto' }}>
              <table>
                <thead><tr><th>#</th>{Array.from({ length: cols }, (_, i) => <th key={i}>{colName(i)}</th>)}<th /></tr></thead>
                <tbody>
                  {rows.slice(0, 200).map((r, i) => {
                    const errs = bad.get(i + 1);
                    return (
                      <tr key={i} className={errs ? 'row-invalid' : undefined} style={errs ? { background: 'var(--danger-soft)' } : undefined}>
                        <td className="muted">{i + 1}</td>
                        {Array.from({ length: cols }, (_, c) => (
                          <td key={c} style={c === map.width || c === map.height || c === map.qty ? { fontWeight: 600 } : undefined}>{r[c] ?? ''}</td>
                        ))}
                        <td className="small danger">{errs ? errs.map((e) => m.errors[e]).join(', ') : ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {rows.length > 200 && <p className="muted small">{interpolate(m.more, { n: rows.length - 200 })}</p>}
          </>
        )}
        <div className="row end" style={{ marginTop: 12 }}>
          <button type="button" className="btn" onClick={() => dialog.current?.close()}>{m.cancel}</button>
          <button type="button" className="btn btn-primary" disabled={!result || result.valid === 0} onClick={apply}>{m.apply}</button>
        </div>
      </dialog>
    </>
  );
}
