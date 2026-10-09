// Çizim sürümünün içeriğine erişim — karar 146 (güvenlik denetimi 3.50.9 AUD-8).
// Tek kural server/orders/drawing-access.js'tedir; sipariş verisi (sanitizeOrder), dosya adresi (/dosya/cizim/…) ve çizim
// görüntüleyicisi aynı işlevleri kullanır. Müşteri geri çekilen sürümün SATIRINI görür (durum, tarih, gerekçe);
// dosyalarını ve müşteri notunu alamaz. İç roller, taslak ve gönderilmiş / onaylanmış / revizyon istenmiş sürümler değişmedi.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CUSTOMER_HIDDEN_STATUSES, CUSTOMER_OPEN_STATUSES, CUSTOMER_ROW_ONLY_STATUSES,
  drawingAccess, drawingFileWhere, drawingsView, findDrawingFile,
} from '../server/orders/drawing-access.js';
import { ROLES, can } from '../server/auth/permissions.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

/** Şemadaki çizim durumları (prisma/schema.prisma → enum DrawingStatus) */
const SCHEMA_STATUSES = (() => {
  const body = /enum DrawingStatus \{([\s\S]*?)\}/.exec(read('prisma/schema.prisma'))[1];
  return body.split('\n').map((l) => l.replace(/\/\/.*$/, '').trim()).filter(Boolean);
})();
const INTERNAL = ['ADMIN', 'YONETICI_YARDIMCISI', 'SATIS', 'CIZIM', 'DENETIMCI'];

test('roller: iç dosyaları gören roller (yönetici, satış, çizim, denetimci) ve görmeyen tek rol (müşteri) — kural yetkiye bakar, rol adına değil', () => {
  assert.deepEqual([...ROLES].sort(), [...INTERNAL, 'MUSTERI'].sort());
  for (const r of INTERNAL) assert.equal(can(r, 'FILE_INTERNAL_VIEW'), true, r);
  assert.equal(can('MUSTERI', 'FILE_INTERNAL_VIEW'), false);
  const src = strip(read('server/orders/drawing-access.js'));
  assert.equal(/'MUSTERI'|'ADMIN'|'SATIS'|'CIZIM'|'DENETIMCI'/.test(src), false, 'rol adı yazılmaz');
  assert.ok(src.includes("can(role, 'FILE_INTERNAL_VIEW')"));
});

test('şemadaki HER çizim durumu sınıflandırılmıştır (açık / yalnızca satır / gizli) — yeni durum eklenirse karar verilmeden geçmez', () => {
  assert.deepEqual(SCHEMA_STATUSES.sort(), ['BEKLIYOR', 'GERI_CEKILDI', 'ONAYLANDI', 'ONAY_BEKLIYOR', 'REVIZYON_ISTENDI', 'TASLAK', 'YAPILIYOR']);
  const classified = [...CUSTOMER_OPEN_STATUSES, ...CUSTOMER_ROW_ONLY_STATUSES, ...CUSTOMER_HIDDEN_STATUSES];
  assert.deepEqual([...classified].sort(), [...SCHEMA_STATUSES].sort(), 'her durum tam bir kümede');
  assert.equal(new Set(classified).size, classified.length, 'bir durum iki kümede olamaz');
  assert.deepEqual([...CUSTOMER_ROW_ONLY_STATUSES], ['GERI_CEKILDI']);
  assert.deepEqual([...CUSTOMER_HIDDEN_STATUSES], ['TASLAK']);
  assert.equal(Object.isFrozen(CUSTOMER_OPEN_STATUSES) && Object.isFrozen(CUSTOMER_ROW_ONLY_STATUSES) && Object.isFrozen(CUSTOMER_HIDDEN_STATUSES), true);
});

