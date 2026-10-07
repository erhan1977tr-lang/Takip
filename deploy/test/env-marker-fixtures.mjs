// YALNIZCA sunucu kurulumu testi (.github/workflows/deploy-test.yml → deploy/test/env-marker.sh) içindir: gerçek sunucu
// işaretini (karar 151) GERÇEK kurulumda denemek için bir yönetici oturumu üretir. Üretimde ÇALIŞMAZ: TAKIP_TEST_FIXTURES=1
// verilmeli ve adres localhost olmalı.
// Oturum anahtarı rastgeledir, veritabanına yalnızca özeti yazılır (uygulamanın yaptığı gibi) ve çıktı olarak yalnızca test
// betiğinin okuduğu dosyaya gider (günlüğe yazılmaz). Bu klasör (deploy/test) imaja girmez (.dockerignore); betik çalışan
// işçi kapsayıcısına standart girdiden verilir:
//   docker exec -i -u 1001:1001 -e TAKIP_TEST_FIXTURES=1 takip-worker-1 node --input-type=module - < env-marker-fixtures.mjs
// (çalışma klasörü /app: uygulamanın kendi modülleri oradan yüklenir) → son satırda JSON
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';

const app = (file) => import(pathToFileURL(path.resolve(file)).href);
const { SESSION_TTL_MS } = await app('server/auth/session-policy.js');

if (process.env.TAKIP_TEST_FIXTURES !== '1' || !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(process.env.APP_URL ?? '')) {
  console.error('Bu betik yalnızca kurulum testinde çalışır (TAKIP_TEST_FIXTURES=1 ve APP_URL=localhost).');
  process.exit(2);
}
const db = new PrismaClient();
try {
  const admin = await db.user.findFirstOrThrow({ where: { appRole: 'ADMIN', isActive: true } });
  const token = crypto.randomBytes(32).toString('base64url');
  // Oturum satırı (lib/auth/session.ts → createSession ile aynı alanlar; özet: SHA-256, hex)
  await db.session.create({
    data: { userId: admin.id, tokenHash: crypto.createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + SESSION_TTL_MS), userAgent: 'ortam-isareti-testi' },
  });
  console.log(JSON.stringify({ token }));
} finally {
  await db.$disconnect();
}
