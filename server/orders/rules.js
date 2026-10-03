// Sipariş iş kuralları — Next.js'ten bağımsız, birim testli.
//
// Akış:
//   YENI ──satış karar verir──▶ HAZIRLANIYOR ──otomatik──▶ URETIMDE ─▶ YUKLENDI ─▶ ARSIVLENDI
//   HAZIRLANIYOR içinde iki bağımsız hat vardır:
//     Çizim hattı (drawingTrack): YOK | GEREKLI → YAPILIYOR → ONAY_BEKLIYOR ⇄ REVIZYON_ISTENDI → ONAYLANDI
//     Teklif hattı (offer.status): HAZIRLANIYOR (satış) → YONETIMDE (yönetici) → GONDERILDI (müşteri görür)
//   Müşteri yalnızca çizimi onaylar; teklifi onaylamaz, sadece görür.
//   Satış kararını (çizime / teklife gönder) teklif satıştayken geri alabilir; teklif yöneticiye gittikten sonra
//   değişikliği yalnızca yönetici yapar. Müşterideki teklifi yönetici her an günceller (yeni sürüm olarak).
//   Otomatik üretim: çizim YOK ya da ONAYLANDI  +  teklif GONDERILDI olunca sipariş kendiliğinden URETIMDE olur
//   (beklemedeki sipariş geçmez; beklemeden çıkarılınca yeniden kontrol edilir). İptal yalnızca yöneticidedir.
//
// Ekranda görünen metinler burada DEĞİL, server/i18n/{tr,ro}/ sözlüklerindedir; buradaki işlevler kod döndürür.
import { can } from '../auth/permissions.js';


// Rozet renkleri (metinleri: status.order / status.drawing / status.offer)
export const ORDER_STATUS = {
  YENI: { tone: 'muted' },
  HAZIRLANIYOR: { tone: 'info' },
  URETIMDE: { tone: 'info' },
  YUKLENDI: { tone: 'ok' },
  ARSIVLENDI: { tone: 'muted' },
  IPTAL: { tone: 'muted' },
};

export const DRAWING = {
  YOK: { tone: 'muted' },
  GEREKLI: { tone: 'purple' },
  YAPILIYOR: { tone: 'purple' },
  ONAY_BEKLIYOR: { tone: 'warn' },
  REVIZYON_ISTENDI: { tone: 'danger' },
  ONAYLANDI: { tone: 'ok' },
};

export const OFFER = {
  NONE: { tone: 'muted' },
  HAZIRLANIYOR: { tone: 'info' },
  YONETIMDE: { tone: 'warn' },
  GONDERILDI: { tone: 'ok' },
};

export const CLOSED = ['YUKLENDI', 'ARSIVLENDI', 'IPTAL'];
export const ACTIVE_DRAWING = ['GEREKLI', 'YAPILIYOR', 'REVIZYON_ISTENDI'];

/**
 * Müşterinin gördüğü tek satırlık durum (metni: status.customer.<key>.label / .next).
 * @param {{status: string, drawing?: string, offer?: string|null}} p
 * @returns {{key: string, tone: string}}
 */
export function customerSummary({ status, drawing = 'YOK', offer = null }) {
  if (status === 'YENI') return { key: 'reviewing', tone: 'muted' };
  if (status === 'HAZIRLANIYOR') {
    if (drawing === 'ONAY_BEKLIYOR') return { key: 'awaitingApproval', tone: 'warn' };
    if (drawing === 'REVIZYON_ISTENDI') return { key: 'revision', tone: 'danger' };
    if (drawing === 'GEREKLI' || drawing === 'YAPILIYOR') return { key: 'drawing', tone: 'purple' };
    if (offer === 'GONDERILDI') return { key: 'offerReady', tone: 'ok' };
    return { key: 'preparing', tone: 'info' };
  }
  if (status === 'URETIMDE') return { key: 'production', tone: 'info' };
  if (status === 'YUKLENDI') return { key: 'shipped', tone: 'ok' };
  if (status === 'ARSIVLENDI') return { key: 'archived', tone: 'muted' };
  return { key: 'cancelled', tone: 'muted' };
}

