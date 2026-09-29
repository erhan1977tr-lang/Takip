'use client';

import { useActionState, useState } from 'react';
import type { Dict } from '@/lib/i18n';
import { rich } from '@/lib/rich';
import { interpolate } from '@/server/i18n/interpolate.js';
import { createOrderAction, type NewOrderState } from './actions';

type Glass = { id: string; name: string };
const ACCEPT = '.pdf,.dwg,.dxf,.step,.stp,.igs,.iges,.xls,.xlsx,.doc,.docx,.zip,.jpg,.jpeg,.png';

/** m: sözlüğün newOrder.form parçası (sunucudaki sayfa, kullanıcının diline göre verir). */
export function NewOrderForm({ catalog, suggestedNo, prefix, shipDate, m }: { catalog: Glass[]; suggestedNo: number; prefix: string; shipDate: string; m: Dict['newOrder']['form'] }) {
  const [state, action, pending] = useActionState<NewOrderState, FormData>(createOrderAction, {});
  const v = state.values;
  const [rows, setRows] = useState<{ key: number; id: string; qty: string }[]>(
    () => (v?.glasses.length ? v.glasses : [{ id: '', qty: '1' }]).map((g, i) => ({ key: i, ...g }))
  );
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [no, setNo] = useState(v?.no ?? String(suggestedNo));
  const ready = fileNames.length > 0 && rows.some((r) => r.id);

  return (
    <form action={action}>
      <div className="card">
        <h2>{m.info.title}</h2>
        <p className="muted small">{rich(m.info.shipNote, { date: <b>{shipDate}</b> })}</p>
        <div className="grid-2" style={{ marginTop: 12 }}>
          <div>
            <label htmlFor="title">{m.info.name}</label>
            <input id="title" name="title" type="text" required maxLength={160} placeholder={m.info.namePlaceholder} defaultValue={v?.title} />
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
        <label htmlFor="files" className="dropzone">
          <input id="files" name="files" type="file" multiple accept={ACCEPT} required onChange={(e) => setFileNames(Array.from(e.target.files ?? []).map((f) => f.name))} />
          <b>{fileNames.length ? interpolate(m.files.selected, { n: fileNames.length }) : m.files.pick}</b>
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
              {catalog.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input name="glassQty" aria-label={m.glass.qty} type="number" min={1} step={1} value={r.qty} onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, qty: e.target.value } : x)))} />
            {rows.length > 1 && <button type="button" className="btn btn-link danger" aria-label={m.glass.remove} onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>✕</button>}
          </div>
        ))}
        <button type="button" className="btn" onClick={() => setRows([...rows, { key: Date.now(), id: '', qty: '1' }])}>{m.glass.add}</button>
      </div>

      {state.error && <div className="alert alert-error">{state.error}</div>}
      <div className="card row" style={{ justifyContent: 'space-between' }}>
        <span className="muted small">
          {!fileNames.length && <>{m.submit.needFile} </>}
          {!rows.some((r) => r.id) && m.submit.needGlass}
        </span>
        <button type="submit" className="btn btn-primary" disabled={pending || !ready}>{pending ? m.submit.sending : m.submit.send}</button>
      </div>
    </form>
  );
}
