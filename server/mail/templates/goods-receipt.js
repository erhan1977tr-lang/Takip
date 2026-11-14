// Mal kabulü depo e-postası (3.87.0, karar 282) — Romence (depo Romanya'da). Ekinde INTRAREA MARFĂ belgesi (PDF; 4.2.20'den
// beri ürün sahibinin formu, karar 320 — e-postada belge no, palet / kutu ve toplam ağırlık da yazar).
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

const count = (n) => (n == null ? '—' : String(n));
/** Belge bilgisi satırları (düz metin): palet, kutu, toplam ağırlık */
const docText = (d, weightLabel) => (d ? [`Paleți: ${count(d.pallets)}`, `Cutii: ${count(d.boxes)}`, `${weightLabel}: ${d.weight} kg`] : []);
/** Belge bilgisi satırları (HTML tablo satırları) */
const docRows = (d, weightLabel) => (d ? `
<tr><td style="color:#6b7280">Paleți</td><td><b>${esc(count(d.pallets))}</b></td></tr>
<tr><td style="color:#6b7280">Cutii</td><td><b>${esc(count(d.boxes))}</b></td></tr>
<tr><td style="color:#6b7280">${esc(weightLabel)}</td><td><b>${esc(d.weight)} kg</b></td></tr>` : '');

/**
 * @param {{ orderNo: string, supplierName: string, seq: number, receivedOn: Date, reference: string | null, complete: boolean,
 *   lines: { code: string, name: string, color: string | null, length: string | null, qty: number, unit: string }[],
 *   totals: { qty: number, unit: string }[], fileName: string, correction?: { seq: number, createdAt: Date, reason: string },
 *   doc?: { no: string, base?: string, pallets: number | null, boxes: number | null, weight: string } }} p
 *   doc (4.2.20, karar 320): INTRAREA MARFĂ belge no (düzeltmede "… REV.n" + önceki belge no), palet / kutu ve toplam ağırlık
 *   (kg) e-postaya yazılır; düzeltmenin konusu belge no ile kurulur. Verilmezse metin eskisiyle aynıdır.
 *   correction: verilirse e-posta bir kabul DÜZELTMESİNİ bildirir (karar 286) — konu ve metin açıkça "corecție", orijinal
 *   recepția nr. referansı, miktarlar stoktan düşülen adetlerdir.
 * @returns {{ subject: string, text: string, html: string }}
 */