test('erişim tablosu (rol × durum): iç roller her şeyi görür; müşteri taslağı hiç, geri çekileni yalnızca satır olarak, ötekileri tam görür', () => {
  for (const role of INTERNAL) for (const st of [...SCHEMA_STATUSES, 'BILINMEYEN']) assert.equal(drawingAccess(role, st), 'FULL', `${role} ${st}`);
  const customer = {
    TASLAK: 'NONE', GERI_CEKILDI: 'ROW', ONAY_BEKLIYOR: 'FULL', ONAYLANDI: 'FULL', REVIZYON_ISTENDI: 'FULL', BEKLIYOR: 'FULL', YAPILIYOR: 'FULL',
  };
  assert.deepEqual(Object.keys(customer).sort(), [...SCHEMA_STATUSES].sort());
  for (const [st, want] of Object.entries(customer)) assert.equal(drawingAccess('MUSTERI', st), want, st);
  // Tanınmayan durum / rol: kapalı
  for (const st of ['BILINMEYEN', '', null, undefined, 'taslak', 'geri_cekildi']) assert.equal(drawingAccess('MUSTERI', st), 'NONE', String(st));
  for (const role of [undefined, null, '', 'YOK', 'musteri']) {
    assert.equal(drawingAccess(role, 'ONAY_BEKLIYOR'), 'FULL');
    assert.equal(drawingAccess(role, 'GERI_CEKILDI'), 'ROW', String(role));
    assert.equal(drawingAccess(role, 'TASLAK'), 'NONE', String(role));
  }
});

test('dosya sorgusunun koşulu erişim tablosuyla AYNI kümedir: dosyası verilen durumlar = içeriği tam görülen durumlar', () => {
  for (const role of INTERNAL) assert.deepEqual(drawingFileWhere(role), {}, role);
  const where = drawingFileWhere('MUSTERI');
  assert.deepEqual(Object.keys(where), ['status']);
  assert.deepEqual(Object.keys(where.status), ['in']);
  const full = SCHEMA_STATUSES.filter((st) => drawingAccess('MUSTERI', st) === 'FULL').sort();
  assert.deepEqual([...where.status.in].sort(), full);
  assert.equal(where.status.in.includes('GERI_CEKILDI') || where.status.in.includes('TASLAK'), false);
  // Her çağrı yeni dizi verir (çağıran değiştirse de kural bozulmaz)
  drawingFileWhere('MUSTERI').status.in.push('GERI_CEKILDI');
  assert.equal(drawingFileWhere('MUSTERI').status.in.includes('GERI_CEKILDI'), false);
});

const file = (id, name) => ({ id, name, storageKey: `2026/10/${id}`, size: 10, mime: 'application/pdf', scanStatus: 'CLEAN', createdAt: new Date('2026-10-01T10:00:00Z') });
const version = (v, status, extra = {}) => ({
  id: `d${v}`, version: v, status, orderId: 'o1', noteCustomer: `müşteri notu v${v}`, noteInternal: `iç not v${v}`, sentAt: new Date('2026-10-01T10:00:00Z'),
  withdrawnAt: null, withdrawReason: null, fileUrl: null, fileName: null, fileSize: null, mime: null, checksum: null, scanSignature: null, scanStatus: 'CLEAN',
  files: [file(`f${v}a`, `cizim-v${v}.pdf`), file(`f${v}b`, `cizim-v${v}.dxf`)], revisions: [], ...extra,
});
const VERSIONS = () => [
  version(1, 'REVIZYON_ISTENDI', { revisions: [{ id: 'r1', comment: 'düzeltin' }] }),
  version(2, 'GERI_CEKILDI', { withdrawnAt: new Date('2026-10-02T09:00:00Z'), withdrawReason: 'Yanlış dosya gönderildi' }),
  // eski tek-dosya alanları dolu bir geri çekilmiş kayıt
  version(3, 'GERI_CEKILDI', { files: [], fileUrl: '2026/09/eski.pdf', fileName: 'eski-cizim.pdf', fileSize: 99, mime: 'application/pdf', checksum: 'abc', scanSignature: 'x', withdrawReason: 'Eski kayıt' }),
  version(4, 'ONAYLANDI'),
  version(5, 'ONAY_BEKLIYOR'),
  version(6, 'TASLAK'),
];

