'use client';

import { useMemo, useState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import type { Dict } from '@/lib/i18n';
import type { CompEntry, CompFormData } from '@/lib/compensation';
import { interpolate } from '@/server/i18n/interpolate.js';
import { createCompensationAction } from './compensation-actions';

const dmy = (day: string) => day.slice(0, 10).split('-').reverse().join('.');

/** Gönderilirken ikinci tıklama yok (sunucuda ayrıca tek kullanımlık anahtar var) */
function Submit({ disabled, children }: { disabled: boolean; children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return <button className="btn btn-primary" disabled={disabled || pending}>{children}</button>;
}

/**
 * Kırık / telafi camı formu (karar 108) — teklif tablosunun altında tek, kısa bir kart: cam → adet → fiyat → hedef → özet
 * ve açık onay. Teklif satırındaki "Kırık / Telafi" (cam önceden seçili gelir) ve "Önemli kararlar"daki düğme (cam burada
 * seçilir) aynı formu açar. Buradaki denetimler yalnızca kolaylıktır; her şey sunucuda yeniden doğrulanır.
 */
export function CompensationForm({ data, preselect, history, error, cancelHref, locale, intl, m, kinds }: {
  data: CompFormData;
  /** Satırdan gelindiyse seçili cam satırı */
  preselect: string | null;
  /** Kaynak siparişin önceki telafileri (aynı satır için olanlar formda gösterilir) */
  history: Pick<CompEntry, 'id' | 'sourceLineId' | 'quantity' | 'day' | 'status' | 'destOrder' | 'createdAt'>[];
  error: string | null;
  cancelHref: string;
  locale: 'tr' | 'ro';
  intl: string;
  m: Dict['compensation'];
  kinds: Dict['status']['lineKind'];
}) {
  const f = m.form;
  const money = useMemo(() => new Intl.NumberFormat(intl, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), [intl]);
  const perM2 = (v: number) => interpolate(m.perM2, { price: money.format(v), cur: data.currency });
  const [lineId, setLineId] = useState(() => (preselect && data.lines.some((l) => l.id === preselect) ? preselect : data.lines.length === 1 ? data.lines[0].id : ''));
  const [qty, setQty] = useState('1');
  const [item, setItem] = useState('');
  const [mode, setMode] = useState<'NORMAL' | 'FREE' | 'CUSTOM'>('NORMAL');
  const [price, setPrice] = useState('');
  const [destType, setDestType] = useState<'' | 'EXISTING' | 'NEW'>('');
  const [destId, setDestId] = useState('');
  const [day, setDay] = useState('');
  const [sure, setSure] = useState(false);

  const line = data.lines.find((l) => l.id === lineId) ?? null;
  const glassOf = (l: { glass: string; glassRo: string | null }) => (locale === 'ro' && l.glassRo ? l.glassRo : l.glass);
  const link = line?.links.find((x) => x.itemId === item) ?? null;
  const max = line ? Math.min(line.adet, link ? link.free : line.adet) : 0;
  const n = Number(qty);
  const qtyOk = !!line && Number.isInteger(n) && n >= 1 && n <= max;
  const p = Number(price.replace(',', '.'));
  const priceOk = mode !== 'CUSTOM' || (price.trim() !== '' && Number.isFinite(p) && p > 0);
  const dest = data.destinations.find((d) => d.id === destId) ?? null;
  const destOk = destType === 'NEW' ? day >= data.minDay : destType === 'EXISTING' ? !!dest && !dest.reason : false;
  const ready = qtyOk && priceOk && destOk;
  // Satış, teklifi müşteride olan siparişe eklerse karar yöneticinin onayını bekler
  const pending = destType === 'EXISTING' && dest?.via === 'SENT' && !data.admin;
  const past = line ? history.filter((h) => h.sourceLineId === line.id && h.status !== 'REJECTED') : [];
  const eligible = data.destinations.filter((d) => !d.reason);
  const change = () => setSure(false);

  const normalText = line?.normal == null ? '—' : line.free ? m.free : perM2(line.normal);
  const priceText = mode === 'FREE' ? m.free : mode === 'CUSTOM' ? (priceOk ? perM2(p) : '—') : normalText;

  return (
    <div className="card comp-form" id="telafi">
      <div className="section-head">
        <h2>{f.title}</h2>
        <Link href={cancelHref} className="btn">{f.cancel}</Link>
      </div>
      <p className="muted small">{f.intro}</p>
      {error && <div className="alert alert-error">{error}</div>}
      <form action={createCompensationAction}>
        <input type="hidden" name="id" value={data.orderId} />
        <input type="hidden" name="key" value={data.requestKey} />
        <input type="hidden" name="mode" value={mode} />
        <input type="hidden" name="destType" value={destType} />

        <div className="grid-2">
          <div className="field">
            <label htmlFor="comp-line">{f.glass}</label>
            <select id="comp-line" name="lineId" value={lineId} required onChange={(e) => { setLineId(e.target.value); setItem(''); change(); }}>
              {data.lines.length > 1 && <option value="">{f.glassPick}</option>}
              {data.lines.map((l) => (
                <option key={l.id} value={l.id}>{interpolate(f.glassOption, { n: l.n, glass: glassOf(l), dims: `${l.enMm}×${l.boyMm}`, qty: l.adet })}</option>
              ))}
            </select>
            {line && line.ops.length > 0 && (
              <p className="hint">{interpolate(f.ops, { list: line.ops.map((o) => interpolate(f.opsItem, { kind: kinds[o.kind as keyof typeof kinds] ?? o.kind, n: o.adet })).join(', ') })}</p>
            )}
          </div>
          <div className="field">
            <label htmlFor="comp-qty">{f.quantity}</label>
            <input id="comp-qty" name="quantity" type="number" min={1} max={max || undefined} step={1} required value={qty} onChange={(e) => { setQty(e.target.value); change(); }} />
            {line && <p className="hint">{interpolate(f.quantityHint, { max })}</p>}
          </div>
        </div>

        {past.length > 0 && (
          <div className="alert alert-warn comp-history">
            <b>{f.history}</b>{' '}
            {past.map((h) => interpolate(f.historyItem, { qty: h.quantity, order: h.destOrder?.orderNo ?? '—', date: h.day ? dmy(h.day) : '—' })).join(' · ')}
          </div>
        )}

        {line && line.links.length > 0 && (
          <div className="field">
            <label htmlFor="comp-link">{f.link}</label>
            <select id="comp-link" name="itemId" value={item} onChange={(e) => { setItem(e.target.value); change(); }}>
              <option value="">{f.linkNone}</option>
              {line.links.map((x) => <option key={x.itemId} value={x.itemId}>{interpolate(f.linkOption, { date: dmy(x.day), n: x.free })}</option>)}
            </select>
            <p className="hint">{f.linkHint}</p>
          </div>
        )}

        <fieldset className="field comp-choice">
          <legend>{f.price}</legend>
          {line && <p className="small">{interpolate(data.admin ? f.normalCustomer : f.normalSales, { price: normalText })}</p>}
          <div className="row">
            {(['NORMAL', 'FREE', 'CUSTOM'] as const).map((k) => (
              <label key={k} className="chip">
                <input type="radio" name="modeChoice" value={k} checked={mode === k} onChange={() => { setMode(k); change(); }} />
                <span>{k === 'NORMAL' ? f.keep : k === 'FREE' ? f.free : f.custom}</span>
              </label>
            ))}
            {mode === 'CUSTOM' && (
              <input name="price" inputMode="decimal" required aria-label={interpolate(f.customLabel, { cur: data.currency })} placeholder={interpolate(f.customLabel, { cur: data.currency })}
                value={price} onChange={(e) => { setPrice(e.target.value); change(); }} style={{ width: 200 }} />
            )}
          </div>
          {mode === 'FREE' && <p className="hint">{f.freeHint}</p>}
          {mode === 'CUSTOM' && !data.admin && <p className="hint">{f.salesCustomHint}</p>}
        </fieldset>

        <fieldset className="field comp-choice">
          <legend>{f.dest}</legend>
          <div className="comp-dest">
            <label className="check">
              <input type="radio" name="destChoice" value="EXISTING" checked={destType === 'EXISTING'} disabled={eligible.length === 0} onChange={() => { setDestType('EXISTING'); change(); }} /> {f.destExisting}
            </label>
            {data.destinations.length === 0 ? <p className="hint">{f.destExistingNone}</p> : (
              <select name="destOrderId" aria-label={f.destPick} value={destId} disabled={destType !== 'EXISTING'} required={destType === 'EXISTING'} onChange={(e) => { setDestId(e.target.value); change(); }}>
                <option value="">{f.destPick}</option>
                {data.destinations.map((d) => (
                  <option key={d.id} value={d.id} disabled={!!d.reason}>
                    {d.reason
                      ? interpolate(f.destBlocked, { order: d.orderNo, date: dmy(d.day), reason: f.destReason[d.reason as keyof typeof f.destReason] ?? d.reason })
                      : interpolate(d.via === 'SENT' && !data.admin ? f.destPending : f.destOption, { order: d.orderNo, date: dmy(d.day) })}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="comp-dest">
            <label className="check">
              <input type="radio" name="destChoice" value="NEW" checked={destType === 'NEW'} onChange={() => { setDestType('NEW'); change(); }} /> {f.destNew}
            </label>
            <label className="small" htmlFor="comp-day">{f.day}</label>
            <input id="comp-day" name="day" type="date" min={data.minDay} value={day} disabled={destType !== 'NEW'} required={destType === 'NEW'} onChange={(e) => { setDay(e.target.value); change(); }} style={{ width: 'auto' }} />
            <p className="hint">{interpolate(f.destNewHint, { no: data.nextNo })}</p>
          </div>
        </fieldset>

        {ready && line && (
          <div className="comp-summary">
            <h3 className="sub-title">{f.summary}</h3>
            <table className="kv">
              <tbody>
                <tr><td>{f.sumSource}</td><td className="mono">{data.orderNo}</td></tr>
                <tr><td>{f.sumGlass}</td><td>{glassOf(line)} · {line.enMm}×{line.boyMm}</td></tr>
                <tr><td>{f.sumQty}</td><td>{n}</td></tr>
                <tr><td>{f.sumNormal}</td><td>{normalText}</td></tr>
                <tr><td>{f.sumPrice}</td><td><b>{priceText}</b></td></tr>
                <tr><td>{f.sumDest}</td><td>{destType === 'NEW' ? `${f.sumDestNew} (${data.nextNo})` : dest?.orderNo}</td></tr>
                <tr><td>{f.sumDay}</td><td>{dmy(destType === 'NEW' ? day : dest?.day ?? '')}</td></tr>
              </tbody>
            </table>
            {pending && <div className="alert alert-info">{f.sumPending}</div>}
            <label className="check comp-confirm">
              <input type="checkbox" name="confirm" checked={sure} onChange={(e) => setSure(e.target.checked)} /> {interpolate(f.confirm, { qty: n })}
            </label>
          </div>
        )}
        <div className="row end" style={{ marginTop: 12 }}>
          <Submit disabled={!ready || !sure}>{f.submit}</Submit>
        </div>
      </form>
    </div>
  );
}
