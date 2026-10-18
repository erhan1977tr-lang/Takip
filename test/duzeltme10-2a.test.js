// DÜZELTME 10 — Aşama 2A (3.96.0): M1 ticari teklif kategori sırası + yeni sekme bağlantıları, M4 teslimat fotoğrafı küçük
// resmi (kırpma yok, yakınlaştırılabilir önizleme), M7 ticari teklifte cam maliyeti önerisi (3.97.5: atanmış fiyat tablosundan).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  COMMERCIAL_CATEGORY_ORDER, CATEGORY_ORDER_VERSION, commercialCategoryRank, customerView, parseOffer,
} from '../server/commercial/rules.js';
import { glassCostTable } from '../server/commercial/glass-cost.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const cat = (code, nameRo, sortOrder) => ({ code, nameRo, nameTr: nameRo, sortOrder });
const PROD = (id, c) => ({ id, code: id.toUpperCase(), nameRo: `Produs ${id}`, nameTr: id, unitCode: 'BUCATI', packMeasure: 'BUC', packContent: '1', category: c });
const CAT = {
  glassProducts: new Map([
    ['g1', { id: 'g1', nameTr: 'Lamine 6.6.2', colorTr: 'Şeffaf', nameRo: '6.2.6', colorRo: 'transparent', isActive: true }],
    ['g2', { id: 'g2', nameTr: 'Lamine 8.8.2', colorTr: 'Şeffaf', nameRo: '8.2.8', colorRo: 'transparent', isActive: true }],
  ]),
  profileProducts: new Map([
    ['acc', PROD('acc', cat('ACCESORII', 'ACCESORII', 4))],
    ['pla', PROD('pla', cat('PLASTICE', 'PLASTICE', 2))],
    ['gar', PROD('gar', cat('GARNITURI', 'GARNITURI', 1))],
    ['alu', PROD('alu', cat('PROFILE_ALUMINIU', 'PROFILE ALUMINIU', 3))],
    ['oth', PROD('oth', cat('DIGER', 'DIVERSE', 0))],
  ]),
  customers: new Map(),
  glassCosts: new Map([['g1', '41.5']]),
};
const BASE = { date: '2026-10-17', firmName: 'Test SRL', validityDays: '5', terms: [], note: '', glassExtraCost: '', glass: [] };
const line = (productId) => ({ productId, qty: '1', price: '1' });

test('M1: ticari teklif kategori sırası Alüminyum → Conta → Plastik → Aksesuar; bilinmeyen kategori arkada', () => {
  assert.deepEqual([...COMMERCIAL_CATEGORY_ORDER], ['PROFILE_ALUMINIU', 'GARNITURI', 'PLASTICE', 'ACCESORII']);
  const r = parseOffer({ ...BASE, profile: ['acc', 'oth', 'pla', 'gar', 'alu'].map(line) }, CAT);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.data.categoryOrder, CATEGORY_ORDER_VERSION);
  const v = customerView({ no: 1, version: 1, data: r.data, draft: false });
  assert.deepEqual(v.profileGroups.map((g) => g.title), ['PROFILE ALUMINIU', 'GARNITURI', 'PLASTICE', 'ACCESORII', 'DIVERSE']);
  assert.ok(commercialCategoryRank({ code: 'X', sortOrder: 0 }) > commercialCategoryRank({ code: 'ACCESORII' }));
});

test('M1: kesinleşmiş eski sürüm (categoryOrder yok) eski sırasıyla çizilir — belge değişmez', () => {
  const r = parseOffer({ ...BASE, profile: ['acc', 'pla', 'gar', 'alu'].map(line) }, CAT);
  const legacy = JSON.parse(JSON.stringify(r.data));
  delete legacy.categoryOrder;
  for (const l of legacy.profile) delete l.categoryRank;
  const v = customerView({ no: 1, version: 1, data: legacy, draft: false });
  assert.deepEqual(v.profileGroups.map((g) => g.title), ['GARNITURI', 'PLASTICE', 'PROFILE ALUMINIU', 'ACCESORII']);
});

test('M1: müşteri profil sipariş formu kendi katalog sırasını kullanır (bu modülün sırası yalnızca ticari teklifte)', () => {
  for (const f of ['app/(panel)/siparisler/yeni/page.tsx', 'server/profile/catalog.js']) {
    if (fs.existsSync(path.join(ROOT, f))) assert.doesNotMatch(read(f), /COMMERCIAL_CATEGORY_ORDER|commercialCategoryRank/, f);
  }
});

