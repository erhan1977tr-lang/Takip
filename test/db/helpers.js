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
