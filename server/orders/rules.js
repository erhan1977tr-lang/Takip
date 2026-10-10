// Sipariş iş kuralları — Next.js'ten bağımsız, birim testli.
//
// Akış:
//   YENI ──satış karar verir──▶ HAZIRLANIYOR ──otomatik──▶ URETIMDE ─▶ YUKLENDI ─▶ ARSIVLENDI
//   HAZIRLANIYOR içinde iki bağımsız hat vardır:
//     Çizim hattı (drawingTrack): YOK | GEREKLI → YAPILIYOR → ONAY_BEKLIYOR ⇄ REVIZYON_ISTENDI → ONAYLANDI
//       Müşterinin DWG/DXF çizimi (karar 167): GEREKLI → çizimcinin kararı → ONAYLANDI (üretime hazır) |
//       DUZELTME_BEKLIYOR (hatalı: müşteri düzeltilmiş dosya gönderir → GEREKLI ya da fabrika çizimi ister → GEREKLI) |
//       YAPILIYOR (fabrika çizecek) — server/orders/dwg-review.js
//     Teklif hattı (offer.status): HAZIRLANIYOR (satış) → YONETIMDE (yönetici) → GONDERILDI (müşteri görür)
//   Müşteri yalnızca çizimi onaylar; teklifi onaylamaz, sadece görür.
//   Satış kararını (çizime / teklife gönder) teklif satıştayken geri alabilir; teklif yöneticiye gittikten sonra
//   değişikliği yalnızca yönetici yapar. Müşterideki teklifi yönetici her an günceller (yeni sürüm olarak).
//   Otomatik üretim: çizim YOK ya da ONAYLANDI  +  teklif GONDERILDI olunca sipariş kendiliğinden URETIMDE olur
//   (beklemedeki sipariş geçmez; beklemeden çıkarılınca yeniden kontrol edilir). İptal yalnızca yöneticidedir.
//
// Ekranda görünen metinler burada DEĞİL, server/i18n/{tr,ro}/ sözlüklerindedir; buradaki işlevler kod döndürür.
import { can } from '../auth/permissions.js';
import { dwgReview } from './dwg-review.js';


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
  DUZELTME_BEKLIYOR: { tone: 'danger' },
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
    // Çizimci müşterinin DWG/DXF çizimini hatalı buldu: sıra müşteride (düzeltilmiş dosya ya da fabrika çizimi — karar 167)
    if (drawing === 'DUZELTME_BEKLIYOR') return { key: 'correction', tone: 'danger' };
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
  else if (drawing === 'DUZELTME_BEKLIYOR') b.push('drawing_correction');
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
 * İlk çizim (v1) müşterinin dosyasından çizildiği için teklifle aynı kabul edilir. lastDrawing: son ÜRETİM çizimi ve
 * version = üretim çizimleri arasındaki sırası (müşterinin karar bekleyen / hatalı DWG/DXF kaydı sayılmaz; "üretime hazır"
 * kabul edilen müşteri çizimi sayılır — server/orders/dwg-review.js → lastProductionDrawing).
 * @param {{offer?: string|null, sentAt?: Date|string|null, lastDrawing?: {version: number, createdAt: Date|string, sentAt?: Date|string|null}|null, checkedAt?: Date|string|null}} p
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
  // Müşterinin DWG/DXF çizimi (karar 167). "Hatalı" açıklaması müşteriye sipariş sayfasında Romence çevirisiyle gösterilir
  // (geçmiş satırında not yok — çevirisiz Türkçe metin müşterinin geçmişine yazılmaz)
  DWG_READY: { customer: true },
  DWG_FAULTY: { customer: true, note: false },
  DWG_UPDATE: { customer: true },
  DWG_RESUBMITTED: { customer: true },
  DWG_FACTORY_REQUESTED: { customer: true },
  OFFER_SUBMITTED: { customer: false },
  OFFER_RETURNED: { customer: false },
  OFFER_WITHDRAWN: { customer: false }, // satış, yöneticiye gönderdiği teklifi geri aldı (karar 212)
  OFFER_SENT: { customer: true },
  OFFER_REVISED: { customer: false },
  OFFER_UPDATED: { customer: true },
  OFFER_CHECKED: { customer: false },
  UNDO_DRAWING: { customer: true },
  UNDO_NO_DRAWING: { customer: false },
  PRODUCTION: { customer: true },
  SHIPPED: { customer: true },
  // 3.51.0'ın tarihe bakarak verdiği "Yüklendi" (karar 156) fiziksel yükleme kanıtı değildi: 3.51.1'de geri alındı (karar
  // 158); eski satır ve geri alma kaydı yalnızca iç ekibe görünür (müşteriye yanlış "Yüklendi" satırı gösterilmez)
  AUTO_SHIPPED: { customer: false },
  AUTO_SHIP_REVERTED: { customer: false },
  ARCHIVED: { customer: true },
  // Otomatik arşiv (karar 158): fiziksel yüklemesi kanıtlı sipariş, yükleme gününden 45 gün sonra — müşteriye "Arşivlendi"
  AUTO_ARCHIVED: { customer: true },
  CANCELLED: { customer: true, note: true },
  HOLD: { customer: false },
  UNHOLD: { customer: false },
  CRATES: { customer: false },
  SHIP_DATE: { customer: true, note: true },
  // Profil siparişi (Aşama 6)
  PROFILE_OFFER_SENT: { customer: true },
  PROFILE_APPROVED: { customer: true, note: true },
  PROFILE_DIRECT: { customer: true, note: true }, // Paket B (karar 229): fiyat listesiyle doğrudan sipariş (not: alış günü)
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
  // Depo ve teslimat (Paket 8): yöneticinin değiştirdiği teslim günü (not = yeni gün) ve teslimat raporu (not = rapor sürümü)
  DELIVERY_DATE_CHANGED: { customer: true, note: true },
  DELIVERY_REPORT: { customer: true, note: true },
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
 * "Sandık parası" teklif satırı: adetle fiyatlanan normal bir satır (tür CAM, birim adet). Açıklaması iki dilde tanınır ve
 * kaydedilirken iki dildeki adı yazılır (server/pricing/tables.js → enrichLines). Metin sözlükte de aynıdır
 * (offer.editor.crateLine).
 * Sandık bedeli (fonksiyonel paket 4): satırı yalnızca YÖNETİCİ ekler (OfferLine.crateFee); satış teklif tablosunda bu
 * satırı görmez ve ekleyemez (sunucu: server/orders/transitions.js → salesInput). Bu sürümden önce satışın eklediği sandık
 * satırları (crateFee = false) olağan satır olarak kalır.
 */
