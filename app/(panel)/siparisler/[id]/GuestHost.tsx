'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { Dict } from '@/lib/i18n';
import { interpolate } from '@/server/i18n/interpolate.js';

/**
 * "Özel durum — başka firmanın yüklemesiyle gidecek" alanları (karar 124; yalnızca yönetici, teklif tablosunun hemen
 * altında). Kapalıyken tek bir işaret kutusudur; işaretlenince siparişin yükleme gününde yüklemesi olan BAŞKA firmaların
 * listesi açılır (her firma bir kez). Yönetici yalnızca firmayı seçer — sipariş ya da sandık seçmez; sandığı Yüklemeler
 * ekranında satış seçer. Form ve sunucu işlemi sayfadadır (page.tsx); yetki ve doğrulama sunucudadır (setGuestHost).
 */
export function GuestHostFields({ hostId, hostName, hosts, days, dayHref, crateNo, m }: {
  hostId: string | null; hostName: string | null; hosts: { id: string; name: string }[]; days: string[]; dayHref: string | null;
  crateNo: number | null; m: Dict['loading']['guest']['host'];
}) {
  const [on, setOn] = useState(!!hostId);
  // Seçili firma artık o gün yüklemiyorsa da listede görünür (yönetici durumu görür ve değiştirir)
  const stale = !!hostId && !hosts.some((h) => h.id === hostId);
  return (
    <>
      <label className="check">
        <input type="checkbox" name="on" checked={on} disabled={days.length === 0 && !hostId} onChange={(e) => setOn(e.target.checked)} /> {m.check}
      </label>
      {days.length === 0 && <p className="muted small">{m.noDay}</p>}
      {on && (
        <>
          <div className="row" style={{ marginTop: 12 }}>
            <label htmlFor="guest-host" style={{ margin: 0 }}>{m.firm}</label>
            <select id="guest-host" name="hostId" required defaultValue={hostId ?? ''} style={{ maxWidth: 360 }}>
              <option value="">{m.choose}</option>
              {hosts.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
              {stale && <option value={hostId!}>{interpolate(m.stale, { name: hostName ?? '—' })}</option>}
            </select>
            <button className="btn btn-primary">{m.save}</button>
            {hostId && (crateNo != null
              ? <span className="badge badge-ok">{interpolate(m.assigned, { no: crateNo })}</span>
              : <span className="badge badge-danger">{m.waiting}</span>)}
            {hostId && dayHref && <Link className="small" href={dayHref}>{m.open}</Link>}
          </div>
          {days.length > 0 && hosts.length === 0 && <p className="muted small">{m.noFirms}</p>}
          <p className="muted small">{days.length > 0 && <>{interpolate(m.days, { days: days.join(', ') })} · </>}{m.hint}</p>
        </>
      )}
      {!on && hostId && (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn btn-danger">{m.remove}</button>
          <span className="muted small">{m.removeHint}</span>
        </div>
      )}
    </>
  );
}
