// Siparişin "Hareketler"i (karar 314 — server/orders/history-placement.js): yönetici ve yönetici yardımcısında sayfanın
// içinde kart olarak; diğer rollerde eskisi gibi sol menünün altında. Guard: veri / süzme aynı, yalnızca yer değişir.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HISTORY_INLINE_ROLES, historyInline } from '../server/orders/history-placement.js';

test('yer: yönetici ve yönetici yardımcısı → sayfa içinde; müşteri, satış, çizim, denetimci → sol menü (eski yer)', () => {
  assert.deepEqual([...HISTORY_INLINE_ROLES], ['ADMIN', 'YONETICI_YARDIMCISI']);
  assert.equal(historyInline('ADMIN'), true);
  assert.equal(historyInline('YONETICI_YARDIMCISI'), true);
  for (const r of ['MUSTERI', 'SATIS', 'CIZIM', 'DENETIMCI', '', null, undefined]) assert.equal(historyInline(r), false, String(r));
});

test('yapı: aynı History bileşeni — cam ve profil siparişinde rolün yeriyle; satırlar ve fiyat değişiklikleri aynı', () => {
  const page = fs.readFileSync(new URL('../app/(panel)/siparisler/[id]/page.tsx', import.meta.url), 'utf8');
  assert.equal((page.match(/inline=\{historyInline\(user\.appRole\)\}/g) ?? []).length, 2, 'cam + profil siparişi');
  const fn = page.slice(page.indexOf('function History('), page.indexOf('// ---------------- işlem kartları'));
  // Sayfa içi kart: başlık + aynı zaman çizelgesi öğeleri
  assert.ok(fn.includes('<div className="card" id="hareketler" data-history="inline">'));
  assert.ok(fn.includes("<h2>{t('order.history')}</h2>"));
  assert.ok(fn.includes('<ul className="timeline">{items.map((i) => i.node)}</ul>'));
  // Diğer roller: sol menünün altı (eski yer, değişmedi)
  assert.ok(fn.includes('<SidebarPortal>'));
  assert.ok(fn.includes('<ul className="timeline side-timeline">{items.map((i) => i.node)}</ul>'));
  // Süzme eskisi gibi (eventText + müşteri görünümü); fiyat değişiklikleri yalnızca sayfanın verdiği kadar
  assert.ok(fn.includes('const label = eventText(t, e.event, isCustomer);'));
  assert.ok(fn.includes('for (const c of priceChanges)'));
  // Sol menüdeki yuva yerinde (diğer roller için)
  const layout = fs.readFileSync(new URL('../app/(panel)/layout.tsx', import.meta.url), 'utf8');
  assert.ok(layout.includes('<div id={SIDEBAR_SLOT} className="sidebar-activity" />'));
});
