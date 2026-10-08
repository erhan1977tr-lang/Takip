'use server';

// Müşterinin profil siparişi formu: metraj hesaplayıcısı ve gönderim öncesi stok uyarısı (Paket 5, karar 175–177).
// İkisi de yalnızca okur — sipariş, kayıt, "Önemli kararlar" yazmaz (stok yetersizliği kaydı siparişle birlikte, bir kez:
// server/profile/create.js → recordStockShortage). Kural server/profile/calculator.js + calc-service.js + stock.js'te.
// Stok değeri yalnızca formdaki (müşterinin kendi siparişindeki) ve stoğu yetmeyen ürünler için döner; genel stok listesi
// müşteriye hiç gitmez. Hız sınırı: server/profile/limits.js.
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT } from '@/lib/i18n';
import { fmtDec } from '@/lib/format';
import { calcErrorText } from '@/lib/profile-calc';
import { runCalc } from '@/server/profile/calc-service.js';
import { customerShortages } from '@/server/profile/stock.js';
import { MAX_PROFILE_LINES, readQuantities } from '@/server/profile/rules.js';
import { localName, unitLabel } from '@/server/profile/catalog.js';
import { profileCalcLimits } from '@/server/profile/limits.js';

export type CalcLine = {
  productId: string; code: string; name: string; unit: string; qty: number; need: string;
  stock: { needed: number; available: number; missing: number } | null;
};
export type CalcResult = { ok: true; title: string; lines: CalcLine[] } | { ok: false; errors: string[] };
export type StockCheckLine = { productId: string; code: string; name: string; unit: string; needed: number; available: number; missing: number };

/** İstemciden gelen değer: yalnızca kısa metin (başka tür / uzun metin boş sayılır) */
const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : '');

/** Hesapla: sistem + renk + cam kalınlığı + toplam metre → ürün başına miktar (forma aktarılmak üzere). */
export async function calculateProfileAction(input: { systemId?: unknown; color?: unknown; thicknessId?: unknown; meters?: unknown }): Promise<CalcResult> {
  const user = await requirePermission('ORDER_CREATE');
  const { t, locale } = await getT();
  if (!user.customer || user.customer.type !== 'CUSTOMER') return { ok: false, errors: [t('newOrder.errors.noFirm')] };
  if (!profileCalcLimits.calc(user.id)) return { ok: false, errors: [t('profile.calc.rateLimit')] };
  const res = await runCalc(db, {
    systemId: str(input?.systemId, 64), color: str(input?.color, 20), thicknessId: str(input?.thicknessId, 64), meters: str(input?.meters, 32),
  });
  const system = res.system?.code ?? '';
  if (!res.ok) return { ok: false, errors: res.errors.map((e) => calcErrorText(t, e, { system, customer: true })) };
  const sysName = res.system ? `${res.system.code} — ${localName(res.system, locale)}` : '';
  return {
    ok: true,
    title: t('profile.calc.resultTitle', { system: sysName, meters: fmtDec(res.meters, 2) }),
    lines: res.lines.map((l) => {
      const measure = t(l.measure === 'BUC' ? 'profile.calc.measure.BUC' : 'profile.calc.measure.M');
      const unit = unitLabel(l.unitCode, locale);
      return {
        productId: l.productId, code: l.code, name: localName(l, locale), unit, qty: l.qty,
        need: t('profile.calc.need', { need: fmtDec(l.need, 2), measure, content: fmtDec(l.content, 3), unit }),
        stock: l.stock ? { needed: l.qty, available: l.stock.available, missing: l.stock.missing } : null,
      };
    }),
  };
}

/**
 * Gönderimden önce stok uyarısı (engellemez): formdaki adetler → yalnızca stoğu yetmeyen ürünler (gereken / mevcut / eksik).
 * Okunamayan istek ya da sınır aşımı sessizce geçilir (`ok: false`): sipariş her durumda gönderilebilir, yetersizlik
 * kaydı siparişle birlikte sunucuda yazılır.
 */
export async function checkProfileStockAction(rows: unknown): Promise<{ ok: true; lines: StockCheckLine[] } | { ok: false }> {
  const user = await requirePermission('ORDER_CREATE');
  if (!user.customer || user.customer.type !== 'CUSTOMER') return { ok: false };
  if (!Array.isArray(rows) || rows.length > MAX_PROFILE_LINES * 2) return { ok: false };
  if (!profileCalcLimits.stockCheck(user.id)) return { ok: false };
  const read = readQuantities(rows.map((r) => ({ id: str((r as { id?: unknown })?.id, 64), qty: str((r as { qty?: unknown })?.qty, 12) })));
  if (!read.ok) return { ok: false };
  const { locale } = await getT();
  const lines = await customerShortages(db, read.lines);
  return {
    ok: true,
    lines: lines.map((l) => ({
      productId: l.productId, code: l.code, name: localName(l, locale), unit: unitLabel(l.unitCode, locale),
      needed: l.needed, available: l.available, missing: l.missing,
    })),
  };
}
