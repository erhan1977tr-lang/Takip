'use client';

import { useId, useState, type ReactNode } from 'react';

/**
 * "Tekliflerim" yükleme günü grubu (Paket B — karar 226): başlık (gün, sipariş sayısı, toplamlar) hep görünür; altındaki
 * sipariş listesi "Göster" ile açılır, düğme "Gizle" olur. Her grubun durumu kendisinindir (biri açılınca diğeri değişmez).
 * Yalnızca görünüm: veri sunucuda hazırlanmıştır, bu bileşen hiçbir istek yapmaz.
 */
export function ReportGroup({ head, showLabel, hideLabel, day, children }: {
  head: ReactNode; showLabel: string; hideLabel: string; day: string; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section className="report-group" data-report-group={day} data-open={open ? '1' : '0'}>
      <div className="report-group-head">
        <div className="report-group-title">{head}</div>
        <button type="button" className="btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)} data-group-toggle>
          {open ? hideLabel : showLabel}
        </button>
      </div>
      <div id={id} hidden={!open} className="report-group-body">{children}</div>
    </section>
  );
}
