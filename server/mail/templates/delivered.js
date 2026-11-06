// Depo teslim onayı bildirimi (4.2.15, karar 311): depo, müşteriye malın teslim edildiğini depo bağlantısından
// onayladığında (Confirmare) Ayarlar → Entegrasyonlar'daki depo e-postası alıcılarına gider. Romence (depo e-postasıyla
// aynı alıcılar). Yalnızca gövde üretilir; ortak GKH düzeni (logo) server/mail/layout.js'tedir.

import { brandedHtml } from '../layout.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10).split('-').reverse().join('.') : '—');

/** Teslim anı, Romanya saatiyle: "06.11.2026 14:35" */
export function deliveredStamp(d, timeZone = 'Europe/Bucharest') {
  if (!d) return '—';
  const p = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(d));
  const g = (t) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('day')}.${g('month')}.${g('year')} ${g('hour')}:${g('minute')}`;
}

const CELL = 'border:1px solid #e5e7eb;padding:6px 8px';

/**
 * @param {{ orderNo: string, firmName: string, contactPerson?: string | null, phone?: string | null, plate?: string | null,
 *   pickupDate?: Date | string | null, deliveredAt: Date | string, timeZone?: string,
 *   items: { code: string, name: string, unit: string, qty: number }[], documents?: string[], test?: boolean }} p
 * @returns {{ subject: string, text: string, html: string }}
 */
export function renderDeliveredEmail(p) {
  const stamp = deliveredStamp(p.deliveredAt, p.timeZone);
  const subject = `${p.test ? '[TEST] Depo Malzeme Teslim Onayı — ' : ''}Predare confirmată — comanda ${p.orderNo} — ${p.firmName} — ${stamp}`;
  const rows = p.items.map((i) => `${i.qty} ${i.unit} — ${i.name} (${i.code})`);
  const docs = p.documents ?? [];
  const testNote = p.test ? 'ACESTA ESTE UN E-MAIL DE TEST. Comanda, clientul și produsele de mai jos sunt EXEMPLE fictive; nu a avut loc nicio predare reală.' : '';
  const text = [
    testNote,
    'Bună ziua,',
    '',
    `Depozitul a confirmat predarea mărfii pentru comanda ${p.orderNo} (${p.firmName}).`,
    '',
    `Data predării: ${stamp}`,
    `Data ridicării planificată: ${day(p.pickupDate)}`,
    `Client: ${p.firmName}${p.contactPerson ? ` — ${p.contactPerson}` : ''}`,
    `Telefon: ${p.phone ?? '—'}`,
    `Nr. mașină: ${p.plate ?? '—'}`,
    '',
    'Produse predate:',
    ...rows.map((r) => `  - ${r}`),
    '',
    docs.length ? `Documente încărcate de depozit (${docs.length}): ${docs.join(', ')}` : 'Documente încărcate de depozit: —',
    '',
    'Acest e-mail a fost trimis automat de portalul Takip (GKH Trading Invest SRL).',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  const html = brandedHtml({ lang: 'ro', title: subject, body: `${p.test ? `<p style="margin:0 0 14px;padding:10px 12px;background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;color:#78350f"><b>E-MAIL DE TEST.</b> ${esc(testNote.replace('ACESTA ESTE UN E-MAIL DE TEST. ', ''))}</p>` : ''}<p style="margin:0 0 12px">Bună ziua,</p>
<p>Depozitul a confirmat <b>predarea mărfii</b> pentru comanda <b>${esc(p.orderNo)}</b> (<b>${esc(p.firmName)}</b>).</p>
<table cellpadding="4" style="border-collapse:collapse">
<tr><td style="color:#6b7280">Data predării</td><td><b>${esc(stamp)}</b></td></tr>
<tr><td style="color:#6b7280">Ridicare planificată</td><td>${esc(day(p.pickupDate))}</td></tr>
<tr><td style="color:#6b7280">Client</td><td>${esc(p.firmName)}${p.contactPerson ? ` <span style="color:#6b7280">— ${esc(p.contactPerson)}</span>` : ''}</td></tr>
<tr><td style="color:#6b7280">Telefon</td><td>${esc(p.phone ?? '—')}</td></tr>
<tr><td style="color:#6b7280">Nr. mașină</td><td>${esc(p.plate ?? '—')}</td></tr>
</table>
<p style="margin-top:14px"><b>Produse predate</b></p>
<table cellpadding="5" style="border-collapse:collapse;border:1px solid #e5e7eb">
<tr style="background:#f3f4f6"><th style="${CELL};text-align:right">Cantitate</th><th style="${CELL};text-align:left">Produs</th><th style="${CELL};text-align:left">Cod</th></tr>
${p.items.map((i) => `<tr><td style="${CELL};text-align:right;white-space:nowrap"><b>${esc(i.qty)}</b> ${esc(i.unit)}</td><td style="${CELL}">${esc(i.name)}</td><td style="${CELL};color:#6b7280">${esc(i.code)}</td></tr>`).join('\n')}
</table>
<p style="margin-top:14px;color:#374151">Documente încărcate de depozit${docs.length ? ` (${docs.length})` : ''}: ${docs.length ? docs.map(esc).join(', ') : '—'}</p>
<p style="color:#6b7280;font-size:12px">Acest e-mail a fost trimis automat de portalul Takip (GKH Trading Invest SRL).</p>` });
  return { subject, text, html };
}
