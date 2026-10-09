// Korkuluk hesaplayıcısının varsayılan yapılandırması (karar 203): kesin teknik kurallar (server/profile/railing-defaults.js →
// RAILING_*) Paket 5'in yapılandırma modeline BİR KEZ yazılır. Tek yazıcı: applyRailingDefaults (seed adımı çağırır).
//   - İşaret denetim kaydıdır (RAILING_DEFAULTS_ACTION): kayıt varsa hiçbir şey yazılmaz (yöneticinin sonradan değiştirdiği,
//     sildiği ya da pasif yaptığı değer yeniden doldurulmaz).
//   - Önce katalog denetlenir: gereken ürün kodu yoksa ya da satış birimi beklenenden farklıysa HİÇBİR şey yazılmaz ve eksik /
//     uyumsuz kodlar döner (yanlış ürün eşleştirilmez, ürün oluşturulmaz). Bir sonraki çalıştırmada yeniden denenir.
//   - Cam kalınlığı: aynı mm varsa yeniden oluşturulmaz (adı boşsa "6+6" yazılır). Paket içeriği: yalnızca boş olana.
//   - Sistem: aynı kodlu sistem varsa satırlarına dokunulmaz (yalnızca türü boşsa yazılır); yoksa satırlarıyla oluşturulur.
// Hepsi tek işlemde, 'profile-calc' danışma kilidi altında.
import { RAILING_CODES, RAILING_PACKS, RAILING_SYSTEMS, RAILING_THICKNESSES } from './railing-defaults.js';

export const RAILING_DEFAULTS_ACTION = 'PROFILE_CALC_DEFAULTS';

/**
 * Katalog bu varsayılanlar için uygun mu (salt okunur): eksik kodlar ve birimi beklenenden farklı ürünler.
 * @param {{ code: string, unitCode: string }[]} products  katalogdaki ilgili ürünler
 * @returns {{ missing: string[], wrongUnit: { code: string, unit: string, expected: string }[] }}
 */
export function railingCatalogProblems(products) {
  const byCode = new Map(products.map((p) => [p.code, p]));
  const missing = RAILING_CODES.filter((c) => !byCode.has(c));
  const wrongUnit = [];
  for (const pk of RAILING_PACKS) {
    const p = byCode.get(pk.code);
    if (p && p.unitCode !== pk.unit) wrongUnit.push({ code: pk.code, unit: p.unitCode, expected: pk.unit });
  }
  return { missing, wrongUnit };
}

/**
 * Yöneticinin ekranı için durum (salt okunur)
 * @param {any} db
 * @returns {Promise<{ applied: boolean, missing: string[], wrongUnit: { code: string, unit: string, expected: string }[] }>}
 */
export async function railingDefaultsStatus(db) {
  const [mark, products] = await Promise.all([
    db.auditLog.findFirst({ where: { action: RAILING_DEFAULTS_ACTION }, select: { id: true } }),
    db.profileProduct.findMany({ where: { code: { in: [...RAILING_CODES, ...RAILING_PACKS.map((p) => p.code)] } }, select: { code: true, unitCode: true } }),
  ]);
  return { applied: !!mark, ...railingCatalogProblems(products) };
}

/**
 * Varsayılanları yazar (idempotent).
 * @param {any} db
 * @returns {Promise<{ state: 'done' | 'already' | 'blocked', missing?: string[], wrongUnit?: object[], created?: string[], kept?: string[] }>}
 */
export async function applyRailingDefaults(db) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('profile-calc', 0))`;
    if (await tx.auditLog.findFirst({ where: { action: RAILING_DEFAULTS_ACTION }, select: { id: true } })) return { state: 'already' };
    const codes = [...new Set([...RAILING_CODES, ...RAILING_PACKS.map((p) => p.code)])];
    const products = await tx.profileProduct.findMany({ where: { code: { in: codes } }, select: { id: true, code: true, unitCode: true } });
    const problems = railingCatalogProblems(products);
    if (problems.missing.length || problems.wrongUnit.length) return { state: 'blocked', ...problems };
    const productId = new Map(products.map((p) => [p.code, p.id]));

    // Cam kalınlıkları
    const thicknessId = new Map();
    const lastT = await tx.profileGlassThickness.aggregate({ _max: { sortOrder: true } });
    let tOrder = lastT._max.sortOrder ?? 0;
    for (const t of RAILING_THICKNESSES) {
      const cur = await tx.profileGlassThickness.findUnique({ where: { mm: t.mm } });
      if (cur) {
        if (!cur.label) await tx.profileGlassThickness.update({ where: { id: cur.id }, data: { label: t.label } });
        thicknessId.set(t.key, cur.id);
      } else {
        tOrder += 10;
        const created = await tx.profileGlassThickness.create({ data: { mm: t.mm, label: t.label, sortOrder: tOrder } });
        thicknessId.set(t.key, created.id);
      }
    }
    // Paket içerikleri (6 m boy, poşet bir boya yeter, conta kutusu) — yalnızca boş olana
    const packs = [];
    for (const pk of RAILING_PACKS) {
      const r = await tx.profileProduct.updateMany({ where: { code: pk.code, packContent: null, packMeasure: null }, data: { packContent: pk.content, packMeasure: pk.measure } });
      if (r.count) packs.push(pk.code);
    }
    // Sistemler
    const created = [];
    const kept = [];
    const lastS = await tx.profileSystem.aggregate({ _max: { sortOrder: true } });
    let sOrder = lastS._max.sortOrder ?? 0;
    for (const s of RAILING_SYSTEMS) {
      const cur = await tx.profileSystem.findUnique({ where: { code: s.code } });
      if (cur) {
        if (!cur.kind) await tx.profileSystem.update({ where: { id: cur.id }, data: { kind: s.kind } });
        kept.push(s.code);
        continue;
      }
      sOrder += 10;
      await tx.profileSystem.create({
        data: {
          code: s.code, kind: s.kind, nameTr: s.nameTr, nameRo: s.nameRo, sortOrder: sOrder,
          items: {
            create: s.items.map((i, n) => ({
              slot: i.slot, productId: productId.get(i.product), color: i.color, thicknessId: i.thickness ? thicknessId.get(i.thickness) : null,
              perMeter: i.perMeter, sortOrder: (n + 1) * 10,
            })),
          },
        },
      });
      created.push(s.code);
    }
    await tx.auditLog.create({
      data: {
        action: RAILING_DEFAULTS_ACTION, entityType: 'ProfileSystem', entityId: 'railing', actorRole: 'SYSTEM',
        details: { created, kept, packs, thicknesses: RAILING_THICKNESSES.map((t) => ({ mm: t.mm, label: t.label })) },
      },
    });
    return { state: 'done', created, kept };
  });
}
