'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import type { Dict } from '@/lib/i18n';
import { interpolate } from '@/server/i18n/interpolate.js';
import { duplicateRows, glassIndex, importCapacity, importRows, looksLikeHeaderRow } from '@/server/commercial/excel-import.js';
import { readCommercialExcelAction } from './actions';
import type { EditorGlass } from './OfferEditor';

export type ImportedGlassRow = { productId: string; en: number; boy: number; qty: number };
type Map4 = { glass: number; width: number; height: number; qty: number };
const NO_MAP: Map4 = { glass: -1, width: -1, height: -1, qty: -1 };

/**
 * Ticari teklif → Cam: "Excel'den Aktar" (4.1.0, karar 298). Dosya bilgisayardan seçilir, sunucuda bellekte okunur (saklanmaz)
 * ve ön izleme satırları döner. Sütun eşleştirme, doğrulama ve cam eşleştirmesi tarayıcıda server/commercial/excel-import.js
 * ile (satış aktarımının doğrulama yardımcıları + ticari sınırlar). "Teklif tablosuna aktar" yalnızca geçerli ve camı belirlenmiş
 * satırları düzenleyiciye verir; kayıt yönetici "Taslağı kaydet"e basınca sunucuda yeniden doğrulanır.
 */
export function ExcelImport({ m, glass, existing, imported, onImport }: {
  m: Dict['commercial']['import'];
  glass: EditorGlass[];
  /** Cam bölümündeki mevcut satırlar (sandık kalemleri dahil — 100 satır sınırı; aynı satır uyarısı) */
  existing: { productId: string; en: string; boy: string; qty: string }[];
  /** Bu ekranda daha önce aktarılmış dosyaların içerik özetleri */
  imported: string[];
  onImport: (rows: ImportedGlassRow[], fingerprint: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [data, setData] = useState<{ rows: string[][]; fingerprint: string; name: string } | null>(null);
  const [error, setError] = useState('');
  const [map, setMap] = useState<Map4>(NO_MAP);
  const [skipHeader, setSkipHeader] = useState(true);
  const [defaultId, setDefaultId] = useState('');
  const [picks, setPicks] = useState<Record<number, string>>({});
  const [confirmed, setConfirmed] = useState(false);

  const index = useMemo(() => glassIndex(glass.map((g) => ({ id: g.id, ...g.match, label: g.label }))), [glass]);
  const valid = useMemo(() => new Set(glass.map((g) => g.id)), [glass]);
  const byId = useMemo(() => new Map(glass.map((g) => [g.id, g])), [glass]);
  const rows = data?.rows ?? null;
  const cols = useMemo(() => Math.max(0, ...(rows ?? []).slice(0, 50).map((r) => r.length)), [rows]);
  const mapped = map.width >= 0 && map.height >= 0 && map.qty >= 0;
  const result = useMemo(
    () => (rows && mapped ? importRows(rows, map, { skipHeader, index, defaultId, picks, valid }) : null),
    [rows, map, skipHeader, index, defaultId, picks, valid, mapped],
  );
  const ready = useMemo(() => (result?.rows ?? []).filter((r) => r.ok).map((r) => ({ productId: r.glass!, en: r.en!, boy: r.boy!, qty: r.qty! })), [result]);
  const existingCount = existing.length;
  const cap = importCapacity(existingCount, ready.length);
  const sameFile = !!data && imported.includes(data.fingerprint);
  const sameRows = duplicateRows(ready, existing);
  const needConfirm = sameFile || sameRows > 0;
  const noCost = ready.filter((r) => byId.get(r.productId)?.listCost == null).length;
  const canApply = !!result && ready.length > 0 && cap.ok && (!needConfirm || confirmed) && !pending;
  const colName = (i: number) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : '');

  const reset = () => { setData(null); setError(''); setMap(NO_MAP); setDefaultId(''); setPicks({}); setConfirmed(false); setSkipHeader(true); };
  const open = () => { reset(); if (fileInput.current) fileInput.current.value = ''; dialog.current?.showModal(); };
  const read = (file: File | undefined) => {
    reset();
    if (!file) return;
    const fd = new FormData();
    fd.set('file', file);
    start(async () => {
      try {
        const res = await readCommercialExcelAction(fd);
        if (!res.ok) { setError(res.error); return; }
        setData({ rows: res.rows, fingerprint: res.fingerprint, name: res.name });
      } catch {
        setError(m.errors.FAILED);
      }
    });
  };
  const choose = (k: keyof Map4, v: string) => {
    const next = { ...map, [k]: Number(v) };
    setMap(next);
    setConfirmed(false);
    if (rows && next.width >= 0 && next.height >= 0 && next.qty >= 0) setSkipHeader(looksLikeHeaderRow(rows, next));
  };
  const apply = () => {
    if (!canApply || !data) return;
    onImport(ready, data.fingerprint);
    dialog.current?.close();
  };
  const status = (s: keyof typeof m.status) => m.status[s];
  const errorText = (codes: string[]) => codes.map((c) => (Object.hasOwn(m.rowErrors, c) ? m.rowErrors[c as keyof typeof m.rowErrors] : c)).join(', ');

  return (
    <>
      <button type="button" className="btn" data-excel-import onClick={open}>{m.button}</button>
      <dialog ref={dialog} className="modal modal-wide" aria-label={m.title} data-excel-dialog>
        <h2>{m.title}</h2>
        <p className="muted small">{m.intro}</p>
        <div className="field">
          <label htmlFor="cx-file">{m.file}</label>
          <input id="cx-file" ref={fileInput} type="file" accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => read(e.target.files?.[0])} data-excel-file />
        </div>
        {pending && <p className="loading">{m.loading}</p>}
        {error && <div className="alert alert-error" role="alert" data-excel-error>{error}</div>}
        {rows && (
          <>
            <div className="grid-2">
              {(['glass', 'width', 'height', 'qty'] as const).map((k) => (
                <div key={k}>
                  <label htmlFor={`cx-${k}`}>{m.map[k]}</label>
                  <select id={`cx-${k}`} value={String(map[k])} onChange={(e) => choose(k, e.target.value)}>
                    <option value="-1">{k === 'glass' ? m.noColumn : m.pickColumn}</option>
                    {Array.from({ length: cols }, (_, i) => <option key={i} value={i}>{interpolate(m.column, { c: colName(i), v: (rows[0]?.[i] ?? '').slice(0, 20) })}</option>)}
                  </select>
                </div>
              ))}
              <div>
                <label htmlFor="cx-default">{m.defaultGlass}</label>
                <select id="cx-default" value={defaultId} onChange={(e) => { setDefaultId(e.target.value); setConfirmed(false); }}>
                  <option value="">{m.defaultNone}</option>
                  {glass.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
                </select>
              </div>
            </div>
            <label className="check small" style={{ marginTop: 8 }}>
              <input type="checkbox" checked={skipHeader} onChange={(e) => setSkipHeader(e.target.checked)} /> {m.skipHeader}
            </label>
            {result && (
              <>
                <div className="import-stats" data-excel-stats>
                  <span className="badge badge-ok" data-stat="ready">{interpolate(m.stats.ready, { n: result.ready })}</span>
                  {result.invalid > 0 && <span className="badge badge-danger" data-stat="invalid">{interpolate(m.stats.invalid, { n: result.invalid })}</span>}
                  {result.needsGlass > 0 && <span className="badge badge-warn" data-stat="needsGlass">{interpolate(m.stats.needsGlass, { n: result.needsGlass })}</span>}
                </div>
                {!cap.ok && <div className="alert alert-error" data-excel-capacity>{interpolate(m.capacity, { existing: cap.existing, free: cap.free, adding: cap.adding })}</div>}
                {noCost > 0 && <div className="alert alert-warn" data-excel-nocost>{interpolate(m.noCost, { n: noCost })}</div>}
                {needConfirm && (
                  <div className="alert alert-warn" data-excel-duplicate>
                    {sameFile && <div>{m.sameFile}</div>}
                    {sameRows > 0 && <div>{interpolate(m.sameRows, { n: sameRows })}</div>}
                    <label className="check small"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} data-excel-confirm /> {m.confirmAgain}</label>
                  </div>
                )}
                <div className="import-preview">
                  <table data-excel-preview>
                    <thead><tr><th>{m.cols.line}</th><th>{m.cols.glass}</th><th className="num">{m.cols.en}</th><th className="num">{m.cols.boy}</th><th className="num">{m.cols.qty}</th><th>{m.cols.result}</th></tr></thead>
                    <tbody>
                      {result.rows.slice(0, 200).map((r) => {
                        const unresolved = r.errors.length === 0 && (!r.glass || r.glassStatus === 'PICKED');
                        return (
                          <tr key={r.line} className={r.ok ? undefined : 'row-invalid'} data-excel-row={r.line} data-glass-status={r.glassStatus}>
                            <td className="muted">{r.line}</td>
                            <td>
                              {r.glassText && <div className="small">{r.glassText}</div>}
                              <div className="small muted">{status(r.glassStatus)}{r.glass && r.glassStatus !== 'PICKED' ? ` · ${byId.get(r.glass)?.label ?? ''}` : ''}</div>
                              {unresolved && (
                                <select value={picks[r.line] ?? ''} aria-label={`${m.pickGlass} ${r.line}`} data-excel-pick={r.line}
                                  onChange={(e) => { const v = e.target.value; setPicks((p) => { const n = { ...p }; if (v) n[r.line] = v; else delete n[r.line]; return n; }); setConfirmed(false); }}>
                                  <option value="">{m.pickGlass}</option>
                                  {glass.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
                                </select>
                              )}
                            </td>
                            <td className="num">{r.en ?? '—'}</td>
                            <td className="num">{r.boy ?? '—'}</td>
                            <td className="num">{r.qty ?? '—'}</td>
                            <td className={r.ok ? 'small' : 'small text-danger'}>{r.errors.length ? errorText(r.errors) : r.ok ? m.ok : m.notImported}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {result.rows.length > 200 && <p className="muted small">{interpolate(m.more, { n: result.rows.length - 200 })}</p>}
              </>
            )}
          </>
        )}
        <div className="row end" style={{ marginTop: 12 }}>
          <button type="button" className="btn" onClick={() => dialog.current?.close()}>{m.cancel}</button>
          <button type="button" className="btn btn-primary" disabled={!canApply} onClick={apply} data-excel-apply>{interpolate(m.apply, { n: ready.length })}</button>
        </div>
      </dialog>
    </>
  );
}
