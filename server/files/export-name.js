// Dışa aktarılan dosyaların adı — TEK kural (Paket 7, karar 191). Excel ve PDF dosya adları kullanıcının seçili panel dilindedir:
// ad parçası sözlükten gelir (server/i18n/{tr,ro}/exports.js → names.*), ardından belgeye özgü parçalar (firma kodu, sipariş no,
// gün): "Yukleme-Ozeti-2026-10-08.xlsx" / "Rezumat-Incarcare-2026-10-08.xlsx". Dosya adında yalnızca güvenli karakterler
// bulunur: Türkçe ve Romence harfler Latin karşılığına çevrilir (ş → s, ț → t …), harf / rakam / alt çizgi dışındaki her şey tek
// tireye iner; boşluk, tırnak, bölü, yıldız (maskeli ad) hiçbir zaman dosya adına geçmez. Belge numarası ve içerik değişmez.

const LATIN = {
  ç: 'c', Ç: 'C', ğ: 'g', Ğ: 'G', ı: 'i', İ: 'I', ö: 'o', Ö: 'O', ş: 's', Ş: 'S', ü: 'u', Ü: 'U',
  ă: 'a', Ă: 'A', â: 'a', Â: 'A', î: 'i', Î: 'I', ș: 's', Ș: 'S', ț: 't', Ț: 'T', ţ: 't', Ţ: 'T',
};

/**
 * Dosya adı parçası: Latin harfe çevrilir, güvenli olmayan her karakter dizisi tek "-" olur, baş / son tire atılır.
 * @param {unknown} s
 * @param {number} [max]
 */
export function safeFilePart(s, max = 60) {
  const latin = String(s ?? '').replace(/[çÇğĞıİöÖşŞüÜăĂâÂîÎșȘțȚţŢ]/g, (c) => LATIN[c] ?? c)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return latin.replace(/[^A-Za-z0-9_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '');
}

/**
 * Dışa aktarılan dosyanın adı: dil sözlüğündeki ad + parçalar + uzantı. Boş parça atlanır; ad boşsa "Takip".
 * @param {string} base  sözlükten (ör. t('exports.names.loadingSummary'))
 * @param {(string | number | null | undefined)[]} parts
 * @param {'xlsx' | 'pdf'} ext
 */
export function exportFileName(base, parts, ext) {
  const name = [safeFilePart(base), ...parts.map((p) => safeFilePart(p))].filter(Boolean).join('-') || 'Takip';
  return `${name}.${ext}`;
}

/**
 * İndirme başlığı (Content-Disposition). Ad exportFileName'den gelir (yalnızca güvenli ASCII); yine de tırnak / ters bölü /
 * satır sonu taşımaz.
 * @param {string} name  @param {{ inline?: boolean }} [o]
 */
export function contentDisposition(name, { inline = false } = {}) {
  const safe = String(name).replace(/["\\\r\n]/g, '');
  return `${inline ? 'inline' : 'attachment'}; filename="${safe}"`;
}