/**
 * Otomatik üretime geçmek için eksik kalanlar (boş dizi = koşullar tamam). Metni: status.blockers.<kod>.
 * @param {{status: string, drawing?: string, offer?: string|null}} p
 * @returns {string[]}
 */
export function productionBlockers({ status, drawing = 'YOK', offer = null }) {
  if (status !== 'HAZIRLANIYOR') return ['not_preparing'];
  const b = [];
  if (drawing === 'ONAY_BEKLIYOR') b.push('drawing_at_customer');
  else if (drawing !== 'YOK' && drawing !== 'ONAYLANDI') b.push('drawing_not_done');
  if (offer !== 'GONDERILDI') b.push(offer === 'YONETIMDE' ? 'offer_at_admin' : 'offer_not_sent');
  return b;
}

/**
 * Sipariş şimdi otomatik olarak üretime geçmeli mi?
 * @param {{status: string, onHold?: boolean, drawing?: string, offer?: string|null}} p
 * @returns {boolean}
 */
export function shouldAutoProduce({ status, onHold = false, drawing = 'YOK', offer = null }) {
  return !onHold && productionBlockers({ status, drawing, offer }).length === 0;
}

/**
 * Müşterideki teklif, gönderildikten (ya da yöneticinin son kontrolünden) sonra yüklenen revize çizimden eski mi?
 * Revizyon ölçüleri değiştirmiş olabilir; yönetici teklifi güncellemeli ya da güncel olduğunu işaretlemeli.
 * İlk çizim (v1) müşterinin dosyasından çizildiği için teklifle aynı kabul edilir.
 * @param {{offer?: string|null, sentAt?: Date|string|null, lastDrawing?: {version: number, createdAt: Date|string}|null, checkedAt?: Date|string|null}} p
 * @returns {boolean}
 */
export function offerNeedsCheck({ offer = null, sentAt = null, lastDrawing = null, checkedAt = null }) {
  if (offer !== 'GONDERILDI' || !sentAt || !lastDrawing || lastDrawing.version < 2) return false;
  const seen = Math.max(new Date(sentAt).getTime(), checkedAt ? new Date(checkedAt).getTime() : 0);
  return new Date(lastDrawing.sentAt ?? lastDrawing.createdAt).getTime() > seen;
}

/** Adım çubuğu (metni: status.stages.<anahtar>). */
export const STAGES = ['received', 'review', 'drawingOffer', 'production', 'loading'];

/** Adım çubuğunda o anki adımın sırası (0 tabanlı). Arşivde tümü tamamlanmış sayılır. */
export function stageIndex(status) {
  return { YENI: 1, HAZIRLANIYOR: 2, URETIMDE: 3, YUKLENDI: 4, ARSIVLENDI: 5 }[status] ?? 1;
}

// ---------- SLA ----------
export const SLA_HOURS = {
  review: 24, // YENI: satış kararı
  drawing: { GEREKLI: 24, YAPILIYOR: 48, REVIZYON_ISTENDI: 24 },
  offer: { HAZIRLANIYOR: 24, YONETIMDE: 24 },
};

const addH = (d, h) => new Date(new Date(d).getTime() + h * 3_600_000);

/**
 * En yakın SLA son tarihi. Beklemede, müşteri onayı beklenirken ya da kapanmış siparişte SLA işlemez.
 * @param {{status: string, onHold?: boolean, createdAt: Date|string, drawing?: string, drawingSince?: Date|null, offer?: string|null, offerSince?: Date|null}} p
 * @returns {Date|null}
 */
