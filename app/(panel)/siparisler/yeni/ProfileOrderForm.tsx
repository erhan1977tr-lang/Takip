'use client';

import { useActionState, useState } from 'react';
import type { Dict } from '@/lib/i18n';
import { rich } from '@/lib/rich';
import { interpolate } from '@/server/i18n/interpolate.js';
import { createProfileOrderAction, type ProfileOrderState } from './actions';

/** Katalog ürünü, kullanıcının dilinde */
export type ProfileOption = { id: string; code: string; name: string; unit: string; imageId: string | null; categoryCode: string };
export type ProfileCategoryOption = { code: string; name: string };
export type ProfileDraft = { id: string; title: string; no: string | null; note: string; qty: Record<string, string> };

/**
 * Profil siparişi formu: kategori kategori ürünler (görsel, ad/kod, birim, adet). Yalnızca adedi > 0 olan ürünler siparişe girer.
 * m: sözlüğün profile.form parçası
 */
export function ProfileOrderForm({ categories, products, suggestedNo, prefix, draft, m, notes }: {
  categories: ProfileCategoryOption[]; products: ProfileOption[]; suggestedNo: number; prefix: string; draft?: ProfileDraft;
  m: Dict['profile']['form']; notes: string[];
}) {
  const [state, action, pending] = useActionState<ProfileOrderState, FormData>(createProfileOrderAction, {});
  const v = state.values;
  const [qty, setQty] = useState<Record<string, string>>(v?.qty ?? draft?.qty ?? {});
  const [no, setNo] = useState(v?.no ?? draft?.no ?? String(suggestedNo));
  const selected = Object.values(qty).filter((q) => /^\d+$/.test(q) && Number(q) > 0).length;
  const code = `${prefix}P${no || '…'}`;

  return (
    <form action={action}>
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

      {products.length === 0 && <div className="alert alert-warn">{m.catalogEmpty}</div>}
      {categories.map((c) => {
        const list = products.filter((p) => p.categoryCode === c.code);
        if (!list.length) return null;
        const picked = list.filter((p) => /^\d+$/.test(qty[p.id] ?? '') && Number(qty[p.id]) > 0).length;
        return (
          <div className="card card-flush" key={c.code}>
            <div className="card-head">
              <h2>{c.name} <span className="badge">{list.length}</span></h2>
              {picked > 0 && <span className="badge badge-info">{interpolate(m.selected, { n: picked })}</span>}
            </div>
            <div className="table-wrap">
              {/* Sütun genişlikleri sabit: birim ve adet sütunları her kategoride aynı hizada */}
              <table className="profile-table profile-pick">
                <thead><tr><th className="c-thumb" /><th>{m.colProduct}</th><th className="c-unit">{m.colUnit}</th><th className="c-qty num">{m.colQty}</th></tr></thead>
                <tbody>
                  {list.map((p) => {
                    const q = qty[p.id] ?? '';
                    const on = /^\d+$/.test(q) && Number(q) > 0;
                    return (
                      <tr key={p.id} className={on ? 'picked' : undefined}>
                        <td className="thumb">{p.imageId ? <img src={`/dosya/urun/${p.imageId}`} alt="" loading="lazy" /> : null}</td>
                        <td><label htmlFor={`q-${p.id}`}><b>{p.name}</b></label><div className="muted small mono">{p.code}</div></td>
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
      <div className="card submit-bar sticky-submit">
        <ul className="submit-check">
          <li className={selected ? 'done' : undefined}>{selected ? interpolate(m.selected, { n: selected }) : m.submit.needItem}</li>
        </ul>
        <div className="row">
          <button type="submit" name="intent" value="draft" className="btn" formNoValidate disabled={pending}>{m.submit.draft}</button>
          <button type="submit" name="intent" value="submit" className="btn btn-primary" disabled={pending || selected === 0}>{pending ? m.submit.sending : m.submit.send}</button>
        </div>
      </div>
    </form>
  );
}
