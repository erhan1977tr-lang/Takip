// Müşterinin DWG/DXF olarak gönderdiği çizim için çizimci kararı (karar 167) — SAF kurallar (veritabanı yok).
//
// Satış siparişi çizim ekibine gönderdiğinde müşterinin sipariş dosyaları arasında DWG / DXF varsa çizimci önce o çizim
// hakkında karar verir (çizim ekibinin "DXF/DWG olarak gelen çizimler" menüsü + sipariş sayfası). Üç karar birbirinden
// ayrı sunucu işlemleridir (server/orders/transitions.js → dwg_ready / dwg_faulty / dwg_update):
//   Üretime Hazır  (READY)  : dosya üretime uygun; müşteri onayı BEKLENMEZ, çizim hattı ONAYLANDI → "Müşteriden onaylı
//                             çizimler". Koşullar tamamsa (teklif müşteride) sipariş olağan kuralla üretime geçer.
//   Çizim Hatalı   (FAULTY) : açıklama zorunlu; müşteriye bildirim + e-posta. Çizim hattı DUZELTME_BEKLIYOR: müşteri
//                             mevcut siparişten düzeltilmiş dosya gönderir (dwg_resubmit → yeniden karar) ya da fabrikadan
//                             çizim ister (dwg_request_drawing → olağan çizim kuyruğu).
//   Çizimi Güncelle (UPDATE): orijinal dosya korunur; çizimci yeni çizimi olağan akışla (taslak → Kontrol Et → müşteriye
//                             gönder → müşteri onayı / revizyon) hazırlar.
// Karar verilmeden çizimci sürüm yükleyemez (availableActions → dwgPending): kararlar ayrı ve kayıtlıdır.
//
// Kayıt: her karar, müşterinin dosyası için bir çizim SÜRÜMÜ satırıdır (Drawing.source = MUSTERI_DXF_DWG; dosya satırı
// yoktur — dosyalar müşterinin sipariş dosyalarıdır, kararın verildiği dosyalar sourceFiles'ta değişmez kopya olarak
// durur). Sürüm geçmişi korunur: hatalı bulunan dosya, kararı veren, zaman ve açıklama silinmez / üzerine yazılmaz.
//   durum = karar: ONAYLANDI (hazır) · REVIZYON_ISTENDI (hatalı) · YAPILIYOR (fabrika çizecek) · BEKLIYOR (müşterinin
//   düzeltilmiş dosyası geldi, karar bekliyor)

/** Müşteri çizimi sayılan uzantılar */
export const CUSTOMER_DRAWING_EXT = Object.freeze(['dwg', 'dxf']);
/** Müşterinin çiziminin karar kaydı (Drawing.source) */
export const DWG_SOURCE = 'MUSTERI_DXF_DWG';
/** Düzeltilmiş dosya geldi, karar bekliyor (Drawing.status) */
export const DWG_RESUBMITTED = 'BEKLIYOR';
/** Karar → müşteri çizimi kaydının durumu */
export const DWG_DECISION_STATUS = Object.freeze({ READY: 'ONAYLANDI', FAULTY: 'REVIZYON_ISTENDI', UPDATE: 'YAPILIYOR' });
/** Kararın beklenebileceği çizim hattı durumları (satış çizime gönderdi; çizimci henüz sürüm yüklemedi) */
const OPEN_TRACKS = Object.freeze(['GEREKLI', 'YAPILIYOR']);
/** "Çizim hatalı" açıklamasının en uzun hâli */
export const DWG_NOTE_MAX = 2000;

/** Dosya müşteri çizimi (DWG / DXF) mi — uzantıya bakılır; içerik denetimi yüklemede yapılmıştır (server/files/signature.js) */
export function isCustomerDrawingFile(name) {
  const n = String(name ?? '').toLowerCase();
  const dot = n.lastIndexOf('.');
  return dot > 0 && CUSTOMER_DRAWING_EXT.includes(n.slice(dot + 1));
}

/**
 * Siparişin karar verilebilecek müşteri çizimleri: müşterinin sipariş dosyaları (iç dosya değil) arasındaki DWG / DXF,
 * virüslü olanlar hariç (karantinadaki dosya kimseye verilmez).
 * @template {{ name: string, kind?: string | null, scanStatus?: string | null }} F
 * @param {F[] | null | undefined} files
 * @returns {F[]}
 */
export function customerDrawingFiles(files) {
  return (files ?? []).filter((f) => (f.kind ?? 'CUSTOMER') === 'CUSTOMER' && isCustomerDrawingFile(f.name) && f.scanStatus !== 'INFECTED');
}

/** Kararın verildiği dosyaların değişmez kopyası (Drawing.sourceFiles) */
export function sourceFilesSnapshot(files) {
  return (files ?? []).map((f) => ({ id: String(f.id), name: String(f.name), checksum: f.checksum ?? null }));
}

/**
 * Kayıttaki dosya listesi (Drawing.sourceFiles değeri) — biçimi bozuk / boşsa boş dizi.
 * @param {unknown} raw
 * @returns {{ id: string, name: string, checksum: string | null }[]}
 */
export function sourceFilesOf(raw) {
  return Array.isArray(raw)
    ? raw.filter((f) => f && typeof f.id === 'string' && typeof f.name === 'string').map((f) => ({ id: f.id, name: f.name, checksum: typeof f.checksum === 'string' ? f.checksum : null }))
    : [];
}

