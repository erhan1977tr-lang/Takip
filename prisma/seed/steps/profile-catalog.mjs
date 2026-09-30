// İlk profil kataloğu (Aşama 6): kategori ve ürünler yalnızca YOKSA eklenir; yöneticinin sonradan yaptığı değişikliklere
// (ad, fiyat, pasif, sıra, görsel) dokunulmaz. Yeni eklenen ürüne formdaki görseli bağlanır.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { PROFILE_CATEGORIES, PROFILE_PRODUCTS } from '../data/profile-catalog.js';

const imageDir = new URL('../data/profile-images/', import.meta.url);

export const profileCatalogStep = {
  name: 'profil kataloğu',
  available: (db) => typeof db.profileProduct?.findMany === 'function',
  async run(db) {
    let cats = 0, products = 0;
    const catId = new Map();
    for (const c of PROFILE_CATEGORIES) {
      const cur = await db.profileCategory.findUnique({ where: { code: c.code } });
      if (cur) { catId.set(c.code, cur.id); continue; }
      const created = await db.profileCategory.create({ data: { code: c.code, nameRo: c.name.ro, nameTr: c.name.tr, sortOrder: c.sortOrder } });
      catId.set(c.code, created.id);
      cats++;
    }
    const images = new Map();
    for (const p of PROFILE_PRODUCTS) {
      if (await db.profileProduct.findUnique({ where: { code: p.code } })) continue;
      let imageId = null;
      if (p.image) {
        if (!images.has(p.image)) {
          const data = fs.readFileSync(new URL(p.image, imageDir));
          const img = await db.profileImage.create({
            data: { data, mime: 'image/jpeg', size: data.length, checksum: crypto.createHash('sha256').update(data).digest('hex'), name: p.image },
          });
          images.set(p.image, img.id);
        }
        imageId = images.get(p.image);
      }
      await db.profileProduct.create({
        data: { code: p.code, categoryId: catId.get(p.category), nameRo: p.name, nameTr: p.name, unitCode: p.unit, sortOrder: p.sortOrder, imageId },
      });
      products++;
    }
    return `${cats} kategori, ${products} ürün eklendi`;
  },
};
