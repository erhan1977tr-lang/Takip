// 4.2.24 (karar 324) — profil siparişinde "Kurye ile gönderim": saf kurallar, depo e-postaları ve Comanda Depozit PDF'i.
// Veritabanı / ağ yok.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { COURIER_TEXT_RO, courierFlag, missingPickup } from '../server/profile/rules.js';
import { renderWarehouseEmail } from '../server/mail/templates/warehouse.js';
import { renderDeliveredEmail } from '../server/mail/templates/delivered.js';
import { depotFormPdf } from '../server/pdf/depot-form.js';
import { FONTS } from '../server/pdf/fonts.js';

const D = (key) => new Date(`${key}T12:00:00.000Z`);

test('kurye: plaka eksik sayılmaz; telefon ve alış günü kuralı aynen kalır', () => {
  assert.deepEqual(missingPickup({ pickupDate: D('2026-11-20'), contactPhone: '0723', vehiclePlate: null, courier: true }), []);
  assert.deepEqual(missingPickup({ pickupDate: D('2026-11-20'), contactPhone: '', vehiclePlate: null, courier: true }), ['contactPhone']);
  assert.deepEqual(missingPickup({ pickupDate: null, contactPhone: '0723', vehiclePlate: null, courier: true }), ['pickupDate']);
  // Kurye seçilmemiş sipariş eskisi gibi: plaka zorunlu
  assert.deepEqual(missingPickup({ pickupDate: D('2026-11-20'), contactPhone: '0723', vehiclePlate: null, courier: false }), ['vehiclePlate']);
  assert.deepEqual(missingPickup({ pickupDate: D('2026-11-20'), contactPhone: '0723', vehiclePlate: null }), ['vehiclePlate']);
});

test('kurye işareti: yalnızca açık "evet" değerleri', () => {
  for (const v of [true, '1', 'on', 'true']) assert.equal(courierFlag(v), true, String(v));
  for (const v of [false, '0', '', null, undefined, 'off', 'yes', 1]) assert.equal(courierFlag(v), false, String(v));
});

const items = [{ code: 'GK15', name: 'Garnitura', unit: 'cutii', qty: 4 }];

test('depo e-postası: kuryede plaka satırı yerine "LIVRARE PRIN CURIER"; kurye değilse eskisi gibi', () => {
  const base = { orderNo: 'GLAP12', firmName: 'Firma', pickupDate: D('2026-11-20'), phone: '+40 723', link: 'https://x/depo/a', validDays: 60, items };
  const c = renderWarehouseEmail({ ...base, plate: null, courier: true });
  assert.match(c.subject, /ridicare 20\.11\.2026 — LIVRARE PRIN CURIER$/);
  assert.ok(c.text.includes('Transport: LIVRARE PRIN CURIER'));
  assert.ok(!c.text.includes('Nr. mașină'));
  assert.ok(c.html.includes('LIVRARE PRIN CURIER') && !c.html.includes('Nr. mașină'));
  const n = renderWarehouseEmail({ ...base, plate: 'B 1 ABC' });
  assert.equal(n.subject, 'Comanda depozit GLAP12 — Firma — ridicare 20.11.2026');
  assert.ok(n.text.includes('Nr. mașină: B 1 ABC') && !n.text.includes('CURIER'));
  assert.equal(COURIER_TEXT_RO, 'Livrare prin curier');
});

test('teslim onayı e-postası: kuryede "Transport: LIVRARE PRIN CURIER"', () => {
  const base = { orderNo: 'GLAP12', firmName: 'Firma', phone: '+40', pickupDate: D('2026-11-20'), deliveredAt: new Date('2026-11-20T09:00:00Z'), timeZone: 'Europe/Bucharest', items, documents: [] };
  const c = renderDeliveredEmail({ ...base, plate: null, courier: true });
  assert.ok(c.text.includes('Transport: LIVRARE PRIN CURIER') && !c.text.includes('Nr. mașină'));
  const n = renderDeliveredEmail({ ...base, plate: 'B 1' });
  assert.ok(n.text.includes('Nr. mașină: B 1') && !n.text.includes('CURIER'));
});

// PDF metni (gömülü yazı tipinin glif kodlarından geri çevrilir — test/db/delivery.test.js ile aynı yöntem)
const REVERSE = Object.fromEntries(['Regular', 'Bold'].map((k) => [k, new Map(FONTS[k].map.map(([cp, gid]) => [gid, cp]))]));
function textOf(pdf) {
  const out = [];
  const s = pdf.toString('latin1');
  const re = /<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g;
  for (let m; (m = re.exec(s));) {
    const start = m.index + m[0].length;
    let ops;
    try { ops = zlib.inflateSync(pdf.subarray(start, start + Number(m[1]))).toString('latin1'); } catch { continue; }
    for (const t of ops.matchAll(/\/(F1|F2) [\d.]+ Tf [\d.-]+ [\d.-]+ Td <([0-9a-f]*)> Tj/g)) {
      out.push((t[2].match(/.{4}/g) ?? []).map((h) => String.fromCodePoint(REVERSE[t[1] === 'F2' ? 'Bold' : 'Regular'].get(parseInt(h, 16)) ?? 63)).join(''));
    }
  }
  return out.join('\n');
}

test('Comanda Depozit PDF: kuryede NR MASINI yerine TRANSPORT : LIVRARE PRIN CURIER', () => {
  const p = {
    orderNo: 'GLAP12', firmName: 'Firma', phone: '+40', pickupDate: D('2026-11-20'), date: D('2026-11-18'),
    categories: [{ code: 'GARNITURI', name: 'Garnituri', unit: 'CUTII' }],
    products: [{ id: '1', code: 'GK15', categoryCode: 'GARNITURI', name: 'GARNITURA EPDM - GK15', image: null }],
    qty: new Map([['GK15', 4]]), note: null,
  };
  const c = textOf(depotFormPdf({ ...p, plate: null, courier: true }));
  assert.ok(c.includes('TRANSPORT :') && c.includes('LIVRARE PRIN CURIER') && !c.includes('NR MASINI'), c);
  const n = textOf(depotFormPdf({ ...p, plate: 'B 1 ABC' }));
  assert.ok(n.includes('NR MASINI :') && n.includes('B 1 ABC') && !n.includes('CURIER'));
});