/** Sürüm müşterinin DWG/DXF çiziminin karar kaydı mı (fabrika sürümü değil) */
export const isCustomerDrawingRecord = (d) => d?.source === DWG_SOURCE;

/**
 * Siparişte müşteri çizimi için çizimci kararı bekleniyor mu?
 *   - sipariş hazırlanıyor, beklemede değil, çizim hattı GEREKLI / YAPILIYOR (satış çizime gönderdi) ve
 *   - hiç çizim sürümü yok + müşterinin DWG / DXF dosyası var (ilk karar: kaydı karar açar), ya da
 *   - son sürüm müşterinin düzeltilmiş dosyasının karar kaydı (BEKLIYOR).
 * drawings: sürümler eskiden yeniye. Liste sorgusu taslakları dışarıda bırakıyorsa drawingCount (ya da Prisma'nın
 * _count.drawings alanı) bütün sürüm sayısıdır (taslak fabrika sürümü varsa çizim zaten olağan akıştadır).
 * @param {{ status: string, drawingTrack?: string | null, onHold?: boolean, files?: { name: string, kind?: string | null, scanStatus?: string | null }[],
 *   drawings?: { id?: string, source?: string | null, status: string, sourceFiles?: unknown }[], drawingCount?: number, _count?: { drawings?: number } }} o
 * @returns {{ pending: boolean, record: object | null, files: object[] }}
 *   record: kararın güncelleyeceği açık kayıt (BEKLIYOR) ya da null (kararı ilk kez verilecek dosyalar: files)
 */
export function dwgReview(o) {
  const none = { pending: false, record: null, files: [] };
  if (!o || o.status !== 'HAZIRLANIYOR' || o.onHold || !OPEN_TRACKS.includes(o.drawingTrack ?? '')) return none;
  const drawings = o.drawings ?? [];
  const latest = drawings[drawings.length - 1] ?? null;
  if (latest && isCustomerDrawingRecord(latest) && latest.status === DWG_RESUBMITTED) {
    return { pending: true, record: latest, files: sourceFilesOf(latest.sourceFiles) };
  }
  if ((o.drawingCount ?? o._count?.drawings ?? drawings.length) > 0) return none;
  const files = customerDrawingFiles(o.files);
  return files.length ? { pending: true, record: null, files } : none;
}

/**
 * "Çizim hatalı" açıklaması: zorunlu, tek metin (satırlar korunur), en çok DWG_NOTE_MAX karakter.
 * @param {unknown} v
 * @returns {{ ok: true, text: string } | { ok: false, code: 'DWG_NOTE' | 'DWG_NOTE_LONG' }}
 */
export function dwgNote(v) {
  const text = String(v ?? '').normalize('NFC').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return { ok: false, code: 'DWG_NOTE' };
  if (text.length > DWG_NOTE_MAX) return { ok: false, code: 'DWG_NOTE_LONG' };
  return { ok: true, text };
}

/**
 * Müşterinin düzeltilmiş dosya gönderiminde en az bir DWG / DXF olmalı (yanında PDF gibi başka izinli dosyalar olabilir).
 * @param {{ name: string }[] | null | undefined} files
 */
export const hasCustomerDrawingFile = (files) => (files ?? []).some((f) => isCustomerDrawingFile(f?.name));

/**
 * "Teklif kontrolü" (server/orders/rules.js → offerNeedsCheck) için son ÜRETİM çizimi ve sırası. Üretim çizimi: müşteriye
 * gönderilmiş fabrika sürümü (taslak değil — eski kuralla aynı) ya da çizimcinin "üretime hazır" kabul ettiği müşteri
 * çizimi (karar 167). Müşterinin karar bekleyen / hatalı bulunan / fabrikaya bırakılan kayıtları çizim değildir, sayılmaz.
 * ordinal = üretim çizimleri arasındaki sıra: 1 → ilk çizim, teklifle aynı kabul edilir (müşterinin karar kaydı araya
 * girince ilk fabrika çizimi "v2" olur ama yine ilk çizimdir). Yalnızca fabrika sürümü olan siparişte ordinal sürüm
 * numarasının aynısıdır (taslak yalnızca son sürüm olabilir) — eski davranış değişmez.
 * at: çizimin müşteriye gittiği / üretime hazır kabul edildiği an.
 * @template {{ source?: string | null, status: string, version: number, createdAt: Date | string, sentAt?: Date | string | null, decidedAt?: Date | string | null }} D
 * @param {D[]} drawings  eskiden yeniye
 * @returns {{ drawing: D, ordinal: number, at: Date | string } | null}
 */
export function lastProductionDrawing(drawings) {
  let ordinal = 0;
  let last = null;
  for (const d of drawings ?? []) {
    const production = isCustomerDrawingRecord(d) ? d.status === 'ONAYLANDI' : d.status !== 'TASLAK';
    if (!production) continue;
    ordinal += 1;
    last = d;
  }
  if (!last) return null;
  const at = isCustomerDrawingRecord(last) ? last.decidedAt ?? last.createdAt : last.sentAt ?? last.createdAt;
  return { drawing: last, ordinal, at };
}
