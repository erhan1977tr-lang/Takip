// Fabrika PDF'i aktarımı (karar 255): ayrıştırılmış PDF + sipariş + katalog → ön izleme ve teklif satırları.
// Saf modül (veritabanı yok). Ön izleme ve aktarma AYNI işlevle hesaplanır (aktarmada yeniden çalışır, parmak izi karşılaştırılır).
//
//   Müşteri / proje : "Proje / Müşterisi" alanındaki firma kodu + numara siparişin firma kodu ve sipariş numarasıyla aynı olmalı
//                     (büyük / küçük harf ve boşluk farkı yok sayılır). Farklı müşteri, farklı proje, belirsiz → aktarma yok.
//   Cam             : glass.js — siparişin camıyla belirgin uyuşmazlık aktarmayı durdurur; tekil tam eşleşme otomatik,
//                     aksi hâlde kullanıcı seçer (yalnızca aynı kodlu camlardan; kod yoksa etkin katalogdan).
//   Fiyat           : PDF'teki bütün tutarlar EUR (TL / € etiketi ve kur yok sayılır). Cam ve işlem alış fiyatları ayrı satırlarda
//                     satış fiyatına (unitPrice) yazılır; müşteri fiyatı (offerPrice) hiçbir zaman doldurulmaz. İskontolu satırda
//                     net birim fiyat = net tutar ÷ miktar (2 ondalık); özgün fiyat, iskonto ve net tutar kaynak kopyada durur.
//   İşlem           : işlem satırı kendinden önceki cama aittir. İşlemli cam tek adetlik satırlara ayrılır (karar 113, 114 —
//                     aynı ticari kalem, toplam m² ve tutar değişmez); işlem miktarı cam adedine tam bölünmeli.
//   Denetim A       : PDF satır tutarları toplamı = Ara Toplam (KDV hariç). Değilse aktarma yok.
//   Metraj          : PDF'in 3 ondalıklı m²'si aynen satıra yazılır (pieceM2 — karar 261); PDF m²'si ölçüyle (en × boy, 3
//                     ondalık) uyuşmuyorsa aktarma durur (AREA_MISMATCH — gerçek fark gizlenmez).
//   Denetim B       : TAKİP'in hesabıyla toplam ↔ Ara Toplam. Fark yalnızca doğrulanmış yuvarlamadan geliyorsa (birim fiyat
//                     yuvarlaması yarım kuruş sınırında) uyarıdır; açıklanamayan fark aktarmayı durdurur. Fark için satır, gizli
//                     düzeltme ya da ek ücret yazılmaz.
import { assignPieceBases, offerLineTotals } from '../rules.js';
import { checkSubtotal, expectedAmount } from './parse.js';
import { factoryGlassSignature, fold, glassCandidates, orderGlassVerdict } from './glass.js';

/**
 * Firma kodu (3 harf) + proje numarası çiftleri: "musterix ABC 40" → [{ code: 'ABC', no: '40' }], "ABC 40-1" → '40-1'.
 * Numara metindir (karar 259): tire ve baştaki sıfırlar korunur, siparişin müşteri numarasıyla aynen karşılaştırılır.
 */
export function projectRefs(text) {
  const f = fold(text);
  const out = [];
  for (const m of f.matchAll(/(?:^|[^A-Z0-9])([A-Z]{3})\s*-?\s*(\d{1,10}(?:-\d{1,10}){0,3})(?![\d-])/g)) out.push({ code: m[1], no: m[2] });
  return out;
}

/**
 * PDF'in müşteri / projesi bu sipariş mi.
 * @returns {{ ok: true, code: string, no: string } | { ok: false, code: 'PROJECT_MISSING' | 'PROJECT_UNRECOGNIZED' | 'WRONG_CUSTOMER' | 'WRONG_PROJECT' | 'PROJECT_AMBIGUOUS', found?: string }}
 */
