'use client';

import { useMemo, useRef, useState } from 'react';
import type { Dict } from '@/lib/i18n';
import { formatOfferProblems } from '@/server/i18n/format.js';
import { interpolate } from '@/server/i18n/interpolate.js';
import { atOfferPrice, offerLineTotals, offerProblems, offerTotals } from '@/server/orders/rules.js';
import { saveOfferAction } from './actions';

/**
 * listPrice: fiyat tablosundaki liste fiyatı ('' → yok). Sunucu kayıtta yeniden hesaplar; burada yalnızca gösterilir.
 * id: kayıtlı satır ('' → yeni) · unitPrice: satış fiyatı · offerPrice: müşteri fiyatı (yalnızca yönetici görür/girer, karar 4)
 */
type Line = { key: number; id: string; description: string; poz: string; enMm: string; boyMm: string; adet: string; unit: string; unitPrice: string; kind: string; free: boolean; listPrice: string; offerPrice: string };

/** Fiyat tablosu (karar 26): cam adı (ekrandaki dilde ve Türkçe) → m² fiyatı; delik ve CNC adet fiyatı */
export type EditorPricing = { name: string; glass: Record<string, number>; holePrice: number | null; cncPrice: number | null };

let seq = 1000;
const blankGlass = (): Line => ({ key: seq++, id: '', description: '', poz: '', enMm: '', boyMm: '', adet: '1', unit: 'm2', unitPrice: '', kind: 'CAM', free: false, listPrice: '', offerPrice: '' });
const money2 = (n: number | null | undefined) => (n != null ? n.toFixed(2) : '');
const blankSub = (kind: 'CNC' | 'DELIK', price: number | null, customerPrice: number | null): Line => {
  const p = money2(price);
  return { key: seq++, id: '', description: '', poz: '', enMm: '', boyMm: '', adet: '1', unit: 'adet', unitPrice: p, kind, free: false, listPrice: p, offerPrice: money2(customerPrice) };
};
const upper = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleUpperCase('tr-TR');
const samePrice = (a: string, b: string) => Math.abs(Number(a.replace(',', '.') || 0) - Number(b.replace(',', '.') || 0)) < 0.005;

const fmt = (n: number) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

