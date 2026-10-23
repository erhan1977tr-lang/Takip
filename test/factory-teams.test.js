// Fabrika Ekipleri (4.3.19, karar 304) — saf kurallar ve yapı: girdi denetimi, ad anahtarı, ilk atamada çizim geçmişi
// engeli; bağımsız çizimci değiştirme ve ortak görüntüleme kaldırıldı; ekip bilgisi müşteri yollarına girmez; servis
// işlevlerinin ilk deyimi yetki denetimi.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseTeam, teamNameKey } from '../server/teams/service.js';
import { firstAssignDrawerBlock } from '../server/orders/sales-routing.js';
import { availableActions } from '../server/orders/rules.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); } else if (/\.(js|mjs|ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const SOURCES = ['app', 'lib', 'server', 'components', 'scripts'].flatMap((d) => walk(d));

test('parseTeam: ad 2–80, çizimci zorunlu, yeni ekipte satışçı zorunlu, fiyat tablosu isteğe bağlı', () => {
  assert.equal(parseTeam({ name: 'A', salesUserId: 's', drawerId: 'd' }).code, 'NAME');
  assert.equal(parseTeam({ name: 'x'.repeat(81), salesUserId: 's', drawerId: 'd' }).code, 'NAME');
  assert.equal(parseTeam({ name: 'Trakya', salesUserId: 's', drawerId: '' }).code, 'DRAWER');
  assert.equal(parseTeam({ name: 'Trakya', drawerId: 'd' }).code, 'SALES');
  assert.deepEqual(parseTeam({ name: '  Trakya   Cam ', salesUserId: 's', drawerId: 'd', priceTableId: '' }), { ok: true, team: { id: null, name: 'Trakya Cam', salesUserId: 's', drawerId: 'd', priceTableId: null } });
  assert.equal(parseTeam({ id: 't', name: 'Trakya', drawerId: 'd' }).ok, true, 'düzenlemede satışçı girdisi gerekmez (değişmez)');
  assert.equal(parseTeam(null).code, 'NAME');
});

test('teamNameKey: büyük / küçük harf ve Türkçe I farkı yok', () => {
  assert.equal(teamNameKey('TRAKYA  İzmir'), teamNameKey('trakya izmir'));
  assert.equal(teamNameKey('IŞIK'), teamNameKey('ışık'));
});

test('ilk atama: başka çizimcide çizim geçmişi varsa engel; çizimci aynıysa ya da geçmiş yoksa engel yok', () => {
  const none = { drawings: 0, drawingTrack: 'YOK' };
  assert.equal(firstAssignDrawerBlock(none, null, 'b'), false);
  assert.equal(firstAssignDrawerBlock(none, 'a', 'b'), false, 'geçmiş yok: varsayılan çizimci yazılır');
  assert.equal(firstAssignDrawerBlock({ drawings: 1, drawingTrack: 'YOK' }, 'a', 'b'), true);
  assert.equal(firstAssignDrawerBlock({ drawings: 0, drawingTrack: 'YAPILIYOR' }, 'a', 'b'), true);
  assert.equal(firstAssignDrawerBlock({ drawings: 0, drawingTrack: 'GEREKLI' }, 'a', 'b'), false);
  assert.equal(firstAssignDrawerBlock({ drawings: 3, drawingTrack: 'ONAYLANDI' }, 'a', 'a'), false, 'aynı çizimci');
  assert.equal(firstAssignDrawerBlock({ drawings: 3, drawingTrack: 'ONAYLANDI' }, 'a', null), true, 'yeni satışçının çizimcisi yok');
});

test('bağımsız çizimci değiştirme yok: işlem listesinde, iş akışında, arayüzde ve iletilerde bulunmaz', () => {
  for (const role of ['ADMIN', 'YONETICI_YARDIMCISI', 'SATIS', 'CIZIM']) {
    for (const status of ['YENI', 'HAZIRLANIYOR', 'URETIMDE']) {
      assert.ok(!availableActions({ role, status, orderType: 'GLASS_ORDER' }).includes('assign_drawer'), `${role} ${status}`);
    }
  }
  const hits = SOURCES.filter((f) => /assign_drawer|assignDrawerAction|ORDER_DRAWER_ASSIGNED|data-drawer-assign/.test(read(f)));
  assert.deepEqual(hits, []);
});

test('ortak görüntüleme kaldırıldı: görüntüleme kapsamı / ekip listesi yok; erişim her yerde orderScope', () => {
  const hits = SOURCES.filter((f) => /orderViewScope|teamViewOnly|loadOrderView|salesTeam\b|sales-team\.js/.test(read(f)));
  assert.deepEqual(hits, []);
  assert.equal(fs.existsSync(path.join(ROOT, 'server/orders/sales-team.js')), false);
});

