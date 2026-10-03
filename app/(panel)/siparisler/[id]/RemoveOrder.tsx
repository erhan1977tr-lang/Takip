'use client';

import { useState } from 'react';
import type { Dict } from '@/lib/i18n';
import { interpolate } from '@/server/i18n/interpolate.js';
import { removeOrderAction } from './compensation-actions';

/**
 * "Siparişi sil" (yalnızca yönetici; karar 110) — iki adım: 1) bölüm açılır, sonuçlar gösterilir; 2) onay kutusu
 * işaretlenince kırmızı düğme etkinleşir. Sunucu da onay kutusu olmadan silmez. Kayıtlar silinmez (yumuşak silme).
 */
export function RemoveOrder({ orderId, docs, error, m }: { orderId: string; docs: number; error: string | null; m: Dict['compensation']['remove'] }) {
  const [open, setOpen] = useState(!!error);
  const [sure, setSure] = useState(false);
  return (
    <div className="card remove-order" id="sil">
      {!open ? (
        <button type="button" className="btn btn-danger" onClick={() => setOpen(true)}>{m.summary}</button>
      ) : (
        <>
          <h2>{m.title}</h2>
          {error && <div className="alert alert-error">{error}</div>}
          <p>{m.intro}</p>
          <p>{m.kept}</p>
          {docs > 0 && <div className="alert alert-warn">{interpolate(m.hasDocs, { n: docs })}</div>}
          <p className="muted small">{m.restoreHint}</p>
          <form action={removeOrderAction}>
            <input type="hidden" name="id" value={orderId} />
            <label className="check">
              <input type="checkbox" name="confirm" checked={sure} onChange={(e) => setSure(e.target.checked)} /> {m.confirm}
            </label>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn btn-danger-solid" disabled={!sure}>{m.submit}</button>
              <button type="button" className="btn" onClick={() => { setOpen(false); setSure(false); }}>{m.cancel}</button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
