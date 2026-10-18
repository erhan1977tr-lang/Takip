'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import type { Dict } from '@/lib/i18n';
import { ConfirmButton } from '@/components/ConfirmButton';
import { interpolate } from '@/server/i18n/interpolate.js';
import { PROFILE_COLORS, billQuantity, previewOffer } from '@/server/commercial/rules.js';
import { calcOfferProfileAction, createOfferAction, issueOfferAction, saveOfferAction } from './actions';

/** listCost: kullanıcıya atanmış fiyat tablosundaki €/m² (Tanımlar → Fiyat Tabloları; yoksa null — uydurulmaz) */
export type EditorGlass = { id: string; label: string; descRo: string; listCost: string | null };
export type EditorCostTable = { name: string | null; reason: string | null };
export type EditorProfile = {
  id: string; code: string; label: string; nameRo: string; category: string; unit: string;
  /** metreyle fiyatlanan ürünün paket içeriği (m); yoksa null */
  content: string | null;
  price: string | null; cost: string | null;
  /** M6: gerçekleşen stok maliyeti (nakliye dahil) ve katalog alış fiyatı — ayrı değerler; cost öneridir */
  stockCost: string | null; catalogCost: string | null;
};
export type EditorCalc = {
  profiles: { id: string; label: string }[]; handrails: { id: string; label: string }[]; thicknesses: { id: string; label: string }[];
  colors: { value: string; label: string }[];
};
export type EditorData = {
  no: string; date: string; customerId: string; firmName: string; validityDays: string; terms: string; note: string; glassExtraCost: string;
  glass: GlassLine[]; profile: ProfileLine[];
};
type GlassLine = { productId: string; description: string; en: string; boy: string; qty: string; price: string; cost: string };
type ProfileLine = { productId: string; description: string; color: string; meters: string; qty: string; price: string; cost: string };
type Keyed<T> = T & { key: number };

const asInput = (v: string | null | undefined) => (v ?? '').replace('.', ',');

/**
 * Bağımsız ticari teklifin düzenleyicisi (karar 277). Satırlar tarayıcıda düzenlenir; ara toplamlar sunucuyla AYNI kuraldan
 * (previewOffer → computeOffer). Kayıt her zaman sunucuda yeniden doğrulanır; ürün adı / kodu / birimi katalogdan alınır.
 * Kaydedilmemiş değişiklik varken "Kesinleştir" kapalıdır: kesinleşen her zaman kaydedilmiş (ekranda görülen) içeriktir.
 */
