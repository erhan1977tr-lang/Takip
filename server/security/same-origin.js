// Kayıt değiştiren Route Handler'lar için kaynak denetimi (CSRF). Uygulamadaki öteki kayıt değiştiren işlemler sunucu
// işlemidir (Next kaynağı kendisi denetler); bu denetim Route Handler ile yapılan tek işlem içindir (app/oturum/etkinlik).
// Oturum çerezi SameSite=Lax olduğundan başka siteden gelen POST zaten çerez taşımaz; buradaki denetim ikinci kattır.
//   - Sec-Fetch-Site varsa (güncel tarayıcılar): yalnızca "same-origin" kabul edilir.
//   - Yoksa Origin varsa: sunucu adı isteğin sunucu adıyla (vekil arkasında X-Forwarded-Host) aynı olmalıdır.
//   - İkisi de yoksa istek tarayıcıdan gelmiyordur (CSRF konusu değildir): kabul edilir.

/**
 * @param {{ secFetchSite?: string | null, origin?: string | null, host?: string | null, forwardedHost?: string | null }} h
 * @returns {boolean}
 */
export function sameOriginRequest({ secFetchSite, origin, host, forwardedHost }) {
  if (secFetchSite) return secFetchSite.trim().toLowerCase() === 'same-origin';
  if (!origin) return true;
  const own = String(forwardedHost || host || '').split(',')[0].trim().toLowerCase();
  if (!own) return false;
  try {
    return new URL(origin).host.toLowerCase() === own;
  } catch {
    return false;
  }
}
