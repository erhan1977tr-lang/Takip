// Uygulama içi yol doğrulaması — karar 145 (güvenlik denetimi 3.50.9 AUD-6 + ilgili "safeLink" maddesi).
// Kural tek yerdedir (server/security/internal-path.js) ve iki kullanıcısı vardır: /dil yönlendirmesi (next) ve bildirim
// bağlantısı (safeLink). Buradaki testler ağ kullanmaz: tarayıcının davranışı, tarayıcının da uyguladığı WHATWG URL
// ayrıştırıcısıyla (Node'un URL sınıfı) modellenir; "kotu.example" hiçbir zaman çözülmez / çağrılmaz.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERNAL_PATH_MAX, internalPath } from '../server/security/internal-path.js';
import { safeLink } from '../server/notifications/feed.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

// Değerin çözüleceği sayfa adresleri (yönlendirme /dil'den, bildirim bağlantısı herhangi bir panel sayfasından çözülür)
const SITES = ['https://takip.test/dil?l=ro&next=x', 'http://127.0.0.1:3000/siparisler/abc?x=1#y', 'https://takip.test/a/b/'];
/** Tarayıcı bu değeri sayfa adresine göre çözdüğünde AYNI sitede kalıyor ve yolu "//" ile başlamıyor mu */
function staysInside(v) {
  return SITES.every((site) => {
    const u = new URL(v, site);
    return u.origin === new URL(site).origin && !u.pathname.startsWith('//');
  });
}
/** Değer Location başlığına AYNEN yazılabiliyor mu (Next'in yanıtı kurduğu Response / Headers doğrulaması) */
function headerSafe(v) {
  try {
    return new Response(null, { status: 303, headers: { Location: v } }).headers.get('location') === v;
  } catch {
    return false;
  }
}
/** /dil?next=<ham> isteğinde yolun aldığı değer (sorgu dizesi BİR kez çözülür) ve döneceği Location */
const nextOf = (raw) => new URL(`http://127.0.0.1/dil?l=ro&next=${raw}`).searchParams.get('next');
const locationFor = (raw) => internalPath(nextOf(raw)) ?? '/login';

