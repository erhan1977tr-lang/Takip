'use client';

import { useMemo, useRef, useState } from 'react';
import { offerLineTotals, offerTotals } from '@/server/orders/rules.js';
import { saveOfferAction } from './actions';

type Line = { key: number; description: string; poz: string; enMm: string; boyMm: string; adet: string; unit: string; unitPrice: string };

const fmt = (n: number) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

export function OfferEditor(props: {
  orderId: string;
  mode: 'sales' | 'admin';
  currency: string;
  catalog: string[];
  initial: Omit<Line, 'key'>[];
  camEtiket: string;
  sandikEtiket: string;
  statusLabel: string;
}) {
  const [lines, setLines] = useState<Line[]>(() =>
    (props.initial.length ? props.initial : [{ description: '', poz: '', enMm: '', boyMm: '', adet: '1', unit: 'm2', unitPrice: '' }]).map((l, i) => ({ key: i, ...l }))
  );
  const totals = useMemo(() => offerTotals(lines), [lines]);
  const set = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const isAdmin = props.mode === 'admin';
  // Hangi düğmeye basıldığı gizli alana yazılır (tarayıcıdan bağımsız, güvenilir yol).
  const intentRef = useRef<HTMLInputElement>(null);
  const intent = (v: string) => () => {
    if (intentRef.current) intentRef.current.value = v;
  };

  return (
    <form action={saveOfferAction} className="card" id="teklif">
      <input type="hidden" name="id" value={props.orderId} />
      <input type="hidden" name="intent" defaultValue="save" ref={intentRef} />
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Teklif tablosu <span className="badge">{props.statusLabel}</span></h2>
        <span className="muted small">Metraj = en × boy × adet (m²). Tutar m² satırlarında metraj × fiyat, adet satırlarında adet × fiyat.</span>
      </div>

      {isAdmin && (
        <div className="grid-2" style={{ marginBottom: 14 }}>
          <div><label htmlFor="camEtiket">Cam etiketi</label><input id="camEtiket" name="camEtiket" type="text" defaultValue={props.camEtiket} /></div>
          <div><label htmlFor="sandikEtiket">Sandık etiketi</label><input id="sandikEtiket" name="sandikEtiket" type="text" defaultValue={props.sandikEtiket} /></div>
        </div>
      )}

      <datalist id="catalog">{props.catalog.map((c) => <option key={c} value={c} />)}</datalist>
      <div className="table-wrap">
        <table className="offer-table">
          <thead>
            <tr><th>#</th><th style={{ minWidth: 200 }}>Açıklama</th><th>Poz</th><th>En (mm)</th><th>Boy (mm)</th><th>Adet</th><th>Birim</th><th className="num">Metraj</th><th>Birim fiyat</th><th className="num">Tutar</th><th /></tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const t = offerLineTotals(l);
              return (
                <tr key={l.key}>
                  <td className="muted">{i + 1}</td>
                  <td><input name="l_desc" list="catalog" value={l.description} onChange={(e) => set(l.key, { description: e.target.value })} aria-label="Açıklama" /></td>
                  <td><input name="l_poz" value={l.poz} onChange={(e) => set(l.key, { poz: e.target.value })} style={{ width: 70 }} aria-label="Poz" /></td>
                  <td><input name="l_en" inputMode="numeric" value={l.enMm} onChange={(e) => set(l.key, { enMm: e.target.value.replace(/\D/g, '') })} style={{ width: 80 }} aria-label="En" /></td>
                  <td><input name="l_boy" inputMode="numeric" value={l.boyMm} onChange={(e) => set(l.key, { boyMm: e.target.value.replace(/\D/g, '') })} style={{ width: 80 }} aria-label="Boy" /></td>
                  <td><input name="l_adet" inputMode="numeric" value={l.adet} onChange={(e) => set(l.key, { adet: e.target.value.replace(/\D/g, '') })} style={{ width: 60 }} aria-label="Adet" /></td>
                  <td>
                    <select name="l_unit" value={l.unit} onChange={(e) => set(l.key, { unit: e.target.value })} aria-label="Birim">
                      <option value="m2">m²</option>
                      <option value="adet">adet</option>
                    </select>
                  </td>
                  <td className="num">{fmt(t.metraj)}</td>
                  <td><input name="l_price" inputMode="decimal" value={l.unitPrice} onChange={(e) => set(l.key, { unitPrice: e.target.value.replace(/[^\d.,]/g, '') })} style={{ width: 90 }} aria-label="Birim fiyat" /></td>
                  <td className="num">{fmt(t.amount)}</td>
                  <td>{lines.length > 1 && <button type="button" className="btn btn-link danger" aria-label="Satırı sil" onClick={() => setLines(lines.filter((x) => x.key !== l.key))}>✕</button>}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5}>Toplam</td>
              <td>{totals.adet}</td>
              <td />
              <td className="num">{fmt(totals.metraj)} m²</td>
              <td />
              <td className="num">{fmt(totals.amount)} {props.currency}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <button type="button" className="btn" style={{ marginTop: 10 }} onClick={() => setLines([...lines, { key: Date.now(), description: '', poz: '', enMm: '', boyMm: '', adet: '1', unit: 'm2', unitPrice: '' }])}>+ Satır ekle</button>

      {isAdmin && (
        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="returnNote">Satışa geri gönderirken not (yalnızca geri gönderirken gerekli)</label>
          <input id="returnNote" name="returnNote" type="text" placeholder="örn. 3. satırın fiyatını kontrol edin" />
        </div>
      )}
      <div className="row end" style={{ marginTop: 14 }}>
        <button type="submit" onClick={intent('save')} className="btn">Taslak olarak kaydet</button>
        {isAdmin ? (
          <>
            <button type="submit" onClick={intent('return')} className="btn btn-danger">Satışa geri gönder</button>
            <button type="submit" onClick={intent('approve')} className="btn btn-primary">Fiyatı onayla ve müşteriye gönder</button>
          </>
        ) : (
          <button type="submit" onClick={intent('submit')} className="btn btn-primary">Teklifi yöneticiye gönder</button>
        )}
      </div>
      <p className="muted small" style={{ marginTop: 8 }}>
        {isAdmin ? 'Onayladığınızda teklif müşterinin panelinde görünür.' : 'Teklif doğrudan müşteriye gitmez; önce sistem yöneticisinin onayına düşer.'}
      </p>
    </form>
  );
}