test('M1: ticari teklif bağlantıları (liste, PDF, Excel, sürümler) yeni sekmede açılır', () => {
  const list = read('app/(panel)/admin/ticari-teklifler/page.tsx');
  assert.match(list, /href=\{`\/admin\/ticari-teklifler\/\$\{o\.id\}`\} target="_blank" rel="noopener noreferrer"/);
  const page = read('app/(panel)/admin/ticari-teklifler/[id]/page.tsx');
  for (const h of ['`${base}/pdf`', '`${base}/excel`', '`${base}/pdf?v=${v.version}`', '`${base}/excel?v=${v.version}`']) {
    assert.ok(page.includes(`href={${h}}`) && new RegExp(`href=\\{${h.replace(/[$`{}?.\/]/g, '\\$&')}\\}[^>]*target="_blank" rel="noopener noreferrer"`).test(page), h);
  }
});

test('M7: liste maliyeti sunucuda kopyalanır; elle farklı maliyet MANUAL; listede olmayan camda değer uydurulmaz', () => {
  const r = parseOffer({ ...BASE, profile: [], glass: [
    { productId: 'g1', en: '1000', boy: '1000', qty: '1', price: '60', cost: '41,50' },
    { productId: 'g1', en: '1000', boy: '1000', qty: '1', price: '60', cost: '43' },
    { productId: 'g2', en: '1000', boy: '1000', qty: '1', price: '60', cost: '' },
    { productId: 'g2', en: '1000', boy: '1000', qty: '1', price: '60', cost: '50' },
    { productId: 'g1', en: '1000', boy: '1000', qty: '1', price: '60', cost: '' },
  ] }, CAT);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.data.glass.map((l) => [l.listCost, l.cost, l.costSource]), [
    ['41.5', '41.5', 'LIST'], ['41.5', '43', 'MANUAL'], [null, null, null], [null, '50', null], ['41.5', null, null],
  ]);
  // Müşteri belgesine liste / elle maliyet gitmez
  const json = JSON.stringify(customerView({ no: 1, version: 1, data: r.data, draft: false }));
  for (const k of ['listCost', 'costSource', '41.5', 'MANUAL']) assert.ok(!json.includes(k), k);
});

test('M7: cam maliyeti kullanıcıya atanmış etkin SALES tablosundan (yoksa varsayılan); ad aranmaz; EUR değilse öneri yok', async () => {
  const fake = (tables, items = [], user = { priceTableId: null }) => ({
    user: { findUnique: async () => user },
    priceTable: { findMany: async ({ where }) => tables.filter((t) => t.kind === where.kind && (where.isActive === undefined || t.isActive === where.isActive)) },
    priceTableItem: { findMany: async ({ where }) => items.filter((i) => i.tableId === where.tableId && (!where.glassProductId || where.glassProductId.in.includes(i.glassProductId))) },
  });
  const dec = (s) => ({ toString: () => s, valueOf: () => Number(s) });
  const T = { id: 't1', name: 'GKH - Trakya 2026', kind: 'SALES', isActive: true, isDefault: false, currency: 'EUR' };
  const D = { id: 't0', name: 'Varsayılan', kind: 'SALES', isActive: true, isDefault: true, currency: 'EUR' };
  const items = [{ tableId: 't1', glassProductId: 'g1', unitPrice: dec('41.50') }, { tableId: 't1', glassProductId: 'g2', unitPrice: dec('0') }, { tableId: 't0', glassProductId: 'g1', unitPrice: dec('30') }];
  // Atanmış tablo (adı "GKH - Trakya 2026" — tire ve boşluk fark etmez, ad hiç aranmaz)
  const ok = await glassCostTable(fake([T, D], items, { priceTableId: 't1' }), 'u1');
  assert.equal(ok.table.name, 'GKH - Trakya 2026');
  assert.deepEqual([...ok.prices], [['g1', '41.50']]); // 0 fiyat "fiyat yok" sayılır
  // Atama yok → etkin varsayılan tablo (satışçının teklif satırlarını dolduran kuralın aynısı)
  assert.equal((await glassCostTable(fake([T, D], items), 'u1')).table.name, 'Varsayılan');
  // Atanmış tablo pasif → varsayılan; o da yoksa öneri yok
  assert.equal((await glassCostTable(fake([{ ...T, isActive: false }, D], items, { priceTableId: 't1' }), 'u1')).table.id, 't0');
  assert.equal((await glassCostTable(fake([T], items), 'u1')).reason, 'MISSING');
  assert.equal((await glassCostTable(fake([]), 'u1')).reason, 'MISSING');
  assert.equal((await glassCostTable(fake([{ ...T, currency: 'TRY' }], [], { priceTableId: 't1' }), 'u1')).reason, 'CURRENCY');
  assert.equal((await glassCostTable(fake([{ ...T, kind: 'CUSTOMER' }], [], { priceTableId: 't1' }), 'u1')).reason, 'MISSING');
});

test('M7: yalnızca ticari teklif modülü kullanır; sipariş teklif editörü fiyatlaması değişmez', () => {
  const users = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['node_modules', '.next', '.git'].includes(e.name)) walk(p); continue; }
      if (/\.(js|ts|tsx|mjs)$/.test(e.name) && /glassCostTable|GLASS_COST_TABLE_NAME/.test(read(p))) users.push(p);
    }
  };
  for (const d of ['app', 'lib', 'server', 'components']) walk(d);
  assert.deepEqual(users.sort(), ['app/(panel)/admin/ticari-teklifler/editor-data.ts', 'server/commercial/glass-cost.js', 'server/commercial/service.js']);
});

test('M4: teslimat fotoğrafı küçük resmi kırpılmaz; tıklayınca aynı yetkili adresle önizleme açılır', () => {
  const css = read('app/globals.css');
  assert.match(css, /\.photo-thumb img \{[^}]*object-fit: contain/);
  assert.doesNotMatch(css, /\.photo-tile img \{[^}]*object-fit: cover/);
  const view = read('app/(panel)/siparisler/[id]/ProfileOrderView.tsx');
  assert.match(view, /<PhotoThumb href=\{`\/dosya\/teslimat\/\$\{ph\.id\}`\}/);
  const comp = read('components/FilePreview.tsx');
  assert.match(comp, /export function PhotoThumb/);
  assert.match(comp, /family="image"/);
});
