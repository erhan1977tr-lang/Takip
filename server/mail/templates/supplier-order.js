// Tedarikçi sipariş e-postası (Paket 6, karar 181) — TEK, merkezi şablon; her tedarikçi için aynı. Dil her zaman
// TÜRKÇE (yöneticinin panel dili ne olursa olsun). Üstte ortak GKH düzeni (logo — server/mail/layout.js); burada yalnızca
// gövde üretilir. Konu: "GKH Trading Invest – Sipariş <NO> – <TEDARİKÇİ>" (revizyonda sonuna " – Revizyon <n>").
// Ürün tablosu YALNIZCA dört sütundur: Ürün Kodu · Açıklama · Miktar · Birim (karar 271 — Renk/RAL, Birim Fiyat, Toplam ve
// genel toplam e-postada yazılmaz; satırdaki renk ve fiyat verisi veritabanında kalır). Teknik ekler e-postaya eklenir
// (gönderen: server/suppliers/dispatch.js).

import { brandedHtml } from '../layout.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** "2026-10-08" ya da Date → "08.10.2026" */
const dmy = (d) => {
  const key = d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key.split('-').reverse().join('.') : '—';
};

export const SUPPLIER_EMAIL_TEXT = Object.freeze({
  greeting: 'Merhaba,',
  intro: 'Aşağıda detayları bulunan siparişimizi bilgilerinize sunarız.',
  revision: (n) => `Bu e-posta siparişin ${n}. revizyonudur ve önceki sürümün yerine geçer.`,
  orderNo: 'Sipariş No',
  orderDate: 'Sipariş Tarihi',
  supplier: 'Tedarikçi',
  cols: ['Ürün Kodu', 'Açıklama', 'Miktar', 'Birim'],
  note: 'Sipariş Notu',
  attachments: 'Ekler',
  closing: 'Siparişimizin tarafınıza ulaştığını ve tahmini yükleme tarihini teyit etmenizi rica ederiz.',
  regards: 'İyi çalışmalar dileriz.',
  company: 'GKH Trading Invest SRL',
});

/**
 * @param {{ orderNo: string, supplierName: string, orderDate: Date | string, revision: number, currency: string,
 *   lines: { code: string, description: string, color?: string | null, qty: number, unit: string, unitPrice?: string | null, lineTotal?: string | null }[],
 *   showPrices?: boolean, total?: string | null, note?: string | null, attachments?: string[] }} p
 *   unit: birimin Türkçe adı (kutu, poşet, boy, adet). color / unitPrice / lineTotal / showPrices / total kabul edilir
 *   ama e-postaya yazılmaz (karar 271).
 * @returns {{ subject: string, text: string, html: string }}
 */
export function renderSupplierOrderEmail(p) {
  const T = SUPPLIER_EMAIL_TEXT;
  const rev = p.revision > 1 ? ` – Revizyon ${p.revision}` : '';
  const subject = `GKH Trading Invest – Sipariş ${p.orderNo} – ${p.supplierName}${rev}`;
  const cols = T.cols;
  const note = String(p.note ?? '').trim();
  const files = (p.attachments ?? []).filter(Boolean);

  // ---- düz metin ----
  const rowText = (l) => [l.code, l.description, String(l.qty), l.unit].join(' | ');
  const text = [
    T.greeting,
    '',
    T.intro,
    ...(p.revision > 1 ? [T.revision(p.revision)] : []),
    '',
    `${T.orderNo}: ${p.orderNo}`,
    `${T.orderDate}: ${dmy(p.orderDate)}`,
    `${T.supplier}: ${p.supplierName}`,
    '',
    cols.join(' | '),
    ...p.lines.map(rowText),
    ...(note ? ['', `${T.note}:`, note] : []),
    ...(files.length ? ['', `${T.attachments}: ${files.join(', ')}`] : []),
    '',
    T.closing,
    '',
    T.regards,
    '',
    T.company,
  ].join('\n');

  // ---- HTML (tablo düzeni, satır içi stiller — e-posta programlarıyla uyum) ----
  const th = 'border:1px solid #e5e7eb;padding:6px 8px;background:#f3f4f6;text-align:left;font-size:12px;color:#374151;white-space:nowrap';
  const td = 'border:1px solid #e5e7eb;padding:6px 8px;vertical-align:top';
  const right = `${td};text-align:right;white-space:nowrap`;
  const head = cols.map((c, i) => `<th style="${th}${i === 2 ? ';text-align:right' : ''}">${esc(c)}</th>`).join('');
  const rows = p.lines.map((l) => `<tr>
<td style="${td};white-space:nowrap"><b>${esc(l.code)}</b></td>
<td style="${td}">${esc(l.description)}</td>
<td style="${right}">${esc(String(l.qty))}</td>
<td style="${td}">${esc(l.unit)}</td>
</tr>`).join('\n');
  const kv = (k, v) => `<tr><td style="padding:2px 12px 2px 0;color:#6b7280;white-space:nowrap">${esc(k)}</td><td style="padding:2px 0"><b>${esc(v)}</b></td></tr>`;
  const body = `<p style="margin:0 0 12px">${esc(T.greeting)}</p>
<p style="margin:0 0 12px">${esc(T.intro)}</p>${p.revision > 1 ? `
<p style="margin:0 0 12px;color:#92400e"><b>${esc(T.revision(p.revision))}</b></p>` : ''}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 14px">
${kv(T.orderNo, p.orderNo)}
${kv(T.orderDate, dmy(p.orderDate))}
${kv(T.supplier, p.supplierName)}
</table>
<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;font-size:13px">
<thead><tr>${head}</tr></thead>
<tbody>
${rows}
</tbody>
</table>${note ? `
<p style="margin:14px 0 4px"><b>${esc(T.note)}</b></p>
<p style="margin:0;white-space:pre-line">${esc(note)}</p>` : ''}${files.length ? `
<p style="margin:14px 0 0;color:#6b7280;font-size:12px">${esc(T.attachments)}: ${files.map(esc).join(', ')}</p>` : ''}
<p style="margin:18px 0 12px">${esc(T.closing)}</p>
<p style="margin:0 0 4px">${esc(T.regards)}</p>
<p style="margin:0"><b>${esc(T.company)}</b></p>`;
  const html = brandedHtml({ lang: 'tr', title: subject, body });
  return { subject, text, html };
}