// Uygulamanın ürettiği bütün biçimler: giriş / kurulum / depo sayfalarının dönüş adresi ve bildirim bağlantıları
const VALID = [
  '/', '/login', '/login?email=a%40b.ro', '/login?email=user%2Btag%40gmail.com', "/login?email=o'brien%40x.ro", '/login?error=locked&m=15',
  '/login?info=idle', '/setup?email=', '/setup?email=x%40y.ro', '/depo/AbC-_123xyzDEF', '/depo/a%2Fb%3Dc',
  '/siparisler', '/siparisler?panel=cizim', '/siparisler/cmgabc123', '/siparisler/cmgabc123#finans', '/siparisler/cmgabc123#kararlar',
  '/siparisler/cmgabc123?ok=created#finans', '/siparisler/cmgabc123?a=1&b=2&c=%C5%9F#x-y_z',
  '/yuklemeler', '/yuklemeler?gun=2026-10-06', '/yuklemeler?gun=2026-10-06#yuklenmeyen', '/yuklemeler?gun=2026-10-06#faturalama',
  '/admin/muhasebe/cam', '/admin/muhasebe/cam#fatura-bekliyor', '/admin/muhasebe/cam/proforma#partiler',
  '/admin/muhasebe/cam/proforma?musteri=cmgcust1#partiler', '/belgeler', '/belgeler#doc-cmgdoc1',
  '/login?next=%2Fx%3Fa%3D1%26b%3D2', '/a?x=!~*()[]{}|^`$,;=+', '/a#!~*()[]{}|^`$,;=+?',
];
// Zararsız ama "şüpheli görünen" değerler: tarayıcıda sitenin kendi yoludur (kullanıcı bilgisi / şema / kodlanmış ayraç
// yalnızca yolun parçasıdır). Yüzde kodlaması yeniden çözülmediği için kabul edilirler.
const HARMLESS = [
  '/evil.example', '/@evil.example', '/user:pw@evil.example', '/https://evil.example', '/javascript:alert(1)', '/:evil.example',
  '/%5cevil.example', '/%5Cevil.example', '/%5c%5cevil.example', '/%09/evil.example', '/%0a/evil.example', '/%0d%0a/evil.example',
  '/%00/evil.example', '/%2f%2fevil.example', '/%2F/evil.example', '/%20/evil.example', '/a/b/../c', '/./a', '/a//b', '/a?x=//evil.example',
  '/a#//evil.example', '/a?next=https://evil.example', '/?//evil.example', '/#//evil.example',
];
const HOSTILE = [
  // çift bölü / ters bölü (tarayıcı ters bölüyü bölü sayar)
  '//evil.example', '///evil.example', '/\\evil.example', '/\\\\evil.example', '/\\/evil.example', '\\\\evil.example', '\\/evil.example',
  '/a\\b', '/a?x=\\', '/a#\\',
  // sekme / satır sonu: tarayıcı adresin her yerinden atar
  '\t', '\n', '\r', '/\t', '/\n', '/\r', '/\t/evil.example', '/\t\\evil.example', '/\t\t/evil.example', '/\n/evil.example', '/\r/evil.example',
  '/\r\n/evil.example', '/\t\n\r/evil.example', '/\n\\evil.example', '/\r\n\\evil.example', '\t//evil.example', '/a\t', '/a?x=\t', '/a#\n',
  '/login\r\nSet-Cookie: x=1', '/login\nLocation: https://evil.example', '/login\r\n\r\n<html>',
  // NUL ve öteki denetim karakterleri, boşluk, DEL
  '/\0/evil.example', '/a\0', '/\x01', '/\x08/evil.example', '/\x0b/evil.example', '/\x0c/evil.example', '/\x1b[0m', '/\x1f/evil.example',
  '/\x7f/evil.example', '/ /evil.example', '/a b', ' /login', '/login ', ' //evil.example',
  // nokta parçaları silinince "//…" yoluna dönüşenler
  '/.//evil.example', '/..//evil.example', '/a/..//evil.example', '/a/b/../..//evil.example', '/%2e//evil.example', '/%2e%2e//evil.example',
  '/a/%2E%2E//evil.example', '/././/evil.example', '/a\\..\\..\\\\evil.example',
  // şema biçimleri
  'https://evil.example', 'http://evil.example', 'HTTPS://EVIL.EXAMPLE', 'https:evil.example', 'https:/evil.example', 'https:\\\\evil.example',
  'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'vbscript:x', 'mailto:a@evil.example', 'file:///etc/passwd', 'blob:x', 'ftp://evil.example',
  // kullanıcı bilgisine benzeyen biçimler
  '//user@evil.example', '//user:pw@evil.example', '//takip.test@evil.example', '/\\takip.test@evil.example', '/\t/takip.test@evil.example',
  'https://takip.test@evil.example/', 'https://takip.invalid@evil.example/', '//takip.invalid:80@evil.example',
  // ASCII dışı (satır ayırıcılar, bölünmez boşluk, BOM, tam genişlikli bölü, harfler)
  '/ /evil.example', '/ /evil.example', '/\u0085/evil.example', '/ /evil.example', '/﻿/evil.example', '/​/evil.example',
  '/／evil.example', '／／evil.example', '/＼evil.example', '/ş', '/é', '/siparisler?q=şişe',
  // göreli / boş
  '', 'login', 'login/', '?x=1', '#x', '.', '..', './login', '../login', 'evil.example', '*',
];

test('geçerli uygulama içi yollar AYNEN döner: sorgu ve parça bayt bayt korunur, tarayıcıda sitede kalır, başlığa yazılabilir', () => {
  for (const v of [...VALID, ...HARMLESS]) {
    assert.equal(internalPath(v), v, show(v));
    assert.equal(staysInside(v), true, `sitede kalır: ${show(v)}`);
    assert.equal(headerSafe(v), true, `başlık değeri: ${show(v)}`);
  }
  // Değer normalleştirilmez: tarayıcının kendi kodlayacağı karakter (') de olduğu gibi döner
  assert.equal(internalPath("/login?email=o'brien%40x.ro"), "/login?email=o'brien%40x.ro");
  assert.notEqual(new URL("/login?email=o'brien%40x.ro", 'http://x.invalid').search, "?email=o'brien%40x.ro", 'ayrıştırıcı bu değeri değiştirirdi');
  // Nokta parçaları da silinmez (tarayıcı kendi çözer; sitede kalır)
  assert.equal(internalPath('/a/b/../c'), '/a/b/../c');
});

test('saldırgan / bozuk değerler reddedilir (null): çift bölü, ters bölü, sekme / LF / CR, NUL ve denetim karakterleri, nokta parçaları, şemalar, kullanıcı bilgisi, ASCII dışı', () => {
  for (const v of HOSTILE) assert.equal(internalPath(v), null, show(v));
  // dize olmayanlar
  for (const v of [null, undefined, 0, 5, true, false, {}, [], ['/login'], { toString: () => '/login' }, Symbol.iterator, () => '/login', new String('/login')]) {
    assert.equal(internalPath(v), null, String(typeof v));
  }
});