export function OfferEditor(props: {
  m: Dict['commercial']; locale: 'tr' | 'ro'; mode: 'new' | 'edit'; offerId?: string; editVersion?: number; version?: number;
  noEditable: boolean; readOnly: boolean; data: EditorData; glass: EditorGlass[]; profile: EditorProfile[];
  customers: { id: string; name: string }[]; calc: EditorCalc; costTable: EditorCostTable; errorSection?: string | null; errorRow?: number | null;
}) {
  const { m, glass: glassCat, profile: profileCat, readOnly } = props;
  const e = m.editor;
  const seq = useRef(1000);
  const [d, setD] = useState(() => ({
    ...props.data,
    glass: props.data.glass.map((l, i) => ({ ...l, key: i })) as Keyed<GlassLine>[],
    profile: props.data.profile.map((l, i) => ({ ...l, key: 500 + i })) as Keyed<ProfileLine>[],
  }));
  const gById = useMemo(() => new Map(glassCat.map((g) => [g.id, g])), [glassCat]);
  const pById = useMemo(() => new Map(profileCat.map((p) => [p.id, p])), [profileCat]);
  const nf = (frac: number, max = frac) => new Intl.NumberFormat(props.locale === 'ro' ? 'ro-RO' : 'tr-TR', { minimumFractionDigits: frac, maximumFractionDigits: max });
  const money = (v: string | null | undefined) => (v == null ? '—' : `${nf(2).format(Number(v))} €`);
  const area = (v: string | null | undefined) => (v == null ? '—' : nf(3).format(Number(v)));

  const payloadObj = {
    no: d.no.trim(), date: d.date, customerId: d.customerId, firmName: d.firmName.trim(), validityDays: d.validityDays.trim(),
    terms: d.terms.split('\n').map((s) => s.trim()).filter(Boolean), note: d.note.trim(), glassExtraCost: d.glassExtraCost.trim(),
    glass: d.glass.map((l) => ({ productId: l.productId, description: l.description, en: l.en, boy: l.boy, qty: l.qty, price: l.price, cost: l.cost })),
    profile: d.profile.map((l) => ({ productId: l.productId, description: l.description, color: l.color, meters: l.meters, qty: l.qty, price: l.price, cost: l.cost })),
  };
  const payload = JSON.stringify(payloadObj);
  const [initial] = useState(payload);
  const dirty = payload !== initial;
  const pv = previewOffer(payloadObj, (id) => pById.get(id)?.content ?? null);
  const T = pv.totals;

  const set = (patch: Partial<Omit<EditorData, 'glass' | 'profile'>>) => setD((x) => ({ ...x, ...patch }));
  const setG = (key: number, patch: Partial<GlassLine>) => setD((x) => ({ ...x, glass: x.glass.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  const setP = (key: number, patch: Partial<ProfileLine>) => setD((x) => ({ ...x, profile: x.profile.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  const pickGlass = (key: number, id: string) => setD((x) => ({
    ...x,
    glass: x.glass.map((l) => {
      if (l.key !== key) return l;
      const prev = gById.get(l.productId);
      const next = gById.get(id);
      // Maliyet: boşsa ya da önceki camın liste fiyatıysa yeni camın liste fiyatı (yoksa boş — değer uydurulmaz); elle girilmiş
      // farklı maliyet korunur.
      const autoCost = !l.cost.trim() || (prev?.listCost != null && l.cost === asInput(prev.listCost));
      return {
        ...l, productId: id,
        description: !l.description || l.description === (prev?.descRo ?? '') ? next?.descRo ?? '' : l.description,
        cost: autoCost ? asInput(next?.listCost) : l.cost,
      };
    }),
  }));
  const pickProfile = (key: number, id: string) => {
    const p = pById.get(id);
    setP(key, { productId: id, description: p?.nameRo ?? '', color: '', meters: '', qty: '', price: asInput(p?.price), cost: asInput(p?.cost) });
  };
  const addGlass = () => setD((x) => ({ ...x, glass: [...x.glass, { key: ++seq.current, productId: '', description: '', en: '', boy: '', qty: '', price: '', cost: '' }] }));
  const addProfile = () => setD((x) => ({ ...x, profile: [...x.profile, { key: ++seq.current, productId: '', description: '', color: '', meters: '', qty: '', price: '', cost: '' }] }));

  // ---- Profil hesaplayıcısı (mevcut kural; yalnızca okur): sonuç satırları tabloya eklenir
  const [calc, setCalc] = useState({ profileId: props.calc.profiles[0]?.id ?? '', handrailId: '', color: '', thicknessId: '', meters: '' });
  const [calcMsg, setCalcMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const runCalc = () => start(async () => {
    const r = await calcOfferProfileAction(calc);
    if (!r.ok) { setCalcMsg({ ok: false, text: interpolate(e.calc.failed, { reason: r.errors.join(' · ') }) }); return; }
    setD((x) => ({
      ...x,
      profile: [...x.profile, ...r.lines.map((l) => {
        const p = pById.get(l.productId);
        return { key: ++seq.current, productId: l.productId, description: p?.nameRo ?? '', color: l.color, meters: l.meters ? asInput(l.meters) : '', qty: l.qty != null ? String(l.qty) : '', price: asInput(p?.price), cost: asInput(p?.cost) };
      })],
    }));
    setCalcMsg({ ok: true, text: interpolate(e.calc.added, { n: r.lines.length }) });
  });

  // Sunucunun bildirdiği satır ya da eksik / hatalı satır (toplama katılmayan) kırmızı; böyle satır varken kayıt kapalı
  const bad = (section: 'glass' | 'profile', i: number) => (props.errorSection === section && props.errorRow === i + 1) || pv[section][i] == null;
  const canSave = pv.invalid === 0 && (!!d.firmName.trim() || !!d.customerId) && /^\d{4}-\d{2}-\d{2}$/.test(d.date);
  const profileGroups = useMemo(() => {
    const out = new Map<string, EditorProfile[]>();
    for (const p of profileCat) out.set(p.category, [...(out.get(p.category) ?? []), p]);
    return [...out];
  }, [profileCat]);

  return (
    <>
      <form action={props.mode === 'new' ? createOfferAction : saveOfferAction} id="teklif-formu">
        {props.offerId && <input type="hidden" name="offerId" value={props.offerId} />}
        {props.editVersion != null && <input type="hidden" name="editVersion" value={props.editVersion} />}
        <input type="hidden" name="offer" value={payload} />
        <fieldset disabled={readOnly} className="fieldset-plain">
          <div className="card" id="bilgiler">
            <h2>{e.header}</h2>
            {readOnly && <div className="alert alert-info">{e.readonly}</div>}
            <div className="grid-3">
              <div>
                <label htmlFor="co-no">{e.no}</label>
                <input id="co-no" className="mono" inputMode="numeric" maxLength={6} value={d.no} onChange={(ev) => set({ no: ev.target.value })} readOnly={!props.noEditable} />
                <div className="hint">{props.noEditable ? e.noHint : e.noLocked}</div>
              </div>
              <div>
                <label htmlFor="co-date">{e.date}</label>
                <input id="co-date" type="date" required value={d.date} onChange={(ev) => set({ date: ev.target.value })} />
              </div>
              <div>
                <label htmlFor="co-validity">{e.validity}</label>
                <input id="co-validity" inputMode="numeric" maxLength={3} value={d.validityDays} onChange={(ev) => set({ validityDays: ev.target.value })} />
              </div>
              <div>
                <label htmlFor="co-customer">{e.customer}</label>
                <select id="co-customer" value={d.customerId} onChange={(ev) => set({ customerId: ev.target.value })}>
                  <option value="">{e.customerNone}</option>
                  {props.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="co-firm">{e.firm}</label>
                <input id="co-firm" maxLength={160} value={d.firmName} onChange={(ev) => set({ firmName: ev.target.value })}
                  placeholder={props.customers.find((c) => c.id === d.customerId)?.name ?? ''} />
                <div className="hint">{e.firmHint}</div>
              </div>
            </div>
          </div>

          <div className="card" id="cam">
            <h2>{e.glass}</h2>
            {props.costTable.name
              ? <p className="hint" data-cost-table="ok">{interpolate(e.costTableOk, { name: props.costTable.name })}</p>
              : <div className="alert alert-warn" data-cost-table={props.costTable.reason ?? 'MISSING'}>{e.costTableMissing}</div>}
            <div className="table-wrap">
              <table className="commercial-lines" data-section="glass">
                <thead>
                  <tr>
                    <th>#</th><th>{e.col.glass}</th><th>{e.col.description}</th><th className="num">{e.col.en}</th><th className="num">{e.col.boy}</th>
                    <th className="num">{e.col.qty}</th><th className="num">{e.col.m2}</th><th className="num">{e.col.price}</th><th className="num">{e.col.amount}</th>
                    <th className="num">{e.col.cost}</th><th className="num">{e.col.costAmount}</th><th className="num">{e.col.profit}</th><th />
                  </tr>
                </thead>
                <tbody>
                  {d.glass.length === 0 && <tr><td colSpan={13} className="empty">{e.empty}</td></tr>}
                  {d.glass.map((l, i) => {
                    const c = pv.glass[i];
                    const n = i + 1;
                    return (
                      <tr key={l.key} data-glass-line={n} className={bad('glass', i) ? 'row-alert' : undefined}>
                        <td className="muted">{n}</td>
                        <td>
                          <select value={l.productId} onChange={(ev) => pickGlass(l.key, ev.target.value)} aria-label={`${e.col.glass} ${n}`}>
                            <option value="" disabled>{e.pickGlass}</option>
                            {glassCat.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
                          </select>
                        </td>
                        <td><input className="text-input" maxLength={200} value={l.description} onChange={(ev) => setG(l.key, { description: ev.target.value })} aria-label={`${e.col.description} ${n}`} /></td>
                        <td className="num"><input className="qty-input" inputMode="numeric" maxLength={5} value={l.en} onChange={(ev) => setG(l.key, { en: ev.target.value })} aria-label={`${e.col.en} ${n}`} /></td>
                        <td className="num"><input className="qty-input" inputMode="numeric" maxLength={5} value={l.boy} onChange={(ev) => setG(l.key, { boy: ev.target.value })} aria-label={`${e.col.boy} ${n}`} /></td>
                        <td className="num"><input className="qty-input" inputMode="numeric" maxLength={6} value={l.qty} onChange={(ev) => setG(l.key, { qty: ev.target.value })} aria-label={`${e.col.qty} ${n}`} /></td>
                        <td className="num nowrap" data-m2>{area(c?.m2)}</td>
                        <td className="num"><input className="price-input" inputMode="decimal" maxLength={14} value={l.price} onChange={(ev) => setG(l.key, { price: ev.target.value })} aria-label={`${e.col.price} ${n}`} /></td>
                        <td className="num nowrap" data-amount>{money(c?.amount)}</td>
                        <td className="num">
                          <input className="price-input" inputMode="decimal" maxLength={14} value={l.cost} onChange={(ev) => setG(l.key, { cost: ev.target.value })} aria-label={`${e.col.cost} ${n}`} />
                          {(() => {
                            const lc = gById.get(l.productId)?.listCost ?? null;
                            if (!l.productId) return null;
                            if (lc == null) return <div className="hint" data-list-cost="none">{e.listCostNone}</div>;
                            const manual = !!l.cost.trim() && l.cost.trim() !== asInput(lc);
                            return <div className="hint" data-list-cost={manual ? 'manual' : 'list'}>{interpolate(manual ? e.listCostManual : e.listCostFrom, { v: nf(2, 4).format(Number(lc)) })}</div>;
                          })()}
                        </td>
                        <td className="num nowrap">{money(c?.costAmount)}</td>
                        <td className="num nowrap">{money(c?.profit)}</td>
                        <td>{!readOnly && <button type="button" className="btn btn-link danger" onClick={() => setD((x) => ({ ...x, glass: x.glass.filter((r) => r.key !== l.key) }))}>{e.remove}</button>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!readOnly && <button type="button" className="btn" onClick={addGlass} style={{ marginTop: 8 }} disabled={d.glass.length >= 100}>{e.addGlass}</button>}
            <div className="grid-3" style={{ marginTop: 12 }}>
              <div>
                <label htmlFor="co-extra">{e.extraCost}</label>
                <input id="co-extra" inputMode="decimal" maxLength={14} value={d.glassExtraCost} onChange={(ev) => set({ glassExtraCost: ev.target.value })} />
                <div className="hint">{e.extraCostHint}{T.extraPerM2 ? ` · ${interpolate(e.totals.extraPerM2, { v: nf(2, 4).format(Number(T.extraPerM2)) })}` : ''}</div>
              </div>
            </div>
          </div>

          <div className="card" id="profil">
            <h2>{e.profile}</h2>
            {!readOnly && (
              <div className="commercial-calc" id="hesaplayici">
                <h3>{e.calc.title}</h3>
                <p className="hint">{e.calc.hint}</p>
                {props.calc.profiles.length === 0 ? <div className="alert alert-warn">{e.calc.unavailable}</div> : (
                  <>
                    <div className="calc-grid">
                      <div className="calc-field">
                        <label htmlFor="cc-profile">{e.calc.profile}</label>
                        <select id="cc-profile" value={calc.profileId} onChange={(ev) => setCalc({ ...calc, profileId: ev.target.value })}>
                          {props.calc.profiles.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                        </select>
                      </div>
                      <div className="calc-field">
                        <label htmlFor="cc-handrail">{e.calc.handrail}</label>
                        <select id="cc-handrail" value={calc.handrailId} onChange={(ev) => setCalc({ ...calc, handrailId: ev.target.value })}>
                          <option value="">{e.calc.none}</option>
                          {props.calc.handrails.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                        </select>
                      </div>
                      <div className="calc-field">
                        <label htmlFor="cc-color">{e.calc.color}</label>
                        <select id="cc-color" value={calc.color} onChange={(ev) => setCalc({ ...calc, color: ev.target.value })}>
                          <option value="">—</option>
                          {props.calc.colors.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                        </select>
                      </div>
                      <div className="calc-field">
                        <label htmlFor="cc-thickness">{e.calc.thickness}</label>
                        <select id="cc-thickness" value={calc.thicknessId} onChange={(ev) => setCalc({ ...calc, thicknessId: ev.target.value })}>
                          <option value="">—</option>
                          {props.calc.thicknesses.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                        </select>
                      </div>
                      <div className="calc-field calc-meters">
                        <label htmlFor="cc-meters">{e.calc.meters}</label>
                        <input id="cc-meters" inputMode="decimal" maxLength={10} value={calc.meters} onChange={(ev) => setCalc({ ...calc, meters: ev.target.value })}
                          onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); runCalc(); } }} />
                      </div>
                    </div>
                    <div className="calc-actions">
                      <button type="button" className="btn" onClick={runCalc} disabled={pending || !calc.meters.trim()} data-calc-run>{e.calc.run}</button>
                    </div>
                    {calcMsg && <div className={`alert ${calcMsg.ok ? 'alert-ok' : 'alert-error'}`} role="status" style={{ marginTop: 8 }}>{calcMsg.text}</div>}
                  </>
                )}
              </div>
            )}
            <div className="table-wrap">
              <table className="commercial-lines" data-section="profile">
                <thead>
                  <tr>
                    <th>#</th><th>{e.col.product}</th><th>{e.col.description}</th><th>{e.col.color}</th><th className="num">{e.col.meters} / {e.col.quantity}</th>
                    <th className="num">{e.col.quantity}</th><th className="num">{e.col.unitPrice}</th><th className="num">{e.col.amount}</th>
                    <th className="num">{e.col.unitCost}</th><th className="num">{e.col.costAmount}</th><th className="num">{e.col.profit}</th><th />
                  </tr>
                </thead>
                <tbody>
                  {d.profile.length === 0 && <tr><td colSpan={12} className="empty">{e.empty}</td></tr>}
                  {d.profile.map((l, i) => {
                    const c = pv.profile[i];
                    const p = pById.get(l.productId);
                    const n = i + 1;
                    return (
                      <tr key={l.key} data-profile-line={n} data-code={p?.code ?? ''} className={bad('profile', i) ? 'row-alert' : undefined}>
                        <td className="muted">{n}</td>
                        <td>
                          <select value={l.productId} onChange={(ev) => pickProfile(l.key, ev.target.value)} aria-label={`${e.col.product} ${n}`}>
                            <option value="" disabled>{e.pickProduct}</option>
                            {profileGroups.map(([cat, list]) => (
                              <optgroup key={cat} label={cat}>{list.map((x) => <option key={x.id} value={x.id}>{x.code} — {x.label}</option>)}</optgroup>
                            ))}
                          </select>
                          {p?.content && <div className="small muted">{interpolate(e.perMl, { content: nf(0, 3).format(Number(p.content)), unit: p.unit })}</div>}
                        </td>
                        <td><input className="text-input" maxLength={200} value={l.description} onChange={(ev) => setP(l.key, { description: ev.target.value })} aria-label={`${e.col.description} ${n}`} /></td>
                        <td>
                          <select value={l.color} onChange={(ev) => setP(l.key, { color: ev.target.value })} aria-label={`${e.col.color} ${n}`}>
                            <option value="">{e.colorNone}</option>
                            {PROFILE_COLORS.map((cv) => <option key={cv} value={cv}>{props.calc.colors.find((x) => x.value === cv)?.label ?? cv}</option>)}
                          </select>
                        </td>
                        <td className="num">
                          {p?.content
                            ? <input className="qty-input" inputMode="decimal" maxLength={10} value={l.meters} onChange={(ev) => setP(l.key, { meters: ev.target.value })} aria-label={`${e.col.meters} ${n}`} data-meters />
                            : <input className="qty-input" inputMode="numeric" maxLength={6} value={l.qty} onChange={(ev) => setP(l.key, { qty: ev.target.value })} aria-label={`${e.col.quantity} ${n}`} data-qty />}
                        </td>
                        <td className="num nowrap" data-bill>
                          {(() => {
                            // Miktar fiyattan bağımsız gösterilir (aynı kural: billQuantity)
                            const q = p ? billQuantity(l, p.content) : null;
                            if (!q) return '—';
                            return <>{nf(0, 3).format(Number(q.bill))} {p?.content ? 'ML' : p?.unit}{p?.content && <div className="small muted">{interpolate(e.packs, { n: q.packs, unit: p.unit })}</div>}</>;
                          })()}
                        </td>
                        <td className="num"><input className="price-input" inputMode="decimal" maxLength={14} value={l.price} onChange={(ev) => setP(l.key, { price: ev.target.value })} aria-label={`${e.col.unitPrice} ${n}`} /></td>
                        <td className="num nowrap" data-amount>{money(c?.amount)}</td>
                        <td className="num">
                          <input className="price-input" inputMode="decimal" maxLength={14} value={l.cost} onChange={(ev) => setP(l.key, { cost: ev.target.value })} aria-label={`${e.col.unitCost} ${n}`} />
                          {(() => {
                            const p = pById.get(l.productId);
                            if (!p) return null;
                            const v = l.cost.trim();
                            const src = v && p.stockCost != null && v === asInput(p.stockCost) ? 'stock' : v && p.catalogCost != null && v === asInput(p.catalogCost) ? 'catalog' : v ? 'manual' : 'none';
                            return (
                              <div className="hint" data-cost-source={src}>
                                {p.stockCost != null && <div>{interpolate(e.stockCost, { v: nf(2, 4).format(Number(p.stockCost)) })}</div>}
                                {p.catalogCost != null && <div>{interpolate(e.catalogCost, { v: nf(2, 4).format(Number(p.catalogCost)) })}</div>}
                                {p.stockCost == null && p.catalogCost == null && <div>{e.noCost}</div>}
                              </div>
                            );
                          })()}
                        </td>
                        <td className="num nowrap">{money(c?.costAmount)}</td>
                        <td className="num nowrap">{money(c?.profit)}</td>
                        <td>{!readOnly && <button type="button" className="btn btn-link danger" onClick={() => setD((x) => ({ ...x, profile: x.profile.filter((r) => r.key !== l.key) }))}>{e.remove}</button>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!readOnly && <button type="button" className="btn" onClick={addProfile} style={{ marginTop: 8 }} disabled={d.profile.length >= 200}>{e.addProfile}</button>}
          </div>

          <div className="card" id="kosullar">
            <div className="grid-2">
              <div>
                <label htmlFor="co-terms">{e.terms}</label>
                <textarea id="co-terms" rows={8} value={d.terms} onChange={(ev) => set({ terms: ev.target.value })} />
                <div className="hint">{e.termsHint}</div>
              </div>
              <div>
                <label htmlFor="co-note">{e.note}</label>
                <textarea id="co-note" rows={8} maxLength={1000} value={d.note} onChange={(ev) => set({ note: ev.target.value })} />
                <div className="hint">{e.noteHint}</div>
              </div>
            </div>
          </div>
        </fieldset>

        <div className="card" id="toplamlar">
          <h2>{e.totals.title}</h2>
          <p className="hint">{m.internalOnly}</p>
          <table className="kv" data-totals>
            <tbody>
              <tr><td>{e.totals.glassM2}</td><td className="num" data-total="glassM2">{area(T.glassM2)}</td></tr>
              <tr><td>{e.totals.glass}</td><td className="num" data-total="glass">{money(T.glass)}</td></tr>
              <tr><td>{e.totals.profile}</td><td className="num" data-total="profile">{money(T.profile)}</td></tr>
              <tr><td><strong>{e.totals.total}</strong></td><td className="num" data-total="total"><strong>{money(T.total)}</strong></td></tr>
              <tr><td>{e.totals.extra}</td><td className="num">{money(T.extraCost)}</td></tr>
              <tr><td>{e.totals.cost}</td><td className="num" data-total="cost">{money(T.cost)}</td></tr>
              <tr><td>{e.totals.profit}</td><td className="num" data-total="profit">{money(T.profit)}</td></tr>
              <tr><td>{e.totals.margin}</td><td className="num" data-total="margin">{T.margin != null ? `%${nf(2).format(Number(T.margin))}` : '—'}</td></tr>
            </tbody>
          </table>
          {T.missingCost > 0 && <div className="alert alert-warn" data-missing-cost>{interpolate(e.totals.missingCost, { n: T.missingCost })}</div>}
          {pv.invalid > 0 && <div className="alert alert-warn" data-invalid>{interpolate(e.totals.invalid, { n: pv.invalid })}</div>}
          {!readOnly && (
            <div className="row" style={{ marginTop: 8 }}>
              <button type="submit" className="btn btn-primary" data-save disabled={!canSave}>{props.mode === 'new' ? e.create : e.save}</button>
              {dirty && props.mode === 'edit' && <span className="muted small" data-unsaved>{e.unsaved}</span>}
            </div>
          )}
        </div>
      </form>

      {props.mode === 'edit' && !readOnly && props.offerId && (
        <form action={issueOfferAction} className="card" id="kesinlestir">
          <input type="hidden" name="offerId" value={props.offerId} />
          <input type="hidden" name="editVersion" value={props.editVersion} />
          {dirty
            ? <p className="muted">{m.actions.issueUnsaved}</p>
            : <ConfirmButton success message={interpolate(m.actions.issueConfirm, { v: props.version ?? 1 })}>{m.actions.issue}</ConfirmButton>}
        </form>
      )}
    </>
  );
}
