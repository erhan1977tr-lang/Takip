// Canlıya geçiş betikleri (P7, karar 250): deploy/canliya-gecis/*.sql gerçek (migration'ları uygulanmış) şemada hatasız
// çalışır ve hiçbir şey yazmaz. Betik, operatörün psql'de çalıştırdığı biçimiyle okunur; \echo satırları atılır, her sorgu
// READ ONLY bir işlemde çalıştırılır.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

let db;
before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
});
after(closeDb);

const statements = (file) => fs.readFileSync(new URL(`../../deploy/canliya-gecis/${file}`, import.meta.url), 'utf8')
  .split('\n').filter((l) => !/^\s*(--|\\echo)/.test(l)).join('\n')
  .split(/;\s*\n/).map((s) => s.trim()).filter((s) => s && !/^(BEGIN|ROLLBACK)\b/i.test(s));

for (const file of ['p7-onkontrol.sql', 'p7-geri-donus.sql', 'uretim-onayi-kapsam.sql', 'uretim-onayi-bildirim-sagligi.sql', 'uretim-onayi-asama-kontrol.sql']) {
  dbTest(`${file}: her sorgu salt okunur işlemde hatasız çalışır; yazma / DDL yok`, offline(async () => {
    const text = fs.readFileSync(new URL(`../../deploy/canliya-gecis/${file}`, import.meta.url), 'utf8').replace(/--.*$/gm, '');
    assert.ok(!/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT|COPY)\b/i.test(text.replace(/'[^']*'/g, "''")), 'yalnızca SELECT');
    assert.match(text, /BEGIN TRANSACTION READ ONLY;/);
    assert.match(text, /ROLLBACK;\s*$/);
    const list = statements(file);
    assert.ok(list.length >= 4);
    for (const sql of list) {
      assert.match(sql, /^(SELECT|WITH)\b/i, sql.slice(0, 60));
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$queryRawUnsafe(sql);
      });
    }
  }));
}

// Aşama 1'den (yeni sürüm + migration) ÖNCE canlıdaki 4.2.0 şemasında çalıştırılacak betikler üretim onayının yeni
// sütunlarını kullanmaz (4.2.1–4.2.8 migration'ları: Order / Offer onay alanları).
const NEW_COLUMNS = /productionApprovalRequired|loadingOverride|approval(RequestedAt|DueAt|OverdueAt|DeliveredAt|DeliveryChannel|DeliveryFailedAt|DeliveryError|ReminderAt)|approvedAt|approvedById|changeRequested|changeNote/;
for (const file of ['uretim-onayi-kapsam.sql', 'uretim-onayi-bildirim-sagligi.sql']) {
  dbTest(`${file}: 4.2.0 şemasıyla çalışır (üretim onayının yeni sütunlarını kullanmaz)`, offline(async () => {
    const text = fs.readFileSync(new URL(`../../deploy/canliya-gecis/${file}`, import.meta.url), 'utf8').replace(/--.*$/gm, '');
    assert.ok(!NEW_COLUMNS.test(text), 'yeni sütun kullanılmamalı');
  }));
}
