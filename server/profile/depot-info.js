// Profil deposunun konumu ve iletişim kişileri (4.2.28 — ürün sahibi 26.11.2026). Profil siparişinin PROFORMA bildirimlerinde
// müşteriye yazılır: proforma e-postası (FGO'nun kestiği belge e-postası — server/documents/delivery.js — ve elle kesilen proformanın
// bildirim e-postası — server/notifications/email.js) ve uygulama içi bildirim (server/notifications/inapp.js). Başka hiçbir
// e-posta / bildirim / belge bu bilgiyi taşımaz. Değerler TEK yerde: adres ya da kişiler değişirse yalnızca bu dosya değişir.

/** Deponun Google Maps bağlantısı (yalnızca https://www.google.com/maps… ya da https://maps.app.goo.gl/…) */
export const DEPOT_MAPS_URL = 'https://maps.app.goo.gl/KcRhnfGEa84iNEPv9';

/** İletişim kişileri — sıra sabit: önce depo, sonra GKH */
export const DEPOT_CONTACTS = Object.freeze([
  Object.freeze({ key: 'depot', name: 'Adrian', phone: '+40 723 344 443' }),
  Object.freeze({ key: 'gkh', name: 'Enis', phone: '+40 750 492 221' }),
]);

/** Bilgi yalnızca profil siparişinin proformasında yazılır (cam siparişi, avans, fatura ve öbür olaylar değişmez) */
export const isProfileProforma = ({ orderTypeCode, kind }) => orderTypeCode === 'PROFILE_ORDER' && kind === 'PROFORMA';

/**
 * Metin satırları (alıcının dilinde): [etiket, değer]. labels: { location, contactDepot, contactGkh } (i18n'den ya da sabit Romence).
 * @param {{ location: string, contactDepot: string, contactGkh: string }} labels
 * @returns {[string, string][]}
 */
export function depotRows(labels) {
  const [depot, gkh] = DEPOT_CONTACTS;
  return [
    [labels.location, DEPOT_MAPS_URL],
    [labels.contactDepot, `${depot.name}: ${depot.phone}`],
    [labels.contactGkh, `${gkh.name}: ${gkh.phone}`],
  ];
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const tel = (phone) => `tel:${String(phone).replace(/[^\d+]/g, '')}`;

/**
 * E-posta gövdesine eklenen HTML bölümü (başlık + Maps bağlantısı + tıklanabilir telefonlar).
 * @param {{ title: string, location: string, mapsLink: string, contactDepot: string, contactGkh: string }} labels
 */
export function depotHtml(labels) {
  const [depot, gkh] = DEPOT_CONTACTS;
  const row = (k, v) => `<tr><td style="color:#6b7280;vertical-align:top">${esc(k)}</td><td><b>${v}</b></td></tr>`;
  return `<div data-depot-info style="margin:16px 0 0;padding:12px 14px;border:1px solid #e5e7eb;border-radius:6px;background:#f9fafb">
<p style="margin:0 0 8px"><b>${esc(labels.title)}</b></p>
<table cellpadding="4" style="border-collapse:collapse">${[
    row(labels.location, `<a href="${esc(DEPOT_MAPS_URL)}">${esc(labels.mapsLink)}</a>`),
    row(labels.contactDepot, `${esc(depot.name)}: <a href="${esc(tel(depot.phone))}">${esc(depot.phone)}</a>`),
    row(labels.contactGkh, `${esc(gkh.name)}: <a href="${esc(tel(gkh.phone))}">${esc(gkh.phone)}</a>`),
  ].join('')}</table>
</div>`;
}

/** Düz metin bölümü */
export function depotText(labels) {
  return [labels.title, ...depotRows(labels).map(([k, v]) => `${k}: ${v}`)].join('\n');
}

/** Romence etiketler (FGO belge e-postası yalnızca Romence — server/documents/delivery.js) */
export const DEPOT_LABELS_RO = Object.freeze({
  title: 'Ridicare marfă — depozit',
  location: 'Locație depozit',
  mapsLink: 'Deschide în Google Maps',
  contactDepot: 'Contact depozit',
  contactGkh: 'Contact GKH',
});
