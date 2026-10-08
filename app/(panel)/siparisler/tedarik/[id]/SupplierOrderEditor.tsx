'use client';

import { useMemo, useRef, useState } from 'react';
import type { Dict } from '@/lib/i18n';
import { ConfirmButton } from '@/components/ConfirmButton';
import { interpolate } from '@/server/i18n/interpolate.js';
import { lineTotal, orderTotals, parsePrice } from '@/server/suppliers/money.js';
import { approveSendAction, saveDraftAction } from '../actions';

export type EditorProduct = {
  id: string; code: string; label: string; nameTr: string; orderUnit: string;
  /** Bu siparişin tedarikçisi ve para birimi için kayıtlı alış fiyatı (yoksa null — uydurulmaz) */
  catalogPrice: string | null;
  /** Ürünün tanımlı tedarikçisi bu siparişinkinden başkaysa adı */
  otherSupplier: string | null;
  own: boolean;
};
export type EditorLine = { productId: string; description: string; color: string; qty: string; unitCode: string; unitPrice: string };
type Row = EditorLine & { key: number };

const QTY_RE = /^\d{1,6}$/;
const fmt = (v: string) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v));
const fmtPrice = (v: string) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(Number(v));
const validQty = (q: string) => QTY_RE.test(q.trim()) && Number(q) >= 1 && Number(q) <= 100_000;
/** Kayıtlı fiyat ("12.5") giriş alanında Türkçe yazımla ("12,5"); sunucu ikisini de okur */
const asInput = (v: string | null | undefined) => (v ?? '').replace('.', ',');

/**
 * Tedarikçi siparişinin taslak düzenleyicisi (Paket 6, karar 181). Satırlar tarayıcıda düzenlenir, "Taslağı kaydet" ile
 * sunucuya gider (sunucu her şeyi yeniden doğrular, fiyat kaynağını kendisi belirler). Kaydedilmemiş değişiklik varken
 * "Siparişi onayla / gönder" kapalıdır: tedarikçiye her zaman KAYDEDİLMİŞ (ekranda görülen) içerik gider.
 * Ara toplamlar sunucuyla aynı kuraldan (server/suppliers/money.js) hesaplanır.
 */
