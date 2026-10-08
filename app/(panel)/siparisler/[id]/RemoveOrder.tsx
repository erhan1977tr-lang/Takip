'use client';

import { useState } from 'react';
import type { Dict } from '@/lib/i18n';
import { interpolate } from '@/server/i18n/interpolate.js';
import { removeOrderAction } from './compensation-actions';

/** Silme önizlemesi (sunucuda hesaplanır — server/orders/removal.js → removalPreview; nedenler sabit metne çevrilmiş) */
export type RemovalPreview = {
  orderNo: string;
  title: string | null;
  version: number;
  busy: boolean;
  reasons: string[];
  kept: { offers: number; drawings: number; files: number; notes: number };
};

const norm = (s: string) => s.trim().toLocaleUpperCase('tr-TR');

/**
 * "Siparişi sil" (yalnızca yönetici; karar 110, iki aşamalı onay — fonksiyonel paket 4):
 *   1. adım — silinecek sipariş numarası ve işlemin sonucu (ya da silmeyi engelleyen nedenler); "Devam et" / "Vazgeç"
 *   2. adım — ayrı son onay: yönetici sipariş numarasını yazar; numara eşleşmeden kırmızı düğme çalışmaz; "Vazgeç"
 * Asıl denetim sunucuda: yetki, yazılan numara, önizlemedeki sürüm, kuyruk ve mali / operasyonel geçmiş (removeOrder).
 * Kayıtlar silinmez (yumuşak silme); silinen sipariş "Silinen siparişler"den geri yüklenir.
 */
export function RemoveOrder({ orderId, preview, error, m }: { orderId: string; preview: RemovalPreview; error: string | null; m: Dict['compensation']['remove'] }) {
  const [step, setStep] = useState<0 | 1 | 2>(error ? 1 : 0);
  const [typed, setTyped] = useState('');
  const blocked = preview.busy || preview.reasons.length > 0;
  // Önizleme bu arada engellendiyse (ör. belge kesildi — sayfa yenilenince bileşen durumu korunur) son onay gösterilmez:
  // 1. adım nedenleri gösterir
  const shown = step === 2 && blocked ? 1 : step;
  const match = norm(typed) !== '' && norm(typed) === norm(preview.orderNo);
  const cancel = () => {
    setStep(0);
    setTyped('');
  };
  return (
    <div className="card remove-order" id="sil" data-step={shown}>
      {shown === 0 ? (
        <button type="button" className="btn btn-danger" onClick={() => setStep(1)}>{m.summary}</button>
      ) : (
        <>
          <h2>{m.title}</h2>
          {error && <div className="alert alert-error">{error}</div>}
          {shown === 1 && (
            <div data-remove-step="1">
              <h3 className="sub-title">{m.step1}</h3>
              <p className="remove-target">
                <b>{interpolate(m.target, { order: preview.orderNo })}</b>
                {preview.title && <span className="muted"> · {preview.title}</span>}
              </p>
              {blocked ? (
                <div className="alert alert-error" data-remove-blocked>
                  <b>{m.blockedTitle}</b> {preview.busy ? m.errors.BUSY : m.blockedText}
                  {preview.reasons.length > 0 && (
                    <ul className="plain-list" style={{ marginTop: 6 }}>{preview.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
                  )}
                </div>
              ) : (
                <>
                  <p>{m.intro}</p>
                  <p>{m.kept}</p>
                  <p className="muted small">{interpolate(m.keptCounts, preview.kept)}</p>
                  <p className="muted small">{m.restoreHint}</p>
                </>
              )}
              <div className="row" style={{ marginTop: 12 }}>
                {!blocked && <button type="button" className="btn btn-danger" onClick={() => setStep(2)}>{m.continue}</button>}
                <button type="button" className="btn" onClick={cancel}>{m.cancel}</button>
              </div>
            </div>
          )}
          {shown === 2 && (
            <form action={removeOrderAction} data-remove-step="2">
              <h3 className="sub-title">{m.step2}</h3>
              <input type="hidden" name="id" value={orderId} />
              <input type="hidden" name="v" value={preview.version} />
              <label htmlFor="sil-no">{interpolate(m.confirm, { order: preview.orderNo })}</label>
              <input id="sil-no" name="confirmNo" type="text" autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn btn-danger-solid" disabled={!match}>{m.submit}</button>
                <button type="button" className="btn" onClick={cancel}>{m.cancel}</button>
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}
