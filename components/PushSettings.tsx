'use client';

import { useEffect, useState } from 'react';
import { pushStatusAction, removePushAction, savePushAction, testPushAction } from '@/app/(panel)/ayarlar/push-actions';

// "Bu cihazda bildirimleri aç" + "Ana ekrana ekle" (4.2.33, karar 331). İzin yalnızca kullanıcının düğmeye basmasıyla
// istenir (iPhone başka türlüsüne izin vermez). Sayfa açılışında sunucuya yalnızca "bu cihaz kayıtlı mı" sorulur.
type Texts = {
  title: string, intro: string, on: string, off: string, enable: string, disable: string, test: string, testSent: string,
  working: string, unsupported: string, iosInstall: string, denied: string, notReady: string, failed: string, rateLimit: string,
  installTitle: string, installAndroid: string, installIos: string, installButton: string, installed: string,
};

type Phase = 'loading' | 'unsupported' | 'ios-install' | 'not-ready' | 'off' | 'on' | 'denied';

function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const sameKey = (sub: PushSubscription, key: Uint8Array) => {
  const k = sub.options?.applicationServerKey;
  if (!k) return true;
  const a = new Uint8Array(k);
  return a.length === key.length && a.every((v, i) => v === key[i]);
};

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

type InstallEvent = Event & { prompt: () => Promise<void>, userChoice: Promise<unknown> };

export function PushSettings({ publicKey, texts }: { publicKey: string | null, texts: Texts }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [standalone, setStandalone] = useState(false);

  useEffect(() => {
    setStandalone(isStandalone());
    const onPrompt = (e: Event) => { e.preventDefault(); setInstall(e as InstallEvent); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    let alive = true;
    (async () => {
      const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
      if (!supported) return setPhase(isIos() && !isStandalone() ? 'ios-install' : 'unsupported');
      if (!publicKey) return setPhase('not-ready');
      if (Notification.permission === 'denied') return setPhase('denied');
      try {
        const reg = await navigator.serviceWorker.register('/sw', { scope: '/' });
        const sub = await reg.pushManager.getSubscription();
        const st = await pushStatusAction(sub?.endpoint ?? null);
        if (!alive) return;
        if (!st.ready) return setPhase('not-ready');
        setPhase(sub && st.registered && sameKey(sub, keyBytes(publicKey)) && Notification.permission === 'granted' ? 'on' : 'off');
      } catch {
        if (alive) setPhase('off');
      }
    })();
    return () => { alive = false; window.removeEventListener('beforeinstallprompt', onPrompt); };
  }, [publicKey]);

  async function enable() {
    if (!publicKey) return;
    setBusy(true);
    setNote(null);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { setPhase(perm === 'denied' ? 'denied' : 'off'); return; }
      const reg = await navigator.serviceWorker.register('/sw', { scope: '/' });
      await navigator.serviceWorker.ready;
      const key = keyBytes(publicKey);
      let sub = await reg.pushManager.getSubscription();
      if (sub && !sameKey(sub, key)) { await sub.unsubscribe().catch(() => false); sub = null; }
      sub = sub ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const r = await savePushAction(sub.toJSON());
      if (r.ok) setPhase('on');
      else setNote(r.code === 'RATE_LIMIT' ? texts.rateLimit : r.code === 'DISABLED' ? texts.notReady : texts.failed);
    } catch {
      setNote(texts.failed);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setNote(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await removePushAction(sub.endpoint);
        await sub.unsubscribe().catch(() => false);
      }
      setPhase('off');
    } catch {
      setNote(texts.failed);
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    try {
      const r = await testPushAction();
      setNote(r.ok ? texts.testSent : r.code === 'RATE_LIMIT' ? texts.rateLimit : texts.notReady);
    } finally {
      setBusy(false);
    }
  }

  async function doInstall() {
    if (!install) return;
    await install.prompt().catch(() => {});
    setInstall(null);
  }

  return (
    <section className="card" id="telefon" style={{ maxWidth: 560 }} data-push-phase={phase}>
      <h2>{texts.title}</h2>
      <p className="muted">{texts.intro}</p>
      {phase === 'loading' && <p className="muted">{texts.working}</p>}
      {phase === 'unsupported' && <div className="alert alert-warn">{texts.unsupported}</div>}
      {phase === 'ios-install' && <div className="alert alert-warn">{texts.iosInstall}</div>}
      {phase === 'not-ready' && <div className="alert alert-warn">{texts.notReady}</div>}
      {phase === 'denied' && <div className="alert alert-warn">{texts.denied}</div>}
      {(phase === 'off' || phase === 'on') && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span className={`badge ${phase === 'on' ? 'badge-ok' : ''}`} data-push-state={phase}>{phase === 'on' ? texts.on : texts.off}</span>
          {phase === 'off'
            ? <button type="button" className="btn btn-primary" onClick={enable} disabled={busy} data-push-enable>{texts.enable}</button>
            : <>
              <button type="button" className="btn" onClick={test} disabled={busy} data-push-test>{texts.test}</button>
              <button type="button" className="btn btn-link" onClick={disable} disabled={busy} data-push-disable>{texts.disable}</button>
            </>}
        </div>
      )}
      {note && <p className="hint" role="status">{note}</p>}
      <h3 style={{ marginTop: 16 }}>{texts.installTitle}</h3>
      {standalone
        ? <p className="muted" data-installed>{texts.installed}</p>
        : <>
          {install && <p><button type="button" className="btn" onClick={doInstall} data-install>{texts.installButton}</button></p>}
          <ul className="muted" style={{ paddingLeft: 18, margin: 0 }}>
            <li>{texts.installAndroid}</li>
            <li>{texts.installIos}</li>
          </ul>
        </>}
    </section>
  );
}
