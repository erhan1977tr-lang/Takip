'use client';

import { useEffect, useState } from 'react';

// Çıkış formunda bu cihazın telefon bildirimi adresi (4.2.33, karar 331): çıkışta sunucu bu cihazın aboneliğini siler →
// bu telefona artık bildirim gitmez. Servis çalışanı / abonelik yoksa alan boş gider. İstek yapmaz (yalnızca tarayıcı içi).
export function PushEndpointField() {
  const [endpoint, setEndpoint] = useState('');
  useEffect(() => {
    let alive = true;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.getRegistration('/')
      .then((reg) => reg?.pushManager?.getSubscription())
      .then((sub) => { if (alive && sub) setEndpoint(sub.endpoint); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return <input type="hidden" name="pushEndpoint" value={endpoint} />;
}

/** Servis çalışanını kaydeder ("ana ekrana ekle" ve telefon bildirimi için). Sayfa / dosya önbelleğe almaz. */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw', { scope: '/' }).catch(() => {});
  }, []);
  return null;
}
