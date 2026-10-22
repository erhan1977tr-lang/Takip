// Tek ekip varsayılanı — YALNIZCA TEST / CI veritabanları için (karar 300). Satışçı / çizimci ayrımından önce yazılmış
// testler siparişleri doğrudan (db.order.create) ya da yönlendirme kuralı olmadan oluşturur; gerçek sistemde sahip
// yönlendirme kuralından gelir. Bu tetikleyiciler eski testlerin TEK EKİP varsayımını veritabanı düzeyinde sürdürür.
// Uygulama kodu bu tetikleyicilere asla güvenmez; gerçek migration'larda yoktur. Gerçek sunucuda (TAKIP_DEPLOYMENT) çalışmaz.
//   test/db/helpers.js → resetDb (birim / veritabanı testleri)
//   node scripts/test/single-team.mjs (CI: uçtan uca test sunucusunun veritabanı, sunucu açılmadan önce)
/**
 * Tek ekip varsayılanı (karar 300) — YALNIZCA test veritabanında. Satışçı / çizimci ayrımından önce yazılmış testler
 * siparişleri doğrudan (db.order.create) ya da yönlendirme kuralı olmadan oluşturur; gerçek sistemde sahip yönlendirme
 * kuralından gelir. Bu tetikleyiciler eski testlerin TEK EKİP varsayımını veritabanı düzeyinde sürdürür:
 *   - sahibi boş eklenen cam siparişi → ilk etkin satışçı (+ onun varsayılan çizimcisi),
 *   - varsayılan çizimcisi boş satışçı → ilk etkin çizimci (çizimci sonradan eklenirse ona bağlanır),
 *   - defaultTable: fiyat tablosu ataması boş satışçı → etkin varsayılan satış tablosu (eski "atama yoksa varsayılan"
 *     davranışını varsayan testler için; uygulama artık varsayılana DÜŞMEZ — bunu sınayan testler defaultTable: false).
 * Çok ekipli testler resetDb(db, { singleTeam: false }) ile çağırır: tetikleyiciler kaldırılır, sahip / çizimci açıkça
 * verilir. Uygulama kodu bu tetikleyicilere asla güvenmez (gerçek migration'larda yoktur).
 */
