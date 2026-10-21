'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import type { Dict } from '@/lib/i18n';
import { interpolate } from '@/server/i18n/interpolate.js';
import { duplicateRows, glassIndex, guessHeaderRow, HEADER_ROW_CHOICES, headerRowOf, importCapacity, importRows } from '@/server/commercial/excel-import.js';
import { ExcelGrid, excelColName as colName, excelCols } from '@/components/ExcelGrid';
import { readCommercialExcelAction } from './actions';
import type { EditorGlass } from './OfferEditor';

export type ImportedGlassRow = { productId: string; en: number; boy: number; qty: number };
type Map4 = { glass: number; width: number; height: number; qty: number };
type View = 'all' | 'ok' | 'invalid' | 'glass';
const NO_MAP: Map4 = { glass: -1, width: -1, height: -1, qty: -1 };

/**
 * Ticari teklif → Cam: "Excel'den Aktar" (4.1.0, karar 298; 4.2.0 ön izleme). Dosya bilgisayardan seçilir, sunucuda bellekte
 * okunur (saklanmaz) ve ön izleme satırları döner. Pencere satış teklif tablosunun aktarımıyla aynı düzende: dosyanın GERÇEK
 * hücreleri ortak tabloda (components/ExcelGrid.tsx), başlık satırı ve Cam tipi / En / Boy / Adet sütunları seçilir; doğrulama ve
 * cam eşleştirmesi tarayıcıda server/commercial/excel-import.js ile (satış aktarımının doğrulama yardımcıları + ticari sınırlar).
 * Geçerli ve hatalı satırlar ayrı görünür; "Teklif tablosuna aktar" önce özet gösterir, yalnızca kullanıcı onaylayınca geçerli ve
 * camı belirlenmiş satırlar düzenleyiciye eklenir; kayıt yönetici "Taslağı kaydet"e basınca sunucuda yeniden doğrulanır.
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
  const [headerRow, setHeaderRow] = useState(-1);
  const [headerTouched, setHeaderTouched] = useState(false);
  const [defaultId, setDefaultId] = useState('');
  const [picks, setPicks] = useState<Record<number, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [view, setView] = useState<View>('all');
  const [step, setStep] = useState<'map' | 'confirm'>('map');

  const index = useMemo(() => glassIndex(glass.map((g) => ({ id: g.id, ...g.match, label: g.label }))), [glass]);
  const valid = useMemo(() => new Set(glass.map((g) => g.id)), [glass]);
  const byId = useMemo(() => new Map(glass.map((g) => [g.id, g])), [glass]);
  const rows = data?.rows ?? null;
  const cols = useMemo(() => excelCols(rows), [rows]);
  const mapped = map.width >= 0 && map.height >= 0 && map.qty >= 0;
  const result = useMemo(
    () => (rows && mapped ? importRows(rows, map, { headerRow, index, defaultId, picks, valid }) : null),
    [rows, map, headerRow, index, defaultId, picks, valid, mapped],
  );
  const byLine = useMemo(() => new Map((result?.rows ?? []).map((r) => [r.line, r])), [result]);
  const ready = useMemo(() => (result?.rows ?? []).filter((r) => r.ok).map((r) => ({ productId: r.glass!, en: r.en!, boy: r.boy!, qty: r.qty! })), [result]);
  const invalidList = useMemo(() => (result?.rows ?? []).filter((r) => r.errors.length > 0), [result]);
  const existingCount = existing.length;
  const cap = importCapacity(existingCount, ready.length);
  const sameFile = !!data && imported.includes(data.fingerprint);
  const sameRows = duplicateRows(ready, existing);
  const needConfirm = sameFile || sameRows > 0;
  const noCost = ready.filter((r) => byId.get(r.productId)?.listCost == null).length;
  const canApply = !!result && ready.length > 0 && cap.ok && (!needConfirm || confirmed) && !pending;
  // Sütun seçimlerinde görünen değer: seçilen başlık satırının hücresi (başlık yoksa ilk satır — satış ekranındaki gibi)
  const labelRow = rows ? rows[headerRow >= 0 ? headerRow : 0] ?? [] : [];

  const reset = () => {
    setData(null); setError(''); setMap(NO_MAP); setDefaultId(''); setPicks({}); setConfirmed(false);
    setHeaderRow(-1); setHeaderTouched(false); setView('all'); setStep('map');
  };
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
    setStep('map');
    // Başlık satırı önerisi: kullanıcı başlığı kendisi seçmediyse ölçü / adet sütunları seçilince önerilir
    if (rows && !headerTouched && next.width >= 0 && next.height >= 0 && next.qty >= 0) setHeaderRow(guessHeaderRow(rows, next));
  };
  const chooseHeader = (v: string) => {
    setHeaderRow(headerRowOf(v, rows?.length ?? 0));
    setHeaderTouched(true);
    setConfirmed(false);
    setStep('map');
  };
  const commit = () => {
    if (!canApply || !data) return;
    onImport(ready, data.fingerprint);
    dialog.current?.close();
  };
  const status = (s: keyof typeof m.status) => m.status[s];
  const errorText = (codes: string[]) => codes.map((c) => (Object.hasOwn(m.rowErrors, c) ? m.rowErrors[c as keyof typeof m.rowErrors] : c)).join(', ');
  /** Satırın durumu: başlık / başlığın üstü / boş / aktarılacak / hatalı / cam bekliyor */
  const stateOf = (line: number) => {
    if (headerRow >= 0 && line === headerRow + 1) return 'header';
    if (headerRow >= 0 && line <= headerRow) return 'skipped';
    const r = byLine.get(line);
    if (!r) return 'empty';
    return r.ok ? 'ok' : r.errors.length ? 'invalid' : 'glass';
  };
  const shown = (line: number) => view === 'all' || stateOf(line) === view;
  const cell = (text: string | null | undefined, max = 24) => String(text ?? '').trim().slice(0, max);

  const trailing = (line: number) => {
    const st = stateOf(line);
    if (st === 'header') return <td className="small muted import-result" data-excel-result>{m.headerRowMark}</td>;
    if (st === 'skipped') return <td className="small muted import-result" data-excel-result>{m.skippedRow}</td>;
    const r = byLine.get(line);
    if (!r) return <td className="import-result" />;
    const unresolved = r.errors.length === 0 && (!r.glass || r.glassStatus === 'PICKED');
    return (
      <td className={r.ok ? 'small import-result' : 'small text-danger import-result'} data-excel-result>
        <div>{r.errors.length ? errorText(r.errors) : r.ok ? m.ok : m.notImported}</div>
        {r.errors.length === 0 && (
          <div className="muted">
            {interpolate(m.parsed, { en: r.en ?? '—', boy: r.boy ?? '—', qty: r.qty ?? '—' })} · {status(r.glassStatus)}
            {r.glass && r.glassStatus !== 'PICKED' ? ` · ${byId.get(r.glass)?.label ?? ''}` : ''}
          </div>
        )}
        {unresolved && (
          <select value={picks[r.line] ?? ''} aria-label={`${m.pickGlass} ${r.line}`} data-excel-pick={r.line}
            onChange={(e) => { const v = e.target.value; setPicks((p) => { const n = { ...p }; if (v) n[r.line] = v; else delete n[r.line]; return n; }); setConfirmed(false); setStep('map'); }}>
            <option value="">{m.pickGlass}</option>
            {glass.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
          </select>
        )}
      </td>
    );
  };

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
              <div>
                <label htmlFor="cx-header">{m.headerRow}</label>
                <select id="cx-header" value={String(headerRow)} onChange={(e) => chooseHeader(e.target.value)}>
                  <option value="-1">{m.headerNone}</option>
                  {rows.slice(0, HEADER_ROW_CHOICES).map((r, i) => (
                    <option key={i} value={i}>{interpolate(m.headerOption, { n: i + 1, v: r.map((c) => cell(c, 16)).filter(Boolean).slice(0, 4).join(' · ') })}</option>
                  ))}
                </select>
              </div>
              {(['glass', 'width', 'height', 'qty'] as const).map((k) => (
                <div key={k}>
                  <label htmlFor={`cx-${k}`}>{m.map[k]}</label>
                  <select id={`cx-${k}`} value={String(map[k])} onChange={(e) => choose(k, e.target.value)}>
                    <option value="-1">{k === 'glass' ? m.noColumn : m.pickColumn}</option>
                    {Array.from({ length: cols }, (_, i) => <option key={i} value={i}>{interpolate(m.column, { c: colName(i), v: cell(labelRow[i], 20) })}</option>)}
                  </select>
                </div>
              ))}
              <div>
                <label htmlFor="cx-default">{m.defaultGlass}</label>
                <select id="cx-default" value={defaultId} onChange={(e) => { setDefaultId(e.target.value); setConfirmed(false); setStep('map'); }}>
                  <option value="">{m.defaultNone}</option>
                  {glass.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
                </select>
              </div>
            </div>
            {!mapped && <p className="muted small" data-excel-hint>{m.mapHint}</p>}
            {result && (
              <>
                <div className="import-stats" data-excel-stats>
                  <span className="badge badge-ok" data-stat="ready">{interpolate(m.stats.ready, { n: result.ready })}</span>
                  {result.invalid > 0 && <span className="badge badge-danger" data-stat="invalid">{interpolate(m.stats.invalid, { n: result.invalid })}</span>}
                  {result.needsGlass > 0 && <span className="badge badge-warn" data-stat="needsGlass">{interpolate(m.stats.needsGlass, { n: result.needsGlass })}</span>}
                </div>
                {invalidList.length > 0 && (
                  <p className="import-invalid" data-excel-invalid-list>
                    {invalidList.slice(0, 40).map((r) => `${r.line}: ${errorText(r.errors)}`).join(' · ')}
                    {invalidList.length > 40 ? ' …' : ''}
                  </p>
                )}
                {!cap.ok && <div className="alert alert-error" data-excel-capacity>{interpolate(m.capacity, { existing: cap.existing, free: cap.free, adding: cap.adding })}</div>}
                {noCost > 0 && <div className="alert alert-warn" data-excel-nocost>{interpolate(m.noCost, { n: noCost })}</div>}
                {needConfirm && (
                  <div className="alert alert-warn" data-excel-duplicate>
                    {sameFile && <div>{m.sameFile}</div>}
                    {sameRows > 0 && <div>{interpolate(m.sameRows, { n: sameRows })}</div>}
                    <label className="check small"><input type="checkbox" checked={confirmed} onChange={(e) => { setConfirmed(e.target.checked); setStep('map'); }} data-excel-confirm /> {m.confirmAgain}</label>
                  </div>
                )}
                <div className="chips" role="radiogroup" aria-label={m.view.label} data-excel-view style={{ marginBottom: 8 }}>
                  {(['all', 'ok', 'invalid', 'glass'] as const).map((v) => (
                    <label key={v} className="chip">
                      <input type="radio" name="cx-view" value={v} checked={view === v} onChange={() => setView(v)} data-excel-filter={v} />
                      <span>{m.view[v]}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
            <ExcelGrid rows={rows} cols={cols} picked={[map.glass, map.width, map.height, map.qty]} show={result ? shown : undefined}
              invalid={(line) => (byLine.get(line)?.errors.length ?? 0) > 0} trailing={trailing} trailingHead={m.cols.result}
              tableProps={{ 'data-excel-preview': '' }}
              rowProps={(line) => {
                const st = stateOf(line);
                const r = byLine.get(line);
                return {
                  'data-excel-row': String(line), 'data-excel-state': st, 'data-glass-status': r?.glassStatus,
                  className: st === 'header' ? 'row-header' : st === 'skipped' ? 'row-skipped' : undefined,
                };
              }} />
            {rows.length > 200 && <p className="muted small">{interpolate(m.more, { n: rows.length - 200 })}</p>}
            {step === 'confirm' && result && (
              <div className="import-confirm" role="region" aria-label={m.confirm.title} data-excel-summary>
                <strong>{interpolate(m.confirm.title, { n: ready.length })}</strong>
                <ul>
                  <li>{interpolate(m.confirm.adding, { n: ready.length, existing: existingCount })}</li>
                  {result.invalid > 0 && <li>{interpolate(m.confirm.invalid, { n: result.invalid })}</li>}
                  {result.needsGlass > 0 && <li>{interpolate(m.confirm.needsGlass, { n: result.needsGlass })}</li>}
                  <li>{m.confirm.keep}</li>
                </ul>
              </div>
            )}
          </>
        )}
        <div className="row end" style={{ marginTop: 12 }}>
          <button type="button" className="btn" onClick={() => dialog.current?.close()}>{m.cancel}</button>
          {step === 'confirm' ? (
            <>
              <button type="button" className="btn" onClick={() => setStep('map')} data-excel-back>{m.confirm.back}</button>
              <button type="button" className="btn btn-primary" disabled={!canApply} onClick={commit} data-excel-commit>{interpolate(m.confirm.commit, { n: ready.length })}</button>
            </>
          ) : (
            <button type="button" className="btn btn-primary" disabled={!canApply} onClick={() => setStep('confirm')} data-excel-apply>{interpolate(m.apply, { n: ready.length })}</button>
          )}
        </div>
      </dialog>
    </>
  );
}
