// Sipariş iş kuralları — Next.js'ten bağımsız, birim testli.
// Durumlar Prisma şemasındaki OrderStatus ile birebir aynıdır.

export const STATUS = {
  YENI: { label: 'İnceleniyor', customer: 'İnceleniyor', tone: 'muted', next: 'Satış ekibi inceliyor' },
  CIZIM_GEREKLI: { label: 'Çizim gerekli', customer: 'Çizim hazırlanıyor', tone: 'purple', next: 'Çizim hazırlanıyor' },
  CIZIM_YAPILIYOR: { label: 'Çizim yapılıyor', customer: 'Çizim hazırlanıyor', tone: 'purple', next: 'Çizim hazırlanıyor' },
  DXF_DWG_GELDI: { label: 'Hazır çizim geldi', customer: 'Çizim inceleniyor', tone: 'purple', next: 'Çizim inceleniyor' },
  ONAY_BEKLIYOR: { label: 'Çizim onayı bekleniyor', customer: 'Onayınız bekleniyor', tone: 'warn', next: 'Çizimi onaylayın' },
  REVIZYON_ISTENDI: { label: 'Revizyon istendi', customer: 'Revizyon hazırlanıyor', tone: 'danger', next: 'Revize hazırlanıyor' },
  TEKLIF_HAZIRLANIYOR: { label: 'Teklif hazırlanıyor', customer: 'Teklif hazırlanıyor', tone: 'info', next: 'Teklif hazırlanıyor' },
  FIYAT_BEKLIYOR: { label: 'Fiyat onayında', customer: 'Teklif hazırlanıyor', tone: 'warn', next: 'Teklif hazırlanıyor' },
  FIYATLANDI: { label: 'Teklif müşteride', customer: 'Teklifiniz hazır', tone: 'ok', next: 'Teklifi onaylayın' },
  URETIMDE: { label: 'Üretimde', customer: 'Onaylandı, üretimde', tone: 'info', next: 'Üretimde' },
  ESKALASYON: { label: 'Eskalasyon', customer: 'İnceleniyor', tone: 'danger', next: 'İnceleniyor' },
  YUKLENDI: { label: 'Yüklendi', customer: 'Yüklendi', tone: 'ok', next: 'Tamamlandı' },
  ARSIVLENDI: { label: 'Arşivlendi', customer: 'Arşivlendi', tone: 'muted', next: '—' },
  IPTAL: { label: 'İptal', customer: 'İptal', tone: 'muted', next: '—' },
};

export const CLOSED = ['YUKLENDI', 'ARSIVLENDI', 'IPTAL'];
export const DRAWING_STATES = ['CIZIM_GEREKLI', 'CIZIM_YAPILIYOR', 'DXF_DWG_GELDI', 'ONAY_BEKLIYOR', 'REVIZYON_ISTENDI'];
export const OFFER_STATES = ['TEKLIF_HAZIRLANIYOR', 'FIYAT_BEKLIYOR', 'FIYATLANDI'];

export const STAGES = ['Alındı', 'Satış incelemesi', 'Çizim', 'Teklif', 'Üretim', 'Yükleme'];

/** Adım çubuğunda o anki adımın sırası (0 tabanlı). Arşivde tümü tamamlanmış sayılır. */
export function stageIndex(status) {
  if (status === 'YENI' || status === 'ESKALASYON') return 1;
  if (DRAWING_STATES.includes(status)) return 2;
  if (OFFER_STATES.includes(status)) return 3;
  if (status === 'URETIMDE') return 4;
  if (status === 'YUKLENDI') return 5;
  if (status === 'ARSIVLENDI') return STAGES.length;
  return 1;
}

// Her aşamanın SLA süresi (saat). null: SLA yok.
export const SLA_HOURS = {
  YENI: 24,
  CIZIM_GEREKLI: 24,
  CIZIM_YAPILIYOR: 48,
  REVIZYON_ISTENDI: 24,
  TEKLIF_HAZIRLANIYOR: 24,
  FIYAT_BEKLIYOR: 24,
};

export function slaDeadlineFor(status, from = new Date()) {
  const h = SLA_HOURS[status];
  return h ? new Date(from.getTime() + h * 3_600_000) : null;
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
  const s = String(name || '');
  return s.slice(0, 3) + '*'.repeat(10);
}
export function canSeeCustomerName(role) {
  return role === 'ADMIN' || role === 'MUSTERI';
}

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
 * @param {{role: string, status: string, onHold?: boolean, canApprove?: boolean, offerStatus?: string|null}} p
 * @returns {string[]} yapılabilecek işlemler
 */
export function availableActions({ role, status, onHold = false, canApprove = false }) {
  const a = [];
  const sales = role === 'SATIS' || role === 'ADMIN';
  const drawer = role === 'CIZIM' || role === 'ADMIN';
  const closed = CLOSED.includes(status);

  if (role === 'MUSTERI') {
    if (status === 'ONAY_BEKLIYOR') {
      if (canApprove) a.push('approve_drawing');
      a.push('request_revision');
    }
    if (status === 'FIYATLANDI' && canApprove) a.push('accept_offer');
    if (!closed) a.push('add_file');
    return a;
  }

  if (onHold) {
    if (sales) a.push('unhold');
    return a;
  }
  if (sales && status === 'YENI') a.push('send_to_drawing', 'start_offer');
  if (drawer && status === 'CIZIM_GEREKLI') a.push('start_drawing');
  if (drawer && (status === 'CIZIM_YAPILIYOR' || status === 'REVIZYON_ISTENDI')) a.push('upload_drawing');
  if (sales && status === 'TEKLIF_HAZIRLANIYOR') a.push('edit_offer', 'submit_offer');
  if (role === 'ADMIN' && status === 'FIYAT_BEKLIYOR') a.push('approve_price', 'return_offer');
  if (sales && status === 'FIYATLANDI') a.push('mark_production');
  if (sales && status === 'URETIMDE') a.push('mark_shipped');
  if (sales && status === 'YUKLENDI') a.push('archive');
  if (sales && !closed) a.push('hold', 'set_ship_date');
  if (role === 'ADMIN' && !closed) a.push('cancel');
  if (!closed) a.push('add_file');
  return a;
}

/** Sıradaki adım kimde? (detay sayfasındaki "Sıra … tarafında" satırı) */
export function whoseTurn(status, onHold = false) {
  if (onHold) return 'Beklemede';
  if (status === 'YENI' || status === 'TEKLIF_HAZIRLANIYOR' || status === 'URETIMDE') return 'Satış';
  if (['CIZIM_GEREKLI', 'CIZIM_YAPILIYOR', 'REVIZYON_ISTENDI'].includes(status)) return 'Çizim ekibi';
  if (status === 'ONAY_BEKLIYOR' || status === 'FIYATLANDI') return 'Müşteri';
  if (status === 'FIYAT_BEKLIYOR') return 'Sistem yöneticisi';
  return '—';
}
