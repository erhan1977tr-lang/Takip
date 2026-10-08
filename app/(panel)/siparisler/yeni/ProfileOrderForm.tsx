'use client';

import { useActionState, useRef, useState } from 'react';
import type { Dict } from '@/lib/i18n';
import { rich } from '@/lib/rich';
import { interpolate } from '@/server/i18n/interpolate.js';
import { createProfileOrderAction, type ProfileOrderState } from './actions';
import { checkProfileStockAction, type StockCheckLine } from './profile-calc-actions';
import { ProfileCalculator, type CalcOptions } from './ProfileCalculator';

/** Katalog ürünü, kullanıcının dilinde */
export type ProfileOption = { id: string; code: string; name: string; unit: string; imageId: string | null; categoryCode: string };
export type ProfileCategoryOption = { code: string; name: string };
export type ProfileDraft = { id: string; title: string; no: string | null; note: string; qty: Record<string, string> };

const picked = (q: string | undefined) => /^\d+$/.test(q ?? '') && Number(q) > 0;

/**
 * Profil siparişi formu: kategori kategori ürünler (görsel, ad/kod, birim, adet). Yalnızca adedi > 0 olan ürünler siparişe girer.
 * Üstte metraj hesaplayıcısı (Paket 5 — karar 175; yönetici en az bir sistem tanımladıysa): sonucu buradaki adetlere aktarılır,
 * müşteri sonra değiştirebilir ("hesaplandı" / "değiştirildi" işareti). "Siparişi gönder"den önce stok uyarısı (karar 177):
 * stoğu yetmeyen ürünler gösterilir, sipariş engellenmez ("Yine de gönder").
 * m: sözlüğün profile.form parçası · mc: profile.calc parçası
 */