export async function setSingleTeam(db, on, { defaultTable = on, preferSales = null } = {}) {
  // preferSales: uçtan uca test takımının "tek satışçısı" (e2e: 05'te satis@e2e.test bilerek kilitlenir, 08'den sonra
  // fiyat-satis@e2e.test çalışır). Hesap varsa ve etkinse sahibi odur; yoksa ilk etkin satışçı (eski davranış).
  const prefer = typeof preferSales === 'string' && /^[a-z0-9._@-]{3,120}$/i.test(preferSales) ? preferSales : null;
  const firstSales = prefer
    ? `ORDER BY (u.email = '${prefer}') DESC, u."createdAt", u.id LIMIT 1`
    : 'ORDER BY u."createdAt", u.id LIMIT 1';
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS takip_test_default_table ON "PriceTable"`);
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS takip_test_user_table ON "User"`);
  if (defaultTable) {
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION takip_test_user_table() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."appRole" = 'SATIS' AND NEW."priceTableId" IS NULL THEN
          SELECT t.id INTO NEW."priceTableId" FROM "PriceTable" t WHERE t."isDefault" AND t."isActive" AND t.kind = 'SALES' LIMIT 1;
        END IF;
        RETURN NEW;
      END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER takip_test_user_table BEFORE INSERT ON "User" FOR EACH ROW EXECUTE FUNCTION takip_test_user_table()`);
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION takip_test_default_table() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."isDefault" AND NEW."isActive" AND NEW.kind = 'SALES' THEN
          UPDATE "User" SET "priceTableId" = NEW.id WHERE "appRole" = 'SATIS' AND "priceTableId" IS NULL;
        END IF;
        RETURN NEW;
      END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER takip_test_default_table AFTER INSERT OR UPDATE ON "PriceTable" FOR EACH ROW EXECUTE FUNCTION takip_test_default_table()`);
  }
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS takip_test_crate_owner ON "Crate"`);
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS takip_test_order_owner ON "Order"`);
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS takip_test_sales_drawer ON "User"`);
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS takip_test_drawer_join ON "User"`);
  if (!on) return;
  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION takip_test_order_owner() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."orderTypeCode" = 'GLASS_ORDER' AND NEW."salesUserId" IS NULL THEN
        SELECT u.id INTO NEW."salesUserId" FROM "User" u
          WHERE u."appRole" = 'SATIS' AND u."isActive" AND u."deletedAt" IS NULL ${firstSales};
        IF NEW."salesUserId" IS NOT NULL THEN
          NEW."salesAssignedAt" := COALESCE(NEW."salesAssignedAt", NEW."createdAt");
          NEW."salesAssignedVia" := COALESCE(NEW."salesAssignedVia", 'AUTO');
          IF NEW."assignedDrawerId" IS NULL THEN
            SELECT u."defaultDrawerId" INTO NEW."assignedDrawerId" FROM "User" u WHERE u.id = NEW."salesUserId";
          END IF;
        END IF;
      END IF;
      RETURN NEW;
    END $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER takip_test_order_owner BEFORE INSERT ON "Order" FOR EACH ROW EXECUTE FUNCTION takip_test_order_owner()`);
  // Doğrudan yazılan sandık (eski testler): ilk satışçının bölümü
  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION takip_test_crate_owner() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."salesUserId" IS NULL THEN
        SELECT u.id INTO NEW."salesUserId" FROM "User" u
          WHERE u."appRole" = 'SATIS' AND u."isActive" AND u."deletedAt" IS NULL ${firstSales};
      END IF;
      RETURN NEW;
    END $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER takip_test_crate_owner BEFORE INSERT ON "Crate" FOR EACH ROW EXECUTE FUNCTION takip_test_crate_owner()`);
  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION takip_test_sales_drawer() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."appRole" = 'SATIS' AND NEW."defaultDrawerId" IS NULL THEN
        SELECT u.id INTO NEW."defaultDrawerId" FROM "User" u
          WHERE u."appRole" = 'CIZIM' AND u."isActive" AND u."deletedAt" IS NULL ORDER BY u."createdAt", u.id LIMIT 1;
      END IF;
      RETURN NEW;
    END $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER takip_test_sales_drawer BEFORE INSERT ON "User" FOR EACH ROW EXECUTE FUNCTION takip_test_sales_drawer()`);
  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION takip_test_drawer_join() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."appRole" = 'CIZIM' AND NEW."isActive" AND NEW."deletedAt" IS NULL THEN
        UPDATE "User" SET "defaultDrawerId" = NEW.id WHERE "appRole" = 'SATIS' AND "defaultDrawerId" IS NULL;
      END IF;
      RETURN NEW;
    END $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER takip_test_drawer_join AFTER INSERT ON "User" FOR EACH ROW EXECUTE FUNCTION takip_test_drawer_join()`);
}


import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { isServerDeployment } = await import('../../server/env.js');
  if (isServerDeployment()) {
    console.error('single-team: gerçek sunucuda çalıştırılmaz (sunucu işareti).');
    process.exit(2);
  }
  const url = process.env.DATABASE_URL ?? '';
  if (!/takip|test/i.test(new URL(url).pathname)) {
    console.error('single-team: veritabanı adı beklenmedik; yalnızca test veritabanı.');
    process.exit(2);
  }
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  try {
    const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] ?? null : null; };
    const on = !process.argv.includes('--off');
    await setSingleTeam(db, on, { defaultTable: on && !process.argv.includes('--no-default-table'), preferSales: arg('--prefer-sales') });
    console.log(`single-team: tetikleyiciler ${process.argv.includes('--off') ? 'kaldırıldı' : 'kuruldu'}.`);
  } finally {
    await db.$disconnect();
  }
}
