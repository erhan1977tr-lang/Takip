// Fabrika PDF'i aktarımı (karar 255) — veritabanı tarafı. Kurallar saf modüllerde (parse.js, glass.js, plan.js); burada
// yetki, sipariş kapsamı, kayıt, mükerrer denetimi ve aktarma. Aktarma iş akışı işlemidir (transitions.js →
// import_offer_pdf): sipariş sürüm kilidi, geçmiş, denetim kaydı aynı veritabanı işleminde.
//
//   Yetki   : yalnızca teklif hazırlayanlar (OFFER_PREPARE: yönetici, yönetici yardımcısı, satış) — her işlevin ilk denetimi.
//             Kaynak PDF ve fabrika alış fiyatları müşteri, denetimci ve çizim ekibine hiçbir yoldan gitmez.
//   Mükerrer: aynı dosya (SHA-256) aynı siparişe bir kez kaydedilir; aynı fabrika sipariş numarası bir siparişe — satırları
//             teklifte durdukça — bir kez, başka bir siparişe hiç aktarılmaz; bir aktarımdaki iki PDF aynı numarayı taşıyamaz.
import crypto from 'node:crypto';
import { can } from '../../auth/permissions.js';
import { glassLabel } from '../../catalog/glass.js';
import { availableActions, drawingFlags, isCrateText } from '../rules.js';
import { orderScope } from '../scope.js';
import { WorkflowError } from '../../domain/workflow.js';
import { buildLines } from './lines.js';
import { parseFactoryOrder } from './parse.js';
import { buildImportPlan } from './plan.js';
import { extractTextItems, PDF_IMPORT_LIMITS } from './extract.js';

export const MAX_PDFS = 10;
export { PDF_IMPORT_LIMITS };
/** @type {{ ok: false, code: string }} */
const FORBIDDEN = { ok: false, code: 'FORBIDDEN' };
const allowed = (actor) => !!actor && can(actor.role, 'OFFER_PREPARE');

/**
 * Teklif tablosu PDF aktarımına açık mı: cam siparişi, kullanıcının kapsamında, teklif düzenlenebilir (satış taslağı ya da
 * yöneticinin fiyat onayı — iş akışının kendi kuralı: edit_offer / approve_price).
 */
/** @returns {Promise<{ ok: true, order: any, offer: any } | { ok: false, code: string }>} */
async function loadTarget(db, { orderId, actor }) {
  const order = await db.order.findFirst({
    where: { id: String(orderId ?? ''), orderTypeCode: 'GLASS_ORDER', ...orderScope({ appRole: actor.role, customerId: actor.customerId ?? null }) },
    include: {
      items: true,
      customer: { select: { prefix: true } },
      drawings: { orderBy: { version: 'asc' } },
      files: { where: { kind: 'CUSTOMER' }, select: { id: true, name: true, kind: true, checksum: true, scanStatus: true, uploadedById: true } },
      offers: { orderBy: { createdAt: 'desc' }, take: 1, include: { lines: { orderBy: { sortOrder: 'asc' } } } },
    },
  });
  if (!order) return { ok: false, code: 'NOT_FOUND' };
  const offer = order.offers[0] ?? null;
  const acts = availableActions({
    role: actor.role, status: order.status, onHold: order.onHold, canApprove: !!actor.canApprove,
    drawing: order.drawingTrack, offer: offer?.status ?? null, ...drawingFlags(order), orderType: order.orderTypeCode,
  });
  if (!offer || !(acts.includes('edit_offer') || acts.includes('approve_price'))) return { ok: false, code: 'NOT_EDITABLE' };
  return { ok: true, order, offer };
}

/**
 * PDF aktarımı bu kullanıcıya ve siparişe açık mı (dosya saklanmadan ÖNCE çağrılır).
 * @returns {Promise<{ ok: true, orderId: string } | { ok: false, code: string }>}
 */
export async function importTarget(db, { orderId, actor }) {
  if (!allowed(actor)) return FORBIDDEN;
  const t = await loadTarget(db, { orderId, actor });
  return t.ok ? { ok: true, orderId: t.order.id } : t;
}

