'use client';

import { useMemo, useRef, useState } from 'react';
import { LINE_KIND, offerLineTotals, offerProblems, offerTotals } from '@/server/orders/rules.js';
import { saveOfferAction } from './actions';

type Line = { key: number; description: string; poz: string; enMm: string; boyMm: string; adet: string; unit: string; unitPrice: string; kind: string; free: boolean };

let seq = 1000;
const blankGlass = (): Line => ({ key: seq++, description: '', poz: '', enMm: '', boyMm: '', adet: '1', unit: 'm2', unitPrice: '', kind: 'CAM', free: false });
const blankSub = (kind: 'CNC' | 'DELIK'): Line => ({ key: seq++, description: '', poz: '', enMm: '', boyMm: '', adet: '1', unit: 'adet', unitPrice: '', kind, free: false });

const fmt = (n: number) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

export function OfferEditor(props: {
  orderId: string;
  /** sales: satış taslağı · admin: fiyat onayı · update: yönetici müşterideki teklifi günceller */
  mode: 'sales' | 'admin' | 'update';
  cancelHref?: string;
  currency: string;
  catalog: string[];
  initial: Omit<Line, 'key'>[];
  camEtiket: string;
  sandikEtiket: string;
  statusLabel: string;
}) {
  const [lines, setLines] = useState<Line[]>(() =>
    props.initial.length ? props.initial.map((l, i) => ({ key: i, ...l })) : [blankGlass()]
  );
  const totals = useMemo(() => offerTotals(lines), [lines]);
  const problems = useMemo(() => offerProblems(lines.filter((l) => l.kind !== 'CAM' || l.description || l.enMm || l.boyMm || l.unitPrice)), [lines]);
  const set = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  /** Cam satırının (ve varsa alt satırlarının) hemen altına CNC / delik satırı ekler. */
  const addSub = (key: number, kind: 'CNC' | 'DELIK') => setLines((ls) => {
    let i = ls.findIndex((l) => l.key === key) + 1;
    while (i < ls.length && ls[i].kind !== 'CAM') i++;
    return [...ls.slice(0, i), blankSub(kind), ...ls.slice(i)];
  });
  /** Cam satırı silinince altındaki CNC / delik satırları da silinir. */
  const remove = (key: number) => setLines((ls) => {
    const i = ls.findIndex((l) => l.key === key);
    let j = i + 1;
    if (ls[i].kind === 'CAM') while (j < ls.length && ls[j].kind !== 'CAM') j++;
    const next = [...ls.slice(0, i), ...ls.slice(j)];
    return next.length ? next : [blankGlass()];
  });
  let glassNo = 0;
  const isAdmin = props.mode === 'admin';
  const isUpdate = props.mode === 'update';
  // Hangi düğmeye basıldığı gizli alana yazılır (tarayıcıdan bağımsız, güvenilir yol).
  const intentRef = useRef<HTMLInputElement>(null);
  const intent = (v: string) => () => {
    if (intentRef.current) intentRef.current.value = v;
  };

  return (
    <form action={saveOfferAction} className="card" id="teklif">
      <input type="hidden" name="id" value={props.orderId} />
      <input type="hidden" name="intent" defaultValue={isUpdate ? 'update' : 'save'} ref={intentRef} />
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Teklif tablosu <span className="badge">{props.statusLabel}</span></h2>
        <span className="muted small">Metraj = en × boy × adet (m²). Tutar m² satırlarında metraj × fiyat, adet satırlarında adet × fiyat.</span>
      </div>

      {isUpdate && (
        <div className="alert alert-info" style={{ marginBottom: 14 }}>
          Müşterideki teklifi güncelliyorsunuz. Kaydettiğinizde yeni sürüm hemen müşterinin panelinde görünür; önceki sürüm kayıtlarda kalır.
        </div>
      )}
      {(isAdmin || isUpdate) && (
        <div className="grid-2" style={{ marginBottom: 14 }}>
          <div><label htmlFor="camEtiket">Cam etiketi</label><input id="camEtiket" name="camEtiket" type="text" defaultValue={props.camEtiket} /></div>
          <div><label htmlFor="sandikEtiket">Sandık etiketi</label><input id="sandikEtiket" name="sandikEtiket" type="text" defaultValue={props.sandikEtiket} /></div>
        </div>
      )}

      <datalist id="catalog">{props.catalog.map((c) => <option key={c} value={c} />)}</datalist>
      <div className="table-wrap">
        <table className="offer-table">
          <thead>
            <tr><th>#</th><th>Açıklama</th><th>Poz</th><th>En (mm)</th><th>Boy (mm)</th><th>Adet</th><th>Birim</th><th className="num">Metraj</th><th>Birim fiyat</th><th className="num">Tutar</th><th /></tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const t = offerLineTotals(l);
              const sub = l.kind !== 'CAM';
              if (!sub) glassNo += 1;
              const missing = !l.free && !(Number(l.unitPrice.replace(',', '.')) > 0) && (sub || !!(l.description || l.enMm || l.boyMm));
              return (
                <tr key={l.key} className={sub ? 'sub-line' : undefined}>
                  <td className="muted">{sub ? '' : glassNo}
                    <input type="hidden" name="l_kind" value={l.kind} />
                    <input type="hidden" name="l_free" value={l.free ? '1' : '0'} />
                  </td>
                  <td className="desc">
                    {sub && <span className="badge badge-info">{LINE_KIND[l.kind as keyof typeof LINE_KIND]}</span>}{' '}
                    {l.free && <span className="badge badge-ok">bedelsiz</span>}
                    <input name="l_desc" list={sub ? undefined : 'catalog'} value={l.description} placeholder={sub ? `${LINE_KIND[l.kind as keyof typeof LINE_KIND]} açıklaması (isteğe bağlı)` : undefined}
                      onChange={(e) => set(l.key, { description: e.target.value })} aria-label={sub ? `${LINE_KIND[l.kind as keyof typeof LINE_KIND]} açıklaması` : 'Açıklama'} />
                  </td>
                  <td><input name="l_poz" value={l.poz} onChange={(e) => set(l.key, { poz: e.target.value })} style={{ width: 64 }} aria-label="Poz" /></td>
                  {sub ? (
                    <><td><input type="hidden" name="l_en" value="" /></td><td><input type="hidden" name="l_boy" value="" /></td></>
                  ) : (
                    <>
                      <td><input name="l_en" inputMode="numeric" value={l.enMm} onChange={(e) => set(l.key, { enMm: e.target.value.replace(/\D/g, '') })} style={{ width: 72 }} aria-label="En" /></td>
                      <td><input name="l_boy" inputMode="numeric" value={l.boyMm} onChange={(e) => set(l.key, { boyMm: e.target.value.replace(/\D/g, '') })} style={{ width: 72 }} aria-label="Boy" /></td>
                    </>
                  )}
                  <td><input name="l_adet" inputMode="numeric" value={l.adet} onChange={(e) => set(l.key, { adet: e.target.value.replace(/\D/g, '') })} style={{ width: 58 }} aria-label={sub ? `${LINE_KIND[l.kind as keyof typeof LINE_KIND]} adedi` : 'Adet'} /></td>
                  <td>
                    {sub ? (
                      <><input type="hidden" name="l_unit" value="adet" /><span className="muted">adet</span></>
                    ) : (
                      <select name="l_unit" style={{ width: 78 }} value={l.unit} onChange={(e) => set(l.key, { unit: e.target.value })} aria-label="Birim">
                        <option value="m2">m²</option>
                        <option value="adet">adet</option>
                      </select>
                    )}
                  </td>
                  <td className="num">{sub ? '' : fmt(t.metraj)}</td>
                  <td>
                    <input name="l_price" inputMode="decimal" value={l.free ? '' : l.unitPrice} disabled={l.free} className={missing ? 'input-missing' : undefined}
                      onChange={(e) => set(l.key, { unitPrice: e.target.value.replace(/[^\d.,]/g, '') })} style={{ width: 92 }}
                      aria-label={sub ? `${LINE_KIND[l.kind as keyof typeof LINE_KIND]} fiyatı` : 'Birim fiyat'} />
                    {l.free && <input type="hidden" name="l_price" value="0" />}
                  </td>
                  <td className="num">{fmt(t.amount)}</td>
                  <td>
                    <div className="line-actions">
                      <button type="button" className="btn btn-link" onClick={() => set(l.key, { free: !l.free })}>{l.free ? 'ücretli yap' : 'bedelsiz'}</button>
                      {!sub && <button type="button" className="btn btn-link" onClick={() => addSub(l.key, 'CNC')}>+CNC</button>}
                      {!sub && <button type="button" className="btn btn-link" onClick={() => addSub(l.key, 'DELIK')}>+Delik</button>}
                      <button type="button" className="btn btn-link danger" aria-label="Satırı sil" onClick={() => remove(l.key)}>✕</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5}>Toplam</td>
              <td>{totals.adet} cam{totals.cnc ? ` · ${totals.cnc} CNC` : ''}{totals.delik ? ` · ${totals.delik} delik` : ''}</td>
              <td />
              <td className="num">{fmt(totals.metraj)} m²</td>
              <td />
              <td className="num">{fmt(totals.amount)} {props.currency}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <button type="button" className="btn" style={{ marginTop: 10 }} onClick={() => setLines([...lines, blankGlass()])}>+ Cam ekle</button>

      {problems.length > 0 && (
        <div className="alert alert-warn" style={{ marginTop: 12 }}>
          <b>Teklif bu haliyle gönderilemez.</b>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          <span className="small">Taslak olarak kaydedebilirsiniz.</span>
        </div>
      )}

      {isAdmin && (
        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="returnNote">Satışa geri gönderirken not (yalnızca geri gönderirken gerekli)</label>
          <input id="returnNote" name="returnNote" type="text" placeholder="örn. 3. satırın fiyatını kontrol edin" />
        </div>
      )}
      {isUpdate && (
        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="updateNote">Güncelleme notu (müşteri görmez)</label>
          <input id="updateNote" name="updateNote" type="text" placeholder="örn. v2 çizime göre ölçüler güncellendi" />
        </div>
      )}
      <div className="row end" style={{ marginTop: 14 }}>
        {isUpdate ? (
          <>
            <a href={props.cancelHref ?? '#'} className="btn">Vazgeç</a>
            <button type="submit" onClick={intent('update')} className="btn btn-primary" disabled={problems.length > 0}>Teklifi güncelle ve müşteriye gönder</button>
          </>
        ) : (
          <button type="submit" onClick={intent('save')} className="btn">Taslak olarak kaydet</button>
        )}
        {isUpdate ? null : isAdmin ? (
          <>
            <button type="submit" onClick={intent('return')} className="btn btn-danger">Satışa geri gönder</button>
            <button type="submit" onClick={intent('approve')} className="btn btn-primary" disabled={problems.length > 0}>Fiyatı onayla ve müşteriye gönder</button>
          </>
        ) : (
          <button type="submit" onClick={intent('submit')} className="btn btn-primary" disabled={problems.length > 0}>Teklifi yöneticiye gönder</button>
        )}
      </div>
      <p className="muted small" style={{ marginTop: 8 }}>
        {isUpdate
          ? 'Teklif müşteriye gönderildikten sonra yalnızca sistem yöneticisi değiştirebilir.'
          : isAdmin
            ? 'Onayladığınızda teklif müşterinin panelinde görünür.'
            : 'Teklif doğrudan müşteriye gitmez; önce sistem yöneticisinin onayına düşer. Gönderdikten sonra değişikliği yalnızca yönetici yapabilir.'}
      </p>
    </form>
  );
}