export const CRATE_LINE = { tr: 'Sandık parası', ro: 'Ambalaj (ladă)' };
const upTr = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLocaleUpperCase('tr-TR');
/** Açıklama sandık parası satırının adı mı (iki dilde; büyük-küçük harf ve boşluk farkı sayılmaz) */
export const isCrateText = (description) => [CRATE_LINE.tr, CRATE_LINE.ro].some((n) => upTr(n) === upTr(description));
/**
 * Sandık parası satırı: sandık parası adlı, adetle fiyatlanan cam türü satır (yöneticinin ya da satışın). Teklif tablosunda
 * bağımsız, numaralı kalemdir; tutarı olağan adetli satır kuralıyla bir kez sayılır: faturada ve yükleme dökümünde camın
 * tutarına eklenir (server/glass/billing.js → glassGroups), proformada ayrı adetli satırdır (ürün sahibinin kararı, karar 214).
 * @param {{ kind?: string | null, unit?: string | null, description?: unknown }} l
 */
export const isCrateLine = (l) => (l.kind ?? 'CAM') === 'CAM' && (l.unit ?? 'm2') === 'adet' && isCrateText(l.description);
/**
 * Satışın sandık parası (karar 211, 214): satışın kendi eklediği, kendisinin gördüğü ve değiştirdiği sandık satırı —
 * yöneticinin sandık satırıyla aynı düzende bağımsız, numaralı teklif kalemi. Yöneticinin sandık bedeli (crateFee) satışa
 * hiç gitmez.
 * @param {{ kind?: string | null, unit?: string | null, description?: unknown, crateFee?: boolean | null }} l
 */
export const isSalesCrate = (l) => !l.crateFee && isCrateLine(l);

/** Teklif satırı türleri (metni: status.lineKind.<tür>). */
export const LINE_KINDS = ['CAM', 'CNC', 'DELIK'];
const isSub = (l) => l.kind === 'CNC' || l.kind === 'DELIK';