test('ekip bilgisi (FactoryTeam) yalnızca iç yönetim / iç ekip dosyalarında — müşteri yollarına girmez', () => {
  const allowed = new Set([
    'app/(panel)/admin/entegrasyonlar/ekipler/page.tsx',
    'app/(panel)/admin/entegrasyonlar/yonlendirme/page.tsx',
    'app/(panel)/admin/muhasebe/tedarikci/page.tsx',
    'app/(panel)/siparisler/[id]/page.tsx',
    'app/(panel)/yuklemeler/nakliye/route.ts',
    'app/(panel)/yuklemeler/page.tsx',
    'server/teams/service.js',
    'server/teams/state.js',
  ]);
  const users = SOURCES.filter((f) => /factoryTeam/.test(read(f))).map((f) => f.split(path.sep).join('/'));
  assert.deepEqual(users.filter((f) => !allowed.has(f)), []);
  // Sipariş sayfasında yalnızca atama kartının satışçı seçenekleri (ORDER_ASSIGN) — müşteri bu kartı görmez
  const page = read('app/(panel)/siparisler/[id]/page.tsx');
  const at = page.indexOf('factoryTeam');
  assert.ok(page.lastIndexOf("can('assign_sales')", at) > 0, 'yalnızca assignCard içinde');
  // Yükleme sayfası: ad yalnızca CRATE_EDIT + satış olmayan rol (yönetici) için okunur; müşteri CRATE_EDIT'e sahip değil
  assert.match(read('app/(panel)/yuklemeler/page.tsx'), /userCan\(user, 'CRATE_EDIT'\) && user\.appRole !== 'SATIS'\s*\n\s*\? new Map\(\(await db\.user\.findMany\(\{[^\n]*factoryTeam/);
});

test('servis: dışa açık her yazan işlevin ilk deyimi yetki denetimi', () => {
  const src = read('server/teams/service.js');
  for (const fn of ['saveTeam', 'setTeamActive']) {
    const m = new RegExp(`export async function ${fn}\\(.*\\) \\{\\n\\s*(.+)`).exec(src);
    assert.ok(m, fn);
    assert.equal(m[1].trim(), 'if (!allowed(actor)) return FORBIDDEN;', fn);
  }
  // Ekip kaydını yalnızca servis yazar
  const writers = SOURCES.filter((f) => /factoryTeam\.(create|update|upsert|delete)/.test(read(f))).map((f) => f.split(path.sep).join('/'));
  assert.deepEqual(writers, ['server/teams/service.js']);
});

test('fiyat tablosu ve çizimci tekilliği eski ekranlarda da: setDefaultDrawer ve assignTable ekip kilidi + çakışma denetimi', () => {
  const routing = read('server/orders/sales-routing.js');
  assert.match(routing, /await lockTeams\(tx\);\n\s*if \(next && \(await teamActive\(tx, sales\.id\)\) && \(await teamConflicts/);
  const tables = read('server/pricing/tables.js');
  assert.match(tables, /await lockTeams\(tx\);\n\s*if \(tableId && tableId !== u\.priceTableId && \(await teamActive\(tx, u\.id\)\) && \(await teamConflicts/);
  // Pasif ekip: yönlendirme ve atama
  assert.match(routing, /teamInactive\(tx, target\.id\)\) \? 'TEAM_INACTIVE'/);
  assert.match(read('server/orders/transitions.js'), /if \(await teamInactive\(h\.tx, target\.id\)\) throw new WorkflowError\('TEAM_INACTIVE'\);/);
});

test('canlı eşleşme raporu (deploy/canliya-gecis/ekip-eslesmeleri.sql): salt okunur; şifre / token / e-posta / tutar / müşteri adı okumaz', () => {
  const sql = read('deploy/canliya-gecis/ekip-eslesmeleri.sql');
  const body = sql.replace(/--.*$/gm, '').replace(/\\echo.*$/gm, '');
  assert.match(body, /BEGIN TRANSACTION READ ONLY;/);
  assert.match(body, /ROLLBACK;\s*$/);
  assert.ok(!/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT|COPY)\b/i.test(body.replace(/'[^']*'|"[^"]*"/g, "''")));
  for (const banned of ['passwordHash', 'email', 'token', '"code"', 'amount', 'phone', 'Session', 'UserInvite', '"Customer"']) {
    assert.ok(!body.includes(banned), banned);
  }
});
