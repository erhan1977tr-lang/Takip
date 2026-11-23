// Toplu (müşteri) proforma 4.2.27 — karar 326: günü belli olmayan / geçmiş yüklenmemiş siparişler, otomatik avans dayanağı.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OPEN_PAST_DAYS, OPEN_SLOT, batchText, cleanDays, slotOf } from '../server/glass/batch.js';
import { autoAdvanceBasis } from '../server/glass/invoice-batch.js';
import { readFileSync } from 'node:fs';

const TODAY = '2026-11-23';
const at = (day) => new Date(`${day}T10:00:00Z`);

test('slotOf: gelecekteki gün kendi günü; günü olmayan / geçmiş ve yüklenmemiş sipariş "bekleyen" grubu', () => {
  assert.equal(slotOf({ status: 'URETIMDE', estimatedShipDate: at('2026-11-30'), actualShipDate: null }, TODAY), '2026-11-30');
  assert.equal(slotOf({ status: 'HAZIRLANIYOR', estimatedShipDate: at(TODAY), actualShipDate: null }, TODAY), TODAY);
  for (const status of ['YENI', 'HAZIRLANIYOR', 'URETIMDE']) assert.equal(slotOf({ status, estimatedShipDate: null, actualShipDate: null }, TODAY), OPEN_SLOT);
  for (const status of ['YUKLENDI', 'ARSIVLENDI', 'IPTAL']) assert.equal(slotOf({ status, estimatedShipDate: null, actualShipDate: null }, TODAY), null);
  // Geçmiş tarih: yalnızca üretim akışında, "Yüklendi" işaretsiz ve son OPEN_PAST_DAYS gün içinde
  assert.equal(slotOf({ status: 'URETIMDE', estimatedShipDate: at('2026-11-20'), actualShipDate: null }, TODAY), OPEN_SLOT);
  assert.equal(slotOf({ status: 'YENI', estimatedShipDate: at('2026-11-20'), actualShipDate: null }, TODAY), null);
  assert.equal(slotOf({ status: 'YUKLENDI', estimatedShipDate: at('2026-11-20'), actualShipDate: at('2026-11-20') }, TODAY), null);
  const edge = new Date(Date.parse(`${TODAY}T00:00:00Z`) - OPEN_PAST_DAYS * 86_400_000).toISOString().slice(0, 10);
  const older = new Date(Date.parse(`${TODAY}T00:00:00Z`) - (OPEN_PAST_DAYS + 1) * 86_400_000).toISOString().slice(0, 10);
  assert.equal(slotOf({ status: 'URETIMDE', estimatedShipDate: at(edge), actualShipDate: null }, TODAY), OPEN_SLOT);
  assert.equal(slotOf({ status: 'URETIMDE', estimatedShipDate: at(older), actualShipDate: null }, TODAY), null);
});

test('cleanDays "bekleyen" anahtarını kabul eder ve en sona koyar; geçersiz değerler düşer (eski davranış aynı)', () => {
  assert.deepEqual(cleanDays([OPEN_SLOT, '2026-11-30', '2026-11-24', 'x', OPEN_SLOT]), ['2026-11-24', '2026-11-30', OPEN_SLOT]);
  assert.deepEqual(cleanDays(['2026-10-23', '2026-10-16', '2026-10-23', 'x', '', null]), ['2026-10-16', '2026-10-23']);
});

test('belge metni: yalnızca günü belli olmayan siparişler → gün yazılmaz', () => {
  assert.equal(batchText({ orders: [{ orderNo: 'ABC001' }], loadingDays: [] }), 'Comanda: ABC001.');
  assert.equal(batchText({ orders: [{ orderNo: 'ABC001' }], loadingDays: [new Date('2026-10-16T00:00:00Z')] }), 'Comanda: ABC001. Încărcare planificată: 16.10.2026.');
});

test('otomatik avans yalnızca FGO dayanaklı tahsilattan (elle kayda dayanan ya da uyuşmayan tahsilat yöneticinin düğmesiyle)', () => {
  assert.equal(autoAdvanceBasis({ basis: 'FGO', match: 'FGO_ONLY' }), true);
  assert.equal(autoAdvanceBasis({ basis: 'FGO_MANUAL', match: 'MATCHED' }), true);
  assert.equal(autoAdvanceBasis({ basis: 'MANUAL', match: 'MANUAL_ONLY' }), false);
  assert.equal(autoAdvanceBasis({ basis: 'MANUAL', match: 'MISMATCH' }), false);
  assert.equal(autoAdvanceBasis({ basis: 'FGO', match: 'MISMATCH' }), false);
});

test('yapı: otomatik avansın yetkisiz girişini yalnızca işçinin turu çağırır; çekirdek dışa açık değil', () => {
  const inv = readFileSync(new URL('../server/glass/invoice-batch.js', import.meta.url), 'utf8');
  assert.match(inv, /^async function issueAdvance\(/m, 'çekirdek dışa aktarılmaz');
  const callers = ['app', 'lib', 'server', 'scripts'].flatMap((d) => grep(new URL(`../${d}/`, import.meta.url), 'autoAdvanceBatch('));
  assert.deepEqual(callers.sort(), ['server/glass/auto-advance.js', 'server/glass/invoice-batch.js']);
  assert.match(readFileSync(new URL('../scripts/worker.mjs', import.meta.url), 'utf8'), /autoAdvanceTick\(db/);
});

import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
function grep(dirUrl, needle) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const out = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      if (f === 'node_modules' || f.startsWith('.')) continue;
      const p = path.join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(m?js|tsx?)$/.test(f) && readFileSync(p, 'utf8').includes(needle)) out.push(path.relative(root, p));
    }
  };
  walk(fileURLToPath(dirUrl));
  return out;
}