test('sürüm listesi (sanitizeOrder): müşteri — taslak gelmez; geri çekilen sürümün satırı gelir, dosyaları / müşteri notu / eski dosya alanları gelmez; ötekiler aynen', () => {
  const input = VERSIONS();
  const before = JSON.stringify(input);
  const out = drawingsView('MUSTERI', input);
  assert.equal(JSON.stringify(input), before, 'girdi değişmez');
  assert.deepEqual(out.map((d) => [d.version, d.status]), [[1, 'REVIZYON_ISTENDI'], [2, 'GERI_CEKILDI'], [3, 'GERI_CEKILDI'], [4, 'ONAYLANDI'], [5, 'ONAY_BEKLIYOR']]);
  // Geri çekilen: satır bilgisi durur
  const w = out[1];
  assert.deepEqual([w.id, w.version, w.status, w.orderId, w.withdrawReason, w.withdrawnAt.toISOString(), w.sentAt.toISOString()],
    ['d2', 2, 'GERI_CEKILDI', 'o1', 'Yanlış dosya gönderildi', '2026-10-02T09:00:00.000Z', '2026-10-01T10:00:00.000Z']);
  // … içerik gelmez
  assert.deepEqual([w.files, w.noteCustomer], [[], null]);
  const legacy = out[2];
  assert.deepEqual([legacy.files, legacy.noteCustomer, legacy.fileUrl, legacy.fileName, legacy.fileSize, legacy.mime, legacy.checksum, legacy.scanSignature],
    [[], null, null, null, null, null, null, null]);
  assert.equal(legacy.withdrawReason, 'Eski kayıt');
  // Görünümün hiçbir yerinde geri çekilen sürümün dosya adı / anahtarı / müşteri notu yok
  const text = JSON.stringify(out);
  for (const leak of ['cizim-v2.pdf', 'cizim-v2.dxf', 'f2a', 'f2b', '2026/10/f2a', 'müşteri notu v2', 'eski-cizim.pdf', '2026/09/eski.pdf', 'müşteri notu v3', 'cizim-v6', 'müşteri notu v6']) {
    assert.equal(text.includes(leak), false, leak);
  }
  // Ötekiler DEĞİŞMEDEN (aynı nesne): gönderilmiş, onaylanmış, revizyon istenmiş
  assert.equal(out[0], input[0]);
  assert.equal(out[3], input[3]);
  assert.equal(out[4], input[4]);
  assert.deepEqual([out[4].files.map((f) => f.name), out[4].noteCustomer], [['cizim-v5.pdf', 'cizim-v5.dxf'], 'müşteri notu v5']);
  assert.deepEqual(out[0].revisions, [{ id: 'r1', comment: 'düzeltin' }]);
});

test('geri çekilen sürüm (karar 146 + 168): müşteri notunun saklanan çevirisi de içerikle birlikte kapanır; müşteri çizimi kaydının dosya listesi yalnızca içeriği kapalı satırda boşalır', () => {
  const tr = { translation: 'Marginea corectată', translationLang: 'ro', translationStatus: 'DONE', translationError: null, translationAt: new Date('2026-10-02T08:00:00Z') };
  const input = [version(1, 'GERI_CEKILDI', { ...tr, withdrawReason: 'Yanlış dosya' }), version(2, 'ONAY_BEKLIYOR', tr)];
  const out = drawingsView('MUSTERI', input);
  assert.deepEqual([out[0].translation, out[0].translationLang, out[0].translationStatus, out[0].translationError, out[0].translationAt, out[0].sourceFiles], [null, null, null, null, null, null]);
  assert.equal(JSON.stringify(out[0]).includes('Marginea'), false);
  assert.equal(out[1], input[1], 'açık sürüm aynen (çevirinin görünümü notun kuralında — server/notes/view.js)');
  // Müşterinin DWG/DXF karar kaydı (karar 167): kendi dosyalarının listesi — açık durumlarda (ONAYLANDI / REVIZYON_ISTENDI /
  // YAPILIYOR / BEKLIYOR) aynen gelir
  for (const status of ['ONAYLANDI', 'REVIZYON_ISTENDI', 'YAPILIYOR', 'BEKLIYOR']) {
    const rec = { id: `c-${status}`, version: 1, status, source: 'MUSTERI_DXF_DWG', files: [], sourceFiles: [{ id: 'of1', name: 'plan.dwg', checksum: 'c' }], revisions: [] };
    assert.equal(drawingsView('MUSTERI', [rec])[0], rec, status);
  }
});

