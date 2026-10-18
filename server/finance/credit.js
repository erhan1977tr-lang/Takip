// Müşteri fazla ödemesi ve TAKİP içi mahsup — saf kurallar (DÜZELTME 10 Aşama 2C, karar 295). Veritabanı tarafı:
// server/finance/credit-service.js. Tüm tutarlar RON kuruş (BigInt) olarak hesaplanır; ekrana sayı olarak döner.
//
// Tek hesap `creditLedger`: müşterinin ödeme zincirleri (sipariş başına proforma zinciri ya da müşteri proforması partisi) ×
// mahsup kayıtları →
//   - zincir başına fazla ödeme = paymentState().overpaid (max(FGO, elle) − proforma toplamı; avans proforma toplamını aşmaz,
//     karar 295) — yeni bir ödeme hesabı YAZILMAZ
//   - çıkan mahsup (kaynak) / gelen mahsup (hedef) = yalnızca ACTIVE kayıtlar; REVERSED hiç sayılmaz, FGO_RECORDED artık FGO'nun
//     rakamlarındadır (zincirin tahsilatına FGO üzerinden girdi) → iki kez sayılmasın diye mahsup olarak sayılmaz
//   - kullanılabilir bakiye = Σ max(0, fazla − çıkan) (iptal edilmiş sipariş zinciri hariç — o tahsilat ayrı incelemededir)
//   - açık tutar (hedef olabilirlik) = proforma toplamı − tahsilat dayanağı − gelen mahsup
// Mahsup avans faturası dayanağını DEĞİŞTİRMEZ (paymentState'e girmez): TAKİP içi bakiye gerçek bir FGO tahsilatı gibi
// davranmaz, avans / fatura doğurmaz. Muhasebeci FGO'ya işleyince yönetici kaydı "FGO'ya işlendi" yapar.
import { centsNum, toCents } from './payments.js';

export const OFFSET_NOTE_MAX = 500;
export const OFFSET_REASON_MAX = 500;
export const OFFSET_MAX_RON = 10_000_000;
export const OFFSET_STATUSES = Object.freeze(['ACTIVE', 'REVERSED', 'FGO_RECORDED']);
const ACTIVE = 'ACTIVE';

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max + 1);

/**
 * Mahsup formu: tutar (RON, > 0, en çok 2 ondalık), gerekçe / not (zorunlu), açık onay kutusu (kural 5).
 * @returns {{ ok: true, value: { cents: bigint, note: string } } | { ok: false, code: string }}
 */
export function parseOffset({ amount, note, confirm }) {
  if (confirm !== true && confirm !== 'on' && confirm !== '1' && confirm !== 'true') return { ok: false, code: 'CONFIRM_REQUIRED' };
  const raw = String(amount ?? '').trim().replace(/\s+/g, '').replace(',', '.');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(raw)) return { ok: false, code: 'AMOUNT' };
  const cents = toCents(raw);
  if (cents <= 0n || cents > BigInt(OFFSET_MAX_RON) * 100n) return { ok: false, code: 'AMOUNT' };
  const n = clean(note, OFFSET_NOTE_MAX);
  if (!n) return { ok: false, code: 'NOTE' };
  if (n.length > OFFSET_NOTE_MAX) return { ok: false, code: 'TOO_LONG' };
  return { ok: true, value: { cents, note: n } };
}

export const FGO_REF_MAX = 60;

/**
 * Kapatma formu: gerekçe zorunlu + açık onay. FGO_RECORDED = muhasebecinin MANUEL beyanı: FGO belge / tahsilat referansı
 * zorunlu (en çok 60, harf / rakam / boşluk / - / . /), TAKİP bu referansı FGO'da doğrulamaz. REVERSED'da referans alınmaz.
 * @param {{ reason: unknown, confirm: unknown, fgoRef?: unknown }} v  @param {'REVERSED' | 'FGO_RECORDED'} mode
 */
export function parseClose({ reason, confirm, fgoRef }, mode = 'REVERSED') {
  if (confirm !== true && confirm !== 'on' && confirm !== '1' && confirm !== 'true') return { ok: false, code: 'CONFIRM_REQUIRED' };
  const r = clean(reason, OFFSET_REASON_MAX);
  if (!r) return { ok: false, code: 'REASON' };
  if (r.length > OFFSET_REASON_MAX) return { ok: false, code: 'TOO_LONG' };
  if (mode !== 'FGO_RECORDED') return { ok: true, value: { reason: r, fgoRef: null } };
  const ref = clean(fgoRef, FGO_REF_MAX);
  if (!ref) return { ok: false, code: 'FGO_REF' };
  if (ref.length > FGO_REF_MAX || !/^[\p{L}\p{N}][\p{L}\p{N} ./-]*$/u.test(ref)) return { ok: false, code: 'FGO_REF' };
  return { ok: true, value: { reason: r, fgoRef: ref } };
}

/**
 * @typedef {{ key: string, ref: string | null, orderIds: string[], orderNos: string[], cancelled: boolean,
 *   total: unknown, fgoPaid: unknown, manualRon: unknown, basis: unknown, advanced: unknown, overpaid: unknown }} ChainIn
 * @typedef {{ id: string, sourceChain: string, targetChain: string, amountRon: unknown, status: string }} OffsetIn
 */

