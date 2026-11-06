// Depo teslim onayı bildirimi (4.2.15, karar 311): şablon ve zaman damgası — ağ yok, DB yok.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveredStamp, renderDeliveredEmail } from '../server/mail/templates/delivered.js';
import { isBranded } from '../server/mail/layout.js';

const sample = (extra = {}) => renderDeliveredEmail({
  orderNo: 'DMCP12', firmName: 'Demo Cam SRL', contactPerson: 'Ion <Demo>', phone: '0700 000 000', plate: 'B 12 DEM',
  pickupDate: new Date('2026-11-06T00:00:00Z'), deliveredAt: new Date('2026-11-06T12:35:10Z'), timeZone: 'Europe/Bucharest',
  items: [{ code: 'AD45', name: 'Garnitură & profil', unit: 'buc', qty: 12 }, { code: 'SPIGOTI', name: 'Spigot inox', unit: 'buc', qty: 4 }],
  documents: ['imza.pdf'], ...extra,
});

test('teslim onayı: Romanya saati damgası (kış +02:00 / yaz +03:00)', () => {
  assert.equal(deliveredStamp(new Date('2026-11-06T12:35:10Z'), 'Europe/Bucharest'), '06.11.2026 14:35');
  assert.equal(deliveredStamp(new Date('2026-07-01T21:30:00Z'), 'Europe/Bucharest'), '02.07.2026 00:30');
  assert.equal(deliveredStamp(null), '—');
});

test('teslim onayı: konu, metin ve HTML — sipariş, müşteri, teslim anı, ürünler, belgeler; HTML kaçışlı ve GKH düzeninde', () => {
  const m = sample();
  assert.equal(m.subject, 'Predare confirmată — comanda DMCP12 — Demo Cam SRL — 06.11.2026 14:35');
  for (const s of ['comanda DMCP12', 'Demo Cam SRL', 'Data predării: 06.11.2026 14:35', 'Data ridicării planificată: 06.11.2026', 'Ion <Demo>', '0700 000 000', 'B 12 DEM',
    '12 buc — Garnitură & profil (AD45)', '4 buc — Spigot inox (SPIGOTI)', 'Documente încărcate de depozit (1): imza.pdf']) assert.ok(m.text.includes(s), s);
  assert.ok(isBranded(m.html), 'ortak GKH düzeni (logo) — karar 129');
  assert.ok(m.html.includes('Ion &lt;Demo&gt;') && !m.html.includes('Ion <Demo>'), 'HTML kaçışı');
  assert.ok(m.html.includes('Garnitură &amp; profil') && m.html.includes('<b>12</b> buc'));
  assert.ok(!m.html.includes('TEST') && !m.text.includes('TEST'), 'gerçek bildirimde test uyarısı yok');
  assert.ok(!/\b(EUR|RON|pre[țt]|lei)\b/i.test(m.text), 'fiyat / tutar yok');
});

test('teslim onayı: belge yok ve test kipi', () => {
  const m = sample({ documents: [], contactPerson: null, phone: null, plate: null, test: true });
  assert.ok(m.subject.startsWith('[TEST] Depo Malzeme Teslim Onayı — Predare confirmată'));
  assert.ok(m.text.startsWith('ACESTA ESTE UN E-MAIL DE TEST.') && m.html.includes('E-MAIL DE TEST'));
  assert.ok(m.text.includes('Documente încărcate de depozit: —') && m.text.includes('Telefon: —'));
  // Test kipi gövdenin geri kalanını değiştirmez (aynı HTML tasarımı)
  const real = sample({ documents: [], contactPerson: null, phone: null, plate: null });
  assert.equal(m.html.replace(/<p style="margin:0 0 14px;padding:10px 12px[^]*?<\/p>/, '').replace('[TEST] Depo Malzeme Teslim Onayı — ', ''), real.html);
});
