'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';

/**
 * Anlık arama (Paket 9, karar 201): yazdıkça (DELAY ms bekleyip) aynı sayfanın adresindeki arama parametresini günceller;
 * sonuçları sunucu, adresteki değere göre kendi kapsam ve maske kurallarıyla üretir (tarayıcıya bütün liste yüklenmez).
 *   - Adresin öbür parametreleri (sekme, panel, süzgeçler) korunur; boş arama parametreyi kaldırır (normal liste).
 *   - Geç gelen eski yanıt yenisini ezemez: yalnızca son yazılan değer gönderilir (bekleyen zamanlayıcı her tuşta iptal
 *     edilir), yeni gezinme yönlendiricide bekleyen eskisinin yerini alır (eski yanıt uygulanmaz); kutunun değeri yalnızca
 *     kullanıcının yazdığıdır — sunucudan dönen değer kutuya yazılmaz.
 *   - Form ve "Ara" düğmesi yerinde kalır (betik çalışmazsa / Enter ile olağan arama).
 * Kullanıcı etkinliği oturum izleyicisinde zaten sayılır (yazma); bu bileşen oturuma ayrıca dokunmaz.
 */
export function LiveSearch({
  name = 'q', defaultValue = '', placeholder, label, searching, delay = 300,
}: { name?: string; defaultValue?: string; placeholder: string; label: string; searching: string; delay?: number }) {
  const router = useRouter();
  const path = usePathname();
  const [value, setValue] = useState(defaultValue);
  const [pending, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last = useRef(defaultValue.trim());

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const go = (raw: string) => {
    const q = raw.trim();
    if (q === last.current) return;
    last.current = q;
    const params = new URLSearchParams(window.location.search);
    if (q) params.set(name, q);
    else params.delete(name);
    const qs = params.toString();
    start(() => router.replace(`${path}${qs ? `?${qs}` : ''}`, { scroll: false }));
  };

  return (
    <span className="live-search" data-pending={pending ? '1' : undefined}>
      <input
        type="search" name={name} value={value} placeholder={placeholder} aria-label={label} autoComplete="off"
        onChange={(e) => {
          const v = e.target.value;
          setValue(v);
          // Yalnızca son yazılan değer gider: önceki zamanlayıcı iptal edilir
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => go(v), delay);
        }}
      />
      <span className="live-search-state" role="status" aria-live="polite">{pending ? searching : ''}</span>
    </span>
  );
}
