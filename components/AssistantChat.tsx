'use client';
// Panel AI asistanı (3.95.0, karar 290): sağ altta sohbet düğmesi → açılır pencere (masaüstü) / tam ekran (mobil).
// - Yalnızca ASSISTANT_PANEL yetkisi olan kullanıcıya çizilir (panel düzeni); sunucu eylemi ve işçi ayrıca denetler.
// - Sayfa açılışında, yenilemede ve otomatik yenilemede HİÇBİR AI isteği yapılmaz: istek yalnızca "Gönder" ile gider.
// - Yanıt güvenilmeyen metindir: server/assistant/markdown.js veri ağacına çevirir, burada yalnızca React metin düğümleri
//   ve sabit iç bağlantılar (/siparisler?q=…) çizilir — HTML yorumlanmaz, ham HTML eklenmez.
// - Geçmiş yalnızca bu sekmenin sessionStorage'ında (kullanıcıya özgü anahtar); kalıcı kayıt yok.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { askAssistantAction } from '@/app/(panel)/asistan-actions';
import { parseAnswer, orderHref } from '@/server/assistant/markdown.js';

type Part = { t: 'text' | 'b' | 'order'; v: string; bold?: boolean };
type Block = { type: 'p'; parts: Part[] } | { type: 'ul'; items: Part[][] } | { type: 'table'; head: Part[][]; rows: Part[][][] };
type Msg = { role: 'user' | 'bot' | 'error'; text: string; code?: string };

export type AssistantTexts = {
  open: string; openTitle: string; title: string; subtitle: string; expand: string; shrink: string; close: string; reset: string;
  resetTitle: string; placeholder: string; send: string; thinking: string; context: string; intro: string; privacy: string;
  counter: string; you: string; bot: string; retry: string; error: Record<string, string>;
};

const MAX_CHARS = 1000;
const MAX_STORED = 40;
const CLIENT_TIMEOUT_MS = 120_000;
const ORDER_PATH = /^\/siparisler\/([A-Za-z0-9_-]{8,64})(?:\/|$)/;

function load(key: string): Msg[] {
  try {
    const raw = sessionStorage.getItem(key);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list)
      ? list.filter((m) => m && (m.role === 'user' || m.role === 'bot' || m.role === 'error') && typeof m.text === 'string').slice(-MAX_STORED)
      : [];
  } catch {
    return [];
  }
}
function save(key: string, list: Msg[]) {
  try { sessionStorage.setItem(key, JSON.stringify(list.slice(-MAX_STORED))); } catch { /* tarayıcı depolaması kapalı: yalnızca bellekte */ }
}

function Inline({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map((p, i) => {
        if (p.t === 'order') {
          const link = <Link key={i} href={orderHref(p.v)} className="asst-order" prefetch={false}>{p.v}</Link>;
          return p.bold ? <strong key={i}>{link}</strong> : link;
        }
        return p.t === 'b' ? <strong key={i}>{p.v}</strong> : <span key={i}>{p.v}</span>;
      })}
    </>
  );
}

function Answer({ text }: { text: string }) {
  const blocks = parseAnswer(text) as unknown as Block[];
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === 'ul') return <ul key={i}>{b.items.map((it, j) => <li key={j}><Inline parts={it} /></li>)}</ul>;
        if (b.type === 'table') {
          return (
            <div key={i} className="asst-table-wrap">
              <table className="asst-table">
                <thead><tr>{b.head.map((h, j) => <th key={j} scope="col"><Inline parts={h} /></th>)}</tr></thead>
                <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}><Inline parts={c} /></td>)}</tr>)}</tbody>
              </table>
            </div>
          );
        }
        return <p key={i}><Inline parts={b.parts} /></p>;
      })}
    </>
  );
}

