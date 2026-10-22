// Veritabanı testleri için ortak yardımcılar (ADR 0008).
// Testler AYRI bir veritabanında çalışır (TEST_DATABASE_URL) ve tabloları temizler.
// TEST_DATABASE_URL yoksa testler atlanır — üretim ya da geliştirme verisine asla dokunulmaz.
import { test } from 'node:test';
import { sameDatabase } from '../../server/env.js';

export const TEST_URL = process.env.TEST_DATABASE_URL || '';

function safetyProblem() {
  if (!TEST_URL) return 'TEST_DATABASE_URL tanımlı değil';
  if (process.env.DATABASE_URL && sameDatabase(TEST_URL, process.env.DATABASE_URL)) return 'TEST_DATABASE_URL, DATABASE_URL ile aynı';
  const name = new URL(TEST_URL).pathname.slice(1);
  if (!/test/i.test(name)) return `test veritabanının adında "test" geçmeli (şu an: ${name})`;
  return null;
}

/** Veritabanı gerektiren test; güvenlik koşulu sağlanmazsa atlanır (CI'da atlanması hata sayılır). */
export function dbTest(name, fn) {
  const problem = safetyProblem();
  if (problem && process.env.CI && TEST_URL) throw new Error(problem);
  return problem ? test(name, { skip: problem }) : test(name, fn);
}

/**
 * Gerçek ağ isteği engeli (FGO / ANAF gerçek sistemlerdir): sarılan test boyunca global fetch'e düşen HER istek hata
 * fırlatır ve test, hata yutulsa bile başarısız olur. FGO / BNR çağrıları testlerde yalnızca sahte fetchImpl / bnrImpl
 * ile yapılır. Kullanım: dbTest('…', offline(async () => { … })).
 * @param {(t: any) => Promise<void>} fn
 */
export function offline(fn) {
  return async (t) => {
    const real = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      throw new Error(`test: gerçek ağ isteği yapılmamalı (${String(url).slice(0, 120)})`);
    };
    try {
      await fn(t);
    } finally {
      globalThis.fetch = real;
    }
    if (calls.length) throw new Error(`test sırasında gerçek ağ isteği yapıldı: ${calls.join(', ').slice(0, 400)}`);
  };
}

let client;
/** @returns {Promise<import('@prisma/client').PrismaClient>} */
export async function getDb() {
  if (!client) {
    const { PrismaClient } = await import('@prisma/client');
    client = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
  }
  return client;
}

export async function closeDb() {
  if (client) await client.$disconnect();
  client = undefined;
}

/** Tüm uygulama tablolarını boşaltır (migration kaydı hariç) ve temel veriyi (roller, sipariş tipleri) yeniden yükler. */
/**
 * @param {{ calcDefaults?: boolean, supplierCodes?: boolean }} [o]  calcDefaults: false → korkuluk hesaplayıcısının
 *   varsayılanları yazılmaz (karar 203). supplierCodes (varsayılan açık, DÜZELTME 10 M5): katalog ürünlerine test tedarikçi
 *   kodu "TED-<kod>" yazılır — tedarikçi siparişi kodsuz onaylanmaz; kodsuz davranışı sınayan test kodu kendisi siler.
 */
export async function resetDb(db, { calcDefaults = true, supplierCodes = true, singleTeam = true, defaultTable = singleTeam } = {}) {
  await truncateAll(db);
  const { runBaseSeed } = await import('../../prisma/seed/base.mjs');
  await runBaseSeed(db, { log: () => {}, skip: calcDefaults ? [] : ['profile-calc-defaults'] });
  if (supplierCodes) await db.$executeRawUnsafe(`UPDATE "ProfileProduct" SET "supplierCode" = 'TED-' || "code" WHERE "supplierCode" IS NULL`);
  await setSingleTeam(db, singleTeam, { defaultTable });
}

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
export async function setSingleTeam(db, on, { defaultTable = on } = {}) {
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
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS takip_test_order_owner ON "Order"`);
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS takip_test_sales_drawer ON "User"`);
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS takip_test_drawer_join ON "User"`);
  if (!on) return;
  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION takip_test_order_owner() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."orderTypeCode" = 'GLASS_ORDER' AND NEW."salesUserId" IS NULL THEN
        SELECT u.id INTO NEW."salesUserId" FROM "User" u
          WHERE u."appRole" = 'SATIS' AND u."isActive" AND u."deletedAt" IS NULL ORDER BY u."createdAt", u.id LIMIT 1;
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

async function truncateAll(db) {
  const rows = await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (!rows.length) return;
  const list = rows.map((r) => `"public"."${r.tablename.replace(/"/g, '""')}"`).join(', ');
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL takip.audit_maintenance = 'on'`),
    db.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`),
  ]);
}

