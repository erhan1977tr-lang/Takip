'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import type { Dict } from '@/lib/i18n';
import { rich } from '@/lib/rich';
import { interpolate } from '@/server/i18n/interpolate.js';
import { ALLOWED_EXT, fileProblem } from '@/server/orders/rules.js';
import { createOrderAction, type NewOrderState } from './actions';

/** Katalogdaki cam, kullanıcının dilinde: group = cam adı, label = ad — renk */
export type GlassOption = { id: string; group: string; label: string };
export type DraftData = {
  id: string; title: string; no: string | null; note: string;
  lines: { id: string; qty: string }[]; files: { id: string; name: string; size: number; pending: boolean }[];
};
// Kabul edilen türler tek yerden: server/orders/rules.js (sunucu da aynı listeyle ve içerik kontrolüyle denetler)
const ACCEPT = ALLOWED_EXT.map((e: string) => `.${e}`).join(',');
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 1024 * 1024 ? 2 : 1)} MB`;
const extOf = (name: string) => (name.includes('.') ? name.split('.').pop()!.slice(0, 4) : '');
const sameFile = (a: File, b: File) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
/** Seçimi dosya alanına yazar (form bu alanı gönderir). Eski tarayıcıda DataTransfer yoksa alan olduğu gibi kalır. */
function applyFiles(el: HTMLInputElement | null, list: File[]) {
  if (!el) return;
  try {
    const dt = new DataTransfer();
    list.forEach((f) => dt.items.add(f));
    el.files = dt.files;
  } catch {
    /* alan tarayıcının son seçimiyle kalır */
  }
}

/**
 * Müşterinin yeni cam siparişi formu (eski TAKİP düzeni): sipariş bilgileri → dosyalar → cam → ek bilgi → gönder.
 * Bir siparişte TEK cam tipi seçilir (karar 85; sunucu da ikinci camı reddeder). Dosyalar aynı <input type="file">
 * ile gönderilir (kayıt, içerik kontrolü ve antivirüs sunucuda değişmedi); burada yalnızca seçim kolaylaşır:
 * sürükle-bırak, birkaç seferde ekleme, listeden çıkarma.
 * m: sözlüğün newOrder.form parçası (sunucudaki sayfa, kullanıcının diline göre verir).
 */
export function NewOrderForm({ catalog, suggestedNo, prefix, shipDate, draft, m }: {
  catalog: GlassOption[]; suggestedNo: number; prefix: string; shipDate: string; draft?: DraftData; m: Dict['newOrder']['form'];
}) {
  const [state, action, pending] = useActionState<NewOrderState, FormData>(createOrderAction, {});
  const v = state.values;
  // Siparişte tek cam tipi; eski taslakta birden çok cam varsa ilki gelir. Cam ADEDİ formda yok (karar 160): adetleri,
  // ölçüleri ve fiyatı satış ekibi müşterinin dosyalarına göre teklif tablosunda girer.
  const [glassId, setGlassId] = useState<string>(() => v?.glasses[0]?.id ?? draft?.lines[0]?.id ?? '');
  const [picked, setPicked] = useState<File[]>([]);
  const [over, setOver] = useState(false);
  const [removed, setRemoved] = useState<string[]>(v?.removed ?? []);
  const [no, setNo] = useState(v?.no ?? draft?.no ?? String(suggestedNo));
  const [title, setTitle] = useState(v?.title ?? draft?.title ?? '');
  const input = useRef<HTMLInputElement>(null);
  const kept = (draft?.files ?? []).filter((f) => !removed.includes(f.id));
  const hasFile = picked.length + kept.length > 0;
  const hasGlass = !!glassId;
  const ready = hasFile && hasGlass && !!title.trim();
  const groups = [...new Set(catalog.map((c) => c.group))];

  const setFiles = (list: File[]) => { applyFiles(input.current, list); setPicked(list); };
  const addFiles = (incoming: File[]) => setFiles([...picked, ...incoming.filter((f) => !picked.some((p) => sameFile(p, f)))]);
  // Sunucu hata döndürünce tarayıcı formu sıfırlar: cam seçimi, "çıkar" işaretleri ve seçilen dosyalar ekrandaki
  // duruma göre alanlara geri yazılır (müşteri yeniden seçmek zorunda kalmaz; gönderilen form ekranla aynı olur)
  useEffect(() => {
    const f = input.current?.form;
    if (!f) return;
    const sel = f.querySelector<HTMLSelectElement>('select[name=glassId]');
    if (sel && sel.value !== glassId) sel.value = glassId;
    f.querySelectorAll<HTMLInputElement>('input[name=removeFile]').forEach((c) => { c.checked = removed.includes(c.value); });
    if (picked.length && input.current && input.current.files?.length !== picked.length) applyFiles(input.current, picked);
  }, [state, glassId, removed, picked]);

  return (
    <form action={action}>
      {draft && <input type="hidden" name="draftId" value={draft.id} />}
      <div className="card">
        <h2>{m.info.title}</h2>
        {/* Tarih, siparişe yazılacak tarihle aynı hesaptan gelir (server/orders/rules.js → glassLoadingDate) */}
        <div className="alert alert-info ship-note">{rich(m.info.shipNote, { date: <b>{shipDate}</b> })}</div>
        <div className="grid-2">
          <div>
            <label htmlFor="title">{m.info.name}</label>
            <input id="title" name="title" type="text" required maxLength={160} placeholder={m.info.namePlaceholder} value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label htmlFor="no">{m.info.number}</label>
            <input id="no" name="customerOrderNo" type="text" inputMode="numeric" required value={no} onChange={(e) => setNo(e.target.value.replace(/\D/g, ''))} />
            {/* Önerilen numara değiştirilmediyse ve bu arada başka sipariş aldıysa sunucu bir sonraki numarayı verir */}
            <input type="hidden" name="suggestedNo" value={suggestedNo} />
            <div className="hint">{rich(m.info.numberHint, { code: <b>{prefix}{no || '…'}</b> })}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>{m.files.title}</h2>
        <label
          htmlFor="files" className={`dropzone${over ? ' over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); addFiles(Array.from(e.dataTransfer.files ?? [])); }}
        >
          <input ref={input} id="files" name="files" type="file" multiple accept={ACCEPT} className="dropzone-input" required={kept.length === 0}
            onChange={(e) => addFiles(Array.from(e.target.files ?? []))} />
          <span className="dropzone-icon" aria-hidden="true">↑</span>
          <b>{m.files.drop}</b>
          <span>{m.files.pick}</span>
          <span className="muted small">{m.files.limits}</span>
        </label>

        {picked.length > 0 && (
          <div className="upload-list" id="secilen-dosyalar">
            <div className="section-head">
              <h3 className="sub-title">{interpolate(m.files.selected, { n: picked.length })}</h3>
              <span className="muted small">{interpolate(m.files.total, { size: mb(picked.reduce((s, f) => s + f.size, 0)) })}</span>
            </div>
            {picked.map((f, i) => (
              <div className="file-row" key={`${f.name}-${f.size}-${f.lastModified}`}>
                <div className="file-ext">{extOf(f.name)}</div>
                <div className="grow">
                  <div className="fname">{f.name}</div>
                  <div className="small muted">{mb(f.size)}{fileProblem(f.name, f.size) && <> <span className="badge badge-danger">{m.files.invalid}</span></>}</div>
                </div>
                <button type="button" className="btn btn-link danger" aria-label={`${m.files.remove}: ${f.name}`} onClick={() => setFiles(picked.filter((_, j) => j !== i))}>{m.files.remove}</button>
              </div>
            ))}
          </div>
        )}

        {draft && draft.files.length > 0 && (
          <div className="upload-list">
            <h3 className="sub-title">{interpolate(m.files.saved, { n: kept.length })}</h3>
            {draft.files.map((f) => {
              const off = removed.includes(f.id);
              return (
                <div key={f.id} className={`file-row${off ? ' removed' : ''}`}>
                  <div className="file-ext">{extOf(f.name)}</div>
                  <div className="grow">
                    <div className="fname">{f.name}</div>
                    <div className="small muted">{mb(f.size)}{f.pending && <> <span className="badge badge-warn" title={m.files.scanPending}>{m.files.scanPending}</span></>}</div>
                  </div>
                  <label className="check small">
                    <input type="checkbox" name="removeFile" value={f.id} checked={off}
                      onChange={(e) => setRemoved(e.target.checked ? [...removed, f.id] : removed.filter((x) => x !== f.id))} />
                    {m.files.remove}
                  </label>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="card">
        <h2>{m.glass.title}</h2>
        <p className="muted small">{m.glass.intro}</p>
        {catalog.length === 0 && <div className="alert alert-warn">{m.glass.catalogEmpty}</div>}
        <div className="glass-pick">
          <div>
            <label htmlFor="glass">{m.glass.glass}</label>
            <select id="glass" name="glassId" value={glassId} required onChange={(e) => setGlassId(e.target.value)}>
              <option value="">{m.glass.pick}</option>
              {groups.map((g) => (
                <optgroup key={g} label={g}>
                  {catalog.filter((c) => c.group === g).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
        </div>
        <p className="hint">{m.glass.oneOnly}</p>
      </div>

      <div className="card">
        <h2 id="note-title">{m.note.title}</h2>
        <p className="muted small" id="note-intro">{m.note.intro}</p>
        <textarea id="note" name="note" rows={4} maxLength={2000} defaultValue={v?.note ?? draft?.note ?? ''} placeholder={m.note.placeholder} aria-labelledby="note-title" aria-describedby="note-intro" />
      </div>

      {state.error && <div className="alert alert-error" role="alert">{state.error}</div>}
      <div className="card submit-bar sticky-submit">
        <ul className="submit-check">
          {ready ? <li className="done">{m.submit.ready}</li> : (
            <>
              {!title.trim() && <li>{m.submit.needTitle}</li>}
              {!hasFile && <li>{m.submit.needFile}</li>}
              {!hasGlass && <li>{m.submit.needGlass}</li>}
            </>
          )}
        </ul>
        <div className="row">
          {/* Taslak: zorunlu alanlar boş olabilir (tarayıcı kontrolü atlanır; sunucu gevşek kurallarla kaydeder) */}
          <button type="submit" name="intent" value="draft" className="btn" formNoValidate disabled={pending}>{m.submit.draft}</button>
          <button type="submit" name="intent" value="submit" className="btn btn-primary" disabled={pending || !ready}>{pending ? m.submit.sending : m.submit.send}</button>
        </div>
      </div>
    </form>
  );
}
