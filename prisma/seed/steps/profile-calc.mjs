// Profil hesaplayıcısı (Paket 5, karar 175): ürün sahibinin verdiği kesin paket içerikleri (GK15 137 m, AD45 24 m, MC12 27 m,
// MC16 43 m / kutu) BİR KEZ yazılır. İşaret denetim kaydıdır (PROFILE_PACK_SEED): kayıt varsa adım hiçbir şey yapmaz —
// yönetici sonradan değiştirir ya da silerse yeniden doldurulmaz. Yalnızca içeriği boş olan ürüne yazılır (yöneticinin
// girdiği değerin üzerine yazılmaz); katalogda olmayan kod atlanır. Tüketim katsayısı, sistem, kalınlık YAZILMAZ (tahmin yok).
import { PACK_CONTENTS } from '../data/profile-calc.js';

export const PACK_SEED_ACTION = 'PROFILE_PACK_SEED';

export const profileCalcStep = {
  name: 'profil hesaplayıcı (kesin paket içerikleri)',
  available: (db) => typeof db.profileSystem?.findMany === 'function' && typeof db.auditLog?.findFirst === 'function',
  async run(db) {
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('profile-calc', 0))`;
      if (await tx.auditLog.findFirst({ where: { action: PACK_SEED_ACTION }, select: { id: true } })) return 'daha önce yazıldı';
      const set = [];
      const kept = [];
      for (const p of PACK_CONTENTS) {
        const r = await tx.profileProduct.updateMany({ where: { code: p.code, packContent: null, packMeasure: null }, data: { packContent: p.content, packMeasure: p.measure } });
        (r.count ? set : kept).push(p.code);
      }
      await tx.auditLog.create({
        data: { action: PACK_SEED_ACTION, entityType: 'ProfileProduct', entityId: 'catalog', actorRole: 'SYSTEM', details: { set, kept, values: PACK_CONTENTS.map((p) => ({ ...p })) } },
      });
      return `${set.length} ürüne paket içeriği yazıldı`;
    });
  },
};