export function slaDeadline({ status, onHold = false, createdAt, drawing = 'YOK', drawingSince = null, offer = null, offerSince = null }) {
  if (onHold) return null;
  if (status === 'YENI') return addH(createdAt, SLA_HOURS.review);
  if (status !== 'HAZIRLANIYOR') return null;
  const c = [];
  const dh = SLA_HOURS.drawing[drawing];
  if (dh && drawingSince) c.push(addH(drawingSince, dh));
  const oh = SLA_HOURS.offer[offer];
  if (oh && offerSince) c.push(addH(offerSince, oh));
  return c.length ? new Date(Math.min(...c.map((d) => d.getTime()))) : null;
}

/** Son tarihe kalan (ya da geçen) süre. Metni: status.sla.left / status.sla.late ({h} = saat, 1 ondalık). */
export function slaInfo(deadline, now = new Date()) {
  if (!deadline) return null;
  const hours = (new Date(deadline).getTime() - now.getTime()) / 3_600_000;
  const over = hours < 0;
  return { over, risk: !over && hours < 6, hours, h: Math.abs(hours).toFixed(1) };
}

/**
 * CAM siparişinin tahmini yükleme günü — TEK merkezi hesap (yeni siparişin varsayılan tarihi ve formdaki bilgi).
 * Çarşamba başlayıp sonraki Salı (dahil) biten dönemdeki siparişler aynı gruptur; yükleme günü dönemin Çarşambası
 * + 23 gün (Cuma). Ürün sahibinin kesin örnekleri: 30.09–06.10.2026 → 23.10.2026, 07.10–13.10.2026 → 30.10.2026.
 * Gün, işletmenin saat diliminde alınır (gece yarısı sınırı). Saat kaymasın diye gün ortası (12:00 UTC) döner.
 * Kayıtlı tarih tek kaynaktır (Order.estimatedShipDate); satış/yönetici değiştirirse her ekran onu gösterir.
 */
export function glassLoadingDate(from = new Date(), timeZone = 'Europe/Bucharest') {
  const key = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(from);
  const d = new Date(`${key}T12:00:00Z`);
  const sinceWednesday = (d.getUTCDay() - 3 + 7) % 7;
  d.setUTCDate(d.getUTCDate() - sinceWednesday + 23);
  return d;
}

/** "YYYY-MM-DD" → gün ortası UTC tarih; geçersizse null. */
export function parseDateOnly(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return d.getUTCMonth() === Number(m[2]) - 1 ? d : null;
}

/** Satış ve çizim ekibi müşteri adının yalnızca ilk 3 harfini görür. */
export function maskName(name) {
  return String(name || '').slice(0, 3) + '*'.repeat(10);
}
export function canSeeCustomerName(role) {
  return can(role, 'CUSTOMER_NAME_VIEW');
}

// ---------- olay geçmişi ----------
// Metinler: events.<OLAY>.label (iç ekip) ve events.<OLAY>.customer (müşteri).
// customer: müşteri bu olayı görür mü; note: olayın notu müşteriye de gösterilir mi.
export const EVENTS = {
  CREATED: { customer: true },
  SENT_TO_DRAWING: { customer: true },
  NO_DRAWING: { customer: false },
  DRAWING_STARTED: { customer: false },
  DRAWING_DRAFT: { customer: false, note: true },
  DRAWING_UPLOADED: { customer: true, note: true },
  DRAWING_WITHDRAWN: { customer: true, note: true },
  REVISION_REQUESTED: { customer: true, note: true },
  DRAWING_APPROVED: { customer: true, note: true },
  OFFER_SUBMITTED: { customer: false },
  OFFER_RETURNED: { customer: false },
  OFFER_SENT: { customer: true },
  OFFER_REVISED: { customer: false },
  OFFER_UPDATED: { customer: true },
  OFFER_CHECKED: { customer: false },
  UNDO_DRAWING: { customer: true },
  UNDO_NO_DRAWING: { customer: false },
  PRODUCTION: { customer: true },
  SHIPPED: { customer: true },
  ARCHIVED: { customer: true },
  CANCELLED: { customer: true, note: true },
  HOLD: { customer: false },
  UNHOLD: { customer: false },
  CRATES: { customer: false },
  SHIP_DATE: { customer: true, note: true },
  // Profil siparişi (Aşama 6)
  PROFILE_OFFER_SENT: { customer: true },
  PROFILE_APPROVED: { customer: true, note: true },
  PICKUP_UPDATED: { customer: true, note: true },
  PICKUP_MOVED: { customer: true, note: true },
  PROFORMA: { customer: true, note: true },
  PAID: { customer: true, note: true },
  WAREHOUSE_SENT: { customer: true },
  WAREHOUSE_RESENT: { customer: false },
  WAREHOUSE_EMAILED: { customer: false, note: false },
  WAREHOUSE_EMAIL_FAILED: { customer: false },
  DELIVERED: { customer: true },
  INVOICED: { customer: true, note: true },
  // Kırık / telafi camı ve sipariş silme (Aşama 9): yalnızca iç ekip görür
  COMPENSATION: { customer: false },
  COMPENSATION_ADDED: { customer: false },
  COMPENSATION_PENDING: { customer: false },
  COMPENSATION_REJECTED: { customer: false },
  REMOVED: { customer: false },
  RESTORED: { customer: false },
};