/**
 * Saklanmış PDF'leri (storeFiles — içerik denetimi + antivirüs) aktarma kaydına çevirir: metin çıkarılır ve ayrıştırılır;
 * okunamayan PDF de kaydedilir (sabit hata koduyla — ön izleme gösterir). Aynı dosya aynı siparişte zaten varsa yeni
 * kayıt açılmaz: var olan kayıt kullanılır, yeni saklanan dosya `discard` listesinde döner (çağıran diskten siler).
 * @param {any} db
 * @param {{ actor: any, orderId: string, stored: { storageKey: string, name: string, size: number, mime?: string | null, checksum: string, scanStatus: string, scannedAt?: Date | null }[], readFile: (storageKey: string) => Promise<Uint8Array>, extract?: typeof extractTextItems }} p
 * @returns {Promise<{ ok: true, ids: string[], discard: { storageKey: string }[] } | { ok: false, code: string }>}
 */
export async function recordUploads(db, { actor, orderId, stored, readFile, extract = extractTextItems }) {
  if (!allowed(actor)) return FORBIDDEN;
  const t = await loadTarget(db, { orderId, actor });
  if (!t.ok) return t;
  const ids = [];
  const discard = [];
  for (const f of stored) {
    const same = await db.offerImport.findUnique({ where: { orderId_checksum: { orderId: t.order.id, checksum: f.checksum } }, select: { id: true } });
    if (same) { ids.push(same.id); discard.push({ storageKey: f.storageKey }); continue; }
    let parsed = null;
    let parseError = null;
    try {
      const data = await readFile(f.storageKey);
      const ex = await extract(data);
      if (!ex.ok) parseError = ex.error;
      else parsed = parseFactoryOrder(buildLines(ex.items));
    } catch {
      parseError = 'UNREADABLE';
    }
    try {
      const row = await db.offerImport.create({
        data: {
          orderId: t.order.id, name: String(f.name).slice(0, 255), storageKey: f.storageKey, size: f.size, mime: f.mime ?? null, checksum: f.checksum,
          scanStatus: f.scanStatus, scannedAt: f.scannedAt ?? null, uploadedById: actor.id ?? null,
          parsed: parsed ?? undefined, parseError, factoryOrderNo: parsed?.header.factoryNo ?? null,
        },
        select: { id: true },
      });
      ids.push(row.id);
    } catch (e) {
      // Aynı dosya aynı anda iki kez: ilk kayıt kullanılır
      if (/** @type {any} */ (e)?.code !== 'P2002') throw e;
      const first = await db.offerImport.findUnique({ where: { orderId_checksum: { orderId: t.order.id, checksum: f.checksum } }, select: { id: true } });
      if (!first) throw e;
      ids.push(first.id);
      discard.push({ storageKey: f.storageKey });
    }
  }
  return { ok: true, ids: [...new Set(ids)], discard };
}

/** Ölçüsüz, işlemsiz, boş cam satırı (müşterinin siparişinden açılan ilk satır gibi): aktarmada kullanıcı izniyle kaldırılır */
export function emptyGlassLines(lines) {
  return lines.filter((l, i) => (l.kind ?? 'CAM') === 'CAM' && l.enMm == null && l.boyMm == null && !l.crateFee && !isCrateText(l.description)
    && !l.compensationId && !l.importId && !['CNC', 'DELIK'].includes(lines[i + 1]?.kind));
}

const fingerprintOf = (imp, plan) => crypto.createHash('sha256')
  .update(JSON.stringify({ id: imp.id, checksum: imp.checksum, header: plan.header, lines: plan.lines, blocking: plan.blocking.map((b) => b.code) }))
  .digest('hex').slice(0, 32);

/**
 * Ön izleme (ve aktarmanın yeniden hesabı — aynı işlev). db: veritabanı ya da işlem (tx).
 * @param {{ actor: any, order: any, offer: any, importIds: string[], choices?: object, locale?: string }} p
 */
