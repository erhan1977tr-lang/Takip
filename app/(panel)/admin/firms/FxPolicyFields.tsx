'use client';

import { useState } from 'react';
import type { Dict } from '@/lib/i18n';

/** Müşterinin kur politikası alanları: yüzde yalnızca "BNR + %" seçilince görünür. Doğrulama sunucudadır (parseFxPolicy). */
export function FxPolicyFields({ policy, percent, max, m }: { policy: string; percent: string; max: number; m: Dict['fx'] }) {
  const [p, setP] = useState(policy);
  return (
    <div className="grid">
      <div>
        <label htmlFor="fxPolicy">{m.title}</label>
        <select id="fxPolicy" name="fxPolicy" value={p} onChange={(e) => setP(e.target.value)}>
          <option value="BT_UNIT_SELL">{m.policy.BT_UNIT_SELL}</option>
          <option value="BNR">{m.policy.BNR}</option>
          <option value="BNR_PLUS_PERCENT">{m.policy.BNR_PLUS_PERCENT}</option>
        </select>
        {p === 'BT_UNIT_SELL' && <div className="hint">{m.btAutoNote}</div>}
      </div>
      {p === 'BNR_PLUS_PERCENT' && (
        <div>
          <label htmlFor="fxMarkupPercent">{m.percent}</label>
          <input id="fxMarkupPercent" name="fxMarkupPercent" type="text" inputMode="decimal" maxLength={6} required defaultValue={percent} style={{ maxWidth: 160 }} />
          <div className="hint">{m.percentHint.replace('{max}', String(max))}</div>
        </div>
      )}
    </div>
  );
}
