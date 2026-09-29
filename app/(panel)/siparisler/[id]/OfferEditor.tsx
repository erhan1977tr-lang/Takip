'use client';

import { useMemo, useRef, useState } from 'react';
import type { Dict } from '@/lib/i18n';
import { formatOfferProblems } from '@/server/i18n/format.js';
import { interpolate } from '@/server/i18n/interpolate.js';
import { offerLineTotals, offerProblems, offerTotals } from '@/server/orders/rules.js';
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
  /** Sözlük parçaları (istemciye sözlüğün yalnızca gereken kısmı gider) */
  m: Dict['offer'];
  common: Dict['common'];
  problemsMsg: Dict['offerProblems'];
  lineKind: Dict['status']['lineKind'];
}) {
  const { m, common, lineKind } = props;
  const [lines, setLines] = useState<Line[]>(() =>
    props.initial.length ? props.initial.map((l, i) => ({ key: i, ...l })) : [blankGlass()]
  );
  const totals = useMemo(() => offerTotals(lines), [lines]);
  const problems = useMemo(() => offerProblems(lines.filter((l) => l.kind !== 'CAM' || l.description || l.enMm || l.boyMm || l.unitPrice)), [lines]);
  const problemTexts = useMemo(
    () => formatOfferProblems(problems, { offerProblems: props.problemsMsg, lineKind }),
    [problems, props.problemsMsg, lineKind]
  );
  /** Satır türünün adı: "CNC" / "Delik" (dile göre) */
  const kindName = (kind: string) => lineKind[kind as keyof typeof lineKind] ?? kind;
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
        <h2 style={{ margin: 0 }}>{m.editor.title} <span className="badge">{props.statusLabel}</span></h2>
        <span className="muted small">{m.editor.formula}</span>
      </div>

      {isUpdate && (
        <div className="alert alert-info" style={{ marginBottom: 14 }}>
          {m.editor.updateInfo}
        </div>
      )}
      {(isAdmin || isUpdate) && (
        <div className="grid-2" style={{ marginBottom: 14 }}>
          <div><label htmlFor="camEtiket">{m.editor.glassLabel}</label><input id="camEtiket" name="camEtiket" type="text" defaultValue={props.camEtiket} /></div>
          <div><label htmlFor="sandikEtiket">{m.editor.crateLabel}</label><input id="sandikEtiket" name="sandikEtiket" type="text" defaultValue={props.sandikEtiket} /></div>
        </div>
      )}

      <datalist id="catalog">{props.catalog.map((c) => <option key={c} value={c} />)}</datalist>
      <div className="table-wrap">
        <table className="offer-table">
          <thead>
            <tr><th>#</th><th>{m.cols.description}</th><th>{m.cols.poz}</th><th>{m.cols.widthMm}</th><th>{m.cols.heightMm}</th><th>{m.cols.qty}</th><th>{m.cols.unit}</th><th className="num">{m.cols.metraj}</th><th>{m.cols.unitPrice}</th><th className="num">{m.cols.amount}</th><th /></tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const tot = offerLineTotals(l);
              const sub = l.kind !== 'CAM';
              if (!sub) glassNo += 1;
              const kind = kindName(l.kind);
              const missing = !l.free && !(Number(l.unitPrice.replace(',', '.')) > 0) && (sub || !!(l.description || l.enMm || l.boyMm));
              return (
                <tr key={l.key} className={sub ? 'sub-line' : undefined}>
                  <td className="muted">{sub ? '' : glassNo}
                    <input type="hidden" name="l_kind" value={l.kind} />
                    <input type="hidden" name="l_free" value={l.free ? '1' : '0'} />
                  </td>
                  <td className="desc">
                    {sub && <span className="badge badge-info">{kind}</span>}{' '}
                    {l.free && <span className="badge badge-ok">{m.free}</span>}
                    <input name="l_desc" list={sub ? undefined : 'catalog'} value={l.description} placeholder={sub ? interpolate(m.editor.subDescPlaceholder, { kind }) : undefined}
                      onChange={(e) => set(l.key, { description: e.target.value })} aria-label={sub ? interpolate(m.editor.subDescAria, { kind }) : m.cols.description} />
                  </td>
                  <td><input name="l_poz" value={l.poz} onChange={(e) => set(l.key, { poz: e.target.value })} style={{ width: 64 }} aria-label={m.cols.poz} /></td>
                  {sub ? (
                    <><td><input type="hidden" name="l_en" value="" /></td><td><input type="hidden" name="l_boy" value="" /></td></>
                  ) : (
                    <>
                      <td><input name="l_en" inputMode="numeric" value={l.enMm} onChange={(e) => set(l.key, { enMm: e.target.value.replace(/\D/g, '') })} style={{ width: 72 }} aria-label={m.cols.width} /></td>
                      <td><input name="l_boy" inputMode="numeric" value={l.boyMm} onChange={(e) => set(l.key, { boyMm: e.target.value.replace(/\D/g, '') })} style={{ width: 72 }} aria-label={m.cols.height} /></td>
                    </>
                  )}
                  <td><input name="l_adet" inputMode="numeric" value={l.adet} onChange={(e) => set(l.key, { adet: e.target.value.replace(/\D/g, '') })} style={{ width: 58 }} aria-label={sub ? interpolate(m.editor.subQtyAria, { kind }) : m.cols.qty} /></td>
                  <td>
                    {sub ? (
                      <><input type="hidden" name="l_unit" value="adet" /><span className="muted">{common.unitPiece}</span></>
                    ) : (
                      <select name="l_unit" style={{ width: 78 }} value={l.unit} onChange={(e) => set(l.key, { unit: e.target.value })} aria-label={m.cols.unit}>
                        <option value="m2">m²</option>
                        <option value="adet">{common.unitPiece}</option>
                      </select>
                    )}
                  </td>
                  <td className="num">{sub ? '' : fmt(tot.metraj)}</td>
                  <td>
                    <input name="l_price" inputMode="decimal" value={l.free ? '' : l.unitPrice} disabled={l.free} className={missing ? 'input-missing' : undefined}
                      onChange={(e) => set(l.key, { unitPrice: e.target.value.replace(/[^\d.,]/g, '') })} style={{ width: 92 }}
                      aria-label={sub ? interpolate(m.editor.subPriceAria, { kind }) : m.cols.unitPrice} />
                    {l.free && <input type="hidden" name="l_price" value="0" />}
                  </td>
                  <td className="num">{fmt(tot.amount)}</td>
                  <td>
                    <div className="line-actions">
                      <button type="button" className="btn btn-link" onClick={() => set(l.key, { free: !l.free })}>{l.free ? m.editor.makePaid : m.editor.makeFree}</button>
                      {!sub && <button type="button" className="btn btn-link" onClick={() => addSub(l.key, 'CNC')}>+{lineKind.CNC}</button>}
                      {!sub && <button type="button" className="btn btn-link" onClick={() => addSub(l.key, 'DELIK')}>+{lineKind.DELIK}</button>}
                      <button type="button" className="btn btn-link danger" aria-label={m.editor.deleteRow} onClick={() => remove(l.key)}>✕</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5}>{common.total}</td>
              <td>
                {interpolate(m.editor.countGlass, { n: totals.adet })}
                {totals.cnc ? ` · ${interpolate(m.editor.countCnc, { n: totals.cnc })}` : ''}
                {totals.delik ? ` · ${interpolate(m.editor.countHoles, { n: totals.delik })}` : ''}
              </td>
              <td />
              <td className="num">{fmt(totals.metraj)} m²</td>
              <td />
              <td className="num">{fmt(totals.amount)} {props.currency}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <button type="button" className="btn" style={{ marginTop: 10 }} onClick={() => setLines([...lines, blankGlass()])}>+ {m.editor.addGlass}</button>

      {problems.length > 0 && (
        <div className="alert alert-warn" style={{ marginTop: 12 }}>
          <b>{m.editor.cannotSend}</b>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{problemTexts.map((p) => <li key={p}>{p}</li>)}</ul>
          <span className="small">{m.editor.canSaveDraft}</span>
        </div>
      )}

      {isAdmin && (
        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="returnNote">{m.editor.returnNote}</label>
          <input id="returnNote" name="returnNote" type="text" placeholder={m.editor.returnNotePlaceholder} />
        </div>
      )}
      {isUpdate && (
        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="updateNote">{m.editor.updateNote}</label>
          <input id="updateNote" name="updateNote" type="text" placeholder={m.editor.updateNotePlaceholder} />
        </div>
      )}
      <div className="row end" style={{ marginTop: 14 }}>
        {isUpdate ? (
          <>
            <a href={props.cancelHref ?? '#'} className="btn">{common.cancel}</a>
            <button type="submit" onClick={intent('update')} className="btn btn-primary" disabled={problems.length > 0}>{m.editor.updateAndSend}</button>
          </>
        ) : (
          <button type="submit" onClick={intent('save')} className="btn">{m.editor.saveDraft}</button>
        )}
        {isUpdate ? null : isAdmin ? (
          <>
            <button type="submit" onClick={intent('return')} className="btn btn-danger">{m.editor.returnToSales}</button>
            <button type="submit" onClick={intent('approve')} className="btn btn-primary" disabled={problems.length > 0}>{m.editor.approveAndSend}</button>
          </>
        ) : (
          <button type="submit" onClick={intent('submit')} className="btn btn-primary" disabled={problems.length > 0}>{m.editor.submit}</button>
        )}
      </div>
      <p className="muted small" style={{ marginTop: 8 }}>
        {isUpdate
          ? m.editor.footUpdate
          : isAdmin
            ? m.editor.footAdmin
            : m.editor.footSales}
      </p>
    </form>
  );
}
