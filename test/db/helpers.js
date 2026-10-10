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
/** @param {{ calcDefaults?: boolean }} [o]  calcDefaults: false → korkuluk hesaplayıcısının varsayılanları yazılmaz (karar 203) */
export async function resetDb(db, { calcDefaults = true } = {}) {
  await truncateAll(db);
  const { runBaseSeed } = await import('../../prisma/seed/base.mjs');
  await runBaseSeed(db, { log: () => {}, skip: calcDefaults ? [] : ['profile-calc-defaults'] });
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
