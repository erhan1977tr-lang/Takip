'use client';

import { useState } from 'react';

/**
 * Tahmini yükleme tarihi — Sipariş Bilgileri'nde satır içi düzenleme (Paket C — karar 230).
 * Düzenleme yalnızca işlem izinliyse (sunucu availableActions → set_ship_date) gösterilir; asıl kontrol (rol, Yüklendi /
 * Arşiv, onaylı yükleme kilidi, sipariş sürümü) sunucuda işlemin kendisinde yapılır. Kaydetmeden önce açık onay: eski → yeni.
 * Aynı gün seçilirse form gönderilmez.
 */
export function ShipDateEdit({
  orderId, version, current, currentText, editable, locked, action, labels,
}: {
  orderId: string; version: number; current: string; currentText: string; editable: boolean; locked: boolean;
  action: (formData: FormData) => void | Promise<void>;
  labels: { edit: string; save: string; cancel: string; confirm: string; none: string; locked: string; field: string };
}) {
  const [open, setOpen] = useState(false);
  const dmy = (iso: string) => (iso ? iso.split('-').reverse().join('.') : labels.none);
  if (!editable) {
    return (
      <span data-ship-date={current || ''} data-ship-locked={locked ? '1' : undefined}>
        {currentText}
        {locked && <span className="muted small" style={{ display: 'block' }}>{labels.locked}</span>}
      </span>
    );
  }
  if (!open) {
    return (
      <span className="row" style={{ gap: 6 }} data-ship-date={current || ''}>
        <span>{currentText}</span>
        <button type="button" className="btn btn-link" data-ship-edit onClick={() => setOpen(true)}>{labels.edit}</button>
      </span>
    );
  }
  return (
    <form
      action={action}
      className="row"
      style={{ gap: 6 }}
      data-ship-form
      onSubmit={(e) => {
        const input = e.currentTarget.elements.namedItem('date') as HTMLInputElement | null;
        const next = input?.value ?? '';
        if (!next || next === current) {
          e.preventDefault();
          if (next === current) setOpen(false);
          return;
        }
        if (!window.confirm(labels.confirm.replace('%FROM%', dmy(current)).replace('%TO%', dmy(next)))) e.preventDefault();
      }}
    >
      <input type="hidden" name="id" value={orderId} />
      <input type="hidden" name="v" value={version} />
      <input id="ship-date" name="date" type="date" aria-label={labels.field} defaultValue={current} style={{ width: 'auto' }} required />
      <button className="btn btn-primary" type="submit">{labels.save}</button>
      <button className="btn" type="button" onClick={() => setOpen(false)}>{labels.cancel}</button>
    </form>
  );
}