export function ProfileOrderForm({ categories, products, suggestedNo, prefix, draft, m, mc, calc, notes }: {
  categories: ProfileCategoryOption[]; products: ProfileOption[]; suggestedNo: number; prefix: string; draft?: ProfileDraft;
  m: Dict['profile']['form']; mc: Dict['profile']['calc']; calc: CalcOptions | null; notes: string[];
}) {
  const [state, action, pending] = useActionState<ProfileOrderState, FormData>(createProfileOrderAction, {});
  const v = state.values;
  const [qty, setQtyState] = useState<Record<string, string>>(v?.qty ?? draft?.qty ?? {});
  const [no, setNo] = useState(v?.no ?? draft?.no ?? String(suggestedNo));
  // Hesaplayıcının yazdığı adetler (ürün id → adet): satırda "hesaplandı" ya da müşteri değiştirdiyse "değiştirildi"
  const [calcSet, setCalcSet] = useState<Record<string, string>>({});
  // Gönderim öncesi stok uyarısı
  const [shortage, setShortage] = useState<StockCheckLine[] | null>(null);
  const [checking, setChecking] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const skipCheck = useRef(false);
  const busy = useRef(false);
  const selected = Object.values(qty).filter(picked).length;
  const code = `${prefix}P${no || '…'}`;
  const names = Object.fromEntries(products.map((p) => [p.id, `${p.code} — ${p.name}`]));

  const setQty = (next: Record<string, string>) => {
    setQtyState(next);
    setShortage(null); // adet değişti: eski stok uyarısı geçersiz
  };
  const send = () => {
    skipCheck.current = true;
    formRef.current?.requestSubmit(sendRef.current ?? undefined);
  };
  // "Siparişi gönder": önce stok uyarısı (okur, yazmaz). Uyarı yoksa ya da denetim yapılamadıysa doğrudan gönderilir —
  // sipariş hiçbir durumda engellenmez; yetersizlik kaydı siparişle birlikte sunucuda yazılır.
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.value !== 'submit') return;
    if (skipCheck.current) { skipCheck.current = false; return; }
    e.preventDefault();
    if (busy.current) return; // denetim sürüyor (çift tıklama)
    busy.current = true;
    setChecking(true);
    checkProfileStockAction(Object.entries(qty).map(([id, q]) => ({ id, qty: q })))
      .then((r) => (r.ok && r.lines.length ? r.lines : null), () => null)
      .then((lines) => {
        busy.current = false;
        setChecking(false);
        if (lines) setShortage(lines);
        else send();
      });
  };

  return (
    <form action={action} ref={formRef} onSubmit={onSubmit}>
      {draft && <input type="hidden" name="draftId" value={draft.id} />}
      <div className="card">
        <h2>{m.info.title}</h2>
        <div className="grid-2">
          <div>
            <label htmlFor="title">{m.info.name}</label>
            <input id="title" name="title" type="text" maxLength={160} placeholder={m.info.namePlaceholder} defaultValue={v?.title ?? draft?.title ?? ''} />
          </div>
          <div>
            <label htmlFor="no">{m.info.number}</label>
            <input id="no" name="customerOrderNo" type="text" inputMode="numeric" required value={no} onChange={(e) => setNo(e.target.value.replace(/\D/g, ''))} />
            <input type="hidden" name="suggestedNo" value={suggestedNo} />
            <div className="hint">{rich(m.info.numberHint, { code: <b>{code}</b> })}</div>
          </div>
        </div>
      </div>

      {calc && products.length > 0 && (
        <ProfileCalculator
          options={calc} m={mc} qty={qty} names={names}
          onTransfer={(next, lines) => {
            setQty(next);
            setCalcSet((cur) => ({ ...cur, ...Object.fromEntries(lines.map((l) => [l.productId, String(l.qty)])) }));
          }}
        />
      )}

      {products.length === 0 && <div className="alert alert-warn">{m.catalogEmpty}</div>}
      {categories.map((c) => {
        const list = products.filter((p) => p.categoryCode === c.code);
        if (!list.length) return null;
        const count = list.filter((p) => picked(qty[p.id])).length;
        return (
          <div className="card card-flush" key={c.code}>
            <div className="card-head">
              <h2>{c.name} <span className="badge">{list.length}</span></h2>
              {count > 0 && <span className="badge badge-info">{interpolate(m.selected, { n: count })}</span>}
            </div>
            <div className="table-wrap">
              {/* Sütun genişlikleri sabit: birim ve adet sütunları her kategoride aynı hizada */}
              <table className="profile-table profile-pick">
                <thead><tr><th className="c-thumb" /><th>{m.colProduct}</th><th className="c-unit">{m.colUnit}</th><th className="c-qty num">{m.colQty}</th></tr></thead>
                <tbody>
                  {list.map((p) => {
                    const q = qty[p.id] ?? '';
                    const calcQ = calcSet[p.id];
                    return (
                      <tr key={p.id} className={picked(q) ? 'picked' : undefined}>
                        <td className="thumb">{p.imageId ? <img src={`/dosya/urun/${p.imageId}`} alt="" loading="lazy" /> : null}</td>
                        <td>
                          <label htmlFor={`q-${p.id}`}><b>{p.name}</b></label>
                          <div className="muted small mono">
                            {p.code}
                            {calcQ != null && (q === calcQ
                              ? <> <span className="badge badge-info" data-calc-mark="calc">{mc.markCalc}</span></>
                              : <> <span className="badge badge-warn" data-calc-mark="edited">{mc.markEdited}</span></>)}
                          </div>
                        </td>
                        <td className="muted">{p.unit}</td>
                        <td className="num">
                          <input type="hidden" name="p_id" value={p.id} />
                          <input id={`q-${p.id}`} name="p_qty" type="number" inputMode="numeric" min={0} max={100000} step={1} value={q} placeholder="0"
                            className="qty-input" aria-label={`${p.name} — ${m.colQty}`}
                            onChange={(e) => setQty({ ...qty, [p.id]: e.target.value.replace(/[^\d]/g, '') })} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      <div className="card">
        <h2 id="note-title">{m.note.title}</h2>
        <p className="muted small" id="note-intro">{m.note.intro}</p>
        <textarea id="note" name="note" rows={4} maxLength={2000} defaultValue={v?.note ?? draft?.note ?? ''} placeholder={m.note.placeholder} aria-labelledby="note-title" aria-describedby="note-intro" />
        <div className="offer-notes">{notes.map((n) => <p key={n}>{n}</p>)}</div>
      </div>

      {state.error && <div className="alert alert-error" role="alert">{state.error}</div>}
      {/* Stok uyarısı (karar 177): yalnızca bu formdaki, stoğu yetmeyen ürünler — sipariş engellenmez */}
      {shortage && (
        <div className="alert alert-warn" id="stok-uyari" role="alert" data-stock-check>
          <b>{m.stockCheck.title}</b>
          <p className="small">{m.stockCheck.intro}</p>
          <div className="table-wrap">
            <table className="profile-table stock-check-table">
              <thead>
                <tr>
                  <th>{m.stockCheck.colProduct}</th><th className="num">{m.stockCheck.colNeeded}</th>
                  <th className="num">{m.stockCheck.colAvailable}</th><th className="num">{m.stockCheck.colMissing}</th>
                </tr>
              </thead>
              <tbody>
                {shortage.map((l) => (
                  <tr key={l.productId} data-stock-check-row={l.code}>
                    <td><b>{l.name}</b> <span className="muted small mono">{l.code}</span></td>
                    <td className="num nowrap">{l.needed} <span className="muted small">{l.unit}</span></td>
                    <td className="num">{l.available}</td>
                    <td className="num text-danger"><b>{l.missing}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={() => { setShortage(null); send(); }} disabled={pending}>{m.stockCheck.send}</button>
            <button type="button" className="btn" onClick={() => setShortage(null)}>{m.stockCheck.back}</button>
          </div>
        </div>
      )}
      <div className="card submit-bar sticky-submit">
        <ul className="submit-check">
          <li className={selected ? 'done' : undefined}>{selected ? interpolate(m.selected, { n: selected }) : m.submit.needItem}</li>
        </ul>
        <div className="row">
          <button type="submit" name="intent" value="draft" className="btn" formNoValidate disabled={pending}>{m.submit.draft}</button>
          <button ref={sendRef} type="submit" name="intent" value="submit" className="btn btn-primary" disabled={pending || selected === 0}>
            {pending ? m.submit.sending : checking ? m.stockCheck.checking : m.submit.send}
          </button>
        </div>
      </div>
    </form>
  );
}
