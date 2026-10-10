'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';

/**
 * Yükleme günü firma tablosunun bir firması (Paket 7): ana satır + açılır iki bölüm — alt siparişler ve sandıklar.
 * İçerik sunucuda hazırlanır (adlar role göre maskeli, tutarlar yetkiye göre süzülmüş); burada yalnızca aç / kapa durumu
 * tutulur. Bölümler DOM'da kalır (gizli), böylece sunucu işlemi sonrası yenilemede form durumu kaybolmaz.
 * Sağdaki işlemler (Yönetici Paneli Paketi 1, karar 215): belge işlemleri yetkisi olan rolde PDF | Excel | Özet | Sandık;
 * satışta yalnızca Sandık (to = null — belge adresleri sunucuda da reddedilir: lib/loading.ts → canFirmDocs).
 */
export function FirmRows(props: {
  id: string;
  name: string;
  /** Firma adının altındaki rozetler (misafir yük, sandık bekliyor, sandık etiketi) */
  badges?: ReactNode;
  /** Sayı ve tutar hücreleri (td) */
  cells: ReactNode;
  orders: ReactNode;
  crates: ReactNode;
  cols: number;
  /** Belge işlemlerinin adresleri; null: rol belge işlemlerini görmez (yalnızca Sandık) */
  to: { pdf: string; xlsx: string; summary: string } | null;
  open?: { orders?: boolean; crates?: boolean };
  m: { toggle: string; crates: string; pdf: string; xlsx: string; summary: string; actions: string };
}) {
  const [orders, setOrders] = useState(!!props.open?.orders);
  const [crates, setCrates] = useState(!!props.open?.crates);
  // Adres "acik=<firma>" ile gelince ("sandık seçimi bekliyor" bağlantısı, sandık işleminden sonraki yönlendirme) sandık bölümü
  // açılır — aynı sayfada istemci gezintisinde de (bileşen yeniden kurulmaz; önceki değer saklanıp prop değişince durum ayarlanır)
  const wantCrates = !!props.open?.crates;
  const [seenOpen, setSeenOpen] = useState(wantCrates);
  if (wantCrates !== seenOpen) {
    setSeenOpen(wantCrates);
    if (wantCrates) setCrates(true);
  }
  const ordersId = `firma-${props.id}-siparisler`;
  const cratesId = `firma-${props.id}-sandiklar`;
  return (
    <tbody className="firm" id={`firma-${props.id}`} data-firm={props.id}>
      <tr className={`firm-row${orders || crates ? ' open' : ''}`}>
        <td className="firm-cell">
          <button type="button" className="firm-toggle" aria-expanded={orders} aria-controls={ordersId} title={props.m.toggle} onClick={() => setOrders((v) => !v)}>
            <span className="firm-caret" aria-hidden="true">{orders ? '▾' : '▸'}</span>
            <b className="group-name">{props.name}</b>
          </button>
          {props.badges}
        </td>
        {props.cells}
        <td className="actions firm-actions" data-label={props.m.actions}>
          {/* İki satır (Paket C — karar 234): 1) PDF / Excel 2) Özet / Sandık. Belgeleri göremeyen rolde (satış) yalnızca Sandık.
              Aynı bağlantılar, aynı yetki; sandık formu yine satırın altında açılır. */}
          <div className="firm-acts">
            {props.to && (
              <div className="firm-acts-line" data-acts-line="docs">
                <a className="btn" href={props.to.pdf} data-action="pdf">{props.m.pdf}</a>
                <a className="btn" href={props.to.xlsx} data-action="xlsx">{props.m.xlsx}</a>
              </div>
            )}
            <div className="firm-acts-line" data-acts-line="more">
              {props.to && <Link className="btn" href={props.to.summary} data-action="summary">{props.m.summary}</Link>}
              <button type="button" className={`btn${crates ? ' active' : ''}`} aria-expanded={crates} aria-controls={cratesId} data-action="crates" onClick={() => setCrates((v) => !v)}>{props.m.crates}</button>
            </div>
          </div>
        </td>
      </tr>
      <tr className="firm-orders" id={ordersId} hidden={!orders}>
        <td colSpan={props.cols}><div className="firm-sub">{props.orders}</div></td>
      </tr>
      <tr className="firm-crates" id={cratesId} hidden={!crates}>
        <td colSpan={props.cols}><div className="firm-sub">{props.crates}</div></td>
      </tr>
    </tbody>
  );
}