test('reddedilenlerin içinde tarayıcının site DIŞINA çözeceği her değer vardır (kural bunları kapatır)', () => {
  // Kanıt değeri: bu dizeler eski denetimlerden ("/" ile başlıyor, "//" ile başlamıyor) geçiyordu ve tarayıcıda başka siteye gider
  const outside = (v) => { try { return new URL(v, SITES[0]).origin !== 'https://takip.test'; } catch { return false; } };
  const oldSafeLink = (v) => typeof v === 'string' && /^\/(?!\/)/.test(v);
  const oldSafeNext = (v) => !(!v || !v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\'));
  const leakedLink = HOSTILE.filter((v) => oldSafeLink(v) && outside(v));
  const leakedNext = HOSTILE.filter((v) => oldSafeNext(v) && outside(v) && headerSafe(v));
  for (const v of ['/\\evil.example', '/\t/evil.example', '/\t\\evil.example', '/\n/evil.example', '/\r\n\\evil.example']) assert.ok(leakedLink.includes(v), `eski safeLink: ${show(v)}`);
  for (const v of ['/\t/evil.example', '/\t\\evil.example', '/\t\t/evil.example']) assert.ok(leakedNext.includes(v), `eski safeNext: ${show(v)}`);
  for (const v of [...leakedLink, ...leakedNext]) assert.equal(internalPath(v), null, show(v));
  // Ve genel olarak: listedeki her değer için "kabul edildiyse sitede kalır"
  for (const v of HOSTILE) if (internalPath(v) != null) assert.equal(staysInside(v), true, show(v));
});

test('uzunluk: 1 … 2000 karakter; 2001 reddedilir', () => {
  assert.equal(INTERNAL_PATH_MAX, 2000);
  const max = `/${'a'.repeat(INTERNAL_PATH_MAX - 1)}`;
  assert.equal(max.length, 2000);
  assert.equal(internalPath(max), max);
  assert.equal(internalPath(`${max}a`), null);
  assert.equal(internalPath(`/${'a'.repeat(100_000)}`), null);
  assert.equal(internalPath(`/x?${'a=1&'.repeat(600)}`), null, 'sorgu ile birlikte uzunluk sayılır');
  assert.equal(internalPath('/'), '/');
});

test('yüzde kodlaması yeniden ÇÖZÜLMEZ: kodlanmış ayraç / denetim karakteri sitenin kendi yoludur ve aynen kalır', () => {
  for (const v of ['/%5cevil.example', '/%5Cevil.example', '/%09/evil.example', '/%0a/evil.example', '/%0d%0aSet-Cookie:x=1', '/%00', '/%2f%2fevil.example', '/%252f', '/%', '/%zz', '/%2']) {
    assert.equal(internalPath(v), v, show(v));
    assert.equal(staysInside(v), true, show(v));
  }
  // Tek istisna ayrıştırıcının kendisinin "nokta parçası" saydığı kodlamadır: yol "//…" olur → reddedilir
  for (const v of ['/%2e//evil.example', '/%2E%2E//evil.example', '/a/%2e%2E//evil.example']) assert.equal(internalPath(v), null, show(v));
  // Doğrulayıcı kaynağında yeniden çözme yok
  const src = read('server/security/internal-path.js').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/decodeURI|unescape|\.normalize\(/.test(src), false, 'değer çözülmez / dönüştürülmez');
  assert.equal(/^\s*import\s/m.test(src), false, 'bağımsız dosya (içe aktarma yok)');
});

test('sorgu dizesi katmanı (/dil?next=…): kodlanmış saldırı değerleri çözülünce reddedilir → /login; geçerli değerler aynen', () => {
  const toLogin = [
    '//evil.example', '/\\evil.example', '/%5cevil.example', '/%5Cevil.example', '%2f%2fevil.example', '%2F%5Cevil.example', '/%2f/evil.example',
    '/%09/evil.example', '/%09\\evil.example', '/%09%5cevil.example', '/%09%09/evil.example', '%2f%09%2fevil.example', '%09//evil.example',
    '/%0a/evil.example', '/%0d/evil.example', '/%0d%0a/evil.example', '/%0a%5cevil.example', '/%0d%0aSet-Cookie:%20x=1', '/login%0d%0aLocation:%20https://evil.example',
    '/%00/evil.example', '/%0b/evil.example', '/%0c/evil.example', '/%1f/evil.example', '/%7f/evil.example', '/%20/evil.example', '/+/evil.example', '/login%20',
    '/.//evil.example', '/a/..//evil.example', '/%2e%2e//evil.example', '/%252e%252e//evil.example', 'https://evil.example', 'https:%2f%2fevil.example', 'javascript:alert(1)',
    '//user@evil.example', '/%5ctakip.test@evil.example', '/%E2%80%A8/evil.example', '/%C2%A0/evil.example', '/%EF%BC%8Fevil.example', '/%c5%9f', '', 'login',
  ];
  for (const raw of toLogin) assert.equal(locationFor(raw), '/login', `${raw} → ${show(nextOf(raw))}`);
  // Eski kuraldan geçip tarayıcıyı dışarı gönderen iki biçim (denetimde doğrulandı) artık /login'e döner
  assert.equal(nextOf('/%09/evil.example'), '/\t/evil.example');
  assert.equal(nextOf('/%09%5cevil.example'), '/\t\\evil.example');
  // Çift kodlanmış değer BİR kez çözülür; kalan yüzde kodu yolun parçasıdır (sitede kalır) → aynen
  const kept = [
    ['/%2509/evil.example', '/%09/evil.example'], ['/%255cevil.example', '/%5cevil.example'], ['/%252f%252fevil.example', '/%2f%2fevil.example'],
    ['/login', '/login'], ['%2Flogin%3Femail%3Da%2540b.ro', '/login?email=a%40b.ro'], ['/login%3Femail%3Duser%252Btag%2540gmail.com', '/login?email=user%2Btag%40gmail.com'],
    ['/siparisler/cmgabc123%3Fok%3Dcreated%23finans', '/siparisler/cmgabc123?ok=created#finans'], ['/yuklemeler?gun=2026-10-06', '/yuklemeler?gun=2026-10-06'],
    ['%2Fyuklemeler%3Fgun%3D2026-10-06%23yuklenmeyen', '/yuklemeler?gun=2026-10-06#yuklenmeyen'], ['%2Fsetup%3Femail%3D', '/setup?email='], ['/depo/AbC-_123', '/depo/AbC-_123'],
  ];
  for (const [raw, want] of kept) {
    assert.equal(locationFor(raw), want, raw);
    assert.equal(staysInside(want), true, want);
  }
  // Giriş sayfasının ürettiği bağlantı biçimi (LanguageSwitch: encodeURIComponent(next)) her geçerli değeri aynen geri verir
  for (const v of VALID) assert.equal(locationFor(encodeURIComponent(v)), v, show(v));
});

test('tüketici özellik testi: saldırı alfabesinden kurulan HER kısa dize için — kabul edildiyse tarayıcıda sitede kalır, yolu "//" olmaz, başlığa aynen yazılır', () => {
  // Parçalar: ayraçlar, tarayıcının attığı / dönüştürdüğü karakterler, nokta parçaları ve kodlamaları, şema / kullanıcı bilgisi imleri
  const ALPHABET = ['/', '\\', '\t', '\n', '\r', '.', '%2e', '%2f', '%5c', '%09', '@', ':', '?', '#', 'a', ' ', '\0'];
  const FORBIDDEN = ['\\', '\t', '\n', '\r', ' ', '\0'];
  let total = 0;
  let accepted = 0;
  const visit = (prefix, depth) => {
    if (prefix !== '') {
      total += 1;
      const got = internalPath(prefix);
      if (got !== null) {
        accepted += 1;
        if (got !== prefix) assert.fail(`değer değişti: ${show(prefix)}`);
        if (!staysInside(prefix)) assert.fail(`site dışına / "//" yoluna çözülüyor: ${show(prefix)}`);
        if (!headerSafe(prefix)) assert.fail(`başlık değeri değil: ${show(prefix)}`);
        if (FORBIDDEN.some((c) => prefix.includes(c)) || !prefix.startsWith('/') || prefix.startsWith('//')) assert.fail(`biçim: ${show(prefix)}`);
      }
    }
    if (depth === 0) return;
    for (const part of ALPHABET) visit(prefix + part, depth - 1);
  };
  visit('', 5);
  assert.equal(total, [1, 2, 3, 4, 5].reduce((n, k) => n + ALPHABET.length ** k, 0), 'bütün dizeler denendi');
  assert.ok(accepted > 1000 && accepted < total / 10, `kabul edilen: ${accepted} / ${total}`);
});

test('her kod noktası: sekme / LF / CR / ters bölü ve ASCII dışı hiçbir karakter kabul edilen bir değerin içinde olamaz', () => {
  const points = [];
  for (let cp = 0; cp <= 0x2ff; cp++) points.push(cp);
  points.push(0x2028, 0x2029, 0xfeff, 0xff0f, 0xff3c, 0x3000, 0x200b, 0x202e, 0x1f600);
  const forms = (c) => [`/${c}/evil.example`, `/${c}\\evil.example`, `${c}//evil.example`, `/${c}`, `/a${c}//evil.example`, `/a${c}/..//evil.example`, `/a?x=${c}`, `/a#${c}`, `/${c}${c}evil.example`];
  for (const cp of points) {
    const c = String.fromCodePoint(cp);
    const printable = cp >= 0x21 && cp <= 0x7e && c !== '\\';
    for (const v of forms(c)) {
      const got = internalPath(v);
      if (got === null) continue;
      assert.equal(got, v);
      assert.equal(printable, true, `U+${cp.toString(16)} kabul edilen değerde: ${show(v)}`);
      assert.equal(staysInside(v), true, show(v));
      assert.equal(headerSafe(v), true, show(v));
    }
    // Yazdırılabilir ASCII (ters bölü ve ayrıştırıcının ayraç saydıkları dışında) düz bir yol parçası olarak kabul edilir
    if (printable && !'/.?#'.includes(c)) assert.equal(internalPath(`/a${c}b`), `/a${c}b`, `U+${cp.toString(16)}`);
    else if (!printable) assert.equal(internalPath(`/a${c}b`), null, `U+${cp.toString(16)}`);
  }
});

test('tek kural, iki kullanıcı: /dil yönlendirmesi ve bildirim bağlantısı ortak doğrulayıcıyı kullanır; elle yazılmış ikinci bir denetim yok', () => {
  assert.equal(safeLink, internalPath, 'bildirim bağlantısı = ortak doğrulayıcı');
  const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // Kuralın iki katmanı da kaynakta durur (biri ötekinin açığını kapattığı için davranış testi tek başına ayırt edemez):
  // biçim (tek "/", yazdırılabilir ASCII, ters bölü yok) ve ayrıştırma (aynı kaynak, yol "//" değil)
  const rule = read('server/security/internal-path.js');
  assert.ok(rule.includes('const SHAPE = /^\\/(?!\\/)[\\x21-\\x5b\\x5d-\\x7e]*$/;'), 'biçim kuralı');
  assert.ok(rule.includes("if (url.origin !== ORIGIN || url.pathname.startsWith('//')) return null;"), 'ayrıştırma kuralı');
  assert.ok(rule.includes("const ORIGIN = 'http://takip.invalid';"), 'sabit sahte http kaynağı');
  assert.ok(rule.includes('value.length === 0 || value.length > INTERNAL_PATH_MAX'), 'uzunluk kuralı');
  const route = strip(read('app/dil/route.ts'));
  assert.ok(route.includes("internalPath(req.nextUrl.searchParams.get('next')) ?? '/login'"), 'next ortak kuraldan geçer; geçmezse /login');
  assert.equal(/safeNext|startsWith\(/.test(route), false, 'eski önek denetimi kaldırıldı');
  // Dil çerezi dönüş adresinden bağımsız yazılır (next reddedilse de): çerez koşulu yalnızca dile bakar
  assert.match(route, /if \(isLocale\(l\)\) \{\s*res\.cookies\.set\(LOCALE_COOKIE, l,/);
  assert.equal(/next/.test(route.slice(route.indexOf('if (isLocale(l))'))), false, 'çerez yazımı next değerine bağlı değil');
  // Uygulama kodunda başka "tek bölüyle başlıyor mu" denetimi kalmadı
  const walk = (dir, exts) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, exts) : exts.test(e.name) ? [p] : [];
  });
  const files = walk('app', /\.tsx?$/).concat(walk('lib', /\.tsx?$/), walk('components', /\.tsx?$/), walk('server', /\.js$/));
  const handRolled = files.filter((f) => f !== path.join('server', 'security', 'internal-path.js'))
    .filter((f) => /startsWith\((['"])\/\/\1\)|\^\\\/\(\?!\\\/\)/.test(strip(read(f))));
  assert.deepEqual(handRolled, []);
  // Doğrulayıcıyı kullananlar: yalnızca bu iki yer (yeni bir kullanıcı bilerek eklenir)
  const users = files.filter((f) => /internal-path\.js/.test(read(f))).sort();
  assert.deepEqual(users, [path.join('app', 'dil', 'route.ts'), path.join('server', 'notifications', 'feed.js')]);
});
