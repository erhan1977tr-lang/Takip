// Mal kabulü depo e-postası (3.87.0, karar 282) — Romence (depo Romanya'da). Ekinde INTRAREA MARFĂ belgesi (PDF).
// İçerik yalnızca fiilen teslim alınan miktarlardır: fiyat, alış / satış tutarı, maliyet ya da kâr YOKTUR (çağıran da vermez).
import { brandedHtml } from '../layout.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10).split('-').reverse().join('.') : '—');
/** Uzunluk (m): yalnızca ondalık kısmın sondaki sıfırları atılır ("6.000" → "6 m", "60" → "60 m", "6.500" → "6,5 m") */
const len = (s) => {
  if (!s) return '';
  const t = String(s);
  return `${(t.includes('.') ? t.replace(/0+$/, '').replace(/\.$/, '') : t).replace('.', ',')} m`;
};

/**
 * @param {{ orderNo: string, supplierName: string, seq: number, receivedOn: Date, reference: string | null, complete: boolean,
 *   lines: { code: string, name: string, color: string | null, length: string | null, qty: number, unit: string }[],
 *   totals: { qty: number, unit: string }[], fileName: string }} p
 * @returns {{ subject: string, text: string, html: string }}
 */
export function renderGoodsReceiptEmail(p) {
  const subject = `GKH Trading Invest – Intrare marfă – ${p.orderNo} – recepția nr. ${p.seq} – ${p.supplierName}`;
  const detail = (l) => [l.color ? `culoare ${l.color}` : '', l.length ? `lungime ${len(l.length)}` : ''].filter(Boolean).join(', ');
  const total = p.totals.map((t) => `${t.qty} ${t.unit}`).join(' + ');
  const text = [
    'Bună ziua,',
    '',
    `Marfa de la furnizorul ${p.supplierName} a fost recepționată (comanda furnizor ${p.orderNo}, recepția nr. ${p.seq}).`,
    `Documentul INTRAREA MARFĂ este atașat în PDF (${p.fileName}).`,
    '',
    `Data recepției: ${day(p.receivedOn)}`,
    `Aviz / referință: ${p.reference ?? '—'}`,
    '',
    'Produse recepționate:',
    ...p.lines.map((l) => `  - ${l.qty} ${l.unit} — ${l.name} (${l.code})${detail(l) ? ` — ${detail(l)}` : ''}`),
    '',
    `Total: ${p.lines.length} poziții · ${total}`,
    p.complete ? 'Comanda furnizor a fost recepționată integral.' : 'Recepție parțială: restul comenzii urmează.',
    '',
    'Acest e-mail a fost trimis automat de portalul Takip (GKH Trading Invest SRL).',
  ].join('\n');
  const rows = p.lines.map((l) => `<tr>
<td style="border:1px solid #e5e7eb;font-family:monospace">${esc(l.code)}</td>
<td style="border:1px solid #e5e7eb">${esc(l.name)}${detail(l) ? `<br><span style="color:#6b7280;font-size:12px">${esc(detail(l))}</span>` : ''}</td>
<td style="border:1px solid #e5e7eb;text-align:right"><b>${l.qty}</b></td>
<td style="border:1px solid #e5e7eb">${esc(l.unit)}</td></tr>`).join('\n');
  const html = brandedHtml({ lang: 'ro', title: subject, body: `<p style="margin:0 0 12px">Bună ziua,</p>
<p>Marfa de la furnizorul <b>${esc(p.supplierName)}</b> a fost recepționată (comanda furnizor <b>${esc(p.orderNo)}</b>, recepția nr. <b>${p.seq}</b>). Documentul <b>INTRAREA MARFĂ</b> este atașat în PDF.</p>
<table cellpadding="4" style="border-collapse:collapse">
<tr><td style="color:#6b7280">Data recepției</td><td><b>${esc(day(p.receivedOn))}</b></td></tr>
<tr><td style="color:#6b7280">Aviz / referință</td><td>${esc(p.reference ?? '—')}</td></tr>
</table>
<p style="margin-top:14px"><b>Produse recepționate</b></p>
<table cellpadding="5" style="border-collapse:collapse;border:1px solid #e5e7eb">
<tr style="background:#f3f4f6"><th style="border:1px solid #e5e7eb;text-align:left">Cod</th><th style="border:1px solid #e5e7eb;text-align:left">Produs</th><th style="border:1px solid #e5e7eb;text-align:right">Cantitate</th><th style="border:1px solid #e5e7eb;text-align:left">U.M.</th></tr>
${rows}
</table>
<p><b>Total:</b> ${p.lines.length} poziții · ${esc(total)}</p>
<p>${p.complete ? 'Comanda furnizor a fost recepționată integral.' : 'Recepție parțială: restul comenzii urmează.'}</p>
<p style="color:#6b7280;font-size:12px">Acest e-mail a fost trimis automat de portalul Takip (GKH Trading Invest SRL).</p>` });
  return { subject, text, html };
}
