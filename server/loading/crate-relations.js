// Müşteri paneli "Yüklemelerim → Sandık bilgileri": misafir yük ilişkisi (karar 254). Saf kural — veritabanı okuması
// lib/loading.ts → customerCrateRelations.
//
//   Fiziksel sandık yalnızca EV SAHİBİ müşterinindir; misafir sipariş için ayrı sandık yoktur (karar 33, 124). İlişkinin iki
//   tarafı da kendi panelinde görür:
//     away   — müşterinin KENDİ siparişi başka firmanın sandığında: sandık etiketi, numarası, ölçüleri, ağırlığı, yükleme
//              günü. Ev sahibi firmanın adı / kodu yazılmaz (yalnızca girilmiş fiziksel etiket); o sandıktaki başka
//              siparişler dönmez.
//     hosted — müşterinin KENDİ sandığında başka firmanın siparişi: sandık, misafir firmanın adı ve sipariş numarası
//              (ev sahibine giden misafir yük bildirimiyle aynı bilgi — karar 124). Misafir siparişin fiyatı, belgesi,
//              dosyası açılmaz.
//   İlişkinin tarafı olmayan (üçüncü) müşteri hiçbir şey görmez: yalnızca sipariş sahibi ya da sandık sahibi müşteriye ait
//   bağlar döner (sorgu da bu koşulla sınırlıdır).
import { crateLabel, crateWeight } from './transport.js';

const num = (v) => (v == null || v === '' ? null : Number(v));
const isoDay = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/**
 * @param {{ order: { id: string, orderNo: string, customerId: string, customer?: { name: string } | null },
 *   crate: { id: string, crateNo: number, shipDay: Date | string | null, customerId: string | null, lengthMm: number | null, widthMm: number | null,
 *     heightMm: number | null, netAgirlik?: unknown, brutAgirlik?: unknown, daraKg?: unknown,
 *     customer?: { sandikEtiket?: string | null } | null, orders?: { order: { customerId: string, sandikEtiket?: string | null } }[] } }[]} links
 * @param {string} customerId  görüntüleyen müşteri firması
 */
export function crateRelations(links, customerId) {
  const away = [];
  const hosted = [];
  if (!customerId) return { away, hosted };
  for (const l of links) {
    const c = l.crate;
    const o = l.order;
    if (!c?.customerId || !o || c.customerId === o.customerId) continue; // misafir yük değil
    const day = isoDay(c.shipDay);
    const label = crateLabel(c, () => '', { fallback: false });
    if (o.customerId === customerId) {
      away.push({
        day, orderId: o.id, orderNo: o.orderNo, crateNo: c.crateNo, label,
        lengthMm: c.lengthMm ?? null, widthMm: c.widthMm ?? null, heightMm: c.heightMm ?? null,
        netKg: num(c.netAgirlik), weightKg: crateWeight(c),
      });
    } else if (c.customerId === customerId) {
      hosted.push({ day, crateId: c.id, crateNo: c.crateNo, label, orderNo: o.orderNo, firm: o.customer?.name ?? '' });
    }
  }
  const byDayNo = (a, b) => String(a.day).localeCompare(String(b.day)) || a.crateNo - b.crateNo || a.orderNo.localeCompare(b.orderNo);
  return { away: away.sort(byDayNo), hosted: hosted.sort(byDayNo) };
}
