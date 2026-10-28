// Fabrika PDF'i aktarımı (karar 255) — veritabanı tarafı. Kurallar saf modüllerde (parse.js, glass.js, plan.js); burada
// yetki, sipariş kapsamı, kayıt, mükerrer denetimi ve aktarma. Aktarma iş akışı işlemidir (transitions.js →
// import_offer_pdf): sipariş sürüm kilidi, geçmiş, denetim kaydı aynı veritabanı işleminde.
//
//   Yetki   : yalnızca teklif hazırlayanlar (OFFER_PREPARE: yönetici, yönetici yardımcısı, satış) — her işlevin ilk denetimi.
//             Kaynak PDF ve fabrika alış fiyatları müşteri, denetimci ve çizim ekibine hiçbir yoldan gitmez.
//   Dosya   : özgün PDF okunduktan sonra silinir (3.75.3); yalnızca ayrıştırılmış kopya ve dosya bilgisi (ad, boyut, özet) kalır.
//   Mükerrer: aynı dosya (SHA-256) ve aynı fabrika sipariş numarası bir siparişe — satırları teklifte durdukça — bir kez
//             aktarılır (satırlar tamamen silinince aynı PDF yeniden aktarılabilir — karar 263); başka bir siparişe hiç
//             aktarılmaz; bir aktarımdaki iki PDF aynı numarayı taşıyamaz. Yalnızca temiz taranmış PDF aktarılır.
import crypto from 'node:crypto';
import { can } from '../../auth/permissions.js';
import { glassLabel } from '../../catalog/glass.js';
import { availableActions, drawingFlags, isCrateText } from '../rules.js';
import { revisionStage, REVISION_OFFER_SELECT } from '../offer-revision.js';
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
  // Müşteri teklif revizyonu (4.2.10): üretimdeki siparişte yalnızca açık revizyonun taslağı düzenlenir — aşama bütün sürümlerden
  const versions = await db.offer.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'desc' }, select: REVISION_OFFER_SELECT });
  const acts = availableActions({
    role: actor.role, status: order.status, onHold: order.onHold, canApprove: !!actor.canApprove,
    drawing: order.drawingTrack, offer: offer?.status ?? null, ...drawingFlags(order), orderType: order.orderTypeCode,
    revision: revisionStage({ ...order, offers: versions }),
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
 * Aynı dosyanın (SHA-256) bu siparişteki önceki kayıtlarından hangisi kullanılır (karar 263):
 *   - satırları güncel teklifte duran aktarılmış (APPLIED) kayıt → o kayıt (ön izleme "zaten aktarıldı" der, aktarma yok);
 *   - aktarılmamış (PREVIEW) kayıt → o kayıt (aynı dosyanın yeni taraması yazılır);
 *   - yalnızca satırları tekliften tamamen silinmiş aktarılmış kayıtlar → null: dosya YENİDEN aktarılabilir, yeni kayıt açılır.
 * Dosya özeti tek başına kalıcı engel değildir.
 * @param {any} tx  @param {string} orderId  @param {string} checksum  @param {Set<string>} liveImportIds  güncel teklifteki aktarım kayıtları
 */
async function reusableImport(tx, orderId, checksum, liveImportIds) {
  const same = await tx.offerImport.findMany({ where: { orderId, checksum }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true } });
  return same.find((r) => r.status === 'APPLIED' && liveImportIds.has(r.id)) ?? same.find((r) => r.status !== 'APPLIED') ?? null;
}

/** Aynı sipariş + aynı dosya için kayıt seçimi ve yazımı sıraya girer (eşzamanlı iki yükleme tek kayıt üretir) */
const fileLock = (tx, orderId, checksum) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pdf-import-file:${orderId}:${checksum}`}, 0))`;

/**
 * Saklanmış PDF'leri (storeFiles — içerik denetimi + antivirüs) aktarma kaydına çevirir: metin çıkarılır ve ayrıştırılır;
 * okunamayan PDF de kaydedilir (sabit hata koduyla — ön izleme gösterir). Özgün PDF KALICI SAKLANMAZ: kayıt dosya
 * anahtarı olmadan yazılır ve okunan HER dosya `discard` listesinde döner (çağıran diskten siler). Aynı dosya bu siparişte
 * zaten kayıtlıysa kayıt seçimi reusableImport'ta (karar 263): aktarılmamış ya da satırları teklifte duran kayıt yeniden
 * kullanılır (aktarılmamış kayıtta taramanın ve okumanın sonucu güncellenir — 4.2.11); önceki aktarımın satırları tamamen
 * silindiyse yeni kayıt açılır.
 * @param {any} db
 * @param {{ actor: any, orderId: string, stored: { storageKey: string, name: string, size: number, mime?: string | null, checksum: string, scanStatus: string, scannedAt?: Date | null }[], readFile: (storageKey: string) => Promise<Uint8Array>, extract?: typeof extractTextItems }} p
 * @returns {Promise<{ ok: true, ids: string[], discard: { storageKey: string }[] } | { ok: false, code: string }>}
 */
export async function recordUploads(db, { actor, orderId, stored, readFile, extract = extractTextItems }) {
  if (!allowed(actor)) return FORBIDDEN;
  const t = await loadTarget(db, { orderId, actor });
  if (!t.ok) return t;
  const liveImportIds = new Set(t.offer.lines.map((l) => l.importId).filter(Boolean));
  const ids = [];
  const discard = [];
  for (const f of stored) {
    discard.push({ storageKey: f.storageKey });
    // Dosya okunup ayrıştırılır (kilit dışında — yavaş iş); kayıt seçimi ve yazımı kilit altında
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
    const id = await db.$transaction(async (tx) => {
      await fileLock(tx, t.order.id, f.checksum);
      const reuse = await reusableImport(tx, t.order.id, f.checksum, liveImportIds);
      if (reuse) {
        // Aynı dosyanın yeni taraması ve yeni okuması: aktarılmamış kayıtta tarama sonucu (önceki "taranamadı" kalıcı olmaz) ve
        // ayrıştırma sonucu güncellenir (4.2.11 — okuyucu düzeldiyse önceki başarısız okuma kalıcı olmaz; ör. noktalı ondalık
        // biçimli PDF yeniden yüklenince satırları okunur). Okuma bu kez başarısızsa hata kodu yazılır (ön izleme okunamadı der).
        if (reuse.status !== 'APPLIED') {
          await tx.offerImport.update({
            where: { id: reuse.id },
            data: { scanStatus: f.scanStatus, scannedAt: f.scannedAt ?? null, parseError, factoryOrderNo: parsed?.header.factoryNo ?? null, ...(parsed ? { parsed } : {}) },
          });
        }
        return reuse.id;
      }
      const row = await tx.offerImport.create({
        data: {
          orderId: t.order.id, name: String(f.name).slice(0, 255), storageKey: null, size: f.size, mime: f.mime ?? null, checksum: f.checksum,
          scanStatus: f.scanStatus, scannedAt: f.scannedAt ?? null, uploadedById: actor.id ?? null,
          parsed: parsed ?? undefined, parseError, factoryOrderNo: parsed?.header.factoryNo ?? null,
        },
        select: { id: true },
      });
      return row.id;
    });
    ids.push(id);
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
 * @param {{ order: any, offer: any, importIds: string[], choices?: object, locale?: string }} p
 */
export async function buildPreview(db, { order, offer, importIds, choices = {}, locale = 'tr' }) {
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
  // Aynı dosyanın (SHA-256) satırları teklifte duran başka bir aktarımı (karar 263): satırlar durdukça aynı PDF yeniden
  // aktarılamaz; satırlar tamamen silindiyse engel kalkar
  const sums = [...new Set(imports.map((i) => i.checksum))];
  const liveSame = sums.length && liveImportIds.size
    ? await db.offerImport.findMany({ where: { orderId: order.id, checksum: { in: sums }, status: 'APPLIED', id: { in: [...liveImportIds] } }, select: { id: true, checksum: true } })
    : [];

  const out = [];
  for (const imp of imports) {
    const blocking = [];
    const warnings = [];
    if (imp.status === 'APPLIED' || liveSame.some((x) => x.checksum === imp.checksum && x.id !== imp.id)) blocking.push({ code: 'ALREADY_IMPORTED' });
    // Antivirüs zorunlu (karar 263): yalnızca temiz taranmış PDF aktarılır — tarama yapılamadıysa (antivirüs kapalı ya da
    // erişilemez: PENDING / SKIPPED) aktarma engellenir; dosya tarayıcı çalışırken yeniden yüklenir
    if (imp.scanStatus === 'INFECTED') blocking.push({ code: 'INFECTED' });
    else if (imp.scanStatus !== 'CLEAN') blocking.push({ code: 'NOT_SCANNED' });
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
  const p = await buildPreview(db, { order: t.order, offer: t.offer, importIds, choices, locale });
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
  // Aynı dosya: kayıt seçimiyle aynı kilit (karar 263) — sıralı alınır
  const sums = (await tx.offerImport.findMany({ where: { id: { in: ids }, orderId: order.id }, select: { checksum: true } })).map((r) => r.checksum).sort();
  for (const c of [...new Set(sums)]) await fileLock(tx, order.id, c);

  const full = await tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { customer: { select: { prefix: true } }, items: true } });
  const preview = await buildPreview(tx, { order: { ...order, customer: full.customer, items: full.items }, offer, importIds: ids, choices: payload.choices ?? {} });
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