test('sürüm listesi: iç roller her sürümü dosyalarıyla ve notlarıyla aynen görür (taslak ve geri çekilen dahil)', () => {
  for (const role of INTERNAL) {
    const input = VERSIONS();
    const out = drawingsView(role, input);
    assert.equal(out.length, input.length, role);
    out.forEach((d, i) => assert.equal(d, input[i], `${role} v${d.version}`));
    assert.deepEqual(out[1].files.map((f) => f.name), ['cizim-v2.pdf', 'cizim-v2.dxf']);
    assert.equal(out[1].noteCustomer, 'müşteri notu v2');
  }
  assert.deepEqual(drawingsView('MUSTERI', []), []);
});

/** Prisma'nın bu iki sorgusunu bellekteki kayıtlar üzerinde çalıştıran küçük sahte veritabanı */
function fakeDb(drawings) {
  const calls = [];
  const okDrawing = (d, w) => (w.id === undefined || w.id === d.id) && (!w.status || w.status.in.includes(d.status))
    && (w.order?.customerId === undefined || w.order.customerId === d.customerId);
  return {
    calls,
    drawingFile: {
      async findFirst({ where }) {
        calls.push(['drawingFile', where]);
        for (const d of drawings) {
          const f = d.files.find((x) => x.id === where.id);
          if (f && okDrawing(d, { ...where.drawing, id: undefined })) return { ...f, drawing: { orderId: d.orderId } };
        }
        return null;
      },
    },
    drawing: {
      async findFirst({ where, include }) {
        calls.push(['drawing', where]);
        const d = drawings.find((x) => okDrawing(x, where));
        return d ? { ...d, files: d.files.slice(0, include.files.take) } : null;
      },
    },
  };
}

test('dosya adresi (/dosya/cizim/<kimlik>): müşteri geri çekilen ve taslak sürümün dosyasını dosya kimliğiyle de eski sürüm kimliğiyle de alamaz; iç roller alır', async () => {
  const rows = VERSIONS().map((d) => ({ ...d, customerId: 'A' }));
  const scope = { removedAt: null, customerId: 'A' };
  const get = (role, id, sc = scope) => findDrawingFile(fakeDb(rows), { id, scope: sc, role });
  // Müşteri: açık sürümler — dosya kimliği ve eski sürüm kimliği
  assert.deepEqual(await get('MUSTERI', 'f5a'), { storageKey: '2026/10/f5a', name: 'cizim-v5.pdf', mime: 'application/pdf', scanStatus: 'CLEAN', orderId: 'o1' });
  assert.equal((await get('MUSTERI', 'f4b')).name, 'cizim-v4.dxf');
  assert.equal((await get('MUSTERI', 'f1a')).name, 'cizim-v1.pdf');
  assert.equal((await get('MUSTERI', 'd5')).name, 'cizim-v5.pdf', 'eski bağlantı: sürümün ilk dosyası');
  // Müşteri: geri çekilen ve taslak — hiçbir kimlikle
  for (const id of ['f2a', 'f2b', 'd2', 'd3', 'f6a', 'f6b', 'd6', 'yok']) assert.equal(await get('MUSTERI', id), null, id);
  // Başka firmanın kapsamı: açık sürüm bile bulunmaz
  assert.equal(await get('MUSTERI', 'f5a', { removedAt: null, customerId: 'B' }), null);
  // İç roller: hepsi (geri çekilen, taslak, eski tek-dosya alanı)
  for (const role of INTERNAL) {
    const all = { removedAt: null };
    assert.equal((await get(role, 'f2a', all)).name, 'cizim-v2.pdf', role);
    assert.equal((await get(role, 'd2', all)).name, 'cizim-v2.pdf', role);
    assert.equal((await get(role, 'f6b', all)).name, 'cizim-v6.dxf', role);
    assert.deepEqual(await get(role, 'd3', all), { storageKey: '2026/09/eski.pdf', name: 'eski-cizim.pdf', mime: 'application/pdf', scanStatus: 'CLEAN', orderId: 'o1' }, role);
  }
  // İki sorgu da AYNI koşulu taşır: sipariş kapsamı + rolün dosya koşulu
  const db = fakeDb(rows);
  await findDrawingFile(db, { id: 'd2', scope, role: 'MUSTERI' });
  const want = { order: scope, ...drawingFileWhere('MUSTERI') };
  assert.deepEqual(db.calls, [['drawingFile', { id: 'd2', drawing: want }], ['drawing', { id: 'd2', ...want }]]);
  const db2 = fakeDb(rows);
  await findDrawingFile(db2, { id: 'yok', scope: { removedAt: null }, role: 'CIZIM' });
  assert.deepEqual(db2.calls, [['drawingFile', { id: 'yok', drawing: { order: { removedAt: null } } }], ['drawing', { id: 'yok', order: { removedAt: null } }]]);
});

