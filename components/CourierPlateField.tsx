'use client';

import { useState } from 'react';

/**
 * Araç plakası alanı + "Kurye ile gönderim" onay kutusu (4.2.24, karar 324). Kutu işaretliyse plaka alanı kapanır ve
 * istenmez (kapalı alan forma gönderilmez); sunucu `courier=1` ile plakayı siler ve plaka şartı aramaz
 * (server/profile/rules.js → missingPickup, courierFlag). Karar sunucudadır; bu bileşen yalnızca formdur.
 */
export function CourierPlateField({ id, label, courierLabel, courierHint, placeholder, defaultPlate, defaultCourier, required, labelClassName }: {
  id: string; label: string; courierLabel: string; courierHint: string; placeholder?: string;
  defaultPlate?: string; defaultCourier?: boolean; required?: boolean; labelClassName?: string;
}) {
  const [courier, setCourier] = useState(!!defaultCourier);
  return (
    <>
      <label htmlFor={id} className={labelClassName}>{label}</label>
      <input id={id} name="plate" maxLength={60} placeholder={placeholder} defaultValue={defaultPlate ?? ''} style={{ textTransform: 'uppercase' }}
        required={!courier && required} disabled={courier} aria-disabled={courier} data-plate-input />
      <label className="check small" style={{ marginTop: 6 }}>
        <input type="checkbox" name="courier" value="1" checked={courier} onChange={(e) => setCourier(e.target.checked)} data-courier />
        {courierLabel}
      </label>
      {courier && <div className="hint" data-courier-hint>{courierHint}</div>}
    </>
  );
}
