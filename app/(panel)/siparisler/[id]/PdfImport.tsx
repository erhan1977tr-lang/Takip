'use client';

import { useMemo, useRef, useState } from 'react';
import type { Dict } from '@/lib/i18n';
import { interpolate } from '@/server/i18n/interpolate.js';
import { applyFactoryPdfAction, previewFactoryPdfAction, uploadFactoryPdfAction, type PdfImportPreview } from './pdf-import-actions';

type Preview = PdfImportPreview;
type Imp = Preview['imports'][number];
type Problem = Imp['blocking'][number];

const money = (cents: number | null | undefined) => (cents == null ? '—' : new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100));
const area = (milli: number | null | undefined) => (milli == null ? '—' : new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(milli / 1000));
const pct = (bp: number | null | undefined) => (bp == null ? '—' : new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 }).format(bp / 100));
const day = (d: string | null) => (d ? d.split('-').reverse().join('.') : '—');
/** Cam araması: büyük / küçük harf ve Türkçe / Romence harf farkı gözetmez; bütün sözcükler geçmeli */
const fold = (s: string) => s.toLocaleUpperCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/İ/g, 'I').replace(/[ŞȘ]/g, 'S').replace(/Ğ/g, 'G').replace(/Ü/g, 'U').replace(/Ö/g, 'O').replace(/Ç/g, 'C').replace(/[ȚŢ]/g, 'T').replace(/[ĂÂ]/g, 'A').replace(/Î/g, 'I');
const matches = (c: { label: string; search: string }, q: string | undefined) => {
  const words = fold(q ?? '').split(/\s+/).filter(Boolean);
  const hay = fold(`${c.label} ${c.search}`);
  return words.every((w) => hay.includes(w));
};

/**
 * "PDF'den Aktar" (karar 255): fabrika sipariş PDF'leri → ön izleme → onay → teklif tablosu. Bütün hesap ve denetim
 * sunucuda (server/orders/pdf-import/*); burada yalnızca yükleme, seçimler (cam cinsi, işlem türü, aktarılacak PDF'ler,
 * kaldırılacak boş satırlar) ve gösterim. Aktarma ön izlemenin parmak iziyle gider; sunucu yeniden hesaplar.
 * Kaydedilmemiş editör değişikliği varken aktarma kapalıdır (aktarma kayıtlı tabloya ekler, sayfa yenilenir).
 */