export function OfferEditor(props: {
  orderId: string;
  /** Siparişin sayfa açıldığındaki sürümü (iyimser kilit) */
  version: number;
  /** sales: satış taslağı · admin: fiyat onayı · update: yönetici müşterideki teklifi günceller */
  mode: 'sales' | 'admin' | 'update';
  cancelHref?: string;
  currency: string;
  catalog: string[];
  pricing: EditorPricing | null;
  /** Müşteriye özel fiyatlar (yönetici; karar 32): yeni satırın müşteri fiyatı buradan dolar */
  customerPricing?: EditorPricing | null;
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
  // Yönetici (fiyat onayı ve güncelleme) müşteri fiyatıyla çalışır; satış fiyatı yalnızca yanında görünür
  const adminMode = props.mode !== 'sales';
  const totals = useMemo(() => offerTotals(lines), [lines]);
  const offerTot = useMemo(() => offerTotals(atOfferPrice(lines)), [lines]);
  const problems = useMemo(() => {
    const used = lines.filter((l) => l.kind !== 'CAM' || l.description || l.enMm || l.boyMm || l.unitPrice || l.offerPrice);
    return offerProblems(adminMode ? atOfferPrice(used) : used);
  }, [lines, adminMode]);
  const problemTexts = useMemo(
    () => formatOfferProblems(problems, { offerProblems: props.problemsMsg, lineKind }),
    [problems, props.problemsMsg, lineKind]
  );
  /** Satır türünün adı: "CNC" / "Delik" (dile göre) */
  const kindName = (kind: string) => lineKind[kind as keyof typeof lineKind] ?? kind;
  const set = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const glassPrices = useMemo(() => new Map(Object.entries(props.pricing?.glass ?? {}).map(([k, v]) => [upper(k), v])), [props.pricing]);
  const customerGlass = useMemo(() => new Map(Object.entries(props.customerPricing?.glass ?? {}).map(([k, v]) => [upper(k), v])), [props.customerPricing]);
  /**
   * Cam adı değişince liste fiyatı da değişir; fiyat boşsa ya da liste fiyatıysa yeni liste fiyatı yazılır.
   * Yöneticide: müşteri fiyatı boşsa müşterinin fiyat tablosundaki fiyat yazılır.
   */
  const setDescription = (l: Line, description: string) => {
    if (l.kind !== 'CAM') return set(l.key, { description });
    const p = glassPrices.get(upper(description));
    const listPrice = p != null ? p.toFixed(2) : '';
    const follow = !l.unitPrice || (l.listPrice !== '' && samePrice(l.unitPrice, l.listPrice));
    const cp = adminMode && !l.offerPrice ? customerGlass.get(upper(description)) : undefined;
    set(l.key, { description, listPrice, ...(follow && !adminMode ? { unitPrice: listPrice } : {}), ...(cp != null ? { offerPrice: cp.toFixed(2) } : {}) });
  };
  /** Cam satırının (ve varsa alt satırlarının) hemen altına CNC / delik satırı ekler. */
  const addSub = (key: number, kind: 'CNC' | 'DELIK') => setLines((ls) => {
    let i = ls.findIndex((l) => l.key === key) + 1;
    while (i < ls.length && ls[i].kind !== 'CAM') i++;
    const cust = adminMode ? (kind === 'CNC' ? props.customerPricing?.cncPrice : props.customerPricing?.holePrice) ?? null : null;
    const sub = blankSub(kind, kind === 'CNC' ? props.pricing?.cncPrice ?? null : props.pricing?.holePrice ?? null, cust);
    // Yöneticinin eklediği satırın satış fiyatı yoktur (satış fiyatını satış girer)
    return [...ls.slice(0, i), adminMode ? { ...sub, unitPrice: '', listPrice: '' } : sub, ...ls.slice(i)];
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
      {/* Sayfanın gösterdiği sipariş sürümü: bu arada biri siparişi değiştirdiyse kayıt reddedilir */}
      <input type="hidden" name="v" value={props.version} />
      <input type="hidden" name="intent" defaultValue={isUpdate ? 'update' : 'save'} ref={intentRef} />
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>{m.editor.title} <span className="badge">{props.statusLabel}</span></h2>
        <span className="muted small">{m.editor.formula}</span>
      </div>

      {props.pricing && !isUpdate && (
        <p className="muted small" style={{ marginTop: 0 }}>{interpolate(m.editor.tableInfo, { name: props.pricing.name })} {!isAdmin && m.editor.overrideNote}</p>
      )}
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
            <tr><th>#</th><th>{m.cols.description}</th><th>{m.cols.poz}</th><th>{m.cols.widthMm}</th><th>{m.cols.heightMm}</th><th>{m.cols.qty}</th><th>{m.cols.unit}</th><th className="num">{m.cols.metraj}</th><th>{adminMode ? m.cols.salesPrice : m.cols.unitPrice}</th>{adminMode && <th>{m.cols.offerPrice}</th>}<th className="num">{adminMode ? m.cols.offerAmount : m.cols.amount}</th><th /></tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const tot = offerLineTotals(adminMode ? { ...l, unitPrice: l.offerPrice } : l);
              const sub = l.kind !== 'CAM';
              if (!sub) glassNo += 1;
              const kind = kindName(l.kind);
              const shownPrice = adminMode ? l.offerPrice : l.unitPrice;
              const missing = !l.free && !(Number(shownPrice.replace(',', '.')) > 0) && (sub || !!(l.description || l.enMm || l.boyMm));
              return (
                <tr key={l.key} className={sub ? 'sub-line' : undefined}>
                  <td className="muted">{sub ? '' : glassNo}
                    <input type="hidden" name="l_id" value={l.id} />
                    <input type="hidden" name="l_kind" value={l.kind} />
                    <input type="hidden" name="l_free" value={l.free ? '1' : '0'} />
                  </td>
                  <td className="desc">
                    {sub && <span className="badge badge-info">{kind}</span>}{' '}
                    {l.free && <span className="badge badge-ok">{m.free}</span>}
                    <input name="l_desc" list={sub ? undefined : 'catalog'} value={l.description} placeholder={sub ? interpolate(m.editor.subDescPlaceholder, { kind }) : undefined}
                      onChange={(e) => setDescription(l, e.target.value)} aria-label={sub ? interpolate(m.editor.subDescAria, { kind }) : m.cols.description} />
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
                    {adminMode ? (
                      // Yönetici satış fiyatını değiştirmez; sunucu da yönetici kaydında satış fiyatına dokunmaz
                      <><input type="hidden" name="l_price" value={l.free ? '0' : l.unitPrice} /><span className="muted">{l.unitPrice ? fmt(Number(l.unitPrice.replace(',', '.'))) : '—'}</span></>
                    ) : (
                      <>
                        <input name="l_price" inputMode="decimal" value={l.free ? '' : l.unitPrice} disabled={l.free} className={missing ? 'input-missing' : undefined}
                          onChange={(e) => set(l.key, { unitPrice: e.target.value.replace(/[^\d.,]/g, '') })} style={{ width: 92 }}
                          aria-label={sub ? interpolate(m.editor.subPriceAria, { kind }) : m.cols.unitPrice} />
                        {l.free && <input type="hidden" name="l_price" value="0" />}
                      </>
                    )}
                    {l.listPrice !== '' && (
                      l.free || !samePrice(l.unitPrice, l.listPrice)
                        ? <div className="small list-changed">{interpolate(isAdmin ? m.editor.listChangedAdmin : m.editor.listChanged, { p: fmt(Number(l.listPrice)) })}</div>
                        : <div className="small muted">{interpolate(m.editor.listPrice, { p: fmt(Number(l.listPrice)) })}</div>
                    )}
                  </td>
                  {adminMode && (
                    <td>
                      <input name="l_oprice" inputMode="decimal" value={l.free ? '' : l.offerPrice} disabled={l.free} className={missing ? 'input-missing' : undefined}
                        onChange={(e) => set(l.key, { offerPrice: e.target.value.replace(/[^\d.,]/g, '') })} style={{ width: 92 }}
                        aria-label={sub ? interpolate(m.editor.subOfferPriceAria, { kind }) : m.cols.offerPrice} />
                      {l.free && <input type="hidden" name="l_oprice" value="0" />}
                    </td>
                  )}
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
              {adminMode ? <td className="num muted">{fmt(totals.amount)}</td> : <td />}
              {adminMode && <td />}
              <td className="num">{fmt(adminMode ? offerTot.amount : totals.amount)} {props.currency}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 10, flexWrap: 'wrap', gap: 8 }}>
        <button type="button" className="btn" onClick={() => setLines([...lines, blankGlass()])}>+ {m.editor.addGlass}</button>
        {adminMode && (
          <span className="small">
            {interpolate(m.editor.twoTotals, { sales: fmt(totals.amount), offer: fmt(offerTot.amount), diff: fmt(offerTot.amount - totals.amount), cur: props.currency })}
          </span>
        )}
      </div>
      <p className="muted small" style={{ margin: '6px 0 0' }}>{common.pricesExclVat}{adminMode && props.customerPricing ? ` · ${interpolate(m.editor.customerTableInfo, { name: props.customerPricing.name })}` : ''}</p>

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
