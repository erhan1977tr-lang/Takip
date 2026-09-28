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

export const ORDER_STATUS = {
  YENI: { label: 'İnceleniyor', tone: 'muted' },
  HAZIRLANIYOR: { label: 'Hazırlanıyor', tone: 'info' },
  URETIMDE: { label: 'Üretimde', tone: 'info' },
  YUKLENDI: { label: 'Yüklendi', tone: 'ok' },
  ARSIVLENDI: { label: 'Arşivlendi', tone: 'muted' },
  IPTAL: { label: 'İptal', tone: 'muted' },
};

export const DRAWING = {
  YOK: { label: 'Çizimsiz', tone: 'muted' },
  GEREKLI: { label: 'Çizim bekliyor', tone: 'purple' },
  YAPILIYOR: { label: 'Çizim yapılıyor', tone: 'purple' },
  ONAY_BEKLIYOR: { label: 'Müşteri onayında', tone: 'warn' },
  REVIZYON_ISTENDI: { label: 'Revizyon istendi', tone: 'danger' },
  ONAYLANDI: { label: 'Çizim onaylandı', tone: 'ok' },
};

export const OFFER = {
  NONE: { label: 'Teklif yok', tone: 'muted' },
  HAZIRLANIYOR: { label: 'Teklif satışta', tone: 'info' },
  YONETIMDE: { label: 'Fiyat onayında', tone: 'warn' },
  GONDERILDI: { label: 'Teklif müşteride', tone: 'ok' },
};

export const CLOSED = ['YUKLENDI', 'ARSIVLENDI', 'IPTAL'];
export const ACTIVE_DRAWING = ['GEREKLI', 'YAPILIYOR', 'REVIZYON_ISTENDI'];

/**
 * Müşterinin gördüğü tek satırlık durum ve sıradaki adım.
 * @param {{status: string, drawing?: string, offer?: string|null}} p
 * @returns {{label: string, tone: string, next: string}}
 */
export function customerSummary({ status, drawing = 'YOK', offer = null }) {
  if (status === 'YENI') return { label: 'İnceleniyor', tone: 'muted', next: 'Satış ekibi inceliyor' };
  if (status === 'HAZIRLANIYOR') {
    if (drawing === 'ONAY_BEKLIYOR') return { label: 'Onayınız bekleniyor', tone: 'warn', next: 'Çizimi onaylayın' };
    if (drawing === 'REVIZYON_ISTENDI') return { label: 'Revizyon hazırlanıyor', tone: 'danger', next: 'Revize çizim hazırlanıyor' };
    if (drawing === 'GEREKLI' || drawing === 'YAPILIYOR') return { label: 'Çizim hazırlanıyor', tone: 'purple', next: 'Çizim hazırlanıyor' };
    if (offer === 'GONDERILDI') return { label: 'Teklifiniz hazır', tone: 'ok', next: 'Üretim planlanıyor' };
    return { label: 'Hazırlanıyor', tone: 'info', next: 'Teklif hazırlanıyor' };
  }
  if (status === 'URETIMDE') return { label: 'Onaylandı, üretimde', tone: 'info', next: 'Üretimde' };
  if (status === 'YUKLENDI') return { label: 'Yüklendi', tone: 'ok', next: 'Tamamlandı' };
  if (status === 'ARSIVLENDI') return { label: 'Arşivlendi', tone: 'muted', next: '—' };
  return { label: 'İptal', tone: 'muted', next: '—' };
}

/**
 * Müşteriye gösterilen çizim hattı durumu.
 * @param {string} drawing
 * @returns {string}
 */
export function customerDrawingLabel(drawing) {
  return {
    YOK: 'Gerekmiyor', GEREKLI: 'Hazırlanıyor', YAPILIYOR: 'Hazırlanıyor',
    ONAY_BEKLIYOR: 'Onayınız bekleniyor', REVIZYON_ISTENDI: 'Revizyon hazırlanıyor', ONAYLANDI: 'Onaylandı',
  }[drawing] ?? drawing;
}

/**
 * Otomatik üretime geçmek için eksik kalanlar (boş dizi = koşullar tamam).
 * @param {{status: string, drawing?: string, offer?: string|null}} p
 * @returns {string[]}
 */