test('tek kural, üç kullanıcı: sipariş verisi, dosya adresi ve görüntüleyici ortak işlevleri kullanır; durum karşılaştırması başka yerde yazılmaz', () => {
  const orders = strip(read('lib/orders.ts'));
  assert.ok(orders.includes('drawingsView(user.appRole, order.drawings)'), 'sanitizeOrder → drawingsView');
  assert.equal(/status\s*[!=]==\s*'(TASLAK|GERI_CEKILDI)'/.test(orders), false, 'sanitizeOrder içinde elle durum süzgeci yok');

  const route = strip(read('app/dosya/[kind]/[id]/route.ts'));
  assert.ok(route.includes('file = await findDrawingFile(db, { id, scope, role: user.appRole });'), 'dosya yolu → findDrawingFile');
  assert.equal(/TASLAK|GERI_CEKILDI|db\.drawingFile|db\.drawing\b/.test(route), false, 'dosya yolunda elle sorgu / durum yok');
  // Verilmeyen dosya için indirme kaydı yazılmaz: "bulunamadı" dönüşü denetim kaydından ÖNCE
  const notFound = route.indexOf("if (!file) return new Response(t('common.fileNotFound'), { status: 404 });");
  const audit = route.indexOf("await audit('FILE_DOWNLOAD'");
  assert.ok(notFound > 0 && audit > notFound, 'önce bulunamadı, sonra FILE_DOWNLOAD');
  assert.equal(route.split("audit('FILE_DOWNLOAD'").length - 1, 1, 'tek kayıt noktası');
  assert.ok(route.indexOf('findDrawingFile(') < notFound);

  const viewer = strip(read('app/(panel)/siparisler/[id]/cizim/[drawingId]/page.tsx'));
  // Müşterinin DWG/DXF çiziminin karar kaydı (karar 167) görüntülenecek dosyası olmayan bir kayıttır: görüntüleyici açmaz
  assert.ok(viewer.includes("if (!d || isCustomerDrawingRecord(d) || drawingAccess(user.appRole, d.status) !== 'FULL') notFound();"), 'görüntüleyici → drawingAccess');
  assert.ok(viewer.indexOf("!== 'FULL') notFound();") < viewer.indexOf('<DrawingViewer'), 'denetim, dosya listesi kurulmadan önce');

  // Kuralı kullanan dosyalar: yalnızca bu üçü (yeni bir okuma yolu bilerek eklenir)
  const walk = (dir, exts) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, exts) : exts.test(e.name) ? [p] : [];
  });
  const files = walk('app', /\.tsx?$/).concat(walk('lib', /\.tsx?$/), walk('components', /\.tsx?$/), walk('server', /\.js$/));
  const users = files.filter((f) => /drawing-access\.js/.test(read(f))).sort();
  assert.deepEqual(users, [
    path.join('app', '(panel)', 'siparisler', '[id]', 'cizim', '[drawingId]', 'page.tsx'),
    path.join('app', 'dosya', '[kind]', '[id]', 'route.ts'),
    path.join('lib', 'orders.ts'),
  ].sort());
  // Çizim dosyasını kimliğiyle arayan başka kod yok (dosya içeriği yalnızca /dosya/cizim yolundan çıkar)
  const finders = files.filter((f) => f !== path.join('server', 'orders', 'drawing-access.js'))
    .filter((f) => /drawingFile\.find(First|Unique)\(/.test(strip(read(f))));
  assert.deepEqual(finders, []);
});
