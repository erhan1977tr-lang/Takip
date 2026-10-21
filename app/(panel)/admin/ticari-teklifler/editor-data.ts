// Ticari teklif düzenleyicisinin sunucu tarafı verisi (karar 277): katalog seçenekleri (yalnızca okunur), hesaplayıcı
// seçenekleri ve kayıtlı sürüm verisinin form biçimi. Sayfa dosyası değildir (yeni ve düzenleme sayfaları ortak kullanır).
import { db } from '@/lib/db';
import type { Dict, Locale, MsgKey, T } from '@/lib/i18n';
import { editorCatalog } from '@/server/commercial/service.js';
import { DEFAULT_TERMS, DEFAULT_VALIDITY_DAYS, PROFILE_COLORS, perMlContent, profileDefaults } from '@/server/commercial/rules.js';
import { loadCalcOptions } from '@/server/profile/calc-service.js';
import { localName, unitLabel } from '@/server/profile/catalog.js';
import type { EditorCalc, EditorData, EditorGlass, EditorProfile } from './OfferEditor';

const input = (v: unknown) => (v == null ? '' : String(v).replace('.', ','));

export async function editorProps(actor: { id: string; role: string }, t: T, locale: Locale) {
  const cat = await editorCatalog(db, actor);
  if (!cat.ok) throw new Error('FORBIDDEN');
  const opts = await loadCalcOptions(db);
  const glass: EditorGlass[] = cat.glass.map((g) => ({
    id: g.id,
    label: locale === 'tr' ? [g.nameTr, g.colorTr].filter(Boolean).join(' — ') : [g.nameRo || g.nameTr, g.colorRo || g.colorTr].filter(Boolean).join(' — '),
    descRo: [g.nameRo, g.colorRo].map((s) => String(s ?? '').trim()).filter(Boolean).join(', '),
    listCost: g.listCost,
  }));
  const profile: EditorProfile[] = cat.profile.map((p) => {
    const def = profileDefaults(p);
    return {
      id: p.id, code: p.code, label: localName(p, locale), nameRo: p.nameRo || p.nameTr, category: p.category ? localName(p.category, locale) : '',
      unit: unitLabel(p.unitCode, locale), content: perMlContent(p), price: def.price, cost: def.cost, stockCost: def.stockCost, catalogCost: def.catalogCost,
    };
  });
  const sys = (s: { id: string; code: string; nameTr: string; nameRo: string }) => ({ id: s.id, label: `${s.code} — ${localName(s, locale)}` });
  const calc: EditorCalc = {
    profiles: opts.profiles.map(sys), handrails: opts.handrails.map(sys),
    thicknesses: opts.thicknesses.map((x) => ({ id: x.id, label: x.label ?? `${x.mm} mm` })),
    colors: PROFILE_COLORS.map((c) => ({ value: c, label: t(`profile.calc.colors.${c}` as MsgKey) })),
  };
  return { glass, profile, customers: cat.customers, calc, costTable: { name: cat.glassCostTable, reason: cat.glassCostReason, ops: cat.opCosts ?? null } };
}

type Stored = Record<string, unknown>;
const str = (v: unknown) => (v == null ? '' : String(v));
const rows = (v: unknown): Stored[] => (Array.isArray(v) ? (v as Stored[]) : []);

/** Kayıtlı sürüm verisi (CommercialOfferVersion.data) → düzenleyici alanları */
export function editorData(no: number | null, raw: unknown): EditorData {
  const d = (raw ?? {}) as Stored;
  return {
    no: no == null ? '' : String(no), date: str(d.date), customerId: str(d.customerId), firmName: str(d.firmName),
    validityDays: str(d.validityDays ?? DEFAULT_VALIDITY_DAYS), terms: (Array.isArray(d.terms) ? d.terms : []).map(str).join('\n'),
    note: str(d.note), glassExtraCost: input(d.glassExtraCost),
    // Sandık parası (kind SANDIK) ve cam satırının işlemleri (ops: CNC / delik) — eski satırlarda yok (işlemsiz cam)
    glass: rows(d.glass).map((l) => ({
      ...(l.kind === 'SANDIK' ? { kind: 'SANDIK' as const } : {}),
      productId: str(l.productId), description: str(l.description), en: str(l.en), boy: str(l.boy), qty: str(l.qty), price: input(l.price), cost: l.kind === 'SANDIK' ? '' : input(l.cost),
      ops: rows(l.ops).map((o) => ({ kind: o.kind === 'DELIK' ? 'DELIK' as const : 'CNC' as const, description: str(o.description), qty: str(o.qty), price: input(o.price), cost: input(o.cost) })),
    })),
    profile: rows(d.profile).map((l) => ({
      productId: str(l.productId), description: str(l.description), color: str(l.color), meters: l.perMl ? input(l.meters) : '', qty: l.perMl ? '' : str(l.qty),
      price: input(l.price), cost: input(l.cost),
    })),
  };
}

/** Yeni teklifin boş formu (bugün, varsayılan geçerlilik ve koşullar) */
export function emptyEditorData(today: string): EditorData {
  return { no: '', date: today, customerId: '', firmName: '', validityDays: String(DEFAULT_VALIDITY_DAYS), terms: DEFAULT_TERMS.join('\n'), note: '', glassExtraCost: '', glass: [], profile: [] };
}

/** Hata kodu → metin (satır numarasıyla) */
export function errorText(t: T, m: Dict['commercial'], code: string | undefined, row: string | undefined): string | null {
  if (!code) return null;
  const known = Object.hasOwn(m.errors, code);
  return t((known ? `commercial.errors.${code}` : 'commercial.errors.unknown') as MsgKey, { row: /^\d{1,3}$/.test(String(row)) ? String(row) : '?' });
}
