'use client';

import { useEffect, useRef, useState } from 'react';

type Row = { key: number; email: string; isActive: boolean; isPrimary: boolean };
export type SupplierEmailText = {
  title: string; hint: string; add: string; remove: string; active: string; primary: string; limit: string; email: string; empty: string;
};

/**
 * Tedarikçinin e-posta adresleri (DÜZELTME 10 M9): en çok 10 adres; "+ E-posta ekle", düzenle, sil, etkin / pasif, birincil.
 * Liste gizli "emails" alanında JSON olarak gönderilir; sunucu her şeyi yeniden doğrular (geçerlilik, aynı adres, sınır).
 */
export function SupplierEmails({ initial, text, max }: { initial: { email: string; isActive: boolean; isPrimary: boolean }[]; text: SupplierEmailText; max: number }) {
  const seq = useRef(initial.length);
  const start = () => (initial.length ? initial : [{ email: '', isActive: true, isPrimary: true }]).map((r, i) => ({ ...r, key: i }));
  const [rows, setRows] = useState<Row[]>(start);
  const box = useRef<HTMLFieldSetElement>(null);
  // Form gönderildikten sonra React formu sıfırlar ("reset" olayı): liste de başlangıç hâline döner (yeni tedarikçi eklenince
  // önceki adres bir sonraki forma taşınmaz)
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    const form = box.current?.form;
    if (!form) return;
    const onReset = () => setRows(startRef.current());
    form.addEventListener('reset', onReset);
    return () => form.removeEventListener('reset', onReset);
  }, []);
  const set = (key: number, patch: Partial<Row>) => setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : patch.isPrimary ? { ...r, isPrimary: false } : r)));
  const json = JSON.stringify(rows.map(({ email, isActive, isPrimary }) => ({ email: email.trim(), isActive, isPrimary })));
  return (
    <fieldset className="fieldset-plain" data-supplier-emails ref={box}>
      <legend className="label">{text.title}</legend>
      <input type="hidden" name="emails" value={json} />
      {rows.length === 0 && <p className="muted small">{text.empty}</p>}
      {rows.map((r, i) => (
        <div className="row" key={r.key} data-email-row={i + 1} style={{ flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
          <input type="email" id={i === 0 ? 'sp-email' : undefined} maxLength={200} autoComplete="off" value={r.email} aria-label={`${text.email} ${i + 1}`}
            onChange={(e) => set(r.key, { email: e.target.value })} style={{ flex: '1 1 240px', minWidth: 0 }} />
          <label className="check"><input type="checkbox" checked={r.isActive} onChange={(e) => set(r.key, { isActive: e.target.checked })} /> {text.active}</label>
          <label className="check"><input type="radio" name="emailPrimary" checked={r.isPrimary} onChange={() => set(r.key, { isPrimary: true })} /> {text.primary}</label>
          <button type="button" className="btn btn-link danger" onClick={() => setRows((list) => list.filter((x) => x.key !== r.key))}>{text.remove}</button>
        </div>
      ))}
      <button type="button" className="btn" data-add-email disabled={rows.length >= max}
        onClick={() => setRows((list) => [...list, { key: ++seq.current, email: '', isActive: true, isPrimary: list.length === 0 }])}>{text.add}</button>
      {rows.length >= max && <span className="muted small"> {text.limit}</span>}
      <div className="hint">{text.hint}</div>
    </fieldset>
  );
}