export function productionBlockers({ status, drawing = 'YOK', offer = null }) {
  if (status !== 'HAZIRLANIYOR') return ['Sipariş hazırlık aşamasında değil'];
  const b = [];
  if (drawing === 'ONAY_BEKLIYOR') b.push('Çizim müşteri onayında');
  else if (drawing !== 'YOK' && drawing !== 'ONAYLANDI') b.push('Çizim henüz tamamlanmadı');
  if (offer !== 'GONDERILDI') b.push(offer === 'YONETIMDE' ? 'Teklif yönetici onayında' : 'Teklif henüz müşteriye gönderilmedi');
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

export const STAGES =['Alındı', 'Satış incelemesi', 'Çizim ve teklif', 'Üretim', 'Yükleme'];

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

/** "15.0 sa kaldı" / "38.1 sa gecikme" */
export function slaInfo(deadline, now = new Date()) {
  if (!deadline) return null;
  const hours = (new Date(deadline).getTime() - now.getTime()) / 3_600_000;
  const over = hours < 0;
  return { over, risk: !over && hours < 6, hours, text: `${Math.abs(hours).toFixed(1)} sa ${over ? 'gecikme' : 'kaldı'}` };
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
// customer: müşterinin gördüğü metin (null → müşteri görmez); note: notu müşteriye de göster
export const EVENTS = {
  CREATED: { label: 'Sipariş gönderildi', customer: 'Sipariş gönderildi' },
  SENT_TO_DRAWING: { label: 'Çizim ekibine yönlendirildi', customer: 'Çizim hazırlanıyor' },
  NO_DRAWING: { label: 'Çizim gerekmedi, teklife geçildi', customer: null },
  DRAWING_STARTED: { label: 'Çizim üstlenildi', customer: null },
  DRAWING_UPLOADED: { label: 'Çizim müşteri onayına gönderildi', customer: 'Çizim onayınıza sunuldu', note: true },
  REVISION_REQUESTED: { label: 'Müşteri revizyon istedi', customer: 'Revizyon istendi', note: true },
  DRAWING_APPROVED: { label: 'Çizim müşteri tarafından onaylandı', customer: 'Çizim onaylandı', note: true },
  OFFER_SUBMITTED: { label: 'Teklif yönetici onayına gönderildi', customer: null },
  OFFER_RETURNED: { label: 'Teklif satışa geri gönderildi', customer: null },
  OFFER_SENT: { label: 'Fiyat onaylandı, teklif müşteriye gönderildi', customer: 'Teklifiniz hazır' },
  OFFER_REVISED: { label: 'Teklif revize ediliyor', customer: null },
  OFFER_UPDATED: { label: 'Teklif yönetici tarafından güncellendi', customer: 'Teklifiniz güncellendi' },
  OFFER_CHECKED: { label: 'Yönetici teklifi yeni çizime göre kontrol etti, değişiklik yok', customer: null },
  UNDO_DRAWING: { label: 'Çizime gönderme geri alındı', customer: 'Sipariş yeniden inceleniyor' },
  UNDO_NO_DRAWING: { label: 'Teklife gönderme geri alındı', customer: null },
  PRODUCTION: { label: 'Otomatik olarak üretime alındı', customer: 'Üretime alındı' },
  SHIPPED: { label: 'Yüklendi', customer: 'Yüklendi' },
  ARCHIVED: { label: 'Arşivlendi', customer: 'Arşivlendi' },
  CANCELLED: { label: 'İptal edildi', customer: 'İptal edildi', note: true },
  HOLD: { label: 'Beklemeye alındı', customer: null },
  UNHOLD: { label: 'Beklemeden çıkarıldı', customer: null },
  SHIP_DATE: { label: 'Tahmini yükleme tarihi değişti', customer: 'Tahmini yükleme tarihi güncellendi', note: true },
};

// ---------- teklif hesabı ----------
function num(v) {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Satırın metrajı (m²) ve tutarı. unit: 'm2' → metraj × fiyat; 'adet' → adet × fiyat. */
export function offerLineTotals(line) {
  const en = num(line.enMm), boy = num(line.boyMm), adet = Math.max(0, Math.trunc(num(line.adet)));
  const price = num(line.unitPrice);
  const metraj = en > 0 && boy > 0 ? round2(((en * boy) / 1_000_000) * adet) : 0;
  const amount = line.unit === 'adet' ? round2(adet * price) : round2(metraj * price);
  return { metraj, amount };
}
export function offerTotals(lines) {
  return lines.reduce(
    (acc, l) => {
      const t = offerLineTotals(l);
      acc.metraj = round2(acc.metraj + t.metraj);
      acc.amount = round2(acc.amount + t.amount);
      acc.adet += Math.max(0, Math.trunc(num(l.adet)));
      return acc;
    },
    { metraj: 0, amount: 0, adet: 0 }
  );
}

// ---------- dosyalar ----------
export const ALLOWED_EXT = ['pdf', 'dwg', 'dxf', 'step', 'stp', 'igs', 'iges', 'xls', 'xlsx', 'doc', 'docx', 'zip', 'jpg', 'jpeg', 'png'];
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** Hata metni ya da null. */
export function fileProblem(name, size) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (!name || !ALLOWED_EXT.includes(ext)) return `“${name}” desteklenmeyen dosya türü.`;
  if (!size) return `“${name}” boş.`;
  if (size > MAX_FILE_BYTES) return `“${name}” 100 MB sınırını aşıyor.`;
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

  if (sales && status === 'URETIMDE') a.push('mark_shipped');
  if (sales && status === 'YUKLENDI') a.push('archive');
  if (sales && !closed) a.push('hold', 'set_ship_date');
  if (role === 'ADMIN' && !closed) a.push('cancel');
  if (!closed) a.push('add_file');
  return a;
}
