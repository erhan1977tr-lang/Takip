// Demo ortamına örnek veriler yükler: firmalar, beş rolün hesapları, cam kataloğu ve
// akışın her aşamasından siparişler (dosyaları ve çizimleriyle). Yalnızca DEMO_MODE=1 iken çalışır.
// Tekrar çalıştırılırsa veri eklemez; DEMO-GIRIS.txt silinmişse şifreleri yenileyip dosyayı yeniden yazar.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { nextShipDate, offerTotals, slaDeadline } from '../../server/orders/rules.js';
import { DEMO_ACCOUNTS, DEMO_FIRM } from '../../server/demo/accounts.js';
import { runBaseSeed } from '../../prisma/seed/base.mjs';

if (process.env.DEMO_MODE !== '1') {
  console.error('Bu betik yalnızca demo ortamında çalışır (DEMO_MODE=1).');
  process.exit(1);
}

const prisma = new PrismaClient();
const CRED_FILE = path.resolve('DEMO-GIRIS.txt');
const UPLOAD = path.resolve(process.env.UPLOAD_DIR || './uploads');
const NOW = Date.now();
const ago = (h) => new Date(NOW - h * 3_600_000);

// lib/auth/password.ts ile aynı biçim: scrypt$N$r$p$salt$hash
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', 16384, 8, 1, salt.toString('base64url'), key.toString('base64url')].join('$');
}
const newPassword = () => `Takip-${crypto.randomInt(100000, 1000000)}`;

async function writeCredentials(pw) {
  const url = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const rows = DEMO_ACCOUNTS.map((a) => `  ${a.label.padEnd(18)} ${a.email}${a.role === 'MUSTERI' ? `  (${DEMO_FIRM.name}, çizim onay yetkili)` : ''}`);
  await fs.writeFile(CRED_FILE, [
    'TAKİP DEMO — giriş bilgileri',
    `Adres: ${url}/login`,
    `Şifre (tüm hesaplar): ${pw}`,
    '',
    ...rows,
    '',
    'Veriler örnektir. Bu dosya yalnızca bu ortamda durur, git\'e yüklenmez.',
    '',
  ].join('\n'));
}

