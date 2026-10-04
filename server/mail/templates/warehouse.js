// Depoya giden profil siparişi e-postası (Romence; depo Romanya'da). Ekinde doldurulmuş Comanda Depozit formu (PDF).
// Bağlantı: depo, müşteri malı alınca buradan imzalı teslim belgesini yükler ve teslimi onaylar.

import { brandedHtml } from '../layout.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10).split('-').reverse().join('.') : '—');

/**
 * @param {{ orderNo: string, firmName: string, pickupDate: Date | null, phone: string | null, plate: string | null,
 *   items: { code: string, name: string, unit: string, qty: number }[], link: string, validDays: number, resend?: boolean }} p
 * @returns {{ subject: string, text: string, html: string }}
 */
export function renderWarehouseEmail(p) {
  const subject = `${p.resend ? '[RETRIMIS] ' : ''}Comanda depozit ${p.orderNo} — ${p.firmName} — ridicare ${day(p.pickupDate)}`;
  const rows = p.items.map((i) => `${i.qty} ${i.unit} — ${i.name} (${i.code})`);
  const text = [
    'Bună ziua,',
    '',
    `Vă transmitem comanda ${p.orderNo} pentru ${p.firmName}. Formularul completat (Comanda Depozit) este atașat în PDF.`,
    '',
    `Data ridicării: ${day(p.pickupDate)}`,
    `Telefon: ${p.phone ?? '—'}`,
    `Nr. mașină: ${p.plate ?? '—'}`,
    '',
    'Produse:',
    ...rows.map((r) => `  - ${r}`),
    '',
    'După ce clientul ridică marfa, vă rugăm să confirmați predarea și să încărcați documentul semnat (PDF sau fotografie) aici:',
    p.link,
    `Linkul este valabil ${p.validDays} zile.`,
    '',
    p.resend ? 'Acesta este un e-mail retrimis; linkul din e-mailul anterior nu mai este valabil.' : '',
    'Acest e-mail a fost trimis automat de portalul Takip (GKH Trading Invest SRL).',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  // Ortak GKH düzeni (logo başlığı — server/mail/layout.js); burada yalnızca gövde üretilir
  const html = brandedHtml({ lang: 'ro', title: subject, body: `<p style="margin:0 0 12px">Bună ziua,</p>
<p>Vă transmitem comanda <b>${esc(p.orderNo)}</b> pentru <b>${esc(p.firmName)}</b>. Formularul completat (Comanda Depozit) este atașat în PDF.</p>
<table cellpadding="4" style="border-collapse:collapse">
<tr><td style="color:#6b7280">Data ridicării</td><td><b>${esc(day(p.pickupDate))}</b></td></tr>
<tr><td style="color:#6b7280">Telefon</td><td>${esc(p.phone ?? '—')}</td></tr>
<tr><td style="color:#6b7280">Nr. mașină</td><td>${esc(p.plate ?? '—')}</td></tr>
</table>
<p style="margin-top:14px"><b>Produse</b></p>
<table cellpadding="5" style="border-collapse:collapse;border:1px solid #e5e7eb">
${p.items.map((i) => `<tr><td style="border:1px solid #e5e7eb;text-align:right"><b>${i.qty}</b> ${esc(i.unit)}</td><td style="border:1px solid #e5e7eb">${esc(i.name)} <span style="color:#6b7280">(${esc(i.code)})</span></td></tr>`).join('\n')}
</table>
<p style="margin-top:18px">După ce clientul ridică marfa, vă rugăm să confirmați predarea și să încărcați documentul semnat (PDF sau fotografie):</p>
<p><a href="${esc(p.link)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">Confirmă predarea mărfii</a></p>
<p style="color:#6b7280;font-size:12px">Linkul este valabil ${p.validDays} zile.${p.resend ? ' Acesta este un e-mail retrimis; linkul din e-mailul anterior nu mai este valabil.' : ''}<br>Acest e-mail a fost trimis automat de portalul Takip (GKH Trading Invest SRL).</p>` });
  return { subject, text, html };
}