export function PdfImport({ orderId, dirty, previous, m }: {
  orderId: string;
  dirty: boolean;
  previous: { id: string; name: string; factoryNo: string | null; applied: boolean }[];
  m: Dict['offer']['pdf'];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'' | 'upload' | 'preview' | 'apply'>('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [ids, setIds] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<Record<string, boolean>>({});
  const [choices, setChoices] = useState<{ glass: Record<string, string>; ops: Record<string, string> }>({ glass: {}, ops: {} });
  const [drop, setDrop] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState<Record<string, string>>({});

  const included = useMemo(() => ids.filter((id) => !excluded[id]), [ids, excluded]);
  const shown = preview?.imports ?? [];
  const blocked = shown.some((i) => i.blocking.length > 0);
  const lineCount = shown.reduce((n, i) => n + (i.plan?.lineCount ?? 0), 0);

  const refresh = async (nextIds: string[], nextChoices = choices) => {
    if (!nextIds.length) { setPreview(null); return; }
    setBusy('preview'); setError('');
    const res = await previewFactoryPdfAction(orderId, nextIds, nextChoices);
    setBusy('');
    if (!res.ok) { setError(res.error); return; }
    setPreview(res);
    setDrop((d) => Object.fromEntries(res.empty.map((e) => [e.id, d[e.id] ?? true])));
  };

  const upload = async () => {
    const files = Array.from(fileInput.current?.files ?? []);
    if (!files.length) { setError(m.noFiles); return; }
    const fd = new FormData();
    fd.set('id', orderId);
    for (const f of files) fd.append('pdfs', f);
    setBusy('upload'); setError('');
    const res = await uploadFactoryPdfAction(fd);
    setBusy('');
    if (!res.ok) { setError(res.error); return; }
    const next = [...new Set([...ids, ...res.imports.map((i) => i.id)])];
    setIds(next);
    if (fileInput.current) fileInput.current.value = '';
    // Daha önce yüklenen PDF'ler de bu aktarımda kalır: ön izleme birlikte yeniden hesaplanır
    await refresh(next.filter((id) => !excluded[id]));
  };

  const toggle = async (id: string, include: boolean) => {
    const next = { ...excluded, [id]: !include };
    setExcluded(next);
    await refresh(ids.filter((x) => !next[x]));
  };
  const choose = async (kind: 'glass' | 'ops', key: string, value: string) => {
    const next = { ...choices, [kind]: { ...choices[kind], [key]: value } };
    setChoices(next);
    await refresh(included, next);
  };

  const apply = async () => {
    if (!preview || blocked || dirty) return;
    setBusy('apply'); setError('');
    const res = await applyFactoryPdfAction({
      orderId, version: preview.version,
      imports: preview.imports.map((i) => ({ id: i.id, fingerprint: i.fingerprint ?? '' })),
      choices, dropEmpty: Object.entries(drop).filter(([, v]) => v).map(([k]) => k),
    });
    // Başarıda sunucu sayfayı yeniden yükler (yönlendirme); buraya yalnızca hata döner
    setBusy('');
    if (res && !res.ok) setError(res.error);
  };

  const text = (p: Problem) => {
    const tpl = (m.problems as Record<string, string>)[p.code] ?? p.code;
    const params: Record<string, unknown> = { ...p };
    if (p.code === 'PDF_UNREADABLE') params.reason = (m.reasons as Record<string, string>)[String(p.reason)] ?? String(p.reason ?? '');
    if (p.code === 'UNRECOGNIZED_LINE') params.text = p.text ? `: ${String(p.text)}` : '';
    if (p.code === 'ROW_INCOMPLETE') params.text = p.text ? String(p.text) : '—';
    if (p.code === 'AREA_MISMATCH') { params.pdfM2 = (Number(p.pdfM2) / 1000).toFixed(3); params.dimsM2 = (Number(p.dimsM2) / 1000).toFixed(3); }
    return interpolate(tpl, params as Record<string, string | number>);
  };
  const excludedRows = ids.filter((id) => excluded[id]);

  return (
    <>
      <button type="button" className="btn" data-pdf-import onClick={() => dialog.current?.showModal()}>{m.button}</button>
      <dialog ref={dialog} className="modal modal-wide pdf-import" aria-label={m.title}>
        <h2>{m.title}</h2>
        <p className="muted small">{m.intro}</p>
        <p className="muted small">{m.eur}</p>
        {dirty && <div className="alert alert-warn" data-pdf-dirty>{m.dirty}</div>}

        {previous.length > 0 && (
          <details className="pdf-previous">
            <summary className="small">{m.previous} ({previous.length})</summary>
            <ul className="plain-list small">
              {previous.map((p) => (
                <li key={p.id}>
                  {/* Özgün PDF saklanmaz (3.75.3): yalnızca adı ve aktarım durumu */}
                  <span className="mono" data-previous-pdf>{p.name}</span>
                  {p.factoryNo ? ` · ${p.factoryNo}` : ''} · <span className={`badge ${p.applied ? 'badge-ok' : 'badge-muted'}`}>{p.applied ? m.statusApplied : m.statusPreview}</span>
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="field">
          <label htmlFor="pdf-files">{m.files}</label>
          <div className="row" style={{ gap: 8 }}>
            <input id="pdf-files" ref={fileInput} type="file" accept="application/pdf,.pdf" multiple disabled={!!busy} />
            <button type="button" className="btn btn-primary" data-pdf-upload disabled={!!busy} onClick={() => void upload()}>{m.upload}</button>
          </div>
        </div>
        {busy === 'upload' && <p className="loading">{m.uploading}</p>}
        {busy === 'preview' && <p className="loading">{m.refreshing}</p>}
        {error && <div className="alert alert-error" role="alert" data-pdf-error>{error}</div>}

        {shown.map((imp) => (
          <section key={imp.id} className="pdf-import-file" data-pdf-file={imp.factoryNo ?? imp.id}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <h3 className="sub-title mono">{imp.name}</h3>
              <label className="check small"><input type="checkbox" checked={!excluded[imp.id]} onChange={(e) => void toggle(imp.id, e.target.checked)} /> {m.include}</label>
            </div>
            {imp.plan && (
              <dl className="pdf-head small">
                <dt>{m.factoryNo}</dt><dd className="mono" data-factory-no>{imp.plan.header.factoryNo ?? '—'}</dd>
                <dt>{m.project}</dt><dd data-project>{imp.plan.header.projectCode ?? '—'}</dd>
                <dt>{m.orderDate}</dt><dd>{day(imp.plan.header.orderDate)}</dd>
                <dt>{m.deliveryDate}</dt><dd>{day(imp.plan.header.deliveryDate)}</dd>
              </dl>
            )}
            {imp.blocking.length > 0 && (
              <div className="alert alert-error" data-pdf-blocking>
                <b>{m.blocked}</b>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{imp.blocking.map((p, i) => <li key={i} data-code={p.code}>{text(p)}</li>)}</ul>
              </div>
            )}
            {imp.warnings.length > 0 && (
              <div className="alert alert-warn" data-pdf-warnings>
                <b>{m.warnings}</b>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{imp.warnings.map((p, i) => <li key={i} data-code={p.code}>{text(p)}</li>)}</ul>
              </div>
            )}
            {imp.plan && (
              <>
                {imp.plan.glassChoices.filter((g) => !g.auto || !g.selected).map((g) => (
                  <div className="field" key={g.key}>
                    <label>{m.pickGlass}: <span className="muted">{g.description}</span>{g.code ? ` · ${interpolate(m.code, { code: g.code })}` : ''}</label>
                    {/* 4.2.12: bütün katalog (pasifler işaretli); arama ad / renk / kod üzerinde, seçili cam her zaman listede kalır */}
                    <input type="search" placeholder={m.glassSearch} aria-label={m.glassSearch} data-glass-search value={search[g.key] ?? ''}
                      onChange={(e) => setSearch((s) => ({ ...s, [g.key]: e.target.value }))} style={{ marginBottom: 4 }} />
                    <select value={choices.glass[g.key] ?? g.selected ?? ''} data-pick-glass onChange={(e) => void choose('glass', g.key, e.target.value)}>
                      <option value="">—</option>
                      {g.candidates.filter((c) => matches(c, search[g.key]) || c.id === (choices.glass[g.key] ?? g.selected)).map((c) => (
                        <option key={c.id} value={c.id} data-inactive={c.inactive ? '' : undefined}>{c.inactive ? `${c.label} ${m.glassInactive}` : c.label}</option>
                      ))}
                    </select>
                  </div>
                ))}
                {imp.plan.opChoices.filter((o) => !o.auto).map((o) => (
                  <div className="field" key={o.key}>
                    <label>{m.pickOp}: <span className="muted">{o.name}</span></label>
                    <select value={choices.ops[o.key] ?? ''} data-pick-op onChange={(e) => void choose('ops', o.key, e.target.value)}>
                      <option value="">—</option>
                      <option value="CNC">{m.kinds.CNC}</option>
                      <option value="DELIK">{m.kinds.DELIK}</option>
                    </select>
                  </div>
                ))}
                <div className="table-wrap">
                  <table className="pdf-rows" data-pdf-rows>
                    <thead>
                      <tr><th>{m.cols.sno}</th><th>{m.cols.poz}</th><th>{m.cols.glass}</th><th>{m.cols.size}</th><th className="num">{m.cols.qty}</th><th className="num">{m.cols.m2}</th><th className="num">{m.cols.price}</th><th className="num">{m.cols.discount}</th><th className="num">{m.cols.net}</th><th className="num">{m.cols.amount}</th></tr>
                    </thead>
                    <tbody>
                      {imp.plan.rows.map((r) => (
                        <FragmentRows key={r.sourceRow} r={r} m={m} />
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="pdf-checks small" data-pdf-checks>
                  <b>{m.checks}</b>
                  <div data-check="a">
                    {interpolate(m.checkA, { sum: money(imp.plan.checks.a.pdfSum), sub: money(imp.plan.checks.a.subtotal) })}{' '}
                    <span className={`badge ${imp.plan.checks.a.ok ? 'badge-ok' : 'badge-warn'}`}>{imp.plan.checks.a.ok ? m.ok : m.subtotalKept}</span>
                  </div>
                  <div data-check="b" data-diff={imp.plan.checks.b.diff ?? ''}>
                    {interpolate(m.checkB, { takip: money(imp.plan.checks.b.takipTotal), sum: money(imp.plan.checks.b.pdfSum), diff: money(imp.plan.checks.b.diff) })}{' '}
                    {imp.plan.checks.b.diff === 0
                      ? <span className="badge badge-ok">{m.ok}</span>
                      : <span className={`badge ${imp.plan.checks.b.explained ? 'badge-warn' : 'badge-danger'}`}>{imp.plan.checks.b.explained ? m.explained : m.unexplained}</span>}
                  </div>
                  {(imp.plan.checks.vat != null || imp.plan.checks.grandTotal != null) && (
                    <div className="muted" data-check="vat">{interpolate(m.vatIgnored, { vat: money(imp.plan.checks.vat), total: money(imp.plan.checks.grandTotal) })}</div>
                  )}
                </div>
              </>
            )}
          </section>
        ))}
        {excludedRows.length > 0 && <p className="muted small" data-pdf-excluded>{interpolate(m.excluded, { n: excludedRows.length })}</p>}

        {preview && preview.empty.length > 0 && (
          <div className="field" data-pdf-empty>
            <b className="small">{m.empty}</b>
            <p className="hint">{m.emptyHint}</p>
            {preview.empty.map((e) => (
              <label key={e.id} className="check small"><input type="checkbox" checked={!!drop[e.id]} onChange={(ev) => setDrop({ ...drop, [e.id]: ev.target.checked })} /> {e.description || '—'} × {e.adet}</label>
            ))}
          </div>
        )}

        <div className="row end" style={{ marginTop: 12 }}>
          {preview && lineCount > 0 && !blocked && <span className="muted small" data-pdf-linecount>{interpolate(m.lines, { n: lineCount })}</span>}
          <button type="button" className="btn" onClick={() => dialog.current?.close()}>{m.cancel}</button>
          <button type="button" className="btn btn-primary" data-pdf-apply disabled={!preview || !shown.length || blocked || dirty || !!busy} onClick={() => void apply()}>
            {busy === 'apply' ? m.applying : m.apply}
          </button>
        </div>
      </dialog>
    </>
  );
}

function FragmentRows({ r, m }: { r: NonNullable<Imp['plan']>['rows'][number]; m: Dict['offer']['pdf'] }) {
  return (
    <>
      <tr className={r.explained ? 'glass-line' : 'glass-line row-invalid'} data-source-row={r.sourceRow}>
        <td className="muted">{r.sourceRow}</td>
        <td className="mono">{r.poz}{!r.pozFromPdf && <div className="small muted">{m.pozFallback}</div>}</td>
        <td>
          <div className="small muted">{r.description}</div>
          <div data-glass-label>{r.glassLabel ?? '—'}{' '}
            {/* Normal / Şekilli (karar 262): açıklamadan ayrı okunur; aktarımdan sonra teklif tablosunda değiştirilebilir */}
            <span className={`badge ${r.shaped ? 'badge-info' : 'badge-muted'}`} data-pdf-shape={r.shaped ? 'shaped' : 'normal'}>{r.shaped ? m.shapeShaped : m.shapeNormal}</span>
          </div>
        </td>
        <td className="mono">{r.en} × {r.boy}</td>
        <td className="num">{r.adet}</td>
        <td className="num">{area(r.totalM2)} / {area(r.takipM2)}</td>
        <td className="num">{money(r.unitPrice)}</td>
        <td className="num">{pct(r.discount)}</td>
        <td className="num" data-net>{money(r.netUnit)}</td>
        <td className="num">{money(r.amount)} / {money(r.takipAmount)}</td>
      </tr>
      {r.ops.map((o, i) => (
        <tr key={i} className="sub-line" data-op={o.kind ?? ''}>
          <td />
          <td />
          <td><span className="badge badge-info">{o.kind ? m.kinds[o.kind as 'CNC' | 'DELIK'] : '?'}</span> {o.name}</td>
          <td />
          <td className="num">{o.qty ?? '—'}{o.perPiece != null && r.adet > 1 ? ` (${r.adet} × ${o.perPiece})` : ''}</td>
          <td />
          <td className="num">{money(o.unitPrice)}</td>
          <td className="num">{pct(o.discount)}</td>
          <td className="num">{money(o.netUnit)}</td>
          <td className="num">{money(o.amount)}</td>
        </tr>
      ))}
    </>
  );
}
