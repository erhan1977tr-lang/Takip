// YALNIZCA sunucu kurulumu testi (.github/workflows/deploy-test.yml) içindir: işçinin (worker) root olmadan çalıştığını
// sınamak için deneme verisi üretir (karar 137). Üretimde ÇALIŞMAZ: TAKIP_TEST_FIXTURES=1 verilmeli ve adres localhost olmalı.
//   - bir cam siparişi + taranmayı bekleyen (PENDING) iki dosya: temiz bir PDF ve zararsız EICAR test dosyası
//   - depoya gönderilmiş bir profil siparişi + kuyrukta bir depo e-postası (işçi Comanda Depozit PDF'ini üretir)
// Dosyalar bu betiği çalıştıran kullanıcıyla (testte 1001: uygulamanın kullanıcısı) yükleme klasörüne yazılır.
// Gerçek e-posta gönderilmez: test MAIL_OUTBOX_DIR ile çalışır ve depo alıcısı deneme adresidir.
// Bu klasör (deploy/test) imaja girmez (.dockerignore); betik çalışan işçi kapsayıcısına standart girdiden verilir:
//   docker exec -i -u 1001:1001 -e TAKIP_TEST_FIXTURES=1 takip-worker-1 node --input-type=module - ETİKET < worker-fixtures.mjs
// (çalışma klasörü /app: uygulamanın kendi modülleri oradan yüklenir) → son satırda JSON
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';

const app = (file) => import(pathToFileURL(path.resolve(file)).href);
const { eicar } = await app('server/files/clamav.js');
const { WAREHOUSE_KEY } = await app('server/profile/warehouse.js');
const { WAREHOUSE_EMAIL } = await app('server/profile/transitions.js');

if (process.env.TAKIP_TEST_FIXTURES !== '1' || !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(process.env.APP_URL ?? '')) {
  console.error('Bu betik yalnızca kurulum testinde çalışır (TAKIP_TEST_FIXTURES=1 ve APP_URL=localhost).');
  process.exit(2);
}
const label = (process.argv[2] ?? 'a').replace(/[^a-z0-9]/gi, '') || 'a';
const root = path.resolve(process.env.UPLOAD_DIR ?? '');
if (!process.env.UPLOAD_DIR || !fs.existsSync(root)) {
  console.error('UPLOAD_DIR yok');
  process.exit(2);
}
const db = new PrismaClient();
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const admin = await db.user.findFirstOrThrow({ where: { appRole: 'ADMIN' } });
const firm = (await db.customer.findFirst({ where: { prefix: 'ISC' } })) ?? (await db.customer.create({ data: { name: 'Isci Deneme SRL', prefix: 'ISC' } }));
// Depo e-postasının alıcısı deneme adresi (e-posta zaten gönderilmez; dosyaya yazılır)
const recipients = { recipients: ['depo@kurulum.test'] };
await db.integrationSetting.upsert({ where: { key: WAREHOUSE_KEY }, create: { key: WAREHOUSE_KEY, value: recipients }, update: { value: recipients } });

const n = (await db.order.count({ where: { customerId: firm.id } })) + 1;
const glass = await db.order.create({
  data: { orderNo: `ISC${n}`, customerOrderNo: n, title: `işçi denemesi ${label}`, orderTypeCode: 'GLASS_ORDER', customerId: firm.id, createdById: admin.id, status: 'URETIMDE' },
});
// Uygulamanın yazdığı gibi: geçmiş bir ay klasörü + rastgele adlı dosyalar
const dir = '2025/01';
fs.mkdirSync(path.join(root, dir), { recursive: true });
const put = async (kind, buf) => {
  const storageKey = `${dir}/${label}-${kind}-${crypto.randomBytes(8).toString('hex')}.pdf`;
  fs.writeFileSync(path.join(root, storageKey), buf, { flag: 'wx' });
  const row = await db.orderFile.create({
    data: { orderId: glass.id, name: `${kind}-${label}.pdf`, storageKey, size: buf.length, mime: 'application/pdf', checksum: sha(buf), scanStatus: 'PENDING', uploadedById: admin.id },
  });
  return { id: row.id, key: storageKey, sha: sha(buf) };
};
const clean = await put('temiz', Buffer.from(`%PDF-1.4\n% temiz deneme ${label}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1'));
const virus = await put('virus', eicar());

const profile = await db.order.create({
  data: {
    orderNo: `ISCP${n}`, customerOrderNo: n, title: `işçi denemesi ${label} (profil)`, orderTypeCode: 'PROFILE_ORDER', customerId: firm.id, createdById: admin.id,
    profile: { create: { stage: 'DEPODA', pickupDate: new Date('2027-03-19T00:00:00Z'), contactPhone: '+40700000000', vehiclePlate: 'B 00 TST', warehouseSentAt: new Date() } },
    profileItems: { create: [{ code: `TST-${label}`, nameRo: 'Profil de test', nameTr: 'Deneme profili', unitCode: 'BUCATI', categoryCode: 'ACCESORII', qty: 2 }] },
  },
});
await db.notificationOutbox.create({ data: { type: WAREHOUSE_EMAIL, orderId: profile.id, payload: {} } });
await db.$disconnect();
console.log(JSON.stringify({ glassId: glass.id, profileId: profile.id, cleanId: clean.id, cleanKey: clean.key, cleanSha: clean.sha, virusId: virus.id, virusKey: virus.key, virusSha: virus.sha }));
