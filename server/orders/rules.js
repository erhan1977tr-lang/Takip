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
  return new Date(lastDrawing.createdAt).getTime() > seen;
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
 * Tahmini yükleme günü: bugünden en az minDays gün sonraki ilk yükleme günü.
 * weekday: 0=Pazar … 5=Cuma. Saat dilimi kaymasın diye gün ortası (12:00 UTC) döner.
 */
export function nextShipDate(from = new Date(), weekday = 5, minDays = 14) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 12));
  d.setUTCDate(d.getUTCDate() + minDays);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
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
  return role === 'ADMIN' || role === 'MUSTERI';
}

// ---------- olay geçmişi ----------
// Metinler: events.<OLAY>.label (iç ekip) ve events.<OLAY>.customer (müşteri).
// customer: müşteri bu olayı görür mü; note: olayın notu müşteriye de gösterilir mi.
export const EVENTS = {
  CREATED: { customer: true },
  SENT_TO_DRAWING: { customer: true },
  NO_DRAWING: { customer: false },
  DRAWING_STARTED: { customer: false },
  DRAWING_UPLOADED: { customer: true, note: true },
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
};

// ---------- teklif hesabı ----------
function num(v) {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

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
    if (!l.free && !(num(l.unitPrice) > 0)) noPrice.push(row);
  }
  if (noPrice.length) p.push({ code: 'missing_prices', rows: noPrice });
  return p;
}

// ---------- dosyalar ----------
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
 * @param {{role: string, status: string, onHold?: boolean, canApprove?: boolean, drawing?: string, offer?: string|null}} p
 *   offer: son teklifin durumu (HAZIRLANIYOR | YONETIMDE | GONDERILDI) ya da null
 * @returns {string[]} yapılabilecek işlemler
 */
export function availableActions({ role, status, onHold = false, canApprove = false, drawing = 'YOK', offer = null }) {
  const a = [];
  const sales = role === 'SATIS' || role === 'ADMIN';
  const drawer = role === 'CIZIM' || role === 'ADMIN';
  const closed = CLOSED.includes(status);
  const preparing = status === 'HAZIRLANIYOR';

  if (role === 'MUSTERI') {
    // Müşterinin tek onayı çizim onayıdır; teklifi yalnızca görür.
    if (preparing && drawing === 'ONAY_BEKLIYOR') {
      if (canApprove) a.push('approve_drawing');
      a.push('request_revision');
    }
    if (!closed) a.push('add_file');
    return a;
  }

  if (onHold) {
    if (sales) a.push('unhold');
    return a;
  }

  const admin = role === 'ADMIN';
  // Teklif henüz satışta (yöneticiye gönderilmedi). Gönderildikten sonra satış hiçbir değişiklik yapamaz.
  const offerAtSales = offer === null || offer === 'HAZIRLANIYOR';

  if (sales && status === 'YENI') a.push('send_to_drawing', 'no_drawing');
  if (preparing && drawing === 'YOK' && (admin || (sales && offerAtSales))) a.push('send_to_drawing');
  if (sales && preparing && offerAtSales) a.push('edit_offer', 'submit_offer');
  if (admin && preparing && offer === 'YONETIMDE') a.push('approve_price', 'return_offer');
  // Müşterideki teklifi yalnızca yönetici günceller (çizim revizyonu ölçüleri değiştirdiyse; üretimdeyken de).
  if (admin && (preparing || status === 'URETIMDE') && offer === 'GONDERILDI') a.push('update_offer');
  // Satış kararını geri alma: teklif hâlâ satıştayken ve çizim müşteriye gitmeden. Sipariş yeniden karar bekler.
  if (sales && preparing && offerAtSales && (drawing === 'GEREKLI' || drawing === 'YAPILIYOR')) a.push('undo_drawing');
  if (sales && preparing && offerAtSales && drawing === 'YOK') a.push('undo_no_drawing');

  if (drawer && preparing && drawing === 'GEREKLI') a.push('start_drawing');
  if (drawer && preparing && (drawing === 'YAPILIYOR' || drawing === 'REVIZYON_ISTENDI')) a.push('upload_drawing');

  if (sales && ['HAZIRLANIYOR', 'URETIMDE', 'YUKLENDI'].includes(status)) a.push('edit_crates');
  if (sales && status === 'URETIMDE') a.push('mark_shipped');
  if (sales && status === 'YUKLENDI') a.push('archive');
  if (sales && !closed) a.push('hold', 'set_ship_date');
  if (role === 'ADMIN' && !closed) a.push('cancel');
  if (!closed) a.push('add_file');
  return a;
}
