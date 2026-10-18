// Profil iadesi depo e-postası (DÜZELTME 10 M8, 3.99.0) — Romence (depo Romanya'da), mevcut depo alıcılarına. İki bildirim:
// OPENED (iade açıldı; tek kullanımlık depo bağlantısıyla fiziksel teslim onaylanır) ve RECEIVED (depo teslim aldı: sağlam /
// hasarlı). İçerik: sipariş, ürün, miktar, gerekçe, durum. Fiyat, tutar, ödeme ya da mali karşılık YOKTUR.
import { brandedHtml } from '../layout.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * @param {{ notice: 'OPENED' | 'RECEIVED', orderNo: string, seq: number, firmName: string, reason: string,
 *   lines: { code: string, name: string, qty: number, unit: string, good?: number | null, damaged?: number | null }[],
 *   link?: string | null, validDays?: number }} p
 * @returns {{ subject: string, text: string, html: string }}
 */
export function renderProfileReturnEmail(p) {
  const opened = p.notice === 'OPENED';
  const subject = `GKH Trading Invest – ${opened ? 'Retur deschis' : 'Retur recepționat'} – ${p.orderNo} – retur nr. ${p.seq}`;
  const status = opened ? 'Retur deschis — marfa urmează să fie predată la depozit.' : 'Marfa returnată a fost recepționată la depozit.';
  const row = (l) => opened ? `${l.qty} ${l.unit}` : `${l.qty} ${l.unit} (bună: ${l.good ?? 0}, deteriorată: ${l.damaged ?? 0})`;
  const text = [
    'Bună ziua,',
    '',
    `${status}`,
    `Comanda: ${p.orderNo} · Client: ${p.firmName} · Retur nr. ${p.seq}`,
    `Motiv: ${p.reason}`,
    '',
    'Produse:',
    ...p.lines.map((l) => `  - ${row(l)} — ${l.name} (${l.code})`),
    '',
    ...(opened && p.link ? [`Confirmați recepția fizică (bună / deteriorată) la adresa: ${p.link}`, `Link valabil ${p.validDays} zile; nu-l transmiteți altor persoane.`, ''] : []),
    'Acest e-mail a fost trimis automat de portalul Takip (GKH Trading Invest SRL).',
  ].join('\n');
  const rows = p.lines.map((l) => `<tr>
<td style="border:1px solid #e5e7eb;font-family:monospace">${esc(l.code)}</td>
<td style="border:1px solid #e5e7eb">${esc(l.name)}</td>
<td style="border:1px solid #e5e7eb;text-align:right"><b>${l.qty}</b></td>
<td style="border:1px solid #e5e7eb">${esc(l.unit)}</td>
${opened ? '' : `<td style="border:1px solid #e5e7eb;text-align:right">${l.good ?? 0}</td><td style="border:1px solid #e5e7eb;text-align:right">${l.damaged ?? 0}</td>`}</tr>`).join('\n');
  const head = `<tr style="background:#f3f4f6"><th style="border:1px solid #e5e7eb;text-align:left">Cod</th><th style="border:1px solid #e5e7eb;text-align:left">Produs</th><th style="border:1px solid #e5e7eb;text-align:right">Cantitate</th><th style="border:1px solid #e5e7eb;text-align:left">U.M.</th>${opened ? '' : '<th style="border:1px solid #e5e7eb;text-align:right">Bună</th><th style="border:1px solid #e5e7eb;text-align:right">Deteriorată</th>'}</tr>`;
  const html = brandedHtml({ lang: 'ro', title: subject, body: `<p style="margin:0 0 12px">Bună ziua,</p>
<p><b>${esc(status)}</b></p>
<table cellpadding="4" style="border-collapse:collapse">
<tr><td style="color:#6b7280">Comanda</td><td><b>${esc(p.orderNo)}</b></td></tr>
<tr><td style="color:#6b7280">Client</td><td>${esc(p.firmName)}</td></tr>
<tr><td style="color:#6b7280">Retur nr.</td><td><b>${p.seq}</b></td></tr>
<tr><td style="color:#6b7280">Motiv</td><td>${esc(p.reason)}</td></tr>
</table>
<table cellpadding="5" style="border-collapse:collapse;border:1px solid #e5e7eb;margin-top:12px">
${head}
${rows}
</table>
${opened && p.link ? `<p style="margin-top:14px"><a href="${esc(p.link)}">Confirmați recepția fizică (bună / deteriorată)</a><br><span style="color:#6b7280;font-size:12px">Link valabil ${p.validDays} zile; nu-l transmiteți altor persoane.</span></p>` : ''}
<p style="color:#6b7280;font-size:12px">Acest e-mail a fost trimis automat de portalul Takip (GKH Trading Invest SRL).</p>` });
  return { subject, text, html };
}