export function AssistantChat({ storageKey, texts }: { storageKey: string; texts: AssistantTexts }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [lastQuestion, setLastQuestion] = useState('');
  const [ready, setReady] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fabRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const pathname = usePathname() || '';
  const orderId = ORDER_PATH.exec(pathname)?.[1] ?? null;

  // Geçmiş yalnızca bu sekmeden yüklenir; yükleme bitmeden boş liste depoya yazılmaz
  useEffect(() => {
    setMsgs(load(storageKey));
    setReady(true);
  }, [storageKey]);
  useEffect(() => { if (ready) save(storageKey, msgs); }, [msgs, ready, storageKey]);
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, msgs, pending]);

  const close = useCallback(() => { setOpen(false); setTimeout(() => fabRef.current?.focus(), 0); }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  const errorText = (code: string) => texts.error[code] ?? texts.error.FAILED;

  async function ask(question: string) {
    const q = question.trim();
    if (!q || pending) return;
    if (q.length > MAX_CHARS) { setMsgs((m) => [...m, { role: 'error', text: errorText('TOO_LONG'), code: 'TOO_LONG' }]); return; }
    setPending(true);
    setLastQuestion(q);
    setInput('');
    setMsgs((m) => [...m, { role: 'user', text: q }]);
    let r: { ok: true; text: string } | { ok: false; code: string };
    try {
      r = await Promise.race([
        askAssistantAction({ question: q, orderId }),
        new Promise<{ ok: false; code: string }>((resolve) => setTimeout(() => resolve({ ok: false, code: 'TIMEOUT' }), CLIENT_TIMEOUT_MS)),
      ]);
    } catch {
      r = { ok: false, code: 'UNAVAILABLE' };
    }
    setPending(false);
    const next: Msg = r.ok ? { role: 'bot', text: r.text || errorText('FAILED') } : { role: 'error', text: errorText(r.code), code: r.code };
    setMsgs((m) => [...m, next]);
    if (!r.ok && r.code === 'SESSION') window.location.assign('/login?info=idle');
  }

  async function reset() {
    setMsgs([]);
    setLastQuestion('');
    try { sessionStorage.removeItem(storageKey); } catch { /* yok */ }
    try { await askAssistantAction({ reset: true }); } catch { /* işçideki kısa bellek zaten 20 dk'da silinir */ }
  }

  const retryable = (code?: string) => !!code && ['TIMEOUT', 'UNAVAILABLE', 'FAILED', 'AI_BUSY', 'BUSY'].includes(code);
  const lastIsError = msgs.length > 0 && msgs[msgs.length - 1].role === 'error';

  return (
    <>
      {!open && (
        <button ref={fabRef} type="button" className="asst-fab" onClick={() => setOpen(true)} title={texts.openTitle} aria-haspopup="dialog" data-assistant-open>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm3 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm5 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm5 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z" /></svg>
          <span>{texts.open}</span>
        </button>
      )}
      {open && (
        <section className={`asst-panel${full ? ' asst-full' : ''}`} role="dialog" aria-modal={full ? 'true' : 'false'} aria-labelledby={titleId} data-assistant-panel>
          <header className="asst-head">
            <div className="asst-titles">
              <h2 id={titleId}>{texts.title}</h2>
              <span className="asst-sub">{texts.subtitle}</span>
            </div>
            <div className="asst-tools">
              <button type="button" className="btn asst-btn" onClick={reset} title={texts.resetTitle} disabled={pending} data-assistant-reset>{texts.reset}</button>
              <button type="button" className="btn asst-btn asst-expand-hide" onClick={() => setFull((f) => !f)} aria-pressed={full} data-assistant-expand>{full ? texts.shrink : texts.expand}</button>
              <button type="button" className="btn asst-btn" onClick={close} aria-label={texts.close} data-assistant-close>✕</button>
            </div>
          </header>
          <div className="asst-list" ref={listRef} aria-live="polite" aria-busy={pending} data-assistant-list>
            {msgs.length === 0 && (
              <div className="asst-intro"><p>{texts.intro}</p><p className="muted">{texts.privacy}</p></div>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={`asst-msg asst-${m.role}`} data-assistant-msg={m.role}>
                <span className="sr-only">{m.role === 'user' ? texts.you : texts.bot}: </span>
                {m.role === 'bot' ? <Answer text={m.text} /> : <p>{m.text}</p>}
              </div>
            ))}
            {pending && <div className="asst-msg asst-bot asst-pending" role="status" data-assistant-pending><span className="asst-dots" aria-hidden="true" />{texts.thinking}</div>}
            {!pending && lastIsError && retryable(msgs[msgs.length - 1].code) && lastQuestion && (
              <button type="button" className="btn asst-retry" onClick={() => { setMsgs((m) => m.slice(0, -2)); void ask(lastQuestion); }} data-assistant-retry>{texts.retry}</button>
            )}
          </div>
          <form className="asst-form" onSubmit={(e) => { e.preventDefault(); void ask(input); }}>
            {orderId && <div className="asst-context" data-assistant-context>{texts.context}</div>}
            <textarea
              ref={inputRef}
              value={input}
              maxLength={MAX_CHARS}
              rows={2}
              placeholder={texts.placeholder}
              aria-label={texts.placeholder}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(input); } }}
              data-assistant-input
            />
            <div className="asst-form-foot">
              <span className="asst-count">{texts.counter.replace('{n}', String(input.length)).replace('{max}', String(MAX_CHARS))}</span>
              <button type="submit" className="btn btn-primary" disabled={pending || !input.trim()} data-assistant-send>{texts.send}</button>
            </div>
          </form>
        </section>
      )}
    </>
  );
}