export function projectCheck(projectText, { prefix, customerOrderNo }) {
  if (!projectText) return { ok: false, code: 'PROJECT_MISSING' };
  const refs = projectRefs(projectText);
  if (!refs.length) return { ok: false, code: 'PROJECT_UNRECOGNIZED' };
  const codes = [...new Set(refs.map((r) => r.code))];
  const ours = refs.filter((r) => r.code === prefix);
  if (!ours.length) return { ok: false, code: 'WRONG_CUSTOMER', found: codes.join(', ') };
  const nos = [...new Set(ours.map((r) => r.no))];
  if (codes.length > 1 || nos.length > 1) return { ok: false, code: 'PROJECT_AMBIGUOUS', found: refs.map((r) => `${r.code} ${r.no}`).join(', ') };
  if (nos[0] !== String(customerOrderNo ?? '')) return { ok: false, code: 'WRONG_PROJECT', found: `${prefix} ${nos[0]}` };
  return { ok: true, code: prefix, no: nos[0] };
}

/**
 * Normal / şekilli cam (karar 262): fabrika açıklamasında "ŞEKİLLİ" sözcüğü (Türkçe harf, büyük / küçük harf, boşluk ve satır
 * sonu farkı yok sayılır — açıklama satırları birleştirilmiştir) → şekilli; yoksa normal. Teknik özelliklerden (kalınlık, PVB,
 * renk, temper, laminasyon) ayrı okunur. Sözcüğe benzeyen ama tam olmayan yazım ("ŞEKİL") belirsizdir: normal kabul edilir,
 * ön izleme uyarır, satışçı teklif tablosunda düzeltir.
 * @returns {{ shaped: boolean, uncertain: boolean }}
 */
export function shapeOf(description) {
  const f = fold(description).replace(/\s+/g, ' ');
  const shaped = /(?:^|[^A-Z])SEKILLI(?![A-Z])/.test(f);
  return { shaped, uncertain: !shaped && /SEKIL/.test(f) };
}

/** İşlemin TAKİP türü: DELİK geçen → DELIK, CNC → CNC; başka bir ad tanınmaz (tahmin edilmez, kullanıcı seçer) */
export function opKindOf(name) {
  const f = fold(name);
  if (/\bDELIK/.test(f)) return 'DELIK';
  if (/\bCNC\b/.test(f)) return 'CNC';
  return null;
}

const cents = (c) => (c / 100).toFixed(2);
const toCents = (n) => Math.round(Number(n) * 100);
/** Yarı yukarı: a / b (pozitif tam sayılar) */
const divRound = (a, b) => Math.floor((a * 2 + b) / (b * 2));
/** Satır anahtarı (kalemi içe aktarmadan yeniden tanımak için): metin, büyük harf, tek boşluk */
export const glassKey = (description) => fold(description).replace(/[^A-Z0-9.,+ ]+/g, ' ').replace(/\s+/g, ' ').trim();
export const opKey = (name) => fold(name).replace(/\s+/g, ' ').trim();

/**
 * @param {object} p
 * @param {ReturnType<import('./parse.js').parseFactoryOrder>} p.parsed
 * @param {string} p.importKey   satırların ayrılmış cam grubu anahtarı için (içe aktarma kaydının kimliği)
 * @param {{ prefix: string, customerOrderNo: string | number, glass: { id?: string | null, nameTr?: string | null, colorTr?: string | null, nameRo?: string | null, colorRo?: string | null } | null }} p.order
 * @param {{ id: string, nameTr: string, colorTr?: string, nameRo?: string, colorRo?: string, isActive?: boolean, label: string }[]} p.catalog  etkin camlar (label: Türkçe ad — teklif satırının açıklaması)
 * @param {{ glass?: Record<string, string>, ops?: Record<string, string> }} [p.choices]
 */