// ---------- teklif hesabı ----------
function num(v) {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * "Sandık parası" teklif satırı: adetle fiyatlanan normal bir satır (tür CAM, birim adet). Satış "+ Sandık parası" ile ekler;
 * açıklaması iki dilde tanınır ve kaydedilirken iki dildeki adı yazılır (server/pricing/tables.js → enrichLines).
 * Metin sözlükte de aynıdır (offer.editor.crateLine).
 */
export const CRATE_LINE = { tr: 'Sandık parası', ro: 'Ambalaj (ladă)' };

/** Teklif satırı türleri (metni: status.lineKind.<tür>). */
export const LINE_KINDS = ['CAM', 'CNC', 'DELIK'];
const isSub = (l) => l.kind === 'CNC' || l.kind === 'DELIK';

/**
 * Satırın metrajı (m²) ve tutarı. unit: 'm2' → metraj × fiyat; 'adet' → adet × fiyat.
 * CNC / delik satırları her zaman adet × fiyattır ve metraja girmez. Bedelsiz satırın tutarı 0'dır.
 */
export function offerLineTotals(line) {
  const sub = isSub(line);
  const en = num(line.enMm), boy = num(line.boyMm), adet = Math.max(0, Math.trunc(num(line.adet)));
  const price = line.free ? 0 : num(line.unitPrice);
  const metraj = !sub && en > 0 && boy > 0 ? round2(((en * boy) / 1_000_000) * adet) : 0;
  const amount = sub || line.unit === 'adet' ? round2(adet * price) : round2(metraj * price);
  return { metraj, amount };
}
/** Toplamlar. adet = cam adedi (CNC / delik adetleri ayrı sayılır). */
export function offerTotals(lines) {
  return lines.reduce(
    (acc, l) => {
      const t = offerLineTotals(l);
      const n = Math.max(0, Math.trunc(num(l.adet)));
      acc.metraj = round2(acc.metraj + t.metraj);
      acc.amount = round2(acc.amount + t.amount);
      if (l.kind === 'CNC') acc.cnc += n;
      else if (l.kind === 'DELIK') acc.delik += n;
      else acc.adet += n;
      return acc;
    },
    { metraj: 0, amount: 0, adet: 0, cnc: 0, delik: 0 }
  );
}

/**
 * Satırları müşteri fiyatıyla (offerPrice) değerlendirmek için: tutar ve eksik kontrolü müşteri fiyatı üzerinden yapılır
 * (karar 4: yönetici müşteri fiyatını girer; unitPrice satış fiyatıdır).
 * @template {{ offerPrice?: unknown }} L
 * @param {L[]} lines
 */
export const atOfferPrice = (lines) => lines.map((l) => ({ ...l, unitPrice: l.offerPrice == null ? '' : String(l.offerPrice) }));

/**
 * Müşteriye gidecek teklifte eksikler (boş dizi = tamam): fiyatsız satır (bedelsiz değilse),
 * m² satırında ölçü eksikliği, üstünde cam satırı olmayan CNC / delik satırı.
 * Metne çevirmek için: server/i18n/format.js → formatOfferProblems.
 * Satır: {n: cam satırı sırası, kind: 'CAM' | 'CNC' | 'DELIK'}.
 * @param {{kind?: string, description?: string, enMm?: any, boyMm?: any, unit?: string, unitPrice?: any, free?: boolean}[]} lines
 * @returns {({code: 'no_lines'} | {code: 'sub_without_glass', kind: string} | {code: 'missing_dims', row: {n: number, kind: string}} | {code: 'missing_prices', rows: {n: number, kind: string}[]})[]}
 */
export function offerProblems(lines) {
  if (lines.length === 0) return [{ code: 'no_lines' }];
  /** @type {any[]} */
  const p = [];
  const noPrice = [];
  let glassNo = 0, seenGlass = false;
  for (const l of lines) {
    const sub = isSub(l);
    if (!sub) { glassNo += 1; seenGlass = true; }
    const row = { n: glassNo, kind: sub ? String(l.kind) : 'CAM' };
    if (sub && !seenGlass) p.push({ code: 'sub_without_glass', kind: String(l.kind) });
    if (!sub && l.unit !== 'adet' && (!num(l.enMm) || !num(l.boyMm))) p.push({ code: 'missing_dims', row });
    // Fiyatı eksik satır: camda/üründe açıklaması da yazılır (hangi ürün olduğu görünsün)
    if (!l.free && !(num(l.unitPrice) > 0)) noPrice.push(!sub && l.description ? { ...row, desc: String(l.description).slice(0, 60) } : row);
  }
  if (noPrice.length) p.push({ code: 'missing_prices', rows: noPrice });
  return p;
}

// ---------- dosyalar ----------
/** Uygulama içinde açılabilen (müşterinin görüntüleyicide inceleyebildiği) çizim dosyaları */
export const VIEWABLE_EXT = ['pdf', 'png', 'jpg', 'jpeg'];
export const isViewable = (name) => {
  const n = String(name ?? '').toLowerCase();
  const dot = n.lastIndexOf('.');
  return dot > 0 && VIEWABLE_EXT.includes(n.slice(dot + 1));
};

export const ALLOWED_EXT = ['pdf', 'dwg', 'dxf', 'step', 'stp', 'igs', 'iges', 'xls', 'xlsx', 'doc', 'docx', 'zip', 'jpg', 'jpeg', 'png'];
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/**
 * Dosya sorunu ya da null. Metni: files.problem.<code> ({name}).
 * @param {string} name
 * @param {number} size
 * @returns {{code: 'type' | 'empty' | 'size', name: string} | null}
 */
export function fileProblem(name, size) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (!name || !ALLOWED_EXT.includes(ext ?? '')) return { code: 'type', name: String(name || '') };
  if (!size) return { code: 'empty', name };
  if (size > MAX_FILE_BYTES) return { code: 'size', name };
  return null;
}