/**
 * Müşteri bakiyesi (tek hesap). Zincir sırası korunur.
 * @param {ChainIn[]} chains  @param {OffsetIn[]} offsets
 */
export function creditLedger(chains, offsets) {
  const out = new Map();
  const into = new Map();
  for (const o of offsets) {
    if (o.status !== ACTIVE) continue;
    const c = toCents(o.amountRon);
    out.set(o.sourceChain, (out.get(o.sourceChain) ?? 0n) + c);
    into.set(o.targetChain, (into.get(o.targetChain) ?? 0n) + c);
  }
  let available = 0n;
  let overpaid = 0n;
  let paid = 0n;
  let offset = 0n;
  let cancelledPaid = 0n;
  const review = [];
  const rows = chains.map((ch) => {
    const over = toCents(ch.overpaid ?? 0);
    const basis = toCents(ch.basis ?? 0);
    const o = out.get(ch.key) ?? 0n;
    const i = into.get(ch.key) ?? 0n;
    const remaining = over - o;
    const total = ch.total == null ? null : toCents(ch.total);
    const open = total == null ? null : total - basis - i;
    paid += basis;
    offset += o;
    if (ch.cancelled) {
      cancelledPaid += basis;
      if (basis > 0n) review.push({ code: 'CANCELLED_PAID', chain: ch.key });
    } else {
      overpaid += over;
      if (remaining > 0n) available += remaining;
    }
    // Kaynağın fazla ödemesi sonradan azaldı (elle kayıt geçersiz kılındı, FGO tahsilatı düştü): çıkan mahsup fazlayı aşıyor
    if (remaining < 0n) review.push({ code: 'OFFSET_EXCEEDS_SOURCE', chain: ch.key });
    // Hedefin açık tutarı gelen mahsupla eksiye düştü (hedefe sonradan ödeme geldi): mahsup fazla
    if (open != null && open < 0n && i > 0n) review.push({ code: 'OFFSET_EXCEEDS_TARGET', chain: ch.key });
    return {
      key: ch.key, ref: ch.ref, orderIds: ch.orderIds, orderNos: ch.orderNos, cancelled: ch.cancelled,
      total: total == null ? null : centsNum(total), basis: centsNum(basis), fgoPaid: centsNum(toCents(ch.fgoPaid ?? 0)), manualRon: centsNum(toCents(ch.manualRon ?? 0)),
      advanced: centsNum(toCents(ch.advanced ?? 0)), overpaid: centsNum(over), offsetOut: centsNum(o), offsetIn: centsNum(i),
      remaining: centsNum(remaining), open: open == null ? null : centsNum(open),
      // Kaynak olabilir: iptal edilmemiş, kalan fazla > 0 · hedef olabilir: iptal edilmemiş, proforma toplamı bilinir, açık > 0
      canSource: !ch.cancelled && remaining > 0n,
      canTarget: !ch.cancelled && open != null && open > 0n,
    };
  });
  // Kayıtlı ama artık zinciri listede olmayan mahsup (kaynak / hedef proforma FGO'da silindi, sipariş başka zincire geçti)
  const known = new Set(chains.map((c) => c.key));
  for (const o of offsets) {
    if (o.status !== ACTIVE) continue;
    if (!known.has(o.sourceChain) || !known.has(o.targetChain)) review.push({ code: 'OFFSET_CHAIN_GONE', offset: o.id });
  }
  return {
    rows,
    totals: { paid: centsNum(paid), overpaid: centsNum(overpaid), offset: centsNum(offset), available: centsNum(available), cancelledPaid: centsNum(cancelledPaid) },
    review,
  };
}

/**
 * Yeni mahsubun sınırları (kilit altında, güncel deftere göre): kaynak ≠ hedef, kaynak kalan fazla ≥ tutar, hedef açık ≥ tutar.
 * @param {ReturnType<typeof creditLedger>} ledger  @param {{ sourceChain: string, targetChain: string, cents: bigint }} p
 * @returns {{ ok: true } | { ok: false, code: string }}
 */
export function offsetCheck(ledger, { sourceChain, targetChain, cents }) {
  if (sourceChain === targetChain) return { ok: false, code: 'SAME_CHAIN' };
  const src = ledger.rows.find((r) => r.key === sourceChain);
  if (!src) return { ok: false, code: 'SOURCE_GONE' };
  if (src.cancelled) return { ok: false, code: 'SOURCE_CANCELLED' };
  if (toCents(src.remaining) < cents) return { ok: false, code: 'OVER_SOURCE' };
  const dst = ledger.rows.find((r) => r.key === targetChain);
  if (!dst) return { ok: false, code: 'TARGET_NO_PROFORMA' };
  if (dst.cancelled) return { ok: false, code: 'TARGET_CANCELLED' };
  if (dst.open == null) return { ok: false, code: 'TARGET_NO_PROFORMA' };
  if (toCents(dst.open) < cents) return { ok: false, code: 'OVER_TARGET' };
  return { ok: true };
}
