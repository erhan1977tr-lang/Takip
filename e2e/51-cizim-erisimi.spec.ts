import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { test, expect, type APIResponse, type Browser, type Page } from '@playwright/test';
import type { PrismaClient } from '@prisma/client';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, INSPECTOR_PW, TEAM_PW, as } from './helpers';

// Paket D — çizim dosyalarına erişim, GERÇEK sunucuda negatif yetki testleri (AUD-8 / karar 146 değişmedi; burada yalnızca
// doğrulanır). Veri bu dosyaya özeldir: siparişler, çizim sürümleri ve dosyalar doğrudan yazılır; her dosyanın içeriğinde
// benzersiz bir işaret vardır. Yetkisiz her istekte: durum kodu, gövdede hiçbir dosyanın işareti yok, dosya adı / saklama
// anahtarı / yükleme klasörü yolu yok, Content-Disposition yok, indirme kaydı (FILE_DOWNLOAD) yazılmaz.
//
//   A (Ünsal, müşteri ali@unsal.test): v1 ONAYLANDI · v2 GERI_CEKILDI · v3 ONAY_BEKLIYOR (+ virüslü dosya) · v4 TASLAK
//   L (Ünsal): eski tek-dosya düzeni — v1 ONAYLANDI (fileUrl), v2 GERI_CEKILDI (fileUrl), v3 müşterinin DWG kaydı
//   W (Ünsal): v1 REVIZYON_ISTENDI · v2 GERI_CEKILDI · v3 TASLAK — geri çekilen sürüm "güncel" diye etiketlenmez
//   B (Beta Cam, beta@betacam.test): v1 ONAY_BEKLIYOR
//   R (Ünsal, kaldırılmış sipariş): v1 ONAYLANDI — kimse göremez
//   N (Ünsal, çizim hattı YOK): v1 ONAYLANDI + iç sipariş dosyası — çizimci göremez
//   P (Ünsal, profil siparişi): iç sipariş dosyası — satış ve çizimci göremez
//   X (Ünsal): saklama anahtarı yükleme klasörünün DIŞINI gösteren satırlar — dosya hiçbir role verilmez
test.describe.configure({ mode: 'serial' });

const ROOT = process.env.UPLOAD_DIR ?? '';
const BETA = 'beta@betacam.test';
const SALES = 'fiyat-satis@e2e.test'; // 08'de açılan satışçı (satis@e2e.test 05'te bilerek kilitleniyor)
const INSPECTOR = 'denetim@e2e.test';
const RUN = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const DIR = `paketd-${RUN}`;
const OUTSIDE = ROOT ? path.join(path.dirname(path.resolve(ROOT)), `paketd-disari-${RUN}.txt`) : '';

let db: PrismaClient;
/** anahtar → { id, name, storageKey, mark } */
const F: Record<string, { id: string; name: string; storageKey: string; mark: string }> = {};
/** anahtar → sürüm (Drawing) kimliği */
const V: Record<string, string> = {};
/** anahtar → sipariş kimliği */
const O: Record<string, string> = {};
const ALL_MARKS: string[] = [];
const INTERNAL_NOTE = `İÇ NOT ${RUN}`;
const WITHDRAWN_NOTE = `GERİ ÇEKİLEN NOT ${RUN}`;