// ---------- yetki: kim hangi durumda ne yapabilir ----------
/**
 * Siparişin çizim bayrakları (availableActions için): son sürüm taslak mı, çizim birine atanmış mı.
 * @param {{ assignedDrawerId?: string | null, drawings?: { status: string }[] }} o  sürümler eskiden yeniye sıralı
 */
export function drawingFlags(o) {
  const last = o.drawings?.[o.drawings.length - 1];
  return { draft: last?.status === 'TASLAK', assigned: !!o.assignedDrawerId };
}

/**
 * @param {{role: string, status: string, onHold?: boolean, canApprove?: boolean, drawing?: string, offer?: string|null, draft?: boolean, assigned?: boolean}} p
 *   offer: son teklifin durumu (HAZIRLANIYOR | YONETIMDE | GONDERILDI) ya da null
 *   draft: müşteriye gönderilmemiş (TASLAK) çizim sürümü var · assigned: çizim bir çizimciye atanmış
 * @returns {string[]} yapılabilecek işlemler
 */
export function availableActions({ role, status, onHold = false, canApprove = false, drawing = 'YOK', offer = null, draft = false, assigned = false }) {
  const a = [];
  // Rol adına değil yetkiye bakılır (server/auth/permissions.js). Denetimci hiçbir yetkiye sahip değil → boş liste.
  const sales = can(role, 'ORDER_REVIEW');
  const drawer = can(role, 'DRAWING_WORK');
  const offerWriter = can(role, 'OFFER_PREPARE');
  const admin = can(role, 'OFFER_SEND');
  const closed = CLOSED.includes(status);
  const preparing = status === 'HAZIRLANIYOR';

  if (can(role, 'DRAWING_APPROVE')) {
    // Müşterinin tek onayı çizim onayıdır; teklifi yalnızca görür.
    // Onay ve revizyon aynı yetkiye bağlıdır (karar 84): onay yetkisi olmayan müşteri kullanıcısı ikisini de yapamaz.
    if (preparing && drawing === 'ONAY_BEKLIYOR' && canApprove) a.push('approve_drawing', 'request_revision');
    if (!closed && can(role, 'FILE_UPLOAD')) a.push('add_file');
    return a;
  }

  if (onHold) {
    if (sales) a.push('unhold');
    return a;
  }

  // Teklif henüz satışta (yöneticiye gönderilmedi). Gönderildikten sonra satış hiçbir değişiklik yapamaz.
  const offerAtSales = offer === null || offer === 'HAZIRLANIYOR';

  if (sales && status === 'YENI') a.push('send_to_drawing', 'no_drawing');
  if (preparing && drawing === 'YOK' && (admin || (sales && offerAtSales))) a.push('send_to_drawing');
  if (offerWriter && preparing && offerAtSales) a.push('edit_offer', 'submit_offer');
  if (admin && preparing && offer === 'YONETIMDE') a.push('approve_price', 'return_offer');
  // Müşterideki teklifi yalnızca yönetici günceller (çizim revizyonu ölçüleri değiştirdiyse; üretimdeyken de).
  if (admin && (preparing || status === 'URETIMDE') && offer === 'GONDERILDI') a.push('update_offer');
  // Satış kararını geri alma: teklif hâlâ satıştayken ve çizim müşteriye gitmeden. Sipariş yeniden karar bekler.
  if (sales && preparing && offerAtSales && (drawing === 'GEREKLI' || drawing === 'YAPILIYOR')) a.push('undo_drawing');
  if (sales && preparing && offerAtSales && drawing === 'YOK') a.push('undo_no_drawing');

  // Çizim: dosyalar önce taslak sürüme yüklenir, "Müşteriye gönder" ile müşteriye gider (onaylı ikinci adım).
  // Gönderilen sürüm, müşteri karar vermeden gerekçeyle geri çekilebilir.
  if (drawer && preparing && drawing === 'GEREKLI' && !assigned) a.push('start_drawing');
  if (drawer && preparing && ['GEREKLI', 'YAPILIYOR', 'REVIZYON_ISTENDI'].includes(drawing)) {
    a.push('upload_drawing');
    if (draft) a.push('send_drawing', 'remove_drawing_file');
  }
  if (drawer && preparing && drawing === 'ONAY_BEKLIYOR') a.push('withdraw_drawing');

  if (sales && status === 'URETIMDE') a.push('mark_shipped');
  if (sales && status === 'YUKLENDI') a.push('archive');
  if (sales && !closed) a.push('hold', 'set_ship_date');
  if (can(role, 'ORDER_CANCEL') && !closed) a.push('cancel');
  if (!closed && can(role, 'FILE_UPLOAD')) a.push('add_file');
  return a;
}
