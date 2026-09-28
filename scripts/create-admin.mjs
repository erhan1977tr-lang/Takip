// İlk (ya da yeni) sistem yöneticisi hesabını oluşturur ve tek kullanımlık kodu ekrana yazar.
// Kullanım:
//   npm run create-admin -- yonetici@firma.com "Ad Soyad" [--factory "GKH Trading"] [--reset]
// --reset: hesap zaten varsa şifresini sıfırlayıp yeni kod üretir.
import { PrismaClient } from '@prisma/client';
import { createInvite } from '../server/auth/inviteCode.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const val = args[i + 1];
  args.splice(i, val && !val.startsWith('--') ? 2 : 1);
  return val && !val.startsWith('--') ? val : true;
};
const factoryName = flag('--factory');
const reset = flag('--reset') === true;
const [emailArg, nameArg = ''] = args;
const email = String(emailArg || '').trim().toLowerCase();

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Kullanım: npm run create-admin -- yonetici@firma.com "Ad Soyad" [--factory "Fabrika adı"] [--reset]');
  process.exit(1);
}
const secret = process.env.AUTH_SECRET || '';
if (secret.length < 32) {
  console.error('AUTH_SECRET ortam değişkeni en az 32 karakter olmalı.');
  process.exit(1);
}
const ttl = Number(process.env.INVITE_CODE_TTL_HOURS || 24) || 24;
const db = new PrismaClient();

try {
  let factory = await db.customer.findFirst({ where: { type: 'FACTORY' }, orderBy: { createdAt: 'asc' } });
  if (!factory) {
    const name = typeof factoryName === 'string' ? factoryName : 'Fabrika';
    factory = await db.customer.create({ data: { name, type: 'FACTORY' } });
    console.log(`Fabrika kaydı oluşturuldu: ${name}`);
  }

  let user = await db.user.findUnique({ where: { email } });
  if (user && user.passwordHash && !reset) {
    console.error(`${email} zaten aktif bir hesap. Şifresini sıfırlamak için --reset ekleyin.`);
    process.exit(1);
  }
  if (!user) {
    user = await db.user.create({
      data: { email, name: nameArg, appRole: 'ADMIN', type: 'INTERNAL', customerId: factory.id },
    });
    console.log(`Yönetici hesabı oluşturuldu: ${email}`);
  } else {
    user = await db.user.update({
      where: { id: user.id },
      data: { passwordHash: null, isActive: true, appRole: 'ADMIN', type: 'INTERNAL', ...(nameArg ? { name: nameArg } : {}) },
    });
    await db.session.deleteMany({ where: { userId: user.id } });
    console.log(`Hesap sıfırlandı: ${email}`);
  }

  const { code, record } = createInvite(email, secret, ttl);
  await db.$transaction([
    db.userInvite.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } }),
    // Kod bu terminalde teslim edildiği için "gönderildi" sayılır.
    db.userInvite.create({ data: { userId: user.id, codeHash: record.codeHash, expiresAt: record.expiresAt, sentAt: new Date() } }),
  ]);
  await db.auditLog.create({ data: { action: 'ADMIN_BOOTSTRAP', entityType: 'User', entityId: user.id, details: { email } } });

  const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '');
  console.log('');
  console.log(`Doğrulama kodu: ${code}   (${ttl} saat geçerli, tek kullanımlık)`);
  console.log(`Giriş: ${appUrl || '<uygulama adresi>'}/login  → e-postanızı yazıp şifre alanını boş bırakın.`);
  // Otomatik testler kodu bu satırdan okur.
  console.log(`CODE=${code}`);
} finally {
  await db.$disconnect();
}
