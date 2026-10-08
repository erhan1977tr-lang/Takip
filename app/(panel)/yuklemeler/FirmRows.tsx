'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';

/**
 * Yükleme günü firma tablosunun bir firması (Paket 7): ana satır + açılır iki bölüm — alt siparişler ve sandıklar.
 * İçerik sunucuda hazırlanır (adlar role göre maskeli, tutarlar yetkiye göre süzülmüş); burada yalnızca aç / kapa durumu
 * tutulur. Bölümler DOM'da kalır (gizli), böylece sunucu işlemi sonrası yenilemede form durumu kaybolmaz.
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
  to: { pdf: string; xlsx: string; summary: string };
  open?: { orders?: boolean; crates?: boolean };
  m: { toggle: string; crates: string; pdf: string; xlsx: string; summary: string };
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
        <td className="actions firm-actions">
          <button type="button" className={`btn${crates ? ' active' : ''}`} aria-expanded={crates} aria-controls={cratesId} data-action="crates" onClick={() => setCrates((v) => !v)}>{props.m.crates}</button>
          <a className="btn" href={props.to.pdf} data-action="pdf">{props.m.pdf}</a>
          <a className="btn" href={props.to.xlsx} data-action="xlsx">{props.m.xlsx}</a>
          <Link className="btn" href={props.to.summary} data-action="summary">{props.m.summary}</Link>
        </td>
      </tr>
      <tr className="firm-orders" id={ordersId} hidden={!orders}>
        <td colSpan={props.cols}>{props.orders}</td>
      </tr>
      <tr className="firm-crates" id={cratesId} hidden={!crates}>
        <td colSpan={props.cols}>{props.crates}</td>
      </tr>
    </tbody>
  );
}