export function buildImportPlan({ parsed, importKey, order, catalog, choices = {} }) {
  /** @type {{ code: string, [k: string]: unknown }[]} */
  const blocking = [];
  /** @type {{ code: string, [k: string]: unknown }[]} */
  const warnings = [];
  for (const p of parsed.problems) blocking.push({ ...p });
  const header = parsed.header;
  const project = projectCheck(header.project, order);
  if (!project.ok) blocking.push({ code: project.code, ...(project.found ? { found: project.found } : {}) });
  if (!header.factoryNo) blocking.some((b) => b.code.startsWith('FACTORY_NO')) || blocking.push({ code: 'FACTORY_NO_MISSING' });

  const byId = new Map(catalog.map((g) => [g.id, g]));
  const active = catalog.filter((g) => g.isActive !== false);

  // ---- Cam cinsi: aynı açıklama bir kez değerlendirilir ----
  /** @type {Map<string, any>} */
  const glassChoices = new Map();
  for (const r of parsed.rows) {
    const key = glassKey(r.description);
    if (glassChoices.has(key)) continue;
    const sig = factoryGlassSignature(r.description);
    const verdict = orderGlassVerdict(sig, order.glass);
    const cand = glassCandidates(sig, active);
    const pool = sig.code && cand.sameCode.length ? cand.sameCode : active.map((g) => g.id);
    let selected = null;
    let auto = false;
    if (verdict === 'MATCH' && order.glass?.id && byId.get(order.glass.id)?.isActive !== false && byId.has(order.glass.id)) { selected = order.glass.id; auto = true; }
    else if (cand.exact.length === 1) { selected = cand.exact[0]; auto = true; }
    const chosen = choices.glass?.[key];
    if (chosen && pool.includes(chosen)) { selected = chosen; auto = false; }
    if (verdict === 'MISMATCH') blocking.push({ code: 'GLASS_ORDER_MISMATCH', description: r.description, factoryCode: sig.code });
    else if (verdict === 'UNKNOWN') warnings.push({ code: 'ORDER_GLASS_UNVERIFIED', description: r.description });
    if (!sig.ok) warnings.push({ code: sig.problem === 'PVB_NOT_MULTIPLE' ? 'PVB_NOT_MULTIPLE' : 'GLASS_CODE_UNKNOWN', description: r.description, pvb: sig.pvb?.mm ?? null });
    if (!selected) blocking.push({ code: 'NEEDS_GLASS_CHOICE', description: r.description });
    glassChoices.set(key, {
      key, description: r.description, code: sig.code, colours: sig.colours, auto, selected,
      candidates: pool.map((id) => ({ id, label: byId.get(id)?.label ?? id })),
    });
  }

  // ---- İşlem türleri ----
  /** @type {Map<string, any>} */
  const opChoices = new Map();
  for (const r of parsed.rows) {
    for (const o of r.ops) {
      const key = opKey(o.name);
      if (opChoices.has(key)) continue;
      const auto = opKindOf(o.name);
      const chosen = ['CNC', 'DELIK'].includes(String(choices.ops?.[key])) ? String(choices.ops?.[key]) : null;
      const kind = auto ?? chosen;
      if (!kind) blocking.push({ code: 'NEEDS_OP_CHOICE', name: o.name });
      opChoices.set(key, { key, name: o.name, auto: !!auto, kind });
    }
  }

  // ---- Teklif satırları ----
  const lines = [];
  const rows = [];
  parsed.rows.forEach((r, ri) => {
    const sourceRow = r.sno ?? ri + 1;
    const g = glassChoices.get(glassKey(r.description));
    const glass = g?.selected ? byId.get(g.selected) : null;
    // POZ = PDF'in üst bölümündeki ana fabrika Sipariş No (karar 266): satırın kendi Poz sütunu, S.No ya da başlıktaki
    // başka numara (ör. "121.001") kullanılmaz. Ana numara okunamazsa FACTORY_NO_MISSING / _AMBIGUOUS aktarmayı durdurur.
    const poz = header.factoryNo ?? '';
    const valid = [r.m2, r.totalM2, r.unitPrice, r.discount, r.amount].every((v) => v != null) && r.adet > 0;
    // Net birim fiyat: iskonto yoksa PDF'in birim fiyatı; varsa net tutar ÷ toplam m² (2 ondalık, yarı yukarı)
    const glassNet = !valid ? null : r.discount === 0 ? r.unitPrice : divRound(r.amount * 1000, r.totalM2);
    const ops = r.ops.map((o) => {
      const kind = opChoices.get(opKey(o.name))?.kind ?? null;
      const okQty = o.totalQty != null && o.totalQty % 1000 === 0 && o.totalQty > 0;
      if (o.unit && !['ADET', 'AD'].includes(o.unit)) blocking.push({ code: 'OP_UNIT_UNSUPPORTED', row: sourceRow, name: o.name, unit: o.unit });
      else if (!okQty) blocking.push({ code: 'OP_QTY_FRACTION', row: sourceRow, name: o.name });
      const total = okQty ? o.totalQty / 1000 : null;
      if (total != null && total % r.adet !== 0) blocking.push({ code: 'OPS_QTY_AMBIGUOUS', row: sourceRow, name: o.name, qty: total, pieces: r.adet });
      const net = o.unitPrice == null || o.amount == null ? null : o.discount === 0 ? o.unitPrice : total ? divRound(o.amount, total) : null;
      return { ...o, kind, total, net, perPiece: total != null && total % r.adet === 0 ? total / r.adet : null };
    });
    const startIdx = lines.length;
    // Şekilli cam (karar 262): açıklamadaki "ŞEKİLLİ" teknik özelliklerden ayrı okunur (cam cinsi / katalog eşleşmesi değişmez)
    const shape = shapeOf(r.description);
    if (shape.uncertain) warnings.push({ code: 'SHAPE_UNCERTAIN', row: sourceRow, description: r.description });
    // Bir camın m²'si (karar 261): PDF'teki 3 ondalıklı m² aynen (binde bir → "2.386"); okunamadıysa eski kural
    const pieceM2 = r.m2 != null && r.m2 > 0 ? (r.m2 / 1000).toFixed(3) : null;
    const glassLine = (adet, splitGroup) => ({
      kind: 'CAM', description: glass?.label ?? r.description, glassProductId: glass?.id ?? null, poz, enMm: r.en, boyMm: r.boy, adet, unit: 'm2',
      unitPrice: glassNet == null ? '' : cents(glassNet), free: false, offerPrice: null, splitGroup, sourceRow, pieceM2, shaped: shape.shaped,
    });
    const opLine = (o, adet) => ({
      kind: o.kind ?? 'CNC', description: o.name, glassProductId: null, poz: '', enMm: null, boyMm: null, adet, unit: 'adet',
      unitPrice: o.net == null ? '' : cents(o.net), free: false, offerPrice: null, splitGroup: null, sourceRow,
    });
    if (!ops.length) lines.push(glassLine(r.adet, null));
    else {
      const group = r.adet > 1 ? `p${String(importKey).slice(-24)}r${sourceRow}`.slice(0, 40) : null;
      for (let k = 0; k < r.adet; k++) {
        lines.push(glassLine(1, group));
        for (const o of ops) lines.push(opLine(o, o.perPiece ?? o.total ?? 1));
      }
    }
    rows.push({ r, ri, sourceRow, ops, glassNet, startIdx, endIdx: lines.length, poz, glass });
  });

  // ---- Denetimler ----
  const a = checkSubtotal(parsed);
  // A: PDF satır tutarları ↔ Ara Toplam (karar 266, karar 264'ün sınırını kaldırır). Fark, tutarı ne olursa olsun, tek
  // başına aktarmayı DURDURMAZ: ön izlemede uyarıdır, kabul "Teklif tablosuna aktar" ile verilir. Ara Toplam fabrikanın KDV
  // hariç alış toplamı olarak aynen saklanır (OfferImport.parsed + aktarma denetim kaydı: subtotal, rowSum, subtotalDiff);
  // satır fiyatları / tutarları farkı kapatmak için değiştirilmez, fark için satır / düzeltme eklenmez. Satırın kendi
  // hataları (eksik / okunamayan satır, geçersiz tutar, m², cam / işlem) ayrı engel olarak kalır.
  const aDiff = parsed.totals.subtotal == null ? null : parsed.totals.subtotal - a.pdfSum;
  if (aDiff != null && aDiff !== 0) warnings.push({ code: 'SUBTOTAL_DIFFERENCE', pdfSum: cents(a.pdfSum), subtotal: cents(parsed.totals.subtotal), diff: cents(aDiff) });
  const calc = assignPieceBases(lines);
  const totals = calc.map((l) => offerLineTotals({ ...l, unitPrice: l.unitPrice === '' ? '0' : l.unitPrice }));
  const takipTotal = totals.reduce((s, t) => s + toCents(t.amount), 0);
  // B: TAKİP'in kendi hesabı ↔ PDF satır toplamı — satırların her biri açıklanırsa (m² = en × boy, birim fiyat yuvarlaması)
  // fark uyarıdır, açıklanamayan satır varsa aktarma durur. Ara Toplam farkı (A) buraya karışmaz.
  let explained = true;
  const previewRows = rows.map(({ r, sourceRow, ops, glassNet, startIdx, endIdx, poz, glass }) => {
    const exactArea = divRound(r.en * r.boy, 1000); // binde bir m² (fabrika: en × boy, 3 ondalık)
    const areaOk = r.m2 === exactArea;
    const tol = (q) => Math.ceil(q / 2000) + 1; // yarım kuruş × miktar + 1 kuruş
    const priceOk = glassNet != null && r.amount != null && Math.abs(expectedAmount(r.totalM2, glassNet, 0) - r.amount) <= (r.discount === 0 ? 1 : tol(r.totalM2));
    const opsOk = ops.every((o) => o.net != null && o.total != null && Math.abs(o.net * o.total - o.amount) <= (o.discount === 0 ? 1 : tol(o.totalQty)));
    const rowOk = areaOk && priceOk && opsOk;
    if (!rowOk) explained = false;
    // PDF'in m²'si ölçüyle (en × boy, 3 ondalık) uyuşmuyor: m² PDF'ten aynen alınacağı için (karar 261) fark tutarda görünmez —
    // gerçek fark gizlenmez, aktarma durur (satır elle girilir)
    if (!areaOk && r.m2 != null) blocking.push({ code: 'AREA_MISMATCH', row: sourceRow, pdfM2: r.m2, dimsM2: exactArea });
    let takipGlass = 0; let takipOps = 0; let takipM2 = 0;
    for (let k = startIdx; k < endIdx; k++) {
      if (calc[k].kind === 'CAM') { takipGlass += toCents(totals[k].amount); takipM2 += Math.round(totals[k].metraj * 1000); } else takipOps += toCents(totals[k].amount);
    }
    return {
      sourceRow, description: r.description, glassKey: glassKey(r.description), glassLabel: glass?.label ?? null, poz, shaped: shapeOf(r.description).shaped,
      en: r.en, boy: r.boy, adet: r.adet, m2: r.m2, totalM2: r.totalM2, takipM2,
      unitPrice: r.unitPrice, discount: r.discount, netUnit: glassNet, amount: r.amount, takipAmount: takipGlass,
      ops: ops.map((o) => ({ name: o.name, kind: o.kind, qty: o.total, perPiece: o.perPiece, unitPrice: o.unitPrice, discount: o.discount, netUnit: o.net, amount: o.amount })),
      takipOps, explained: rowOk, areaOk,
    };
  });
  const subtotal = parsed.totals.subtotal;
  const diff = takipTotal - a.pdfSum;
  if (diff !== 0) {
    if (explained) warnings.push({ code: 'ROUNDING_DIFFERENCE', diff: cents(diff) });
    else blocking.push({ code: 'UNEXPLAINED_DIFFERENCE', diff: cents(diff) });
  }
  if (!lines.length) blocking.some((b) => b.code === 'NO_ROWS') || blocking.push({ code: 'NO_ROWS' });

  return {
    header: { factoryNo: header.factoryNo, orderDate: header.orderDate, deliveryDate: header.deliveryDate, projectCode: project.ok ? `${project.code} ${project.no}` : null },
    rows: previewRows,
    glassChoices: [...glassChoices.values()],
    opChoices: [...opChoices.values()],
    checks: {
      a: { pdfSum: a.pdfSum, subtotal, ok: a.ok, diff: aDiff },
      b: { takipTotal, pdfSum: a.pdfSum, subtotal, diff, explained: diff === 0 || explained },
      vat: parsed.totals.vat, grandTotal: parsed.totals.grandTotal,
    },
    lines: lines.map((l, i) => ({ ...l, splitGroup: calc[i].splitGroup })),
    blocking: dedupe(blocking),
    warnings: dedupe(warnings),
  };
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((p) => { const k = JSON.stringify(p); if (seen.has(k)) return false; seen.add(k); return true; });
}
