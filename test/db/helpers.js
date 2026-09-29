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
export async function resetDb(db) {
  await truncateAll(db);
  const { runBaseSeed } = await import('../../prisma/seed/base.mjs');
  await runBaseSeed(db, { log: () => {} });
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
