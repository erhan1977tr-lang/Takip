// İstek gövdesi sınırları (güvenlik denetimi 3.50.9 AUD-4, karar 141): vekildeki (deploy/Caddyfile) kademeler ile uygulamanın
// kendi yükleme sınırları birbirini tutmalı — dosya yükleyen her sayfa yeterince büyük, geri kalan her adres küçük sınırda.
// Büyük kademeler yalnızca gövde kapısından geçen isteklere açıktır (karar 143): test/body-gate.test.js.
// Gerçek Caddy arkasındaki deneme: deploy/test/body-limits.sh + deploy/test/body-gate.sh (.github/workflows/deploy-test.yml).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPLOAD_LIMITS } from '../server/files/limits.js';
import { EXCEL_MAX_BYTES } from '../server/files/xlsx.js';
import { MAX_FILE_BYTES } from '../server/orders/rules.js';
import { MAX_IMAGE_BYTES } from '../server/profile/catalog.js';
import { FILE_LIMITS } from '../server/suppliers/rules.js';
import { readCaddyfile } from './caddyfile.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MiB = 1024 * 1024;

// ---------- Caddyfile'ı oku (ortak okuyucu: test/caddyfile.js) ----------
const { code, matchers, tiers, blocked, routeFor, limitFor } = readCaddyfile(path.join(ROOT, 'deploy/Caddyfile'));
const tier = (name) => tiers.find((t) => t.name === name);

/** next.config.mjs → serverActions.bodySizeLimit (bytes kitaplığı: mb = 2^20) */
const nextLimit = () => {
  const m = /bodySizeLimit: '(\d+)mb'/.exec(read('next.config.mjs'));
  assert.ok(m);
  return Number(m[1]) * MiB;
};

