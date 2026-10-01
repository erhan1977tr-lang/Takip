'use client';

import { useActionState, useState } from 'react';
import type { Dict } from '@/lib/i18n';
import { rich } from '@/lib/rich';
import { interpolate } from '@/server/i18n/interpolate.js';
import { createOrderAction, type NewOrderState } from './actions';

/** Katalogdaki cam, kullanıcının dilinde: group = cam adı, label = ad — renk */
export type GlassOption = { id: string; group: string; label: string };
export type DraftData = {
  id: string; title: string; no: string | null; note: string;
  lines: { id: string; qty: string }[]; files: { id: string; name: string; size: number; pending: boolean }[];
};
const ACCEPT = '.pdf,.dwg,.dxf,.step,.stp,.igs,.iges,.xls,.xlsx,.doc,.docx,.zip,.jpg,.jpeg,.png';
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 1024 * 1024 ? 2 : 1)} MB`;

/** m: sözlüğün newOrder.form parçası (sunucudaki sayfa, kullanıcının diline göre verir). */
export function NewOrderForm({ catalog, suggestedNo, prefix, shipDate, draft, m }: {
  catalog: GlassOption[]; suggestedNo: number; prefix: string; shipDate: string; draft?: DraftData; m: Dict['newOrder']['form'];
}) {
  const [state, action, pending] = useActionState<NewOrderState, FormData>(createOrderAction, {});
  const v = state.values;
  const [rows, setRows] = useState<{ key: number; id: string; qty: string }[]>(() => {
    // Siparişte tek cam tipi (müşteri ikinci cam ekleyemez); eski taslakta birden çok cam varsa ilki gelir
    const src = v?.glasses.length ? v.glasses : draft?.lines.length ? draft.lines : [{ id: '', qty: '1' }];
    return src.slice(0, 1).map((g, i) => ({ key: i, ...g }));
  });
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [removed, setRemoved] = useState<string[]>(v?.removed ?? []);
  const [no, setNo] = useState(v?.no ?? draft?.no ?? String(suggestedNo));
  const [title, setTitle] = useState(v?.title ?? draft?.title ?? '');
  const kept = (draft?.files ?? []).filter((f) => !removed.includes(f.id));
  const hasFile = fileNames.length + kept.length > 0;
  const hasGlass = rows.some((r) => r.id);
  const ready = hasFile && hasGlass && !!title.trim();
  const groups = [...new Set(catalog.map((c) => c.group))];

  return (
    <form action={action}>
      {draft && <input type="hidden" name="draftId" value={draft.id} />}
      <div className="card">
        <h2>{m.info.title}</h2>
        <p className="muted small">{rich(m.info.shipNote, { date: <b>{shipDate}</b> })}</p>
        <div className="grid-2" style={{ marginTop: 12 }}>
          <div>
            <label htmlFor="title">{m.info.name}</label>
            <input id="title" name="title" type="text" required maxLength={160} placeholder={m.info.namePlaceholder} value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label htmlFor="no">{m.info.number}</label>
            <input id="no" name="customerOrderNo" type="text" inputMode="numeric" required value={no} onChange={(e) => setNo(e.target.value.replace(/\D/g, ''))} />
            {/* Önerilen numara değiştirilmediyse ve bu arada başka sipariş aldıysa sunucu bir sonraki numarayı verir */}
            <input type="hidden" name="suggestedNo" value={suggestedNo} />
            <div className="hint">{rich(m.info.numberHint, { code: <b>{prefix}{no || '…'}</b> })}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>{m.files.title}</h2>
        {draft && draft.files.length > 0 && (
          <ul className="file-list">
            {draft.files.map((f) => {
              const off = removed.includes(f.id);
              return (
                <li key={f.id} className="row" style={off ? { opacity: 0.5, textDecoration: 'line-through' } : undefined}>
                  <span className="mono small">{f.name}</span>
                  <span className="muted small">{mb(f.size)}</span>
                  {f.pending && <span className="badge badge-warn" title={m.files.scanPending}>{m.files.scanPending}</span>}
                  <label className="small row">
                    <input type="checkbox" name="removeFile" value={f.id} checked={off}
                      onChange={(e) => setRemoved(e.target.checked ? [...removed, f.id] : removed.filter((x) => x !== f.id))} />
                    {m.files.remove}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <label htmlFor="files" className="dropzone">
          <input id="files" name="files" type="file" multiple accept={ACCEPT} required={kept.length === 0} onChange={(e) => setFileNames(Array.from(e.target.files ?? []).map((f) => f.name))} />
          <b>{fileNames.length ? interpolate(m.files.selected, { n: fileNames.length }) : kept.length ? m.files.pickMore : m.files.pick}</b>
          <span className="muted small">{m.files.limits}</span>
          {fileNames.length > 0 && <span className="small mono">{fileNames.join(', ')}</span>}
        </label>
      </div>

      <div className="card">
        <h2>{m.glass.title}</h2>
        <p className="muted small">{m.glass.intro}</p>
        {catalog.length === 0 && <div className="alert alert-warn">{m.glass.catalogEmpty}</div>}
        {rows.map((r) => (
          <div className="glass-row" key={r.key}>
            <select name="glassId" aria-label={m.glass.glass} value={r.id} required onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, id: e.target.value } : x)))}>
              <option value="">{m.glass.pick}</option>
              {groups.map((g) => (
                <optgroup key={g} label={g}>
                  {catalog.filter((c) => c.group === g).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </optgroup>
              ))}
            </select>
            <input name="glassQty" aria-label={m.glass.qty} type="number" min={1} max={9999} step={1} value={r.qty} onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, qty: e.target.value } : x)))} />
          </div>
        ))}
      </div>

      <div className="card">
        <h2><label htmlFor="note">{m.note.title}</label></h2>
        <p className="muted small">{m.note.intro}</p>
        <textarea id="note" name="note" rows={3} maxLength={2000} defaultValue={v?.note ?? draft?.note ?? ''} placeholder={m.note.placeholder} />
      </div>

      {state.error && <div className="alert alert-error" role="alert">{state.error}</div>}
      <div className="card row" style={{ justifyContent: 'space-between' }}>
        <span className="muted small">
          {!title.trim() && <>{m.submit.needTitle} </>}
          {!hasFile && <>{m.submit.needFile} </>}
          {!hasGlass && m.submit.needGlass}
        </span>
        <div className="row">
          {/* Taslak: zorunlu alanlar boş olabilir (tarayıcı kontrolü atlanır; sunucu gevşek kurallarla kaydeder) */}
          <button type="submit" name="intent" value="draft" className="btn" formNoValidate disabled={pending}>{m.submit.draft}</button>
          <button type="submit" name="intent" value="submit" className="btn btn-primary" disabled={pending || !ready}>{pending ? m.submit.sending : m.submit.send}</button>
        </div>
      </div>
    </form>
  );
}