const qtyOf = (line) => Math.max(0, Math.trunc(num(line.adet)));
/** Ayrılmış camın kalemdeki sırası (karar 114): satırın ilk camından önceki cam sayısı; olağan satırda 0. */
const pieceBaseOf = (line) => (isSub(line) || line.unit === 'adet' ? 0 : Math.max(0, Math.trunc(num(line.pieceBase))));
/** q adet camın m²'si — yuvarlama TEK yerde: kalemin (toplam adedin) m²'si iki haneye yuvarlanır */
const areaOf = (line, q) => {
  const en = num(line.enMm), boy = num(line.boyMm);
  return !isSub(line) && en > 0 && boy > 0 ? round2(((en * boy) / 1_000_000) * q) : 0;
};
/** Satırın kalemde başladığı m² (ayrılmış camda kendinden önceki camların m²'si; olağan satırda 0). */
export const pieceStartArea = (line) => areaOf(line, pieceBaseOf(line));

/**
 * Satırın metrajı (m²) ve tutarı. unit: 'm2' → metraj × fiyat; 'adet' → adet × fiyat.
 * CNC / delik satırları her zaman adet × fiyattır ve metraja girmez. Bedelsiz satırın tutarı 0'dır.
 *
 * Ayrılmış cam (karar 114): işlem eklemek için adetli satırdan ayrılan camlar aynı ticari kalemin satırlarıdır
 * (pieceBase: satırdan önceki cam sayısı). Kalemin m²'si ve tutarı TOPLAM adetten hesaplanır ve yuvarlanır; satırın payı
 * iki yuvarlanmış ara toplamın farkıdır: m² = m²(önceki + adet) − m²(önceki), tutar = tutar(m² sonu) − tutar(m² başı).
 * Satırların toplamı böylece her zaman kalemin (ayrılmamış satırın) değerine eşittir — satır başına yuvarlama farkı
 * oluşmaz. pieceBase 0 olan (olağan) satırda sonuç eskisiyle aynıdır.
 */
export function offerLineTotals(line) {
  const sub = isSub(line);
  const adet = qtyOf(line);
  const price = line.free ? 0 : num(line.unitPrice);
  const base = pieceBaseOf(line);
  const start = base ? areaOf(line, base) : 0;
  const end = areaOf(line, base + adet);
  const metraj = base ? round2(end - start) : end;
  const amount = sub || line.unit === 'adet' ? round2(adet * price)
    : base ? round2(round2(end * price) - round2(start * price)) : round2(metraj * price);
  return { metraj, amount };
}
/**
 * Toplamlar. adet = cam adedi (CNC / delik adetleri ve sandık ücreti satırlarının adedi ayrı sayılır — sandık cam değildir,
 * karar 211). Tutar her satırda bir kez sayılır.
 */
export function offerTotals(lines) {
  return lines.reduce(
    (acc, l) => {
      const t = offerLineTotals(l);
      const n = qtyOf(l);
      acc.metraj = round2(acc.metraj + t.metraj);
      acc.amount = round2(acc.amount + t.amount);
      if (l.kind === 'CNC') acc.cnc += n;
      else if (l.kind === 'DELIK') acc.delik += n;
      else if (isCrateLine(l)) acc.crate += n;
      else acc.adet += n;
      return acc;
    },
    { metraj: 0, amount: 0, adet: 0, cnc: 0, delik: 0, crate: 0 }
  );
}

/**
 * Teklifi yöneticiye son gönderen kullanıcı (karar 212): "Yöneticiye göndermeyi geri al" yalnızca ona açılır. İşlemin
 * kendisi aynı kuralı veritabanında yeniden denetler (transitions.js → withdraw_offer).
 * @param {{ event: string, userId?: string | null }[]} events  en yeniden eskiye sıralı
 * @returns {string | null}
 */
export const offerSubmitter = (events) => events.find((e) => e.event === 'OFFER_SUBMITTED')?.userId ?? null;

// ---------- İşlem sahipliği (karar 113) ----------
// CNC ve delik TEK bir fiziksel cama aittir: işlem satırı üstündeki cam satırına bağlıdır ve o cam satırının adedi 1
// olmalıdır. "5 cam + 3 delik" gibi bir kayıt hangi camda hangi işlemin olduğunu söylemez; üretim talimatı tahmin edilmez.
// İşlemi olmayan aynı camlar tek satırda, adetle durmaya devam eder (tablo gereksiz yere satırlara bölünmez).

/**
 * İşlem satırı (CNC / delik) taşıdığı hâlde adedi 1'den büyük olan cam satırlarının yerleri (lines içindeki sıra).
 * Boş dizi = her işlem tek bir cama ait.
 * @param {{ kind?: string, adet?: unknown }[]} lines
 * @returns {number[]}
 */