export async function buildPreview(db, { actor, order, offer, importIds, choices = {}, locale = 'tr' }) {
  const ids = [...new Set((importIds ?? []).map(String))].slice(0, MAX_PDFS * 3);
  const imports = await db.offerImport.findMany({ where: { id: { in: ids }, orderId: order.id }, orderBy: { createdAt: 'asc' } });
  const glasses = await db.glassProduct.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { nameTr: 'asc' }] });
  const catalog = glasses.map((g) => ({ ...g, label: glassLabel(g, 'tr'), display: glassLabel(g, locale) }));
  const it = order.items.find((x) => x.glassProductId) ?? null;
  const orderGlass = it ? (glasses.find((g) => g.id === it.glassProductId) ?? { id: it.glassProductId, nameTr: it.glassName, nameRo: it.glassNameRo, isActive: false }) : null;
  const display = new Map(catalog.map((g) => [g.id, g.display]));

  const factoryNos = imports.map((i) => i.factoryOrderNo).filter(Boolean);
  // Bu siparişte satırları teklifte duran aktarımlar ve başka siparişlere aktarılmış aynı fabrika numaraları
  const liveImportIds = new Set(offer.lines.map((l) => l.importId).filter(Boolean));
  const applied = factoryNos.length
    ? await db.offerImport.findMany({ where: { status: 'APPLIED', factoryOrderNo: { in: factoryNos } }, select: { id: true, orderId: true, factoryOrderNo: true, order: { select: { orderNo: true, removedAt: true } } } })
    : [];
  const seen = new Map();
  for (const i of imports) if (i.factoryOrderNo) seen.set(i.factoryOrderNo, (seen.get(i.factoryOrderNo) ?? 0) + 1);

  const out = [];
  for (const imp of imports) {
    const blocking = [];
    const warnings = [];
    if (imp.status === 'APPLIED') blocking.push({ code: 'ALREADY_IMPORTED' });
    if (imp.scanStatus === 'INFECTED') blocking.push({ code: 'INFECTED' });
    else if (imp.scanStatus === 'PENDING') warnings.push({ code: 'NOT_SCANNED' });
    let plan = null;
    if (imp.parseError || !imp.parsed) blocking.push({ code: 'PDF_UNREADABLE', reason: imp.parseError ?? 'UNREADABLE' });
    else {
      plan = buildImportPlan({ parsed: /** @type {any} */ (imp.parsed), importKey: imp.id, order: { prefix: order.customer?.prefix ?? '', customerOrderNo: order.customerOrderNo, glass: orderGlass }, catalog, choices });
      blocking.push(...plan.blocking);
      warnings.push(...plan.warnings);
    }
    const no = imp.factoryOrderNo;
    if (no && (seen.get(no) ?? 0) > 1) blocking.push({ code: 'DUPLICATE_IN_BATCH', factoryNo: no });
    if (no && imp.status !== 'APPLIED') {
      for (const a of applied) {
        if (a.factoryOrderNo !== no || a.id === imp.id) continue;
        if (a.orderId === order.id && liveImportIds.has(a.id)) blocking.push({ code: 'DUPLICATE_FACTORY_ORDER', factoryNo: no });
        else if (a.orderId !== order.id && !a.order?.removedAt) blocking.push({ code: 'FACTORY_ORDER_ON_OTHER', factoryNo: no, orderNo: a.order?.orderNo ?? '' });
      }
    }
    const unique = (list) => { const s = new Set(); return list.filter((p) => { const k = JSON.stringify(p); if (s.has(k)) return false; s.add(k); return true; }); };
    out.push({
      id: imp.id, name: imp.name, status: imp.status, scanStatus: imp.scanStatus, factoryNo: no,
      blocking: unique(blocking), warnings: unique(warnings),
      plan: plan && {
        header: plan.header, rows: plan.rows, checks: plan.checks,
        glassChoices: plan.glassChoices.map((g) => ({ ...g, candidates: g.candidates.map((c) => ({ id: c.id, label: display.get(c.id) ?? c.label })), selectedLabel: g.selected ? display.get(g.selected) ?? null : null })),
        opChoices: plan.opChoices, lineCount: plan.lines.length,
      },
      lines: plan?.lines ?? [],
      fingerprint: plan ? fingerprintOf(imp, { ...plan, blocking: [...blocking] }) : null,
    });
  }
  return { imports: out, empty: emptyGlassLines(offer.lines).map((l) => ({ id: l.id, description: l.description, adet: l.adet })) };
}

/**
 * Ön izleme: kullanıcıya giden biçim (teklif satırı taslakları gönderilmez — aktarma sunucuda yeniden hesaplar).
 * @returns {Promise<{ ok: true, version: number, empty: { id: string, description: string, adet: number }[], imports: any[] } | { ok: false, code: string }>}
 */