export function SupplierOrderEditor(props: {
  m: Dict['supplier']['order']; orderId: string; version: number; revision: number; isRevision: boolean;
  orderNo: string; orderNoEditable: boolean; orderDate: string; note: string; currency: string;
  email: string | null; lines: EditorLine[]; products: EditorProduct[]; units: { code: string; label: string }[];
  canApprove: boolean; maxLines: number;
}) {
  const { m, products, units, currency } = props;
  const seq = useRef(props.lines.length);
  const [rows, setRows] = useState<Row[]>(() => props.lines.map((l, i) => ({ ...l, key: i })));
  const [orderNo, setOrderNo] = useState(props.orderNo);
  const [orderDate, setOrderDate] = useState(props.orderDate);
  const [note, setNote] = useState(props.note);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const payload = (list: EditorLine[]) => JSON.stringify(list.map((r) => ({
    productId: r.productId, description: r.description.trim(), color: r.color.trim(), qty: r.qty.trim(), unitCode: r.unitCode, unitPrice: r.unitPrice.trim(),
  })));
  // Kaydedilmiş hâl (sayfa her kayıttan sonra yeni sürümle yeniden kurulur — bileşenin anahtarı sürümdür)
  const [initial] = useState(() => JSON.stringify([payload(props.lines), props.orderNo, props.orderDate, props.note.trim()]));
  const linesJson = payload(rows);
  const dirty = JSON.stringify([linesJson, orderNo, orderDate, note.trim()]) !== initial;

  // Satır tutarları ve genel toplam: fiyatı geçerli ve miktarı geçerli satırlar (sunucu kuralı)
  const priced = rows.map((r) => {
    const p = parsePrice(r.unitPrice);
    const price = p.ok ? p.value : null;
    return { price, bad: !p.ok, total: price != null && validQty(r.qty) ? lineTotal(Number(r.qty), price) : null };
  });
  const totals = orderTotals(rows.flatMap((r, i) => (validQty(r.qty) ? [{ qty: Number(r.qty), unitPrice: priced[i].price }] : [])));
  const missing = rows.some((_, i) => priced[i].price == null);

  const update = (key: number, patch: Partial<EditorLine>) => setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const pick = (key: number, productId: string) => {
    const p = byId.get(productId);
    update(key, { productId, description: p?.nameTr ?? '', unitCode: p?.orderUnit ?? units[0]?.code ?? '', unitPrice: asInput(p?.catalogPrice) });
  };
  const add = () => setRows((list) => (list.length >= props.maxLines ? list : [...list, { key: ++seq.current, productId: '', description: '', color: '', qty: '', unitCode: units[0]?.code ?? '', unitPrice: '' }]));
  const remove = (key: number) => setRows((list) => list.filter((r) => r.key !== key));

  const own = products.filter((p) => p.own);
  const others = products.filter((p) => !p.own);
  const options = (list: EditorProduct[]) => list.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.label}</option>);

  return (
    <div className="card" id="taslak">
      <h2>{interpolate(m.editor.title, { n: props.revision })}</h2>
      {props.isRevision && <div className="alert alert-info">{interpolate(m.editor.revisionOf, { n: props.revision })}</div>}
      <form action={saveDraftAction}>
        <input type="hidden" name="orderId" value={props.orderId} />
        <input type="hidden" name="version" value={props.version} />
        <input type="hidden" name="lines" value={linesJson} />
        <div className="grid-3">
          <div>
            <label htmlFor="so-no">{m.editor.orderNo}</label>
            {props.orderNoEditable
              ? <input id="so-no" name="orderNo" required maxLength={30} value={orderNo} onChange={(e) => setOrderNo(e.target.value)} className="mono" />
              : <><input id="so-no" value={orderNo} readOnly className="mono" /><div className="hint">{m.editor.orderNoLocked}</div></>}
          </div>
          <div>
            <label htmlFor="so-date">{m.editor.orderDate}</label>
            <input id="so-date" name="orderDate" type="date" required value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
          </div>
        </div>

        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="supplier-lines">
            <thead>
              <tr>
                <th>#</th><th>{m.editor.col.product}</th><th>{m.editor.col.description}</th><th>{m.editor.col.color}</th>
                <th className="num">{m.editor.col.qty}</th><th>{m.editor.col.unit}</th><th className="num">{m.editor.col.price}</th>
                <th className="num">{m.editor.col.total}</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={9} className="empty">{m.editor.empty}</td></tr>}
              {rows.map((r, i) => {
                const p = byId.get(r.productId);
                const n = i + 1;
                const pr = priced[i];
                return (
                  <tr key={r.key} data-line={n}>
                    <td className="muted">{n}</td>
                    <td>
                      <select value={r.productId} onChange={(e) => pick(r.key, e.target.value)} aria-label={`${m.editor.col.product} ${n}`} required>
                        <option value="" disabled>{m.editor.pickProduct}</option>
                        {own.length > 0 && <optgroup label={m.editor.ownProducts}>{options(own)}</optgroup>}
                        {others.length > 0 && <optgroup label={m.editor.otherProducts}>{options(others)}</optgroup>}
                      </select>
                      {p?.otherSupplier && <div className="muted small">{interpolate(m.editor.otherSupplier, { name: p.otherSupplier })}</div>}
                    </td>
                    <td><input value={r.description} maxLength={200} className="text-input" placeholder={p?.nameTr ?? ''} onChange={(e) => update(r.key, { description: e.target.value })} aria-label={`${m.editor.col.description} ${n}`} /></td>
                    <td><input value={r.color} maxLength={40} className="color-input" onChange={(e) => update(r.key, { color: e.target.value })} aria-label={`${m.editor.col.color} ${n}`} /></td>
                    <td className="num">
                      <input value={r.qty} inputMode="numeric" maxLength={6} className="qty-input"
                        onChange={(e) => update(r.key, { qty: e.target.value })} aria-label={`${m.editor.col.qty} ${n}`} aria-invalid={!!r.qty && !validQty(r.qty)} />
                    </td>
                    <td>
                      <select value={r.unitCode} onChange={(e) => update(r.key, { unitCode: e.target.value })} aria-label={`${m.editor.col.unit} ${n}`}>
                        {units.map((u) => <option key={u.code} value={u.code}>{u.label}</option>)}
                      </select>
                    </td>
                    <td className="num">
                      <input value={r.unitPrice} inputMode="decimal" maxLength={14} className="price-input"
                        onChange={(e) => update(r.key, { unitPrice: e.target.value })} aria-label={`${m.editor.col.price} ${n}`} aria-invalid={pr.bad} />
                      {pr.price == null && !pr.bad && <div><span className="badge badge-warn" data-no-price>{m.editor.noPrice}</span></div>}
                      {p?.catalogPrice != null && pr.price !== p.catalogPrice && (
                        <div className="small muted">
                          {m.editor.catalogPrice}: {fmtPrice(p.catalogPrice)}{' '}
                          <button type="button" className="btn btn-link" onClick={() => update(r.key, { unitPrice: asInput(p.catalogPrice) })}>{m.editor.useCatalog}</button>
                        </div>
                      )}
                    </td>
                    <td className="num nowrap" data-line-total>{pr.total != null ? `${fmt(pr.total)} ${currency}` : '—'}</td>
                    <td className="actions"><button type="button" className="btn btn-link danger" onClick={() => remove(r.key)} aria-label={`${m.editor.removeLine} ${n}`}>×</button></td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={7} className="num"><b>{m.editor.grandTotal}</b></td>
                <td className="num nowrap" data-grand-total><b>{fmt(totals.total)} {currency}</b></td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="row" style={{ marginTop: 8, justifyContent: 'space-between' }}>
          <button type="button" className="btn" onClick={add} disabled={rows.length >= props.maxLines}>{m.editor.addLine}</button>
          <span className="muted small">{interpolate(m.editor.currencyNote, { currency })}</span>
        </div>
        {missing && rows.length > 0 && <div className="alert alert-warn" style={{ marginTop: 8 }} data-missing-price>{m.editor.missingPrice}</div>}

        <label htmlFor="so-note" style={{ marginTop: 12 }}>{m.editor.note}</label>
        <textarea id="so-note" name="note" rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="hint">{m.editor.noteHint}</div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" disabled={!dirty}>{m.editor.save}</button>
          {dirty && <span className="text-danger small" data-unsaved>{m.editor.unsaved}</span>}
        </div>
      </form>

      {props.canApprove && (
        <form action={approveSendAction} className="approve-box">
          <input type="hidden" name="orderId" value={props.orderId} />
          <input type="hidden" name="version" value={props.version} />
          {!props.email && <div className="alert alert-error" data-no-email>{m.emailMissing}</div>}
          <div className="row">
            {dirty || !props.email || rows.length === 0
              ? <button type="button" className="btn btn-primary" disabled>{m.approve.button}</button>
              : <ConfirmButton primary message={interpolate(m.approve.confirm, { no: orderNo, email: props.email })}>{m.approve.button}</ConfirmButton>}
          </div>
          <div className="hint">{m.approve.hint}</div>
        </form>
      )}
    </div>
  );
}
