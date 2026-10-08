'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { interpolate } from '@/server/i18n/interpolate.js';
import { PHOTO_EXT, PHOTO_MAX_BYTES } from '@/server/delivery/rules.js';

/** Sunucu işleminin yanıtı: tek fotoğraf (karar 195) */
export type PhotoUploadResult = { ok: true; duplicate: boolean } | { ok: false; error: string };

type State = 'waiting' | 'uploading' | 'done' | 'duplicate' | 'error';
type Item = { name: string; size: number; state: State; error?: string };

type Texts = {
  hint: string; choose: string; upload: string; progress: string;
  state: Record<State, string>;
  errors: { type: string; size: string; empty: string; other: string };
};

const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const TONE: Record<State, string> = { waiting: 'muted', uploading: 'info', done: 'ok', duplicate: 'info', error: 'danger' };

/**
 * Teslimat fotoğrafı yükleme (Paket 8, karar 195) — depo bağlantısı sayfası ve yöneticinin sipariş sayfası aynı bileşeni
 * kullanır. Seçilen fotoğraflar SIRAYLA, HER BİRİ AYRI istekle gönderilir: biri reddedilirse (tür, boyut, içerik, virüs,
 * sınır) yalnızca o fotoğraf "yüklenemedi" olur, öncekiler ve sonrakiler kaydedilir. Her fotoğrafın durumu ve toplam ilerleme
 * görünür. Sunucu her şeyi yeniden denetler (uzantı / boyut ön kontrolü yalnızca hızlı geri bildirimdir); aynı fotoğraf
 * ikinci kez gelirse yeni kayıt yazılmaz ("zaten yüklenmiş"). Bitince sayfanın verisi yenilenir (yeni fotoğraflar listede).
 */
export function DeliveryPhotoUpload({ action, hidden, m, inputId }: {
  action: (fd: FormData) => Promise<PhotoUploadResult>;
  hidden: Record<string, string>;
  m: Texts;
  inputId: string;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const set = (i: number, patch: Partial<Item>) => setItems((list) => list.map((x, k) => (k === i ? { ...x, ...patch } : x)));

  async function start() {
    const files: File[] = Array.from(input.current?.files ?? []);
    if (!files.length || busy) return;
    setItems(files.map((f) => ({ name: f.name, size: f.size, state: 'waiting' })));
    setBusy(true);
    let changed = false;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const dot = f.name.lastIndexOf('.');
      const ext = dot > 0 ? f.name.slice(dot + 1).toLowerCase() : '';
      const pre = !(PHOTO_EXT as readonly string[]).includes(ext) ? m.errors.type : f.size <= 0 ? m.errors.empty : f.size > PHOTO_MAX_BYTES ? m.errors.size : null;
      if (pre) { set(i, { state: 'error', error: pre }); continue; }
      set(i, { state: 'uploading' });
      const fd = new FormData();
      for (const [k, v] of Object.entries(hidden)) fd.set(k, v);
      fd.set('photo', f);
      try {
        const r = await action(fd);
        if (r.ok) {
          set(i, { state: r.duplicate ? 'duplicate' : 'done' });
          changed = true;
        } else set(i, { state: 'error', error: r.error });
      } catch {
        set(i, { state: 'error', error: m.errors.other });
      }
    }
    setBusy(false);
    if (input.current) input.current.value = '';
    if (changed) router.refresh();
  }

  const done = items.filter((x) => x.state !== 'waiting' && x.state !== 'uploading').length;
  return (
    <div className="photo-upload" data-photo-upload>
      <div className="row">
        <input ref={input} id={inputId} type="file" multiple accept=".jpg,.jpeg,.png,image/jpeg,image/png" disabled={busy} aria-label={m.choose} style={{ flex: 1, minWidth: 0 }} />
        <button type="button" className="btn btn-primary" onClick={start} disabled={busy}>{m.upload}</button>
      </div>
      <p className="hint">{m.hint}</p>
      {items.length > 0 && (
        <div className="photo-progress" aria-live="polite">
          <div className="small">{interpolate(m.progress, { done, total: items.length })}</div>
          <progress max={items.length} value={done} />
          <ul className="plain-list photo-status">
            {items.map((x, i) => (
              <li key={i} data-upload-state={x.state}>
                <span className="fname">{x.name}</span> <span className="muted small">{fmtSize(x.size)}</span>{' '}
                <span className={`badge badge-${TONE[x.state]}`}>{m.state[x.state]}</span>
                {x.error && <div className="small text-danger">{x.error}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