/**
 * Nihai fatura (karar 239) — testlerin ortak yolu: onaylı yükleme (siparişin gönderilmiş teklifinin kopyası, confirmLoading
 * ile aynı işlev: snapshotLine) → yükleme gününün Faturalama kartı (loadingBilling) → fatura partisi (createInvoiceBatch) →
 * işçi (dispatchBatchJobs). Sipariş düzeyinde nihai fatura yoktur. FGO yalnızca verilen sahte fetchImpl ile çağrılır.
 *   loaded: cam satırlarının yüklenen adedi (verilmezse tamamı); kalan NOT_LOADED kaydedilir.
 * @returns {Promise<{ day: string, group: any, created: any, run: { done: number, failed: number } | null, doc: any }>}
 */
export async function finalInvoiceFor(db, { order, adminId, actor, day, bnrImpl, dispatchCtx, loaded = null }) {
  const { snapshotLine } = await import('../../server/loading/confirmation.js');
  const inv = await import('../../server/glass/invoice-batch.js');
  const b = await import('../../server/glass/batch.js');
  const conf = await db.loadingConfirmation.create({ data: { shipDay: new Date(`${day}T00:00:00Z`), confirmedById: adminId, confirmedAt: new Date(`${day}T12:00:00Z`) } });
  const full = await db.order.findUnique({ where: { id: order.id }, include: { offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } } } });
  const offer = full.offers.find((x) => x.status === 'GONDERILDI');
  const rows = [];
  for (const l of offer.lines) {
    const all = Number(l.adet);
    const glass = (l.kind ?? 'CAM') === 'CAM';
    const qty = loaded == null || !glass ? all : loaded;
    if (qty > 0) rows.push(snapshotLine(full, offer, l, { quantity: qty }));
    if (qty < all) rows.push(snapshotLine(full, offer, l, { quantity: all - qty, status: 'NOT_LOADED', reason: 'test' }));
  }
  await db.loadingConfirmationItem.createMany({
    data: rows.map((i) => ({ ...i, confirmationId: conf.id, scopeKey: `l:${i.offerLineId}`, m2: i.m2.toFixed(2), unitCost: i.unitCost.toFixed(2), unitSale: i.unitSale == null ? null : i.unitSale.toFixed(2), costAmount: i.costAmount.toFixed(4), saleAmount: i.saleAmount.toFixed(4) })),
  });
  const r = await inv.loadingBilling(db, { day, bnrImpl });
  const group = r.ok ? r.customers.flatMap((c) => c.groups).find((x) => x.orders.some((y) => y.orderId === order.id)) ?? null : null;
  if (!group || group.problems.length) return { day, group, created: null, run: null, doc: null };
  const created = await inv.createInvoiceBatch(db, { day, groupKey: group.key, previewKey: group.previewKey, actor, bnrImpl });
  if (!created.ok || !dispatchCtx) return { day, group, created, run: null, doc: null };
  const run = await b.dispatchBatchJobs(db, { ...dispatchCtx, onlyBatchId: created.batchId });
  return { day, group, created, run, doc: await db.fgoDocument.findFirst({ where: { batchId: created.batchId } }) };
}

let finalDayNo = 100;
/** finalInvoiceFor için ayrı, geçmiş bir yükleme günü (onay gün başına tektir); dosya başına farklı başlangıç verilebilir */
export function nextPastDay(start = null) {
  if (start != null && finalDayNo < start) finalDayNo = start;
  finalDayNo += 1;
  return new Date(Date.now() - finalDayNo * 86_400_000).toISOString().slice(0, 10);
}