export async function importPreview(db, { actor, orderId, importIds, choices, locale }) {
  if (!allowed(actor)) return FORBIDDEN;
  const t = await loadTarget(db, { orderId, actor });
  if (!t.ok) return t;
  const p = await buildPreview(db, { actor, order: t.order, offer: t.offer, importIds, choices, locale });
  // Firma adını göremeyen rol (satış): PDF'ten okunan serbest satır metni gönderilmez (müşteri adı taşıyabilir — maskeleme kuralı).
  // Proje yalnızca kod + numara olarak döner (plan.header.projectCode); "Proje / Müşterisi" metninin kendisi hiç dönmez.
  const masked = !can(actor.role, 'CUSTOMER_NAME_VIEW');
  const clean = (list) => (masked ? list.map(({ text: _t, ...rest }) => rest) : list);
  return {
    ok: true, version: t.order.version, empty: p.empty,
    imports: p.imports.map(({ lines: _l, blocking, warnings, ...rest }) => ({ ...rest, blocking: clean(blocking), warnings: clean(warnings) })),
  };
}

/**
 * Aktarma (iş akışı işleminin gövdesi — transitions.js → import_offer_pdf; h: işlem bağlamı, sipariş sürümü artırılmış).
 * Ön izleme aynı işlevle yeniden hesaplanır; parmak izi değiştiyse STALE_PREVIEW, engel varsa PDF_IMPORT_BLOCKED.
 * Teklifteki satırlar silinmez / değişmez (yalnızca kullanıcının işaretlediği ölçüsüz boş cam satırları kaldırılır);
 * yeni satırlar sona eklenir. Müşteri fiyatı yazılmaz; teklif yöneticiye gönderilmez.
 * @param {any} h  @param {(tx: any, offer: any, lines: object[]) => Promise<object[]>} complete  satırları katalog / fiyat tablosuyla tamamlar
 */
export async function applyImports(h, complete) {
  const { tx, order, actor, payload, now } = h;
  if (!allowed(actor)) throw new WorkflowError('FORBIDDEN');
  const offer = order.offers[0] ?? null;
  if (!offer) throw new WorkflowError('OFFER_NOT_FOUND');
  const wanted = Array.isArray(payload.imports) ? payload.imports.slice(0, MAX_PDFS) : [];
  if (!wanted.length) throw new WorkflowError('PDF_IMPORT_EMPTY');
  const ids = wanted.map((w) => String(w.id ?? ''));
  // Aynı fabrika numarası aynı anda iki siparişe aktarılamaz: numaralar sıralı kilitlenir (sipariş satırından sonra)
  const nos = (await tx.offerImport.findMany({ where: { id: { in: ids }, orderId: order.id }, select: { factoryOrderNo: true } }))
    .map((r) => r.factoryOrderNo).filter(Boolean).sort();
  for (const no of [...new Set(nos)]) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pdf-import:${no}`}, 0))`;

  const full = await tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { customer: { select: { prefix: true } }, items: true } });
  const preview = await buildPreview(tx, { actor, order: { ...order, customer: full.customer, items: full.items }, offer, importIds: ids, choices: payload.choices ?? {} });
  if (preview.imports.length !== ids.length) throw new WorkflowError('PDF_IMPORT_STALE');
  for (const w of wanted) {
    const p = preview.imports.find((x) => x.id === String(w.id));
    if (!p) throw new WorkflowError('PDF_IMPORT_STALE');
    if (p.blocking.length) throw new WorkflowError('PDF_IMPORT_BLOCKED', { problems: p.blocking.map((b) => b.code) });
    if (!w.fingerprint || p.fingerprint !== String(w.fingerprint)) throw new WorkflowError('PDF_IMPORT_STALE');
  }

  // Kullanıcının açıkça işaretlediği boş cam satırları (yalnızca ön izlemenin gösterdikleri)
  const dropIds = new Set(Array.isArray(payload.dropEmpty) ? payload.dropEmpty.map(String) : []);
  const drop = emptyGlassLines(offer.lines).filter((l) => dropIds.has(l.id)).map((l) => l.id);
  if (drop.length) await tx.offerLine.deleteMany({ where: { id: { in: drop }, offerId: offer.id } });

  const kept = offer.lines.filter((l) => !drop.includes(l.id));
  const added = [];
  for (const p of preview.imports) for (const l of p.lines) added.push({ ...l, importId: p.id });
  const completed = await complete(tx, offer, added);
  const base = kept.reduce((m, l) => Math.max(m, l.sortOrder), -1) + 1;
  const all = [...kept, ...completed.map((l, i) => ({ ...l, sortOrder: base + i }))];
  return { offer, kept, added: completed, all, drop, preview, base, now };
}