export function renderGoodsReceiptEmail(p) {
  if (p.correction) return renderCorrectionEmail(p);
  const subject = `GKH Trading Invest – Intrare marfă – ${p.orderNo} – recepția nr. ${p.seq} – ${p.supplierName}`;
  const detail = (l) => [l.color ? `culoare ${l.color}` : '', l.length ? `lungime ${len(l.length)}` : ''].filter(Boolean).join(', ');
  const total = p.totals.map((t) => `${t.qty} ${t.unit}`).join(' + ');
  const text = [
    'Bună ziua,',
    '',
    `Marfa de la furnizorul ${p.supplierName} a fost recepționată (comanda furnizor ${p.orderNo}, recepția nr. ${p.seq}).`,
    p.doc ? `Documentul INTRAREA MARFĂ nr. ${p.doc.no} este atașat în PDF (${p.fileName}).` : `Documentul INTRAREA MARFĂ este atașat în PDF (${p.fileName}).`,
    '',
    `Data recepției: ${day(p.receivedOn)}`,
    `Aviz / referință: ${p.reference ?? '—'}`,
    ...docText(p.doc, 'Greutate totală'),
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
<p>Marfa de la furnizorul <b>${esc(p.supplierName)}</b> a fost recepționată (comanda furnizor <b>${esc(p.orderNo)}</b>, recepția nr. <b>${p.seq}</b>). Documentul <b>INTRAREA MARFĂ${p.doc ? ` nr. ${esc(p.doc.no)}` : ''}</b> este atașat în PDF.</p>
<table cellpadding="4" style="border-collapse:collapse">
<tr><td style="color:#6b7280">Data recepției</td><td><b>${esc(day(p.receivedOn))}</b></td></tr>
<tr><td style="color:#6b7280">Aviz / referință</td><td>${esc(p.reference ?? '—')}</td></tr>${docRows(p.doc, 'Greutate totală')}
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

/** Kabul düzeltmesinin depo e-postası (Romence). Orijinal kabulün e-postası değişmez; bu ayrı ve tek bir bildirimdir. */
function renderCorrectionEmail(p) {
  const c = /** @type {{ seq: number, createdAt: Date, reason: string }} */ (p.correction);
  const d = p.doc ?? null;
  // 4.2.20 (karar 320): düzeltme, önceki Intrare Marfă belgesinin numarasına "REV.n" eklenmiş adla CORECȚIE olarak gider
  const subject = d ? `GKH Trading Invest – CORECȚIE – Intrare marfă ${d.no} – ${p.supplierName}`
    : `GKH Trading Invest – CORECȚIE recepție – ${p.orderNo} – recepția nr. ${p.seq} – corecția nr. ${c.seq} – ${p.supplierName}`;
  const detail = (l) => [l.color ? `culoare ${l.color}` : '', l.length ? `lungime ${len(l.length)}` : ''].filter(Boolean).join(', ');
  const total = p.totals.map((t) => `-${t.qty} ${t.unit}`).join(' + ');
  const text = [
    'Bună ziua,',
    '',
    d ? `Intrarea marfă nr. ${d.base} (recepția nr. ${p.seq} din ${day(p.receivedOn)}, comanda furnizor ${p.orderNo}, furnizor ${p.supplierName}) a fost CORECTATĂ.`
      : `Recepția nr. ${p.seq} din ${day(p.receivedOn)} (comanda furnizor ${p.orderNo}, furnizor ${p.supplierName}) a fost CORECTATĂ (corecția nr. ${c.seq}).`,
    'Cantitățile de mai jos au fost scăzute din stoc. Recepția originală și documentul ei rămân neschimbate.',
    d ? `Documentul revizuit INTRAREA MARFĂ nr. ${d.no} (CORECȚIE la ${d.base}, cu cantitățile actualizate) este atașat în PDF (${p.fileName}).`
      : `Documentul CORECȚIE RECEPȚIE este atașat în PDF (${p.fileName}).`,
    '',
    `Data corecției: ${day(c.createdAt)}`,
    `Motiv: ${c.reason}`,
    ...docText(d, 'Greutate totală după corecție'),
    '',
    'Cantități scăzute din stoc:',
    ...p.lines.map((l) => `  - -${l.qty} ${l.unit} — ${l.name} (${l.code})${detail(l) ? ` — ${detail(l)}` : ''}`),
    '',
    `Total: ${p.lines.length} poziții · ${total}`,
    '',
    'Acest e-mail a fost trimis automat de portalul Takip (GKH Trading Invest SRL).',
  ].join('\n');
  const rows = p.lines.map((l) => `<tr>
<td style="border:1px solid #e5e7eb;font-family:monospace">${esc(l.code)}</td>
<td style="border:1px solid #e5e7eb">${esc(l.name)}${detail(l) ? `<br><span style="color:#6b7280;font-size:12px">${esc(detail(l))}</span>` : ''}</td>
<td style="border:1px solid #e5e7eb;text-align:right"><b>-${l.qty}</b></td>
<td style="border:1px solid #e5e7eb">${esc(l.unit)}</td></tr>`).join('\n');
  const html = brandedHtml({ lang: 'ro', title: subject, body: `<p style="margin:0 0 12px">Bună ziua,</p>
<p><b>CORECȚIE:</b> ${d ? `intrarea marfă nr. <b>${esc(d.base ?? '')}</b> (recepția nr. <b>${p.seq}</b> din ${esc(day(p.receivedOn))}, comanda furnizor <b>${esc(p.orderNo)}</b>, furnizor <b>${esc(p.supplierName)}</b>) a fost corectată.` : `recepția nr. <b>${p.seq}</b> din ${esc(day(p.receivedOn))} (comanda furnizor <b>${esc(p.orderNo)}</b>, furnizor <b>${esc(p.supplierName)}</b>) a fost corectată (corecția nr. <b>${c.seq}</b>).`} Cantitățile de mai jos au fost scăzute din stoc; recepția originală și documentul ei rămân neschimbate. ${d ? `Documentul revizuit <b>INTRAREA MARFĂ nr. ${esc(d.no)}</b> (CORECȚIE la ${esc(d.base ?? '')}, cu cantitățile actualizate)` : 'Documentul <b>CORECȚIE RECEPȚIE</b>'} este atașat în PDF.</p>
<table cellpadding="4" style="border-collapse:collapse">
<tr><td style="color:#6b7280">Data corecției</td><td><b>${esc(day(c.createdAt))}</b></td></tr>
<tr><td style="color:#6b7280">Motiv</td><td>${esc(c.reason)}</td></tr>${docRows(d, 'Greutate totală după corecție')}
</table>
<p style="margin-top:14px"><b>Cantități scăzute din stoc</b></p>
<table cellpadding="5" style="border-collapse:collapse;border:1px solid #e5e7eb">
<tr style="background:#f3f4f6"><th style="border:1px solid #e5e7eb;text-align:left">Cod</th><th style="border:1px solid #e5e7eb;text-align:left">Produs</th><th style="border:1px solid #e5e7eb;text-align:right">Cantitate</th><th style="border:1px solid #e5e7eb;text-align:left">U.M.</th></tr>
${rows}
</table>
<p><b>Total:</b> ${p.lines.length} poziții · ${esc(total)}</p>
<p style="color:#6b7280;font-size:12px">Acest e-mail a fost trimis automat de portalul Takip (GKH Trading Invest SRL).</p>` });
  return { subject, text, html };
}
