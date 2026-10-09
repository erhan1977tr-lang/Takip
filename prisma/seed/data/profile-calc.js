// Profil hesaplayıcısının kesin değerleri (ürün sahibinin kararı, 08.10.2026 — karar 175). Yalnızca PAKET İÇERİKLERİ:
// bir kutudaki conta metresi. Bunlar 1 m korkuluk için TÜKETİM DEĞİLDİR; tüketim katsayıları, profil boyları, torba
// içerikleri, cam kalınlıkları ve sistemler yönetici tarafından girilir — burada tahmini değer YOKTUR.
// Seed (prisma/seed/steps/profile-calc.mjs) bunları bir kez yazar ve denetim kaydıyla işaretler; yöneticinin sonraki
// değişikliğine dokunmaz.
export const PACK_CONTENTS = Object.freeze([
  Object.freeze({ code: 'GK15', content: '137', measure: 'M' }),
  Object.freeze({ code: 'AD45', content: '24', measure: 'M' }),
  Object.freeze({ code: 'MC12', content: '27', measure: 'M' }),
  Object.freeze({ code: 'MC16', content: '43', measure: 'M' }),
]);

