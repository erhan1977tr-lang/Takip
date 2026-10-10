'use client';

import { useMemo, useState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import type { Dict } from '@/lib/i18n';
import type { CompEntry, CompFormData } from '@/lib/compensation';
import { interpolate } from '@/server/i18n/interpolate.js';
import { compensationFlow } from '@/server/orders/compensation-flow.js';
import { createCompensationAction } from './compensation-actions';

const dmy = (day: string) => day.slice(0, 10).split('-').reverse().join('.');

/** Gönderilirken ikinci tıklama yok (sunucuda ayrıca tek kullanımlık anahtar var) */
function Submit({ disabled, children }: { disabled: boolean; children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return <button className="btn btn-primary" disabled={disabled || pending}>{children}</button>;
}

/**
 * Kırık / telafi camı formu (karar 108, 157) — teklif tablosunun altında tek, kısa bir kart: cam → adet → fiyat → hedef →
 * özet ve açık onay. Teklif satırındaki "Kırık / Telafi" (cam önceden seçili gelir) ve "Önemli kararlar"daki düğme (cam
 * burada seçilir) aynı formu açar. Buradaki denetimler yalnızca kolaylıktır; her şey sunucuda yeniden doğrulanır.
 *   Fiyat: Bedelsiz · Aynı fiyat · Farklı fiyat — üçünü satış da seçer; satışın formunda FİYAT ALANI YOKTUR (farklı fiyatı
 *   yönetici belirler) ve hiçbir müşteri fiyatı tutarı gösterilmez (iki kademeli fiyat, karar 4).
 */
export function CompensationForm({ data, preselect, history, error, cancelHref, locale, intl, m, kinds }: {
  data: CompFormData;
  /** Satırdan gelindiyse seçili cam satırı */
  preselect: string | null;
  /** Kaynak siparişin önceki telafileri (aynı satır için olanlar formda gösterilir) */
  history: Pick<CompEntry, 'id' | 'sourceLineId' | 'glass' | 'enMm' | 'boyMm' | 'quantity' | 'day' | 'status' | 'destOrder' | 'createdAt'>[];
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
  const pickable = (id: string) => data.lines.some((l) => l.id === id && !l.ambiguous);
  const [lineId, setLineId] = useState(() => (preselect && pickable(preselect) ? preselect : data.lines.length === 1 && pickable(data.lines[0].id) ? data.lines[0].id : ''));
  const [qty, setQty] = useState('1');
  const [item, setItem] = useState('');
  // Fiyat kararı (karar 157): üç seçenek herkese açık; farklı fiyatın tutarını yalnızca yönetici girer
  const modes = ['FREE', 'NORMAL', 'CUSTOM'] as const;
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
  // Farklı fiyat: yönetici pozitif bir fiyat girer; satış fiyat GİRMEZ (alan yoktur) — fiyatı yönetici belirler
  const adminPrice = data.admin && mode === 'CUSTOM';
  const priceOk = !adminPrice || (price.trim() !== '' && Number.isFinite(p) && p > 0);
  const dest = data.destinations.find((d) => d.id === destId) ?? null;
  const destOk = destType === 'NEW' ? day >= data.minDay : destType === 'EXISTING' ? !!dest && !dest.reason : false;
  // Kaynak adedi (karar 157): temiz siparişte telafi adedi kadar düşer; kaynakta başka cam kalmıyorsa telafi açılmaz
  const left = line && qtyOk ? line.adet - n : null;
  const emptySource = data.source.reducible && left === 0 && data.lines.length === 1;
  // Teklifin yolu — sunucunun izlediği yolla aynı kural (compensationFlow): kaynakta müşteri fiyatı yoksa "aynı fiyat" da
  // doğrudan gitmez (yeni siparişte fiyat onayı, müşterideki teklifte satış için onay bekler, yönetici için fiyat gerekir)
  const route = line ? compensationFlow({ mode, admin: data.admin, destType: destType || 'NEW', via: destType === 'EXISTING' ? dest?.via ?? null : null, sourceFree: line.free, sourcePriced: line.priced }) : null;
  const pending = route === 'pending';
  // Hedef listesinde "yönetici onayı bekler" işareti: aynı kural, her hedefin teklif durumuyla
  const waitsAdmin = (via: 'DRAFT' | 'SENT' | null | undefined) => compensationFlow({ mode, admin: data.admin, destType: 'EXISTING', via: via ?? null, sourceFree: !!line?.free, sourcePriced: line ? line.priced : true }) === 'pending';
  const priceRequired = route === 'priceRequired';
  const ready = qtyOk && priceOk && destOk && !emptySource && !priceRequired;
  const flow = route === 'draft' ? f.flow.draft : route === 'direct' ? f.flow.direct : route === 'adminSent' ? f.flow.adminSent : f.flow.pricing;
  // Önceki telafiler: aynı satır ya da — kaynak adedi düşünce teklifin yeni sürümü açıldığı için — aynı cam ve ölçü
  const past = line ? history.filter((h) => h.status !== 'REJECTED' && (h.sourceLineId === line.id || (h.glass === line.glass && h.enMm === line.enMm && h.boyMm === line.boyMm))) : [];
  const eligible = data.destinations.filter((d) => !d.reason);
  const change = () => setSure(false);

  // Satışa müşteri fiyatının tutarı gelmez (normal = null): "yöneticinin belirlediği fiyat" yazılır
  const normalText = !line ? '—' : line.free ? m.free : line.normal == null ? f.adminPrice : perM2(line.normal);
  // Aynı fiyat: kaynakta müşteri fiyatı yoksa kesin fiyat yoktur — fiyatı yönetici belirler (sunucu da öyle yürür)
  const priceText = mode === 'FREE' ? m.free : mode === 'CUSTOM' ? (!data.admin ? f.sumPriceAdmin : priceOk ? perM2(p) : '—')
    : line && !line.free && !line.priced ? f.sumPriceAdmin : !line || line.free || line.normal != null ? normalText : f.sameAdmin;
  const opsText = (l: { ops: { kind: string; adet: number; description: string }[] }) =>
    l.ops.map((o) => `${interpolate(f.opsItem, { kind: kinds[o.kind as keyof typeof kinds] ?? o.kind, n: o.adet })}${o.description ? ` (${o.description})` : ''}`).join(', ');

  return (
    <div className="card comp-form" id="telafi">
      <div className="section-head">
        <h2>{f.title}</h2>
        <Link href={cancelHref} className="btn">{f.cancel}</Link>
      </div>
      <p className="muted small">{f.intro}</p>
      {/* Kaynak yüklenmiş / belgeli / kapalı: adedi düşmez, telafi ek üretimdir (karar 157) — form açılır açılmaz görünür */}
      {!data.source.reducible && data.source.reason && <div className="alert alert-warn" data-source-kept={data.source.reason}>{f.sourceKept[data.source.reason]}</div>}
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
              {/* Her seçenek fiziksel cam yapılandırmasını gösterir: işlemsiz camlar (adetle) ve işlemli TEK cam ayrı satırlardır */}
              {data.lines.map((l) => (
                <option key={l.id} value={l.id} disabled={l.ambiguous}>
                  {interpolate(f.glassOption, { n: l.n, glass: glassOf(l), dims: `${l.enMm}×${l.boyMm}`, qty: l.adet })} · {l.ambiguous ? f.glassAmbiguous : l.ops.length ? opsText(l) : f.noOps}
                </option>
              ))}
            </select>
            {line && line.ops.length > 0 && <p className="hint">{interpolate(f.ops, { list: opsText(line) })}</p>}
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
          {line && <p className="small">{data.admin ? interpolate(f.normalCustomer, { price: normalText }) : f.normalSales}</p>}
          <div className="row">
            {modes.map((k) => (
              <label key={k} className="chip">
                <input type="radio" name="modeChoice" value={k} checked={mode === k} onChange={() => { setMode(k); change(); }} />
                <span>
                  {k === 'NORMAL' ? (line && line.normal != null && !line.free ? interpolate(f.keepWith, { price: perM2(line.normal) }) : f.keep)
                    : k === 'FREE' ? (data.admin ? interpolate(f.freeWith, { cur: data.currency }) : f.free) : f.custom}
                </span>
              </label>
            ))}
            {/* Fiyat alanı yalnızca yöneticide: satışın formunda müşteri fiyatı girilemez */}
            {adminPrice && (
              <input name="price" inputMode="decimal" required aria-label={interpolate(f.customLabel, { cur: data.currency })} placeholder={interpolate(f.customLabel, { cur: data.currency })}
                value={price} onChange={(e) => { setPrice(e.target.value); change(); }} style={{ width: 200 }} />
            )}
          </div>
          <p className="hint" data-mode-hint={mode}>{mode === 'FREE' ? f.freeHint : mode === 'NORMAL' ? (line && !line.free && !line.priced ? f.keepHintNoPrice : f.keepHint) : data.admin ? f.adminCustomHint : f.salesCustomHint}</p>
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
                      : interpolate(waitsAdmin(d.via) ? f.destPending : f.destOption, { order: d.orderNo, date: dmy(d.day) })}
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
                {data.source.reducible && left != null && (
                  <tr data-sum="kaynak"><td>{f.sumSourceQty}</td><td><b>{interpolate(f.sumSourceQtyValue, { before: line.adet, after: left })}</b></td></tr>
                )}
                {line.ops.length > 0 && <tr data-sum="islem"><td>{f.sumOps}</td><td>{interpolate(f.sumOpsValue, { list: opsText(line) })}</td></tr>}
                <tr><td>{f.sumNormal}</td><td>{normalText}</td></tr>
                <tr><td>{f.sumPrice}</td><td><b>{priceText}</b></td></tr>
                <tr><td>{f.sumDest}</td><td>{destType === 'NEW' ? `${f.sumDestNew} (${data.nextNo})` : dest?.orderNo}</td></tr>
                <tr><td>{f.sumDay}</td><td>{dmy(destType === 'NEW' ? day : dest?.day ?? '')}</td></tr>
                {!pending && <tr data-sum="akis"><td>{f.sumFlow}</td><td>{flow}</td></tr>}
              </tbody>
            </table>
            {pending && <div className="alert alert-info">{f.sumPending}</div>}
            <label className="check comp-confirm">
              <input type="checkbox" name="confirm" checked={sure} onChange={(e) => setSure(e.target.checked)} /> {interpolate(f.confirm, { qty: n })}
            </label>
          </div>
        )}
        {emptySource && <div className="alert alert-error">{m.errors.SOURCE_EMPTY}</div>}
        {priceRequired && <div className="alert alert-error" data-price-required>{m.errors.PRICE_REQUIRED}</div>}
        <div className="row end" style={{ marginTop: 12 }}>
          <Submit disabled={!ready || !sure}>{f.submit}</Submit>
        </div>
      </form>
    </div>
  );
}