// ---------- örnek dosyalar ----------
/** Tek sayfalık basit PDF (yalnızca ASCII metin ve çizgiler). */
function pdf(lines, drawing) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const parts = lines.map((l, i) => `BT /F1 ${i === 0 ? 18 : 11} Tf 60 ${780 - i * 22} Td (${esc(l)}) Tj ET`);
  if (drawing) {
    const { w, h, label } = drawing; // mm cinsinden cam ölçüsü, ölçekli dikdörtgen
    const s = Math.min(420 / w, 420 / h), W = Math.round(w * s), H = Math.round(h * s), x = 90, y = 160;
    parts.push(`1.5 w ${x} ${y} ${W} ${H} re S`);
    parts.push(`0.5 w ${x} ${y - 20} m ${x + W} ${y - 20} l S ${x - 20} ${y} m ${x - 20} ${y + H} l S`);
    parts.push(`BT /F1 10 Tf ${x + W / 2 - 20} ${y - 34} Td (${w} mm) Tj ET`);
    parts.push(`BT /F1 10 Tf ${x - 70} ${y + H / 2} Td (${h} mm) Tj ET`);
    parts.push(`BT /F1 10 Tf ${x + 10} ${y + H - 20} Td (${esc(label)}) Tj ET`);
  }
  const content = parts.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function store(name, content) {
  const d = new Date();
  const key = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomBytes(16).toString('hex')}${path.extname(name).toLowerCase()}`;
  const full = path.join(UPLOAD, key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
  // Örnek dosyalar antivirüsten geçirilmez (demo): "tarama kapalıyken yüklendi" (SKIPPED)
  return {
    storageKey: key, name, size: content.length, mime: name.endsWith('.pdf') ? 'application/pdf' : null,
    checksum: crypto.createHash('sha256').update(content).digest('hex'), scanStatus: 'SKIPPED',
  };
}

// ---------- kurulum ----------
/** Tümü tek işlemde: yarıda kalırsa hiçbir şey yazılmaz, bir sonraki açılışta baştan denenir. */
async function main(db) {
  const admin0 = await db.user.findUnique({ where: { email: DEMO_ACCOUNTS[0].email } });
  if (admin0) {
    const hasFile = await fs.access(CRED_FILE).then(() => true, () => false);
    // Yeni sürümde eklenen demo hesabı (ör. Denetimci) varsa o da açılır; şifre herkes için yenilenir.
    const missing = [];
    for (const a of DEMO_ACCOUNTS) if (!(await db.user.findUnique({ where: { email: a.email } }))) missing.push(a);
    if (hasFile && !missing.length) {
      console.log('Örnek veriler zaten yüklü.');
      return;
    }
    const pw = newPassword();
    const passwordHash = hashPassword(pw);
    for (const a of DEMO_ACCOUNTS) {
      const u = await db.user.findUnique({ where: { email: a.email } });
      if (!u) continue;
      await db.user.update({ where: { id: u.id }, data: { passwordHash, isActive: true } });
      await db.session.deleteMany({ where: { userId: u.id } });
    }
    for (const a of missing) {
      const internal = a.role !== 'MUSTERI';
      const firm = internal
        ? await db.customer.findFirst({ where: { type: 'FACTORY' }, orderBy: { createdAt: 'asc' } })
        : await db.customer.findFirst({ where: { prefix: DEMO_FIRM.prefix } });
      await db.user.create({
        data: {
          email: a.email, name: a.name, passwordHash, appRole: a.role, type: internal ? 'INTERNAL' : 'CUSTOMER',
          unit: a.unit ?? null, canApprove: !!a.canApprove, customerId: firm?.id ?? null,
        },
      });
    }
    await writeCredentials(pw);
    console.log(missing.length ? `Yeni demo hesapları eklendi: ${missing.map((a) => a.email).join(', ')}; şifre yenilendi.` : 'DEMO-GIRIS.txt bulunamadı; demo şifresi yenilendi.');
    return;
  }

  const pw = newPassword();
  const passwordHash = hashPassword(pw);

  const factory = (await db.customer.findFirst({ where: { type: 'FACTORY' } }))
    ?? (await db.customer.create({ data: { name: 'GKH Trading', type: 'FACTORY' } }));
  const firm = await db.customer.create({
    data: { ...DEMO_FIRM, type: 'CUSTOMER', groupName: 'Demo', contactPerson: 'Mert Bey', email: 'musteri@ornek.test', phone: '+40 721 000 111', address: 'Str. Exemplu 12, Cluj', taxId: 'RO12345678' },
  });

  const users = {};
  for (const a of DEMO_ACCOUNTS) {
    const internal = a.role !== 'MUSTERI';
    users[a.role] = await db.user.create({
      data: {
        email: a.email, name: a.name, passwordHash, appRole: a.role, type: internal ? 'INTERNAL' : 'CUSTOMER',
        unit: a.unit ?? null, canApprove: !!a.canApprove, customerId: internal ? factory.id : firm.id,
      },
    });
  }
  const { ADMIN: admin, SATIS: sales, CIZIM: drawer, MUSTERI: cust } = users;

  // Cam kataloğu: Türkçe ad, Romence ad, ağırlık (kg/m²)
  const GLASSES = [
    ['4mm Float Cam', 'Sticlă float 4 mm', 10],
    ['6mm Temperli Cam', 'Sticlă securizată 6 mm', 15],
    ['8mm Temperli Cam', 'Sticlă securizată 8 mm', 20],
    ['10mm Temperli Cam', 'Sticlă securizată 10 mm', 25],
    ['44.2 Lamine Cam', 'Sticlă laminată 4.4.2', 20],
    ['66.2 Temper Lamine Cam (Şeffaf)', 'Sticlă securizată laminată 6.6.2 (transparentă)', 30],
    ['8mm Temperli Füme Cam', 'Sticlă securizată 8 mm (gri)', 20],
  ];
  const glassByTr = new Map();
  for (const [i, [nameTr, nameRo, weightKgM2]] of GLASSES.entries()) {
    const g = await db.glassProduct.upsert({
      where: { nameTr_colorTr: { nameTr, colorTr: '' } }, create: { nameTr, nameRo, weightKgM2, sortOrder: (i + 1) * 10 }, update: {},
    });
    glassByTr.set(nameTr, g);
  }
  // Fiyat tablosu (varsayılan): demo satışçının teklifine fiyatlar dolu gelir; delik ve CNC sabit fiyatlı
  const PRICES = [18, 26, 32, 40, 34, 62];
  await db.priceTable.create({
    data: {
      name: 'GKH — Standart 2026', currency: 'EUR', holePrice: 3, cncPrice: 12, isDefault: true,
      items: { create: GLASSES.slice(0, PRICES.length).map(([nameTr], i) => ({ glassProductId: glassByTr.get(nameTr).id, unitPrice: PRICES[i] })) },
    },
  });
  const itemOf = ([glassName, camAdedi]) => {
    const g = glassByTr.get(glassName);
    return { glassName, camAdedi, glassProductId: g?.id ?? null, glassNameRo: g?.nameRo ?? null, glassWeightKgM2: g?.weightKgM2 ?? null };
  };

  // ---------- sipariş yardımcıları ----------
  async function order(o) {
    const createdAt = ago(o.hoursAgo);
    const files = [];
    for (const f of o.files) files.push(await store(f.name, f.content));
    const status = o.status ?? 'YENI';
    const drawing = o.drawing ?? 'YOK';
    const drawingSince = o.drawingSince != null ? ago(o.drawingSince) : null;
    const rec = await db.order.create({
      data: {
        orderNo: `${DEMO_FIRM.prefix}${o.no}`, customerOrderNo: o.no, title: o.title, customerId: firm.id, createdById: cust.id,
        status, drawingTrack: drawing, drawingSince, camEtiket: firm.camEtiket, sandikEtiket: firm.sandikEtiket,
        assignedDrawerId: o.drawer ? drawer.id : null, revisionCount: o.revisions ?? 0,
        slaDeadline: slaDeadline({
          status, createdAt, drawing, drawingSince,
          offer: o.offer?.status ?? null, offerSince: o.offer ? ago(o.offer.since) : null,
        }),
        estimatedShipDate: nextShipDate(createdAt), actualShipDate: o.shippedHoursAgo != null ? ago(o.shippedHoursAgo) : null,
        createdAt,
        items: { create: o.items.map(itemOf) },
        files: { create: files.map((s) => ({ ...s, kind: 'CUSTOMER', uploadedById: cust.id, createdAt })) },
      },
    });
    for (const [event, h, who, note] of o.events) {
      await db.orderEvent.create({ data: { orderId: rec.id, event, userId: who?.id ?? null, note: note ?? null, createdAt: ago(h) } });
    }
    if (o.offer) {
      const { status: st, since, sentAgo, lines } = o.offer;
      const amount = offerTotals(lines).amount.toFixed(2);
      await db.offer.create({
        data: {
          // Demo: müşteri fiyatı satış fiyatıyla aynı (yönetici gönderdiği / fiyatladığı tekliflerde)
          orderId: rec.id, status: st, statusSince: ago(since), sentAt: sentAgo != null ? ago(sentAgo) : null, amount,
          offerAmount: st === 'HAZIRLANIYOR' ? null : amount,
          createdById: sales.id, createdAt: ago(since),
          lines: {
            create: lines.map((l, i) => ({
              sortOrder: i, description: l.description, poz: l.poz ?? null, enMm: l.enMm ?? null, boyMm: l.boyMm ?? null,
              adet: l.adet, unit: l.unit ?? 'm2', unitPrice: String(l.unitPrice ?? 0), kind: l.kind ?? 'CAM', free: !!l.free,
              offerPrice: st === 'HAZIRLANIYOR' ? null : String(l.unitPrice ?? 0),
            })),
          },
        },
      });
      if (st === 'GONDERILDI') await db.price.create({ data: { orderId: rec.id, amount, setById: admin.id, setAt: ago(sentAgo) } });
    }
    for (const d of o.drawings ?? []) {
      const f = await store(`${rec.orderNo}-cizim-v${d.v}.pdf`, pdf(
        [`${rec.orderNo} - teknik cizim v${d.v}`, `Musteri: Ornek Cam SRL`, `Ornek cizim (demo)`],
        { w: d.w, h: d.h, label: d.label },
      ));
      // Demo dosyaları üretilen örnek PDF'lerdir; antivirüsten geçmiş (CLEAN) sayılır
      const dr = await db.drawing.create({
        data: {
          orderId: rec.id, version: d.v, scanStatus: 'SKIPPED', status: d.status, uploadedById: drawer.id, createdAt: ago(d.hoursAgo),
          sentAt: d.status === 'TASLAK' ? null : ago(d.hoursAgo), sentById: d.status === 'TASLAK' ? null : drawer.id,
          files: { create: [{ name: f.name, storageKey: f.storageKey, size: f.size, mime: f.mime, checksum: f.checksum, scanStatus: 'CLEAN', uploadedById: drawer.id, createdAt: ago(d.hoursAgo) }] },
        },
      });
      if (d.revision) await db.drawingRevision.create({ data: { drawingId: dr.id, requestedById: cust.id, comment: d.revision, createdAt: ago(d.hoursAgo - 4) } });
    }
    for (const [who, text, internal, h] of o.notes ?? []) {
      await db.orderNote.create({ data: { orderId: rec.id, userId: who.id, text, internal, createdAt: ago(h) } });
    }
    return rec;
  }
  const custPdf = (no, title, rows) => ({ name: `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`, content: pdf([`ORN${no} - ${title}`, 'Ornek Cam SRL - siparis olculeri', '', ...rows]) });
  const dwg = (name) => ({ name, content: Buffer.from(`Demo dosyasi (${name}) - gercek bir cizim dosyasi degildir.\n`) });

  // 1) Yeni sipariş — satış kararı bekliyor
  await order({
    no: 101, title: 'Duş kabini — Yılmaz konutu', hoursAgo: 5,
    items: [['8mm Temperli Cam', 3]],
    files: [custPdf(101, 'Dus kabini', ['Kapi: 800 x 2000 mm', 'Sabit panel: 900 x 2000 mm (2 adet)', '8 mm temperli, seffaf'])],
    events: [['CREATED', 5, cust]],
  });
  // 2) Yeni sipariş — SLA dolmak üzere
  await order({
    no: 102, title: 'Ofis bölme camları', hoursAgo: 21,
    items: [['10mm Temperli Cam', 6]],
    files: [dwg('ofis-bolme-plan.dwg'), custPdf(102, 'Ofis bolme', ['6 panel, 1200 x 2700 mm', '10 mm temperli'])],
    events: [['CREATED', 21, cust]],
  });
  // 3) Çizimsiz; teklif satışta ve SLA gecikmiş
  await order({
    no: 103, title: 'Vitrin camı', hoursAgo: 30, status: 'HAZIRLANIYOR',
    items: [['6mm Temperli Cam', 2]],
    files: [custPdf(103, 'Vitrin', ['2 adet 1500 x 2200 mm'])],
    offer: { status: 'HAZIRLANIYOR', since: 27, lines: [{ description: '6mm Temperli Cam', enMm: 1500, boyMm: 2200, adet: 2, unitPrice: 38 }] },
    events: [['CREATED', 30, cust], ['NO_DRAWING', 27, sales]],
  });
  // 4) Teklif müşteride; müşteri revizyon istedi, revize çizim (v2) onayında → yöneticide "Teklif kontrolü"
  await order({
    no: 104, title: 'Merdiven korkuluğu', hoursAgo: 72, status: 'HAZIRLANIYOR',
    drawing: 'ONAY_BEKLIYOR', drawingSince: 6, drawer: true, revisions: 1,
    items: [['66.2 Temper Lamine Cam (Şeffaf)', 5]],
    files: [custPdf(104, 'Merdiven korkulugu', ['5 panel, 1200 x 1000 mm', '66.2 temper lamine'])],
    offer: {
      status: 'GONDERILDI', since: 40, sentAgo: 40,
      lines: [
        { description: '66.2 Temper Lamine Cam (Şeffaf)', poz: 'K1', enMm: 1200, boyMm: 1000, adet: 5, unitPrice: 95 },
        { description: 'Paslanmaz bağlantı aparatı', adet: 20, unit: 'adet', unitPrice: 4.5 },
      ],
    },
    drawings: [
      { v: 1, status: 'REVIZYON_ISTENDI', hoursAgo: 48, w: 1200, h: 1000, label: 'K1 x5', revision: 'Korkuluk yüksekliği 1100 mm olmalı.' },
      { v: 2, status: 'ONAY_BEKLIYOR', hoursAgo: 6, w: 1200, h: 1100, label: 'K1 x5 (revize)' },
    ],
    events: [
      ['CREATED', 72, cust], ['SENT_TO_DRAWING', 70, sales], ['DRAWING_STARTED', 66, drawer], ['OFFER_SUBMITTED', 60, sales, '660.00 EUR'],
      ['DRAWING_UPLOADED', 48, drawer, 'v1'], ['OFFER_SENT', 40, admin, '660.00 EUR'],
      ['REVISION_REQUESTED', 44, cust, 'Korkuluk yüksekliği 1100 mm olmalı.'], ['DRAWING_UPLOADED', 6, drawer, 'v2'],
    ],
    notes: [
      [cust, 'Montaj 20 Ekim\'de. Yükleme tarihini teyit edebilir misiniz?', false, 30],
      [sales, 'v2 ile yükseklik 1100 mm oldu; teklif 1000 mm üzerinden. Yönetici kontrol etsin.', true, 5],
    ],
  });
  // 5) Çizim yapılıyor; teklif yönetici onayında
  await order({
    no: 105, title: 'Balkon camları', hoursAgo: 20, status: 'HAZIRLANIYOR',
    drawing: 'YAPILIYOR', drawingSince: 10, drawer: true,
    items: [['8mm Temperli Cam', 8]],
    files: [custPdf(105, 'Balkon', ['8 panel, 900 x 1800 mm'])],
    offer: {
      status: 'YONETIMDE', since: 3,
      lines: [
        { description: '8mm Temperli Cam', enMm: 900, boyMm: 1800, adet: 8, unitPrice: 42 },
        { kind: 'CNC', description: 'Kulp yuvası', adet: 8, unit: 'adet', unitPrice: 6 },
        { kind: 'DELIK', description: 'Menteşe deliği', adet: 16, unit: 'adet', unitPrice: 1.5, free: true },
      ],
    },
    events: [['CREATED', 20, cust], ['SENT_TO_DRAWING', 18, sales], ['DRAWING_STARTED', 10, drawer], ['OFFER_SUBMITTED', 3, sales, '592.32 EUR']],
  });
  // 6) Çizime yeni gönderildi; teklif taslağı fiyatsız (satış "Çizime Göndermeyi Geri Al" diyebilir)
  await order({
    no: 106, title: 'Toplantı odası cam duvar', hoursAgo: 4, status: 'HAZIRLANIYOR',
    drawing: 'GEREKLI', drawingSince: 2,
    items: [['44.2 Lamine Cam', 4]],
    files: [dwg('toplanti-odasi.dxf')],
    offer: { status: 'HAZIRLANIYOR', since: 2, lines: [{ description: '44.2 Lamine Cam', adet: 4 }] },
    events: [['CREATED', 4, cust], ['SENT_TO_DRAWING', 2, sales]],
  });
  // 7) Üretimde
  await order({
    no: 107, title: 'Mutfak tezgah arası cam', hoursAgo: 8 * 24, status: 'URETIMDE',
    drawing: 'ONAYLANDI', drawingSince: 5 * 24, drawer: true,
    items: [['8mm Temperli Füme Cam', 2]],
    files: [custPdf(107, 'Mutfak tezgah arasi', ['2 adet 3000 x 600 mm, fume'])],
    offer: { status: 'GONDERILDI', since: 6 * 24, sentAgo: 6 * 24, lines: [{ description: '8mm Temperli Füme Cam', enMm: 3000, boyMm: 600, adet: 2, unitPrice: 55 }] },
    drawings: [{ v: 1, status: 'ONAYLANDI', hoursAgo: 7 * 24, w: 3000, h: 600, label: 'Tezgah arasi x2' }],
    events: [
      ['CREATED', 192, cust], ['SENT_TO_DRAWING', 190, sales], ['DRAWING_STARTED', 185, drawer], ['DRAWING_UPLOADED', 168, drawer, 'v1'],
      ['OFFER_SUBMITTED', 160, sales, '198.00 EUR'], ['OFFER_SENT', 144, admin, '198.00 EUR'],
      ['DRAWING_APPROVED', 120, cust, 'v1'], ['PRODUCTION', 120, cust, 'drawing_approved'],
    ],
  });
  // 8) Yüklendi
  await order({
    no: 108, title: 'Banyo aynası', hoursAgo: 20 * 24, status: 'YUKLENDI', shippedHoursAgo: 2 * 24,
    items: [['4mm Float Cam', 1]],
    files: [custPdf(108, 'Banyo aynasi', ['1 adet 1000 x 800 mm'])],
    offer: { status: 'GONDERILDI', since: 19 * 24, sentAgo: 19 * 24, lines: [{ description: '4mm Float Cam (ayna)', enMm: 1000, boyMm: 800, adet: 1, unitPrice: 30 }] },
    events: [
      ['CREATED', 480, cust], ['NO_DRAWING', 478, sales], ['OFFER_SUBMITTED', 470, sales, '24.00 EUR'],
      ['OFFER_SENT', 456, admin, '24.00 EUR'], ['PRODUCTION', 456, admin, 'no_drawing'], ['SHIPPED', 48, sales],
    ],
  });

  await db.auditLog.create({ data: { action: 'DEMO_SEED', entityType: 'System', details: { orders: 8 } } });
  await writeCredentials(pw);
  console.log(`Örnek veriler yüklendi (8 sipariş, ${DEMO_ACCOUNTS.length} hesap). Giriş bilgileri: DEMO-GIRIS.txt`);
}

try {
  await runBaseSeed(prisma, { log: () => {} }); // önce her ortamda gereken temel veri (roller...)
  await prisma.$transaction((tx) => main(tx), { timeout: 180_000, maxWait: 20_000 });
} finally {
  await prisma.$disconnect();
}