test('Caddyfile: üç kademe — yükleme sayfaları 260 MB, yönetim Excel sayfaları 6 MB, geri kalan her istek 2 MB', () => {
  assert.deepEqual(tiers.map((t) => [t.name, t.max, t.gated]), [['yukleme', 260e6, true], ['yonetim_excel', 6e6, true], [null, 2e6, false]]);
  assert.deepEqual(Object.fromEntries(Object.entries(matchers).map(([k, v]) => [k, v.paths])), {
    govde_izni: ['/oturum/govde-izni', '/oturum/govde-izni/*'],
    yukleme: ['/siparisler/*', '/depo/*'],
    yonetim_excel: ['/admin/fiyatlar', '/admin/musteri-fiyatlari', '/admin/katalog', '/admin/profil-katalogu', '/admin/stok'],
  });
  assert.deepEqual(blocked.map((b) => b.name), ['govde_izni']);
  // Kademeler birbirini dışlar (handle); her kademede bir request_body ve aynı vekil tanımı (snippet). Büyük kademelerde
  // sıra sabittir (route): önce kapı, sonra gövde sınırı, sonra uygulama — okuyucu (test/caddyfile.js) tam bu biçimi arar.
  assert.equal((code.match(/\brequest_body\b/g) ?? []).length, 3, 'her kademede bir request_body');
  assert.equal((code.match(/\bmax_size\b/g) ?? []).length, 3);
  assert.equal((code.match(/^\thandle\b/gm) ?? []).length, 4, 'kapının adresi + üç kademe');
  assert.equal((code.match(/\bimport uygulama\b/g) ?? []).length, 3);
  assert.equal((code.match(/\bimport govde_kapisi\b/g) ?? []).length, 2);
  assert.equal((code.match(/\breverse_proxy\b/g) ?? []).length, 2, 'iki vekil tanımı: uygulama (snippet) ve kapının sorusu (snippet)');
  assert.match(code, /^\(uygulama\) \{\n\treverse_proxy app:3000 \{\n(\t\theader_up -[\w-]+\n)+\t\}\n\}$/m);
  // Sahte IP başlıkları her kademede temizlenir (SEC-01 değişmedi)
  for (const h of ['CF-Connecting-IP', 'CF-IPCountry', 'True-Client-IP', 'X-Real-IP']) assert.match(code, new RegExp(`header_up -${h}\\b`));
  // Güvenlik başlıkları ve sıkıştırma site düzeyinde, bütün kademeler için
  assert.match(code, /^\tencode zstd gzip$/m);
  for (const h of ['Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'X-Robots-Tag']) assert.match(code, new RegExp(`^\\t\\t${h} `, 'm'));
});

test('adres → sınır: giriş ve diğer olağan adresler 2 MB; büyük sınır yalnızca dosya yükleme formu olan sayfalarda', () => {
  const MB2 = 2e6, MB6 = 6e6, MB260 = 260e6;
  const expected = {
    // giriş gerektirmeyen / olağan adresler
    '/': MB2, '/login': MB2, '/setup': MB2, '/dil': MB2, '/oturum/etkinlik': MB2, '/bildirimler/akis': MB2, '/surum': MB2,
    // panel: dosya yüklenmeyen sayfalar
    '/siparisler': MB2, '/teklifler': MB2, '/yuklemeler': MB2, '/belgeler': MB2, '/ayarlar': MB2,
    '/admin/users': MB2, '/admin/firms': MB2, '/admin/firms/abc': MB2, '/admin/entegrasyonlar': MB2, '/admin/kararlar': MB2,
    '/admin/muhasebe/cam': MB2, '/admin/muhasebe/cam/proforma': MB2, '/admin/profil-fiyatlari': MB2,
    // benzer adlar büyük kademeye düşmez
    '/siparislerim': MB2, '/depo': MB2, '/admin/katalog-yedek': MB2, '/admin': MB2,
    // yönetim Excel yüklemeleri
    '/admin/fiyatlar': MB6, '/admin/musteri-fiyatlari': MB6, '/admin/katalog': MB6, '/admin/profil-katalogu': MB6, '/admin/stok': MB6,
    // dosya yükleme formu olan sayfalar
    '/siparisler/yeni': MB260, '/siparisler/cmabc123': MB260, '/siparisler/cmabc123/cizim/cmdef456': MB260, '/depo/AbC-123_x': MB260,
  };
  for (const [p, max] of Object.entries(expected)) assert.equal(limitFor(p), max, p);
  // Büyük kademe yalnızca kapıdan geçen büyük gövdeli isteğe açıktır; aynı adreste küçük gövde ve GET olağan 2 MB'tadır
  for (const p of ['/siparisler/yeni', '/siparisler/cmabc123', '/depo/AbC-123_x', '/admin/katalog', '/admin/stok']) {
    assert.deepEqual(routeFor({ path: p, method: 'POST', contentLength: '3000000' }), { blocked: false, tier: p.startsWith('/admin') ? 'yonetim_excel' : 'yukleme', gated: true, max: limitFor(p) }, p);
    assert.equal(routeFor({ path: p, method: 'POST', contentLength: null }).gated, true, `${p}: boyu bilinmeyen gövde kapıya sorulur`);
    for (const r of [{ method: 'POST', contentLength: '2000000' }, { method: 'POST', contentLength: '0' }, { method: 'GET' }, { method: 'HEAD' }, { method: 'GET', contentLength: '900000000' }]) {
      assert.deepEqual(routeFor({ path: p, ...r }), { blocked: false, tier: null, gated: false, max: MB2 }, `${p} ${JSON.stringify(r)}`);
    }
  }
  // Büyük kademede olmayan hiçbir adres kapıya sorulmaz (ne boyla ne yöntemle)
  for (const [p, max] of Object.entries(expected)) if (max === MB2) for (const m of ['POST', 'PUT', 'DELETE', 'GET']) assert.equal(routeFor({ path: p, method: m }).gated, false, p);
  // Kapının iç adresi dışarıya kapalıdır
  for (const p of ['/oturum/govde-izni', '/oturum/govde-izni/x', '/OTURUM/Govde-Izni']) assert.equal(routeFor({ path: p }).blocked, true, p);
  assert.equal(routeFor({ path: '/oturum/etkinlik' }).blocked, false);
  // Uygulamadaki her sayfa bir kademeye düşer; büyük kademedekiler yalnızca aşağıdaki sayfalardır
  const pages = [];
  const walk = (dir, url) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${dir}/${e.name}`, /^\(.*\)$/.test(e.name) ? url : `${url}/${e.name.replace(/^\[.*\]$/, 'x1')}`);
      else if (e.name === 'page.tsx') pages.push(url || '/');
    }
  };
  walk('app', '');
  assert.ok(pages.length >= 25, `sayfalar bulunamadı (${pages.length})`);
  // /siparisler/tedarik/* (Paket 6): tedarikçi siparişinin sayfasında teknik ek yükleme formu var; liste ve yeni sipariş
  // sayfası aynı önekte kalır. Caddyfile değişmedi: /siparisler/* zaten yükleme kademesidir ve büyük gövde yalnızca geçerli
  // oturumla kapıdan geçer — /siparisler/<herhangi bir kimlik> sayfası ([id]) zaten aynı kademededir, açıklık değişmez.
  assert.deepEqual(pages.filter((p) => limitFor(p) === MB260).sort(), [
    '/depo/x1', '/siparisler/tedarik', '/siparisler/tedarik/x1', '/siparisler/tedarik/yeni', '/siparisler/x1', '/siparisler/x1/cizim/x1', '/siparisler/yeni',
  ]);
  assert.deepEqual(pages.filter((p) => limitFor(p) === MB6).sort(), ['/admin/fiyatlar', '/admin/katalog', '/admin/musteri-fiyatlari', '/admin/profil-katalogu', '/admin/stok']);
  // Gövde alan tek adres işleyicisi (route handler) oturum etkinliğidir: küçük JSON, varsayılan kademede
  const posts = [];
  const routes = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (e.isDirectory()) routes(`${dir}/${e.name}`);
      else if (/^route\.tsx?$/.test(e.name) && /export (async function|const) (POST|PUT|PATCH|DELETE)\b/.test(read(`${dir}/${e.name}`))) posts.push(`${dir}/${e.name}`);
    }
  };
  routes('app');
  assert.deepEqual(posts, ['app/oturum/etkinlik/route.ts']);
});

test('dosya yükleyen her sunucu işlemi, formunun bulunduğu sayfada yeterli sınıra sahiptir (uygulama sınırı ≤ vekil sınırı)', () => {
  // Dosya okuyan işlem dosyaları ('use server' + File): hangi sayfalarda kullanılır ve uygulamanın kendi sınırı (bayt)
  const DEPOT_FILE = 20 * MiB; // app/depo/[token]/actions.ts → MAX; teslim belgesi de 20 MB
  const uploads = {
    'app/(panel)/siparisler/yeni/actions.ts': { pages: ['/siparisler/yeni'], file: MAX_FILE_BYTES, request: 250e6 },
    'app/(panel)/siparisler/[id]/actions.ts': { pages: ['/siparisler/cmabc123'], file: MAX_FILE_BYTES, request: 250e6 },
    'app/(panel)/siparisler/[id]/profile-actions.ts': { pages: ['/siparisler/cmabc123'], file: DEPOT_FILE, request: DEPOT_FILE },
    'app/depo/[token]/actions.ts': { pages: ['/depo/AbC-123_x'], file: DEPOT_FILE, request: UPLOAD_LIMITS.depotOrder.bytes },
    'app/(panel)/admin/fiyatlar/actions.ts': { pages: ['/admin/fiyatlar', '/admin/musteri-fiyatlari'], file: EXCEL_MAX_BYTES, request: EXCEL_MAX_BYTES },
    'app/(panel)/admin/katalog/actions.ts': { pages: ['/admin/katalog'], file: EXCEL_MAX_BYTES, request: EXCEL_MAX_BYTES },
    'app/(panel)/admin/profil-katalogu/actions.ts': { pages: ['/admin/profil-katalogu'], file: Math.max(EXCEL_MAX_BYTES, MAX_IMAGE_BYTES), request: EXCEL_MAX_BYTES },
    'app/(panel)/admin/stok/actions.ts': { pages: ['/admin/stok'], file: EXCEL_MAX_BYTES, request: EXCEL_MAX_BYTES },
    // Tedarikçi siparişinin teknik ekleri (Paket 6): sayfası /siparisler/tedarik/<id> → yükleme kademesi (gövde kapısı: oturum)
    'app/(panel)/siparisler/tedarik/actions.ts': { pages: ['/siparisler/tedarik/cmabc123'], file: FILE_LIMITS.fileBytes, request: FILE_LIMITS.totalBytes },
  };
  // Depoda dosya okuyan başka işlem dosyası yok: yenisi eklenirse sayfası Caddyfile'da tanımlanmadan bu test geçmez
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { walk(rel); continue; }
      if (!/\.tsx?$/.test(e.name)) continue;
      const src = read(rel);
      if (/^'use server';/.test(src) && /\bfilesFrom\(|instanceof File\b/.test(src)) found.push(rel);
    }
  };
  for (const d of ['app', 'lib', 'components']) walk(d);
  assert.deepEqual(found.sort(), Object.keys(uploads).sort());
  assert.equal(MAX_FILE_BYTES, 100 * MiB);
  assert.equal(EXCEL_MAX_BYTES, 5 * MiB);
  assert.equal(MAX_IMAGE_BYTES, 2 * MiB);
  assert.equal(UPLOAD_LIMITS.depotOrder.bytes, 200 * MiB);
  // Çok parçalı form ek yükü (sınır satırları, alan başlıkları, öbür form alanları) için pay
  const OVERHEAD = 256 * 1024;
  for (const [file, u] of Object.entries(uploads)) {
    for (const p of u.pages) {
      assert.ok(limitFor(p) >= u.file + OVERHEAD, `${file} @ ${p}: en büyük tek dosya sığmalı`);
      assert.ok(limitFor(p) >= u.request + OVERHEAD, `${file} @ ${p}: en büyük meşru istek sığmalı`);
    }
  }
  // Yönetim Excel kademesi gereğinden geniş değil (5 MiB dosya + pay; 8 MB'ı aşmaz)
  assert.ok(tier('yonetim_excel').max <= 8e6);
  // Sayfalar gerçekten bu işlemleri kullanıyor (form sayfanın kendisinde ya da sayfanın bileşeninde)
  assert.match(read('app/(panel)/admin/musteri-fiyatlari/page.tsx'), /PriceTablesView/);
  assert.match(read('app/(panel)/admin/fiyatlar/PriceTablesView.tsx'), /ImportPrices/);
  assert.match(read('app/(panel)/siparisler/[id]/page.tsx'), /<form action=\{uploadDrawingAction\}[\s\S]*<form action=\{addFilesAction\}/);
  assert.match(read('app/(panel)/siparisler/[id]/ProfileOrderView.tsx'), /<form action=\{deliveredAction\}/);
  assert.match(read('app/depo/[token]/page.tsx'), /<form action=\{depotAction\}/);
  assert.match(read('app/(panel)/siparisler/tedarik/[id]/page.tsx'), /<form action=\{uploadFilesAction\}/);
  assert.equal(FILE_LIMITS.fileBytes, 10 * MiB);
  assert.equal(FILE_LIMITS.totalBytes, 20 * MiB);
});

test('varsayılan 2 MB, dosyasız en büyük formlara fazlasıyla yeter (form gövdesi veriyle büyüyen sayfalar)', () => {
  // Tarayıcının çok parçalı form gövdesi: her alan = sınır satırı + başlık + değer (Chromium sınırı 40 karakter; React
  // sunucu işlemi alan adına kısa bir ön ek ekler).
  const field = (name, value) => 40 + 2 + `Content-Disposition: form-data; name="1_${name}"`.length + 4 + Buffer.byteLength(value) + 2;
  const key = 'c'.repeat(25); // kalem anahtarı (cuid)
  const max = limitFor('/yuklemeler');
  assert.equal(max, 2e6);
  // Yükleme onayı (/yuklemeler): cam satırı başına 3 alan (yüklenmeyen adet, neden, 200 karaktere kadar açıklama).
  // Bir yükleme gününde 2.000 cam satırı (her birinde tam uzunlukta açıklama) bile sınırın altında kalır.
  const confirmRow = field(`nl:${key}`, '12') + field(`nlr:${key}`, 'NOT_READY') + field(`nln:${key}`, 'x'.repeat(200));
  assert.ok(2000 * confirmRow < max, `2.000 satır = ${2000 * confirmRow} bayt`);
  // Açıklamasız (olağan) durumda 4.000 satır da sığar
  assert.ok(4000 * (field(`nl:${key}`, '') + field(`nlr:${key}`, '') + field(`nln:${key}`, '')) < max);
  // Düzeltme ön izlemesi aynı biçimdedir (cq / cr / cn)
  assert.ok(2000 * (field(`cq:${key}`, '12') + field(`cr:${key}`, 'NOT_READY') + field(`cn:${key}`, 'x'.repeat(200))) < max);
  // Profil fiyat tablosu (/admin/profil-fiyatlari): ürün başına 2 alan — 5.000 ürün
  assert.ok(5000 * (field('p_id', key) + field('p_price', '12345.67')) < limitFor('/admin/profil-fiyatlari'));
  // Sandık formu (/yuklemeler): sunucu en çok 200 satır kabul eder; satır başına ~1 KB bile olsa küçük
  assert.match(read('app/(panel)/yuklemeler/actions.ts'), /validateCrates\(raw\.slice\(0, 200\)\)/);
  // Fatura / proforma seçimleri: en çok 500 sipariş kimliği
  for (const f of ['app/(panel)/yuklemeler/billing-actions.ts', 'app/(panel)/admin/muhasebe/cam/proforma/actions.ts']) assert.match(read(f), /\.slice\(0, 500\)/, f);
  assert.ok(500 * field('orderId', key) < max);
  // Veriyle büyüyen öbür gövdeler büyük kademelerdedir: teklif tablosu sipariş sayfasında, Excel onay verisi yönetim Excel sayfalarında
  assert.equal(limitFor('/siparisler/cmabc123'), 260e6);
  for (const f of ['fiyatlar', 'katalog', 'profil-katalogu']) assert.match(read(`app/(panel)/admin/${f}/actions.ts`), /JSON\.parse\(String\((formData|fd)\.get\('(payload|changes)'\)/, f);
});

test('Next sunucu işlemi sınırı: 250 MB (formda yazan kural) kalır; bağlayıcı sınır vekildedir', () => {
  // Yeni sipariş formunda müşteriye yazılan kural iki dilde aynı: dosya başına 100 MB, toplam 250 MB
  for (const loc of ['tr', 'ro']) assert.match(read(`server/i18n/${loc}/newOrder.js`), /limits: '[^']*100 MB[^']*250 MB[^']*'/, loc);
  assert.equal(nextLimit(), 250 * MiB);
  // Yükleme kademesi: yazılan toplam (250 MB) ve iki tam boy dosya sığar; Next'in sınırı vekilinkinden büyük-eşit
  // (vekilden geçen istek Next'te boyuttan reddedilmez — tek bağlayıcı sınır vekil)
  assert.ok(tier('yukleme').max >= 250e6 + 1e6);
  assert.ok(tier('yukleme').max >= 2 * MAX_FILE_BYTES + 1e6);
  assert.ok(nextLimit() >= tier('yukleme').max);
  // Sınır geneldir: başka bodySizeLimit tanımı yok
  assert.equal((read('next.config.mjs').match(/bodySizeLimit:/g) ?? []).length, 1);
});

test('zaman aşımları ve sürümden bağımsızlık; bellek sınırı bu değişiklikte yok (SEC-12\'ye ertelendi)', () => {
  // Genel seçenekler: başlık 30 sn, gövdenin tamamı 1 saat
  assert.match(code, /^\{\n\tservers \{\n\t\ttimeouts \{\n\s+read_header 30s\n\s+read_body 1h\n\t\t\}\n\t\}\n\}$/m);
  // Yalnızca Caddy 2'nin eski sürümlerinde de bulunan özellikler: sürüme bağlı olanlar kullanılmaz
  // (forward_auth yönergesi yerine aynı işi yapan açık reverse_proxy tanımı kullanılır: izin yanıtı tam olarak denetlenebilsin)
  for (const word of ['read_timeout', 'write_timeout', 'read_body_idle', 'write_idle', 'forward_auth', 'expression']) assert.doesNotMatch(code, new RegExp(`\\b${word}\\b`), word);
  assert.equal((code.match(/\btimeouts\b/g) ?? []).length, 1, 'yalnızca genel seçenekteki timeouts; "timeouts" yönergesi (yeni sürüm) kullanılmaz');
  // Uygulamaya vekilin yukarı akış zaman aşımları değişmedi (uzun süren işlemler / büyük yüklemeler kesilmesin):
  // zaman aşımı yalnızca kapının gövdesiz sorusundadır (karar 143)
  assert.equal((code.match(/\btransport\b/g) ?? []).length, 1);
  assert.doesNotMatch(/^\(uygulama\) \{\n([\s\S]*?)\n\}$/m.exec(code)[1], /transport|timeout/);
  // Uygulama kapsayıcısına bellek / işlemci / süreç sınırı EKLENMEDİ (AUD-4'ün o bölümü SEC-12 kararını bekliyor)
  const compose = read('deploy/docker-compose.yml');
  for (const key of ['mem_limit', 'mem_reservation', 'memswap_limit', 'cpus', 'pids_limit', 'deploy', 'ulimits']) assert.doesNotMatch(compose, new RegExp(`^\\s*${key}:`, 'm'), key);
  // Caddy imajı ve bağlama aynı
  assert.match(compose, /image: caddy:2\n/);
  assert.match(compose, /- \.\/Caddyfile:\/etc\/caddy\/Caddyfile:ro/);
  // Gerçek Caddy denemesi: yalnızca CI'da çalışır, sözdizimi geçerli, iş akışında çağrılıyor
  const script = 'deploy/test/body-limits.sh';
  assert.match(read(script), /^\[ "\$\{GITHUB_ACTIONS:-\}" = true \] \|\| \{ .*exit 2; \}$/m);
  execFileSync('bash', ['-n', path.join(ROOT, script)]);
  const wf = read('.github/workflows/deploy-test.yml');
  assert.match(wf, /bash deploy\/test\/body-limits\.sh\b/);
  assert.match(wf, /shellcheck [^\n]*deploy\/test\/body-limits\.sh/);
});