export function sharedOpsGlasses(lines) {
  const bad = [];
  let glass = -1;
  for (const [i, l] of lines.entries()) {
    if (!isSub(l)) { glass = i; continue; }
    if (glass >= 0 && Math.trunc(num(lines[glass].adet)) > 1 && bad[bad.length - 1] !== glass) bad.push(glass);
  }
  return bad;
}

/** Ayrılmış cam grubunun anahtarı geçerli mi (formdan gelir; yalnızca harf, rakam, - ve _) */
export const isSplitKey = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v);
const newSplitKey = () => `g${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;

/**
 * Cam satırından TEK bir camı ayırır (işlem eklenmeden önce): adedi N > 1 ise satır N − 1 olur, hemen altına (varsa
 * kendi alt satırlarının altına) adedi 1 olan aynı cam satırı eklenir. Ayırma yalnızca fiziksel camların gösterimidir:
 * toplam cam adedi ve birim fiyatlar değişmez. Adedi 1 olan satır olduğu gibi kalır.
 * İki satır aynı ticari kalemdir: aynı splitGroup anahtarını taşırlar (karar 114) — m² ve tutar kalemin toplam
 * adedinden hesaplanır (assignPieceBases → offerLineTotals), ayırma toplamı değiştirmez.
 * @template {{ kind?: string, adet?: unknown, splitGroup?: string | null }} L
 * @param {L[]} lines
 * @param {number} index  cam satırının yeri
 * @param {(line: L) => L} [piece]  ayrılan camın satırı (varsayılan: satırın kopyası); adedi burada 1 yapılır
 * @param {() => string} [newKey]  yeni grup anahtarı (test için)
 * @returns {{ lines: L[], index: number, split: boolean }}  index: tek camın satırının yeri (işlem bunun altına eklenir)
 */
export function splitOnePiece(lines, index, piece = (l) => ({ ...l }), newKey = newSplitKey) {
  const l = lines[index];
  const n = l && !isSub(l) ? Math.trunc(num(l.adet)) : 0;
  if (!(n > 1)) return { lines, index, split: false };
  const typed = (v) => (typeof l.adet === 'string' ? String(v) : v);
  let j = index + 1;
  while (j < lines.length && isSub(lines[j])) j++;
  const splitGroup = isSplitKey(l.splitGroup) ? l.splitGroup : newKey();
  const one = { ...piece(l), adet: typed(1), splitGroup };
  return { lines: [...lines.slice(0, index), { ...l, adet: typed(n - 1), splitGroup }, ...lines.slice(index + 1, j), one, ...lines.slice(j)], index: j, split: true };
}

/**
 * Ayrılmış cam gruplarının sırasını (pieceBase) hesaplar — her teklif kaydında sunucuda ve ekranda aynı işlev (karar 114).
 * Grup: aynı splitGroup anahtarını taşıyan, AYNI cam (açıklama), aynı ölçü, m² birimli cam satırları; sırayla
 * pieceBase = gruptaki önceki satırların adet toplamı. Gruba uymayan (camı / ölçüsü farklılaşmış) ya da tek kalan satır
 * olağan satırdır: anahtarı ve sırası sıfırlanır. Fiyat gruba üyelik koşulu değildir (m² geometridir); tutar her satırın
 * kendi fiyatıyla hesaplanır.
 * @template {{ kind?: string, unit?: string, description?: unknown, enMm?: unknown, boyMm?: unknown, adet?: unknown, splitGroup?: string | null }} L
 * @param {L[]} lines
 * @returns {(L & { splitGroup: string | null, pieceBase: number })[]}
 */
export function assignPieceBases(lines) {
  const out = lines.map((l) => ({ ...l, splitGroup: null, pieceBase: 0 }));
  const groups = new Map();
  for (const [i, l] of lines.entries()) {
    if (isSub(l) || (l.unit ?? 'm2') !== 'm2' || !isSplitKey(l.splitGroup) || !(num(l.enMm) > 0 && num(l.boyMm) > 0)) continue;
    const g = groups.get(l.splitGroup);
    if (!g) groups.set(l.splitGroup, [i]);
    else {
      const ref = lines[g[0]];
      if (String(ref.description ?? '') === String(l.description ?? '') && num(ref.enMm) === num(l.enMm) && num(ref.boyMm) === num(l.boyMm)) g.push(i);
    }
  }
  for (const [key, idx] of groups) {
    if (idx.length < 2) continue;
    let base = 0;
    for (const i of idx) {
      out[i].splitGroup = key;
      out[i].pieceBase = base;
      base += qtyOf(lines[i]);
    }
  }
  return out;
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
 * m² satırında ölçü eksikliği, üstünde cam satırı olmayan CNC / delik satırı, adedi 1'den büyük cama bağlı işlem
 * (ops_multi_glass — karar 113: CNC / delik tek bir cama aittir).
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
  const shared = [];
  let glassNo = 0, seenGlass = false, glass = null;
  for (const l of lines) {
    const sub = isSub(l);
    if (!sub) { glassNo += 1; seenGlass = true; glass = { row: { n: glassNo, kind: 'CAM', ...(l.description ? { desc: String(l.description).slice(0, 60) } : {}) }, many: Math.trunc(num(l.adet)) > 1, done: false }; }
    // İşlem satırı adedi 1'den büyük cama bağlı: hangi camda olduğu belli değil
    if (sub && glass?.many && !glass.done) { glass.done = true; shared.push(glass.row); }
    const row = { n: glassNo, kind: sub ? String(l.kind) : 'CAM' };
    if (sub && !seenGlass) p.push({ code: 'sub_without_glass', kind: String(l.kind) });
    if (!sub && l.unit !== 'adet' && (!num(l.enMm) || !num(l.boyMm))) p.push({ code: 'missing_dims', row });
    // Fiyatı eksik satır: camda/üründe açıklaması da yazılır (hangi ürün olduğu görünsün)
    if (!l.free && !(num(l.unitPrice) > 0)) noPrice.push(!sub && l.description ? { ...row, desc: String(l.description).slice(0, 60) } : row);
  }
  if (noPrice.length) p.push({ code: 'missing_prices', rows: noPrice });
  if (shared.length) p.push({ code: 'ops_multi_glass', rows: shared });
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
 * Siparişin çizim bayrakları (availableActions için): son sürüm taslak mı, çizim birine atanmış mı, müşterinin DWG/DXF
 * çizimi için çizimci kararı bekleniyor mu (karar 167 — server/orders/dwg-review.js; müşteri dosyaları verilmezse hayır).
 * @param {{ status?: string, drawingTrack?: string | null, onHold?: boolean, assignedDrawerId?: string | null,
 *   drawings?: { status: string, source?: string | null }[], files?: { name: string, kind?: string | null, scanStatus?: string | null }[] }} o
 *   sürümler eskiden yeniye sıralı
 */
export function drawingFlags(o) {
  const last = o.drawings?.[o.drawings.length - 1];
  const dwgPending = o.status != null && Array.isArray(o.files) ? dwgReview({ status: o.status, drawingTrack: o.drawingTrack, onHold: o.onHold, files: o.files, drawings: o.drawings ?? [] }).pending : false;
  return { draft: last?.status === 'TASLAK', assigned: !!o.assignedDrawerId, dwgPending };
}

/**
 * @param {{role: string, status: string, onHold?: boolean, canApprove?: boolean, drawing?: string, offer?: string|null, draft?: boolean, assigned?: boolean, dwgPending?: boolean, orderType?: string|null}} p
 *   offer: son teklifin durumu (HAZIRLANIYOR | YONETIMDE | GONDERILDI) ya da null
 *   draft: müşteriye gönderilmemiş (TASLAK) çizim sürümü var · assigned: çizim bir çizimciye atanmış
 *   dwgPending: müşterinin DWG/DXF çizimi için çizimci kararı bekleniyor (karar 167 — drawingFlags)
 *   orderType: siparişin tipi (GLASS_ORDER | PROFILE_ORDER); verilmezse cam siparişi kuralları
 * @returns {string[]} yapılabilecek işlemler
 */
export function availableActions({ role, status, onHold = false, canApprove = false, drawing = 'YOK', offer = null, draft = false, assigned = false, dwgPending = false, orderType = null }) {
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
    // Çizimci müşterinin DWG/DXF çizimini hatalı buldu (karar 167): düzeltilmiş dosya gönder ya da fabrikadan çizim iste.
    // Çizim kararı olduğu için onay ve revizyonla AYNI yetkiyi ister (onay yetkisi olmayan kullanıcı yalnızca görür).
    if (preparing && drawing === 'DUZELTME_BEKLIYOR' && canApprove) a.push('dwg_resubmit', 'dwg_request_drawing');
    // Profil siparişinde müşteri dosya yüklemez (karar 161): ürün ve adet formdadır; ekranda yükleme alanı yok, sunucu da
    // (addFilesAction → bu liste) reddeder. İç ekibin profil siparişine iç dosya eklemesi değişmedi.
    if (!closed && can(role, 'FILE_UPLOAD') && orderType !== 'PROFILE_ORDER') a.push('add_file');
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
  // Satış, yöneticiye gönderdiği teklifi yönetici fiyatlandırıp müşteriye göndermeden geri alabilir (karar 212). Teklifi
  // gönderenin kendisi olması ve aynı anda yöneticinin işlemi işlemin kendisinde denetlenir (transitions.js → withdraw_offer).
  if (offerWriter && !admin && preparing && offer === 'YONETIMDE') a.push('withdraw_offer');
  // Müşterideki teklifi yalnızca yönetici günceller (yeni sürüm — eski sürüm kalır): hazırlanırken, üretimde ve yüklendi
  // olarak işaretlenmiş siparişte (Paket 4: "her zaman"). Mali kilit (FGO belgesi, müşteri belgesi kapsamı, bekleyen belge
  // isteği, onaylı yükleme) işlemin kendisinde denetlenir: server/orders/financial-lock.js → update_offer.
  if (admin && (preparing || status === 'URETIMDE' || status === 'YUKLENDI') && offer === 'GONDERILDI') a.push('update_offer');
  // Satış kararını geri alma: teklif hâlâ satıştayken ve çizim müşteriye gitmeden. Sipariş yeniden karar bekler.
  if (sales && preparing && offerAtSales && (drawing === 'GEREKLI' || drawing === 'YAPILIYOR')) a.push('undo_drawing');
  if (sales && preparing && offerAtSales && drawing === 'YOK') a.push('undo_no_drawing');

  // Çizim: dosyalar önce taslak sürüme yüklenir, "Müşteriye gönder" ile müşteriye gider (onaylı ikinci adım).
  // Gönderilen sürüm, müşteri karar vermeden gerekçeyle geri çekilebilir.
  if (drawer && preparing && drawing === 'GEREKLI' && !assigned) a.push('start_drawing');
  // Müşterinin DWG/DXF çizimi (karar 167): önce üç karardan biri — karar verilmeden sürüm yüklenemez. Müşterinin
  // düzeltmesi beklenirken de çizimci "Çizimi Güncelle" ile çizimi fabrikaya alabilir.
  if (drawer && preparing && dwgPending) a.push('dwg_ready', 'dwg_faulty', 'dwg_update');
  if (drawer && preparing && drawing === 'DUZELTME_BEKLIYOR') a.push('dwg_update');
  if (drawer && preparing && !dwgPending && ['GEREKLI', 'YAPILIYOR', 'REVIZYON_ISTENDI'].includes(drawing)) {
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

// ---------- teklif tablosu: "Tek fiyatı tüm satırlara uygula" ----------
/** Tek fiyatın uygulandığı satır türü: m² ile fiyatlanan cam. CNC, delik ve adetle fiyatlanan satırlar (sandık parası vb.) değildir. */
export const isM2Glass = (l) => l.kind === 'CAM' && l.unit === 'm2';

/**
 * Teklif tablosunda bir satırın fiyat alanını yazar (yalnızca ekrandaki düzenleme; kayıtta sunucu her satırı yine tek tek
 * doğrular). all = "Tek fiyatı tüm satırlara uygula" işaretli: fiyat bir m² cam satırına yazıldıysa bedelsiz OLMAYAN bütün
 * m² cam satırlarına da yazılır. CNC, delik, adetli satırlar ve bedelsiz satırlar değişmez; öbür fiyat alanına dokunulmaz.
 * Satış kendi fiyatını (unitPrice), yönetici müşteri fiyatını (offerPrice) yazar — aynı kural, tek işlev.
 * @template {{ key: number, kind: string, unit: string, free: boolean }} L
 * @param {L[]} lines
 * @param {number} key                         fiyatın yazıldığı satır
 * @param {'unitPrice' | 'offerPrice'} field
 * @param {string} value
 * @param {boolean} [all]
 * @returns {L[]}
 */
export function applyLinePrice(lines, key, field, value, all = false) {
  const target = lines.find((l) => l.key === key);
  const spread = all && !!target && isM2Glass(target);
  return lines.map((l) => (l.key === key || (spread && isM2Glass(l) && !l.free) ? { ...l, [field]: value } : l));
}