const mark = (key: string) => {
  const m = `PAKETD-${RUN}-${key}`;
  ALL_MARKS.push(m);
  return m;
};
/** Uzantıya uygun küçük içerik (içerikte işaret var) */
function body(name: string, m: string): Buffer {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'pdf') return Buffer.from(`%PDF-1.4\n% ${m}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');
  if (ext === 'png') return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(m)]);
  if (ext === 'dxf') return Buffer.from(`999\n${m}\n0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n`, 'latin1');
  return Buffer.from(m);
}
/** Dosyayı yükleme klasörüne yazar; saklama anahtarı döner */
function put(key: string, name: string): { storageKey: string; mark: string; size: number; checksum: string } {
  const m = mark(key);
  const buf = body(name, m);
  const storageKey = `${DIR}/${key}-${crypto.randomBytes(6).toString('hex')}${path.extname(name)}`;
  fs.mkdirSync(path.join(ROOT, DIR), { recursive: true });
  fs.writeFileSync(path.join(ROOT, storageKey), buf);
  return { storageKey, mark: m, size: buf.length, checksum: crypto.createHash('sha256').update(buf).digest('hex') };
}

test.beforeAll(async () => {
  const { PrismaClient: Client } = await import('@prisma/client');
  db = new Client();
});
test.afterAll(async () => {
  // Yalnızca bu dosyanın yükleme klasörü DIŞINA yazdığı tuzak dosyası kaldırılır (veritabanı satırları ve klasördeki dosyalar durur)
  if (OUTSIDE) fs.rmSync(OUTSIDE, { force: true });
  await db.$disconnect();
});

test('veri: iki firma, bütün sürüm durumları, eski düzen, kaldırılmış / çizimsiz / profil siparişi, klasör dışı anahtar', async () => {
  expect(ROOT, 'UPLOAD_DIR (test süreci sunucunun yükleme klasörünü görmeli)').toBeTruthy();
  const cust = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER }, include: { customer: true } });
  const beta = await db.user.findUniqueOrThrow({ where: { email: BETA }, include: { customer: true } });
  const drawer = await db.user.findUniqueOrThrow({ where: { email: DRAWER } });
  const base = 7000 + Math.floor(Math.random() * 2000);
  let k = 0;
  const order = async (key: string, owner: typeof cust, data: Record<string, unknown> = {}) => {
    const no = base * 10 + k++;
    const prefix = owner.customer!.prefix ?? 'XXX';
    const o = await db.order.create({
      data: {
        orderNo: `${prefix}${no}`, customerOrderNo: no, title: `Paket D ${key} ${RUN}`, orderTypeCode: 'GLASS_ORDER', customerId: owner.customer!.id,
        createdById: owner.id, status: 'HAZIRLANIYOR', drawingTrack: 'ONAY_BEKLIYOR', ...data,
      },
    });
    O[key] = o.id;
    return o.id;
  };
  const sent = new Date(Date.now() - 3_600_000);
  /** Sürüm + dosyaları */
  const version = async (key: string, orderId: string, v: number, status: string, files: { key: string; name: string; scan?: string }[], extra: Record<string, unknown> = {}) => {
    const rows = files.map((f) => {
      const p = put(f.key, f.name);
      F[f.key] = { id: '', name: f.name, storageKey: p.storageKey, mark: p.mark };
      return { name: f.name, storageKey: p.storageKey, size: p.size, mime: null, checksum: p.checksum, scanStatus: (f.scan ?? 'CLEAN') as 'CLEAN', uploadedById: drawer.id };
    });
    const d = await db.drawing.create({
      data: {
        orderId, version: v, status: status as 'ONAYLANDI', uploadedById: drawer.id, scanStatus: 'CLEAN',
        ...(status === 'TASLAK' ? {} : { sentAt: sent, sentById: drawer.id }), ...extra,
        files: { create: rows },
      },
      include: { files: true },
    });
    V[key] = d.id;
    for (const f of d.files) {
      const fk = files.find((x) => x.name === f.name)!.key;
      F[fk].id = f.id;
    }
    return d.id;
  };

  const a = await order('A', cust);
  await version('A1', a, 1, 'ONAYLANDI', [{ key: 'a1pdf', name: `a1-${RUN}.pdf` }], { decidedAt: sent });
  await version('A2', a, 2, 'GERI_CEKILDI', [{ key: 'a2pdf', name: `a2-${RUN}.pdf` }, { key: 'a2png', name: `a2-${RUN}.png` }],
    { withdrawnAt: sent, withdrawReason: `Yanlış dosya ${RUN}`, noteCustomer: WITHDRAWN_NOTE });
  await version('A3', a, 3, 'ONAY_BEKLIYOR', [{ key: 'a3pdf', name: `a3-${RUN}.pdf` }, { key: 'a3dxf', name: `a3-${RUN}.dxf` }, { key: 'a3virus', name: `a3-virus-${RUN}.pdf`, scan: 'INFECTED' }],
    { noteInternal: INTERNAL_NOTE });
  await version('A4', a, 4, 'TASLAK', [{ key: 'a4pdf', name: `a4-${RUN}.pdf` }]);

  // Eski düzen: dosya sürüm satırında (fileUrl), DrawingFile yok
  const l = await order('L', cust, { drawingTrack: 'GEREKLI' });
  const l1 = put('l1', `l1-${RUN}.pdf`);
  F.l1 = { id: '', name: `l1-${RUN}.pdf`, storageKey: l1.storageKey, mark: l1.mark };
  const l2 = put('l2', `l2-${RUN}.pdf`);
  F.l2 = { id: '', name: `l2-${RUN}.pdf`, storageKey: l2.storageKey, mark: l2.mark };
  V.L1 = (await db.drawing.create({ data: { orderId: l, version: 1, status: 'ONAYLANDI', uploadedById: drawer.id, sentAt: sent, fileUrl: l1.storageKey, fileName: F.l1.name, scanStatus: 'CLEAN' } })).id;
  V.L2 = (await db.drawing.create({ data: { orderId: l, version: 2, status: 'GERI_CEKILDI', uploadedById: drawer.id, sentAt: sent, withdrawnAt: sent, withdrawReason: 'x', fileUrl: l2.storageKey, fileName: F.l2.name, scanStatus: 'CLEAN' } })).id;
  // Eski düzende dosya kimliği yoktur; adres sürüm kimliğidir
  F.l1.id = V.L1;
  F.l2.id = V.L2;
  // Müşterinin DWG/DXF karar kaydı (karar 167): dosyası sipariş dosyasıdır; kaydın kimliği /dosya/cizim'de dosya vermez
  const lc = put('lcust', `musteri-${RUN}.dwg`);
  const lf = await db.orderFile.create({ data: { orderId: l, kind: 'CUSTOMER', name: `musteri-${RUN}.dwg`, storageKey: lc.storageKey, size: lc.size, checksum: lc.checksum, scanStatus: 'CLEAN', uploadedById: cust.id } });
  F.lcust = { id: lf.id, name: lf.name, storageKey: lc.storageKey, mark: lc.mark };
  V.L3 = (await db.drawing.create({
    data: { orderId: l, version: 3, status: 'BEKLIYOR', source: 'MUSTERI_DXF_DWG', uploadedById: cust.id, scanStatus: 'CLEAN', sourceFiles: [{ id: lf.id, name: lf.name, checksum: lc.checksum }] },
  })).id;

  const w = await order('W', cust, { drawingTrack: 'YAPILIYOR' });
  await version('W1', w, 1, 'REVIZYON_ISTENDI', [{ key: 'w1pdf', name: `w1-${RUN}.pdf` }], { decidedAt: sent });
  await version('W2', w, 2, 'GERI_CEKILDI', [{ key: 'w2pdf', name: `w2-${RUN}.pdf` }], { withdrawnAt: sent, withdrawReason: 'w' });
  await version('W3', w, 3, 'TASLAK', [{ key: 'w3pdf', name: `w3-${RUN}.pdf` }]);

  const b = await order('B', beta);
  await version('B1', b, 1, 'ONAY_BEKLIYOR', [{ key: 'b1pdf', name: `b1-${RUN}.pdf` }]);

  const r = await order('R', cust, { status: 'IPTAL', removedAt: new Date(), removedStatus: 'HAZIRLANIYOR' });
  await version('R1', r, 1, 'ONAYLANDI', [{ key: 'r1pdf', name: `r1-${RUN}.pdf` }]);

  const n = await order('N', cust, { drawingTrack: 'YOK' });
  await version('N1', n, 1, 'ONAYLANDI', [{ key: 'n1pdf', name: `n1-${RUN}.pdf` }]);
  const ni = put('ninternal', `ic-${RUN}.pdf`);
  F.ninternal = { id: (await db.orderFile.create({ data: { orderId: n, kind: 'INTERNAL', name: `ic-${RUN}.pdf`, storageKey: ni.storageKey, size: ni.size, scanStatus: 'CLEAN', uploadedById: drawer.id } })).id, name: `ic-${RUN}.pdf`, storageKey: ni.storageKey, mark: ni.mark };

  const p = await order('P', cust, { orderTypeCode: 'PROFILE_ORDER', drawingTrack: 'YOK' });
  const pi = put('pinternal', `profil-ic-${RUN}.pdf`);
  F.pinternal = { id: (await db.orderFile.create({ data: { orderId: p, kind: 'INTERNAL', name: `profil-ic-${RUN}.pdf`, storageKey: pi.storageKey, size: pi.size, scanStatus: 'CLEAN', uploadedById: drawer.id } })).id, name: `profil-ic-${RUN}.pdf`, storageKey: pi.storageKey, mark: pi.mark };

  // Klasör dışı saklama anahtarları: göreli "../" ve mutlak yol, ikisi de gerçekten var olan bir dosyayı gösterir
  const outsideMark = mark('outside');
  fs.writeFileSync(OUTSIDE, outsideMark);
  const x = await order('X', cust, { drawingTrack: 'ONAYLANDI' });
  const xd = await db.drawing.create({
    data: {
      orderId: x, version: 1, status: 'ONAYLANDI', uploadedById: drawer.id, sentAt: sent, scanStatus: 'CLEAN',
      files: { create: [
        { name: 'goreli.pdf', storageKey: `../${path.basename(OUTSIDE)}`, size: 1, scanStatus: 'CLEAN', uploadedById: drawer.id },
        { name: 'mutlak.pdf', storageKey: OUTSIDE, size: 1, scanStatus: 'CLEAN', uploadedById: drawer.id },
      ] },
    },
    include: { files: true },
  });
  V.X1 = xd.id;
  for (const f of xd.files) F[f.name === 'goreli.pdf' ? 'xrel' : 'xabs'] = { id: f.id, name: f.name, storageKey: f.storageKey, mark: outsideMark };
  expect(Object.values(F).every((f) => f.id)).toBe(true);
});

// ---------------------------------------------------------------- yardımcılar
type Who = 'custA' | 'custB' | 'sales' | 'drawer' | 'admin' | 'inspector' | 'anon';
const pages = {} as Record<Who, Page>;
async function open(browser: Browser) {
  pages.custA = await as(browser, CUSTOMER, CUST_PW);
  pages.custB = await as(browser, BETA, TEAM_PW);
  pages.sales = await as(browser, SALES, TEAM_PW);
  pages.drawer = await as(browser, DRAWER, TEAM_PW);
  pages.admin = await as(browser, ADMIN, ADMIN_PW);
  pages.inspector = await as(browser, INSPECTOR, INSPECTOR_PW);
  pages.anon = await (await browser.newContext()).newPage();
}
async function close() {
  for (const p of Object.values(pages)) await p.context().close();
}
const get = (who: Who, url: string) => pages[who].request.get(url, { maxRedirects: 0 });

/** Reddedilen yanıt: gövdede hiçbir dosya içeriği, dosya adı, saklama anahtarı ya da klasör yolu yok; ek başlığı yok */
async function expectNoLeak(res: APIResponse, what: string, opts: { urlEcho?: boolean } = {}) {
  const text = (await res.body()).toString('latin1');
  for (const m of ALL_MARKS) expect(text, `${what}: içerik işareti`).not.toContain(m);
  // urlEcho: istenen adresin kendisi (Next'in "bulunamadı" sayfası yol parçalarını yazabilir) — sızıntı değildir
  if (!opts.urlEcho) for (const f of Object.values(F)) {
    expect(text, `${what}: saklama anahtarı`).not.toContain(path.basename(f.storageKey));
    if (f.name !== 'goreli.pdf' && f.name !== 'mutlak.pdf') expect(text, `${what}: dosya adı`).not.toContain(f.name);
  }
  if (ROOT) expect(text, `${what}: klasör yolu`).not.toContain(path.resolve(ROOT));
  expect(res.headers()['content-disposition'], `${what}: ek başlığı`).toBeUndefined();
  expect(res.headers()['content-type'] ?? '', `${what}: tür`).not.toContain('application/pdf');
}

/** Dosya adresleri: dosya kimliği ve "?ac=1" */
const fileUrls = (key: string, kind = 'cizim') => [`/dosya/${kind}/${F[key].id}`, `/dosya/${kind}/${F[key].id}?ac=1`];
/** Eski bağlantı: sürüm kimliği (+ ?ac=1) */
const legacyUrls = (key: string) => [`/dosya/cizim/${V[key]}`, `/dosya/cizim/${V[key]}?ac=1`];

// Klasör dışı anahtarlı (X) satırlar hariç: o dosya yetkili kullanıcıya bulunur ama diskte okunmaz (404 "dosya yok");
// indirme kaydı dosya bulunduğunda, diskten okumadan önce yazılır (değişmedi)
const downloads = async (email: string) => {
  const u = await db.user.findUniqueOrThrow({ where: { email } });
  const ids = Object.entries(F).filter(([k]) => k !== 'xrel' && k !== 'xabs').map(([, f]) => f.id);
  return db.auditLog.count({ where: { action: 'FILE_DOWNLOAD', userId: u.id, entityId: { in: [...ids, ...Object.values(V).filter((v) => v !== V.X1)] } } });
};

// ---------------------------------------------------------------- testler
test('rol × dosya matrisi: dosya kimliği, ?ac=1, eski sürüm kimliği — izinli istek dosyanın kendisi, öbürleri içerik vermez', async ({ browser }) => {
  await open(browser);
  // Beklenen durum kodu: 200 dosya · 403 virüslü (karantina) · 404 yok / görülemez · 401 oturum yok
  const internal = { custA: 404, custB: 404, sales: 200, drawer: 200, admin: 200, inspector: 200, anon: 401 } as const;
  const openToA = { ...internal, custA: 200 } as const;
  const openToB = { ...internal, custB: 200 } as const;
  const hidden = { custA: 404, custB: 404, sales: 404, drawer: 404, admin: 404, inspector: 404, anon: 401 } as const;
  const cases: { what: string; urls: string[]; key: string; expect: Record<Who, number> }[] = [
    { what: 'A v1 onaylı (eski sürüm)', urls: fileUrls('a1pdf'), key: 'a1pdf', expect: openToA },
    { what: 'A v2 geri çekilmiş pdf', urls: fileUrls('a2pdf'), key: 'a2pdf', expect: internal },
    { what: 'A v2 geri çekilmiş png', urls: fileUrls('a2png'), key: 'a2png', expect: internal },
    { what: 'A v3 onay bekleyen pdf', urls: fileUrls('a3pdf'), key: 'a3pdf', expect: openToA },
    { what: 'A v3 onay bekleyen dxf', urls: fileUrls('a3dxf'), key: 'a3dxf', expect: openToA },
    { what: 'A v3 virüslü', urls: fileUrls('a3virus'), key: 'a3virus', expect: { ...openToA, custA: 403, sales: 403, drawer: 403, admin: 403, inspector: 403 } },
    { what: 'A v4 taslak', urls: fileUrls('a4pdf'), key: 'a4pdf', expect: internal },
    { what: 'A eski bağlantı v1 (sürüm kimliği)', urls: legacyUrls('A1'), key: 'a1pdf', expect: openToA },
    { what: 'A eski bağlantı v2 geri çekilmiş', urls: legacyUrls('A2'), key: 'a2pdf', expect: internal },
    { what: 'A eski bağlantı v4 taslak', urls: legacyUrls('A4'), key: 'a4pdf', expect: internal },
    { what: 'L eski düzen v1 (fileUrl)', urls: legacyUrls('L1'), key: 'l1', expect: openToA },
    { what: 'L eski düzen v2 geri çekilmiş (fileUrl)', urls: legacyUrls('L2'), key: 'l2', expect: internal },
    { what: 'L müşteri DWG kaydının kimliği', urls: legacyUrls('L3'), key: 'lcust', expect: hidden },
    { what: 'L müşteri DWG sipariş dosyası', urls: fileUrls('lcust', 'siparis'), key: 'lcust', expect: openToA },
    { what: 'B (başka firma) onay bekleyen', urls: fileUrls('b1pdf'), key: 'b1pdf', expect: openToB },
    { what: 'B eski bağlantı', urls: legacyUrls('B1'), key: 'b1pdf', expect: openToB },
    { what: 'R kaldırılmış sipariş', urls: [...fileUrls('r1pdf'), ...legacyUrls('R1')], key: 'r1pdf', expect: hidden },
    { what: 'N çizim hattı yok: çizim dosyası', urls: fileUrls('n1pdf'), key: 'n1pdf', expect: { ...openToA, drawer: 404 } },
    { what: 'N iç sipariş dosyası', urls: fileUrls('ninternal', 'siparis'), key: 'ninternal', expect: { ...internal, drawer: 404 } },
    { what: 'P profil siparişi iç dosyası', urls: fileUrls('pinternal', 'siparis'), key: 'pinternal', expect: { ...internal, sales: 404, drawer: 404 } },
    { what: 'X klasör dışı anahtar (göreli)', urls: fileUrls('xrel'), key: 'xrel', expect: { ...hidden, custA: 404 } },
    { what: 'X klasör dışı anahtar (mutlak)', urls: fileUrls('xabs'), key: 'xabs', expect: { ...hidden, custA: 404 } },
  ];
  const before = { custA: await downloads(CUSTOMER), custB: await downloads(BETA) };
  let allowedA = 0;
  const got: string[] = [];
  const want: string[] = [];
  for (const c of cases) {
    for (const url of c.urls) {
      for (const who of Object.keys(c.expect) as Who[]) {
        const res = await get(who, url);
        got.push(`${c.what} · ${who} · ${url.endsWith('?ac=1') ? 'ac' : 'dl'} → ${res.status()}`);
        want.push(`${c.what} · ${who} · ${url.endsWith('?ac=1') ? 'ac' : 'dl'} → ${c.expect[who]}`);
        if (res.status() === 200) {
          // İzinli: dosyanın kendisi (başka dosya değil), önbelleğe alınmaz, tür koklanmaz
          expect((await res.body()).toString('latin1'), `${c.what} ${who}`).toContain(F[c.key].mark);
          expect(res.headers()['x-content-type-options']).toBe('nosniff');
          expect(res.headers()['cache-control']).toContain('no-store');
          if (who === 'custA') allowedA++;
        } else {
          await expectNoLeak(res, `${c.what} · ${who} · ${url}`);
        }
      }
    }
  }
  expect(got).toEqual(want);
  // İndirme kaydı yalnızca verilen dosyalar için yazılır; reddedilenler (404 / 403) kayıt bırakmaz — B müşterisi A'nın hiçbir
  // dosyasını alamadı, kendi B dosyasını 4 kez aldı (dosya kimliği ve eski bağlantı, her biri indir + aç)
  expect(await downloads(CUSTOMER) - before.custA).toBe(allowedA);
  expect(await downloads(BETA) - before.custB).toBe(4);
});

test('?ac=1: yalnızca PDF / JPG / PNG tarayıcıda açılır; öbür türler her zaman ek olarak iner; ek parametreler yok sayılır', async () => {
  const pdf = await get('custA', `/dosya/cizim/${F.a3pdf.id}?ac=1`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  expect(pdf.headers()['content-disposition']).toMatch(/^inline;/);
  const png = await get('admin', `/dosya/cizim/${F.a2png.id}?ac=1`);
  expect(png.headers()['content-type']).toBe('image/png');
  expect(png.headers()['content-disposition']).toMatch(/^inline;/);
  const dxf = await get('custA', `/dosya/cizim/${F.a3dxf.id}?ac=1`);
  expect(dxf.status()).toBe(200);
  expect(dxf.headers()['content-type']).toBe('application/octet-stream');
  expect(dxf.headers()['content-disposition']).toMatch(/^attachment;/);
  const plain = await get('custA', `/dosya/cizim/${F.a3pdf.id}`);
  expect(plain.headers()['content-type']).toBe('application/octet-stream');
  expect(plain.headers()['content-disposition']).toMatch(/^attachment;/);
  // Başka parametreler ne eklenirse eklensin aynı dosya ya da aynı ret
  for (const q of ['ac=1&path=../../etc/passwd', 'ac=1&id=' + F.b1pdf.id, 'ac=1&kind=siparis', 'ac=1&ac=0', 'ac=true', 'ac=1%00']) {
    const own = await get('custA', `/dosya/cizim/${F.a3pdf.id}?${q}`);
    expect(own.status(), q).toBe(200);
    expect((await own.body()).toString('latin1'), q).toContain(F.a3pdf.mark);
    for (const m of ALL_MARKS.filter((x) => x !== F.a3pdf.mark)) expect((await own.body()).toString('latin1'), q).not.toContain(m);
    const draft = await get('custA', `/dosya/cizim/${F.a4pdf.id}?${q}`);
    expect(draft.status(), q).toBe(404);
    await expectNoLeak(draft, `taslak ?${q}`);
  }
});

test('path traversal ve garip kimlikler: dosya sistemi yolu olarak hiçbir şey okunmaz', async () => {
  const urls = [
    '/dosya/cizim/..%2f..%2f..%2fetc%2fpasswd',
    '/dosya/cizim/%2e%2e%2f%2e%2e%2fpackage.json',
    '/dosya/cizim/..%5c..%5cpackage.json',
    '/dosya/siparis/..%2F..%2Fpackage.json',
    `/dosya/cizim/${F.a3pdf.id}%2f..%2f${F.b1pdf.id}`,
    `/dosya/cizim/${encodeURIComponent(F.a4pdf.storageKey)}`,
    `/dosya/cizim/${encodeURIComponent(path.join(ROOT, F.a4pdf.storageKey))}`,
    `/dosya/cizim/${encodeURIComponent(F.a3pdf.id + "' OR '1'='1")}`,
    `/dosya/cizim/${'a'.repeat(4000)}`,
    `/dosya/..%2fsiparis/${F.lcust.id}`,
    `/dosya/CIZIM/${F.a3pdf.id}`,
    `/dosya/x/${F.a3pdf.id}`,
    `/dosya/rapor/..%2f..%2fpackage.json`,
    `/dosya/teslimat/..%2f..%2fpackage.json`,
  ];
  for (const who of ['admin', 'custA', 'anon'] as const) {
    for (const url of urls) {
      const res = await get(who, url);
      // 400 (geçersiz adres), 401 (oturum yok) ya da 404 — hiçbir zaman dosya
      expect([400, 401, 404], `${who} ${url} → ${res.status()}`).toContain(res.status());
      const text = (await res.body()).toString('latin1');
      expect(text, url).not.toContain('root:x:0:0');
      expect(text, url).not.toContain('"@prisma/client"');
      await expectNoLeak(res, `${who} ${url}`);
    }
  }
});

test('dosya listesi ve yükleme klasörü dışarıdan açılmaz', async () => {
  const urls = [
    '/dosya', '/dosya/', '/dosya/cizim', '/dosya/cizim/', '/dosya/siparis',
    `/${F.a3pdf.storageKey}`, `/uploads/${F.a3pdf.storageKey}`, `/.uploads/${F.a3pdf.storageKey}`, `/${DIR}/`,
    `/_next/static/../../${F.a3pdf.storageKey}`,
  ];
  for (const who of ['admin', 'custA', 'anon'] as const) {
    for (const url of urls) {
      const res = await get(who, url);
      expect(res.status(), `${who} ${url}`).not.toBe(200);
      await expectNoLeak(res, `${who} ${url}`, { urlEcho: true });
    }
  }
});

test('sipariş sayfası ve görüntüleyici: başka firma göremez; müşteriye taslak / geri çekilen içerik / iç not gelmez; güncel sürüm doğru', async () => {
  // Başka firmanın siparişi ve görüntüleyicisi
  for (const url of [`/siparisler/${O.A}`, `/siparisler/${O.A}/cizim/${V.A3}`, `/siparisler/${O.A}/cizim/${V.A1}`]) {
    const res = await get('custB', url);
    expect(res.status(), url).toBe(404);
    await expectNoLeak(res, `custB ${url}`);
  }
  const res = await get('custA', `/siparisler/${O.B}/cizim/${V.B1}`);
  expect(res.status()).toBe(404);
  await expectNoLeak(res, 'custA → B görüntüleyici');

  // Müşterinin görüntüleyicisi: açık sürümler açılır, taslak / geri çekilen / DWG kaydı / kaldırılmış sipariş "bulunamadı"
  const viewer = (o: string, v: string) => `/siparisler/${O[o]}/cizim/${V[v]}`;
  for (const [o, v, s] of [['A', 'A1', 200], ['A', 'A3', 200], ['A', 'A2', 404], ['A', 'A4', 404], ['L', 'L3', 404], ['R', 'R1', 404], ['W', 'W2', 404], ['W', 'W3', 404]] as const) {
    expect((await get('custA', viewer(o, v))).status(), `${o} ${v}`).toBe(s);
    expect((await get('custA', `${viewer(o, v)}?revizyon=1`)).status(), `${o} ${v} revizyon`).toBe(s);
  }
  // İç roller taslak ve geri çekilen sürümü açar (AUD-8: değişmedi); çizimci çizim hattı olmayan siparişi açamaz
  for (const who of ['admin', 'inspector', 'sales', 'drawer'] as const) {
    for (const v of ['A2', 'A4']) expect((await get(who, viewer('A', v))).status(), `${who} ${v}`).toBe(200);
  }
  expect((await get('drawer', viewer('N', 'N1'))).status()).toBe(404);
  expect((await get('admin', viewer('N', 'N1'))).status()).toBe(200);

  // Müşterinin sipariş sayfasının HAM yanıtı (HTML + sunucu bileşeni verisi): taslak ve geri çekilen sürümün dosyaları,
  // kimlikleri, müşteri notu, iç not, iç dosya ve saklama anahtarları yok; açık sürümün dosyası var
  const raw = await (await get('custA', `/siparisler/${O.A}`)).text();
  expect(raw).toContain(F.a3pdf.name);
  expect(raw).toContain(F.a1pdf.name);
  for (const k of ['a2pdf', 'a2png', 'a4pdf']) {
    expect(raw, k).not.toContain(F[k].name);
    expect(raw, k).not.toContain(F[k].id);
  }
  for (const s of [WITHDRAWN_NOTE, INTERNAL_NOTE, V.A4, ...Object.values(F).map((f) => path.basename(f.storageKey))]) expect(raw, s).not.toContain(s);

  // Güncel sürüm: A'da müşteri için v3 (taslak v4 müşteriye hiç gelmez); onay düğmesi yalnızca güncel bekleyen sürümün ekranında
  await pages.custA.goto(`/siparisler/${O.A}`);
  await expect(pages.custA.locator('#cizim .drawing-version[data-version="3"]')).toContainText('güncel');
  for (const v of ['1', '2']) await expect(pages.custA.locator(`#cizim .drawing-version[data-version="${v}"]`)).not.toContainText('güncel');
  await expect(pages.custA.locator('#cizim .drawing-version[data-version="4"]')).toHaveCount(0);
  await pages.custA.goto(viewer('A', 'A3'));
  await expect(pages.custA.getByRole('button', { name: 'Bu çizimi onayla' })).toBeVisible();
  await pages.custA.goto(viewer('A', 'A1'));
  await expect(pages.custA.getByRole('button', { name: 'Bu çizimi onayla' })).toHaveCount(0);

  // W: son gönderilen sürüm geri çekildi, yenisi taslakta → geri çekilen sürüm "güncel" diye etiketlenmez (müşteri ve iç ekip)
  await pages.custA.goto(`/siparisler/${O.W}`);
  await expect(pages.custA.locator('#cizim .drawing-version[data-version="2"]')).toContainText('geri çekildi');
  await expect(pages.custA.locator('#cizim .drawing-version', { hasText: 'güncel' })).toHaveCount(0);
  await pages.admin.goto(`/siparisler/${O.W}`);
  await expect(pages.admin.locator('#cizim .drawing-version[data-version="3"]')).toBeVisible();
  await expect(pages.admin.locator('#cizim .drawing-version', { hasText: 'güncel' })).toHaveCount(0);
  await close();
});
