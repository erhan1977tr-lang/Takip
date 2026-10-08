'use client';

import { useState, useTransition } from 'react';
import type { Dict } from '@/lib/i18n';
import { interpolate } from '@/server/i18n/interpolate.js';
import { applyCalc } from '@/server/profile/calculator.js';
import { calculateProfileAction, type CalcLine, type CalcResult } from './profile-calc-actions';

/** Hesaplayıcının seçenekleri (sayfa yükler; etkin sistemler ve cam kalınlıkları, kullanıcının dilinde) */
export type CalcOptions = {
  systems: { id: string; label: string; needsColor: boolean; needsThickness: boolean }[];
  thicknesses: { id: string; label: string }[];
};

/**
 * Metraj hesaplayıcısı (Paket 5, karar 175): profil siparişi formunun üstünde yatay, kompakt alan. Hesap sunucuda yapılır
 * (calculateProfileAction); "Forma aktar" yalnızca sonuçtaki ürünlerin adedini değiştirir. Formda daha önce girilmiş ve
 * farklı bir adet varsa ÖNCE hangi ürünlerin üzerine yazılacağı gösterilir; müşteri onaylamadan hiçbir şey değişmez.
 * Bu alanın girişleri forma ait değildir (name yok): sipariş yalnızca formdaki adetlerle gönderilir.
 */
export function ProfileCalculator({ options, m, qty, names, onTransfer }: {
  options: CalcOptions;
  m: Dict['profile']['calc'];
  qty: Record<string, string>;
  /** ürün id → formdaki ad (üzerine yazma listesi için) */
  names: Record<string, string>;
  onTransfer: (next: Record<string, string>, lines: CalcLine[]) => void;
}) {
  const [systemId, setSystemId] = useState('');
  const [color, setColor] = useState('');
  const [thicknessId, setThicknessId] = useState('');
  const [meters, setMeters] = useState('');
  const [result, setResult] = useState<CalcResult | null>(null);
  const [confirm, setConfirm] = useState<{ productId: string; from: string; to: string }[] | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();
  const sys = options.systems.find((s) => s.id === systemId);

  const calculate = () => {
    if (!systemId || pending) return;
    start(async () => {
      let r: CalcResult;
      try {
        r = await calculateProfileAction({ systemId, color, thicknessId, meters });
      } catch {
        r = { ok: false, errors: [m.unavailable] };
      }
      setResult(r);
      setConfirm(null);
      setDone(false);
    });
  };
  const transfer = (force: boolean) => {
    if (!result?.ok) return;
    const { next, overwrites } = applyCalc(qty, result.lines);
    if (overwrites.length && !force) { setConfirm(overwrites); return; }
    onTransfer(next, result.lines);
    setConfirm(null);
    setDone(true);
  };
  // Bir seçim değişince eski sonuç ve mesajlar kalkar (yanlış sonuç aktarılmasın)
  const reset = () => { setResult(null); setConfirm(null); setDone(false); };

  return (
    <div className="card calc-card" id="hesaplayici">
      <h2>{m.title}</h2>
      <p className="muted small">{m.intro}</p>
      <div className="calc-bar">
        <div className="calc-field calc-system">
          <label htmlFor="calc-system">{m.system}</label>
          <select id="calc-system" value={systemId} onChange={(e) => { setSystemId(e.target.value); reset(); }}>
            <option value="">{m.pickSystem}</option>
            {options.systems.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
        <div className="calc-field">
          <label htmlFor="calc-color">{m.color}</label>
          <select id="calc-color" value={sys && !sys.needsColor ? '' : color} disabled={!!sys && !sys.needsColor} onChange={(e) => { setColor(e.target.value); reset(); }}>
            <option value="">{sys && !sys.needsColor ? m.notNeeded : m.pickColor}</option>
            {(['RAL7016', 'ELOXAT'] as const).map((c) => <option key={c} value={c}>{m.colors[c]}</option>)}
          </select>
        </div>
        <div className="calc-field">
          <label htmlFor="calc-thickness">{m.thickness}</label>
          <select id="calc-thickness" value={sys && !sys.needsThickness ? '' : thicknessId} disabled={!!sys && !sys.needsThickness} onChange={(e) => { setThicknessId(e.target.value); reset(); }}>
            <option value="">{sys && !sys.needsThickness ? m.notNeeded : m.pickThickness}</option>
            {options.thicknesses.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        <div className="calc-field calc-meters">
          <label htmlFor="calc-meters">{m.meters}</label>
          <input
            id="calc-meters" type="text" inputMode="decimal" autoComplete="off" maxLength={12} placeholder={m.metersPlaceholder} value={meters}
            onChange={(e) => { setMeters(e.target.value); reset(); }}
            // Enter formu (taslak / gönder) göndermez; hesaplar
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); calculate(); } }}
          />
        </div>
        <button type="button" className="btn btn-primary" onClick={calculate} disabled={pending || !systemId}>{pending ? m.calculating : m.calculate}</button>
      </div>

      {result && !result.ok && (
        <div className="alert alert-error" role="alert" data-calc-errors>
          <b>{m.failed}</b>
          <ul className="plain-list">{result.errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}
      {result?.ok && (
        <div className="calc-result" data-calc-result>
          <h3 className="sub-title">{result.title}</h3>
          <div className="table-wrap">
            <table className="profile-table calc-table">
              <thead><tr><th>{m.colProduct}</th><th>{m.colNeed}</th><th className="num">{m.colQty}</th></tr></thead>
              <tbody>
                {result.lines.map((l) => (
                  <tr key={l.productId} data-calc-row={l.code}>
                    <td>
                      <b>{l.name}</b><div className="muted small mono">{l.code}</div>
                      {l.stock && <div className="small text-danger" data-calc-stock>{interpolate(m.stockShort, l.stock)}</div>}
                    </td>
                    <td className="small">{l.need}</td>
                    <td className="num nowrap"><b data-calc-qty>{l.qty}</b> <span className="muted">{l.unit}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {confirm ? (
            <div className="alert alert-warn" role="alert" data-calc-confirm>
              <b>{m.overwriteTitle}</b>
              <p className="small">{m.overwriteText}</p>
              <ul className="plain-list">
                {confirm.map((o) => <li key={o.productId}>{interpolate(m.overwriteLine, { product: names[o.productId] ?? '', from: o.from, to: o.to })}</li>)}
              </ul>
              <div className="row">
                <button type="button" className="btn btn-primary" onClick={() => transfer(true)}>{m.overwriteConfirm}</button>
                <button type="button" className="btn" onClick={() => setConfirm(null)}>{m.cancel}</button>
              </div>
            </div>
          ) : (
            <div className="row">
              <button type="button" className="btn btn-primary" onClick={() => transfer(false)}>{m.apply}</button>
              <button type="button" className="btn btn-link" onClick={reset}>{m.clear}</button>
            </div>
          )}
        </div>
      )}
      {done && <div className="alert alert-ok" role="status" data-calc-applied>{m.applied}</div>}
    </div>
  );
}
