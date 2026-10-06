// YALNIZCA sunucu kurulumu testi (.github/workflows/deploy-test.yml → deploy/test/body-gate.sh) içindir: gövde kapısını
// (karar 143) GERÇEK uygulama + gerçek Caddy ile denemek için deneme verisi üretir. Üretimde ÇALIŞMAZ: TAKIP_TEST_FIXTURES=1
// verilmeli ve adres localhost olmalı.
//   - yöneticinin dört oturumu: geçerli, 31 dakikadır etkinliksiz (boşta), mutlak süresi dolmuş + pasif bir kullanıcının oturumu
//   - bir cam siparişi (yönetici dosya ekleyebilsin)
//   - teslim edilmiş iki profil siparişi: biri geçerli, biri süresi dolmuş depo bağlantısıyla (teslim edilmiş: depo işlemi
//     yalnızca "ek belge" ekler — durum değişmez, bildirim / e-posta / fatura işi doğmaz)
// Oturum ve depo anahtarları rastgeledir, yalnızca özetleri veritabanına yazılır (uygulamanın yaptığı gibi) ve çıktı olarak
// yalnızca test betiğinin okuduğu dosyaya gider (günlüğe yazılmaz). Bu klasör (deploy/test) imaja girmez (.dockerignore);
// betik çalışan işçi kapsayıcısına standart girdiden verilir:
//   docker exec -i -u 1001:1001 -e TAKIP_TEST_FIXTURES=1 takip-worker-1 node --input-type=module - < body-gate-fixtures.mjs
// (çalışma klasörü /app: uygulamanın kendi modülleri oradan yüklenir) → son satırda JSON
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';

const app = (file) => import(pathToFileURL(path.resolve(file)).href);
const { hashToken } = await app('server/profile/warehouse.js');
const { SESSION_IDLE_MS, SESSION_TTL_MS } = await app('server/auth/session-policy.js');

if (process.env.TAKIP_TEST_FIXTURES !== '1' || !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(process.env.APP_URL ?? '')) {
  console.error('Bu betik yalnızca kurulum testinde çalışır (TAKIP_TEST_FIXTURES=1 ve APP_URL=localhost).');
  process.exit(2);
}
const db = new PrismaClient();
const now = Date.now();
const MIN = 60_000;
const token = () => crypto.randomBytes(32).toString('base64url');
/** Oturum anahtarının özeti: lib/auth/session.ts → hashToken ile aynı (SHA-256, hex) */
const sessionHash = (t) => crypto.createHash('sha256').update(t).digest('hex');

const admin = await db.user.findFirstOrThrow({ where: { appRole: 'ADMIN', isActive: true } });
const firm = (await db.customer.findFirst({ where: { prefix: 'KAP' } })) ?? (await db.customer.create({ data: { name: 'Kapi Deneme SRL', prefix: 'KAP' } }));
const passive = await db.user.upsert({
  where: { email: 'kapi-pasif@kurulum.test' },
  create: { email: 'kapi-pasif@kurulum.test', name: 'Kapı Pasif', type: 'INTERNAL', appRole: 'SATIS', customerId: admin.customerId, isActive: false },
  update: { isActive: false },
});

/** Oturum satırı (lib/auth/session.ts → createSession ile aynı alanlar); anahtarın kendisi yalnızca döndürülür */
async function session(userId, { createdAt = now, lastSeenAt = now } = {}) {
  const t = token();
  const row = await db.session.create({
    data: { userId, tokenHash: sessionHash(t), createdAt: new Date(createdAt), lastSeenAt: new Date(lastSeenAt), expiresAt: new Date(createdAt + SESSION_TTL_MS), userAgent: 'kapi-testi' },
  });
  return { id: row.id, token: t };
}
const valid = await session(admin.id);
const idle = await session(admin.id, { createdAt: now - 60 * MIN, lastSeenAt: now - SESSION_IDLE_MS - MIN });
const expired = await session(admin.id, { createdAt: now - SESSION_TTL_MS - MIN, lastSeenAt: now - MIN });
const inactive = await session(passive.id);

const n = (await db.order.count({ where: { customerId: firm.id } })) + 1;
const glass = await db.order.create({
  data: { orderNo: `KAP${n}`, customerOrderNo: n, title: 'kapı denemesi', orderTypeCode: 'GLASS_ORDER', customerId: firm.id, createdById: admin.id, status: 'URETIMDE' },
});
/** Teslim edilmiş profil siparişi + depo bağlantısı (özetiyle; uygulamadaki gibi) */
async function delivered(k, expiresAt) {
  const t = token();
  const order = await db.order.create({
    data: {
      orderNo: `KAPP${n + k}`, customerOrderNo: n + k, title: `kapı denemesi (profil ${k})`, orderTypeCode: 'PROFILE_ORDER', customerId: firm.id, createdById: admin.id,
      profile: {
        create: {
          stage: 'TESLIM_EDILDI', pickupDate: new Date('2027-03-19T00:00:00Z'), contactPhone: '+40700000000', vehiclePlate: 'B 00 KAP', warehouseSentAt: new Date(now - 60 * MIN),
          deliveredAt: new Date(now - 30 * MIN), deliveredVia: 'DEPOT_LINK', depotTokenHash: hashToken(t), depotTokenExpiresAt: new Date(expiresAt),
        },
      },
      profileItems: { create: [{ code: `KAP-${k}`, nameRo: 'Profil de test', nameTr: 'Deneme profili', unitCode: 'BUCATI', categoryCode: 'ACCESORII', qty: 1 }] },
    },
  });
  return { orderId: order.id, token: t };
}
const depot = await delivered(0, now + 86_400_000);
const depotExpired = await delivered(1, now - MIN);
await db.$disconnect();
console.log(JSON.stringify({
  adminId: admin.id, passiveId: passive.id, glassId: glass.id,
  valid, idle, expired, inactive,
  depot, depotExpired,
}));
