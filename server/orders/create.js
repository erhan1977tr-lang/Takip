// Yeni cam siparişi ve sipariş numarası (karar 5): sipariş no = firma kodu + müşterinin sipariş numarası (GLA69).
// Firma kodları benzersiz olduğu için numaralar firmalar arasında çakışmaz; firma içinde veritabanı tekilliği korur.
// Formda bir sonraki numara hazır gelir (suggestNextNo); müşteri değiştirebilir.
//   - Müşteri önerilen numarayı değiştirmediyse ve o numarayı bu arada başka bir sipariş aldıysa
//     (aynı firmadan eşzamanlı iki sipariş) bir sonraki boş numara otomatik verilir.
//   - Müşteri başka bir numara yazdıysa ve o numara kullanılıyorsa sipariş kaydedilmez (DUPLICATE_NUMBER).
// Aynı firmanın siparişleri firma bazlı bir kilitle sırayla oluşturulur (pg_advisory_xact_lock).
import { WorkflowError } from '../domain/workflow.js';
import { outboxEvent } from '../domain/outbox.js';
import { glassLoadingDate, slaDeadline } from './rules.js';
import { CUSTOMER_GLASS_TYPES } from '../catalog/glass.js';
import { isLegacyMultiGlass } from './drafts.js';
import { getEnv } from '../env.js';
import { enqueueOutbox, writeAudit, writeHistory } from './journal.js';
import { parseCustomerOrderNo } from './order-number.js';
import { assertOrderRate } from './create-rate.js';

/**
 * Firmanın bu tipteki bir sonraki sipariş numarası: yalnızca rakamdan oluşan ETKİN numaraların en büyüğü + 1 (metin —
 * karar 259). Tireli numaralar ("40-1") sırayı değiştirmez; silinmiş siparişin numarası sayılmaz (karar 260). Cam ve
 * profil siparişleri ayrı sıralardır (GLA12 ve GLAP12 ayrı siparişlerdir).
 * @returns {Promise<string>}
 */
export async function suggestNextNo(db, customerId, orderTypeCode = 'GLASS_ORDER') {
  const rows = await db.$queryRaw`
    SELECT MAX(CAST("customerOrderNo" AS BIGINT)) AS "max" FROM "Order"
    WHERE "customerId" = ${customerId} AND "orderTypeCode" = ${orderTypeCode} AND "numberActive" IS TRUE AND "customerOrderNo" ~ '^[0-9]{1,15}$'`;
  const max = rows?.[0]?.max == null ? 0n : BigInt(rows[0].max);
  return String(max + 1n);
}

/** Sipariş numarası metni: firma kodu + numara */
export const formatOrderNo = (code, no) => `${code}${no}`;

/** Sipariş tipinin numara biçimiyle: "{CODE}P{SEQ}" + GLA + 12 → GLAP12 */
export const formatTypedNo = (format, code, no) => String(format || '{CODE}{SEQ}').replace('{CODE}', code).replace('{SEQ}', String(no));

/**
 * Formdaki numarayı ve önerilen numarayı doğrular (oluşturma ve taslak aynı kural — server/orders/order-number.js).
 * @returns {{ requested: string, suggested: string | null }}
 */
export function requestedNumbers(requestedNo, suggestedNo, prefix) {
  const requested = parseCustomerOrderNo(requestedNo, prefix);
  if (!requested) throw new WorkflowError('BAD_NUMBER');
  return { requested, suggested: suggestedNo == null ? null : parseCustomerOrderNo(suggestedNo, prefix) };
}

/**
 * Numara seçimi (firma + tip kilidinin içinde çağrılır): numara boşsa istenen, doluysa (öneri değiştirilmediyse)
 * bir sonraki boş numara; müşteri kendisi yazdıysa DUPLICATE_NUMBER. Yalnızca ETKİN siparişler numarayı tutar
 * (karar 260): silinmiş siparişin numarası yeniden verilebilir. Telafi siparişleri kök siparişin numarasını taşır —
 * silinmiş kökün etkin telafi siparişi varsa numara boş sayılmaz.
 * @returns {Promise<string>}
 */
export async function pickNumber(tx, { customerId, orderTypeCode, requestedNo, suggestedNo, format, code }) {
  const { requested, suggested } = requestedNumbers(requestedNo, suggestedNo, code);
  const auto = suggested != null && requested === suggested;
  let no = requested;
  const taken = await tx.order.findFirst({ where: { customerId, orderTypeCode, customerOrderNo: no, numberActive: true }, select: { id: true } });
  if (taken) {
    if (!auto) throw new WorkflowError('DUPLICATE_NUMBER', { orderNo: formatTypedNo(format, code, no) });
    no = await suggestNextNo(tx, customerId, orderTypeCode);
  }
  return no;
}

/** Form anahtarı biçimi ve geçerlilik süresi (karar 288 — D2) */
const REQUEST_KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
const REQUEST_KEY_TTL_MS = 24 * 3_600_000;

/**
 * @param {import('@prisma/client').PrismaClient} db
 * @param {object} p
 * @param {{ id: string, role: string, ip?: string | null }} p.actor
 * @param {{ id: string, prefix: string, camEtiket?: string | null, sandikEtiket?: string | null }} p.firm
 * @param {string} p.title
 * @param {string | number} p.requestedNo      formdaki numara (metin — karar 259)
 * @param {string | number | null} p.suggestedNo  formun açıldığında önerdiği numara (değiştirilmediyse otomatik mod)
 * @param {object[]} p.items          glassOrderItems() sonucu (katalogdan anlık kopya): tam olarak bir cam tipi (karar 85)
 * @param {object[]} p.files          yeni kaydedilmiş dosyalar (server/files/store.js → storeUpload)
 * @param {string | null} [p.note]    "Ek bilgi": müşterinin görebildiği ilk not
 * @param {string | null} [p.draftId] taslaktan gönderiliyorsa: taslağın dosyaları siparişe geçer, taslak silinir
 * @param {string[]} [p.dropDraftFileIds]  taslakta olup müşterinin çıkardığı dosyalar (siparişe geçmez)
 * @param {string | null} [p.requestKey]  tek kullanımlık form anahtarı (karar 288 — D2)
 * @returns {Promise<{ id: string, orderNo: string, customerOrderNo: string, bumped: boolean, dropped: { storageKey: string }[], duplicate?: boolean }>}
 *   dropped: işlemden sonra diskten silinecek dosyalar
 */
export async function createGlassOrder(db, { actor, firm, title, requestedNo, suggestedNo = null, items, files = [], note = null, draftId = null, dropDraftFileIds = [], requestKey = null }) {
  // Tek kullanımlık form anahtarı (3.93.0, karar 288 — D2): aynı form iki kez gönderilirse (çift tıklama / ağ tekrarı)
  // ikinci sipariş açılmaz, ilk sipariş döner. Şema değişmeden: anahtar sipariş oluşturma denetim kaydına yazılır ve firma
  // kilidi altında (numara kilidiyle aynı) aranır. Biçimi bozuk anahtar yok sayılır (eski davranış).
  const key = typeof requestKey === 'string' && REQUEST_KEY_RE.test(requestKey) ? requestKey : null;
  if (!firm?.prefix) throw new WorkflowError('NO_FIRM');
  requestedNumbers(requestedNo, suggestedNo, firm.prefix);
  // Müşterinin yeni cam siparişi tam olarak bir cam tipi içerir (formdan bağımsız, sunucu kuralı). Yalnızca yeni
  // sipariş oluşturmayı bağlar: eski çok camlı siparişlere ve teklif tablosuna dokunmaz.
  if (!Array.isArray(items) || items.length === 0) throw new WorkflowError('NO_GLASS');
  if (items.length > CUSTOMER_GLASS_TYPES) throw new WorkflowError('ONE_GLASS');
  return db.$transaction(async (tx) => {
    // Aynı firmanın sipariş oluşturmaları sıraya girer (işlem bitince kilit kendiliğinden kalkar)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`order-no:${firm.id}`}, 0))`;
    if (key) {
      const prev = await tx.auditLog.findFirst({
        where: { action: 'ORDER_CREATE', userId: actor.id, createdAt: { gte: new Date(Date.now() - REQUEST_KEY_TTL_MS) }, details: { path: ['requestKey'], equals: key } },
        select: { entityId: true },
      });
      const first = prev ? await tx.order.findUnique({ where: { id: prev.entityId }, select: { id: true, orderNo: true, customerOrderNo: true, customerId: true } }) : null;
      if (first && first.customerId === firm.id) return { id: first.id, orderNo: first.orderNo, customerOrderNo: first.customerOrderNo, bumped: false, dropped: [], duplicate: true };
    }
    // Hız sınırı (karar 289): firma kilidi altında, veritabanındaki siparişlerden sayılır
    await assertOrderRate(tx, { firmId: firm.id, userId: actor.id });

    const no = await pickNumber(tx, { customerId: firm.id, orderTypeCode: 'GLASS_ORDER', requestedNo, suggestedNo, format: '{CODE}{SEQ}', code: firm.prefix });
    const orderNo = formatOrderNo(firm.prefix, no);
    const now = new Date();
    // Taslağın dosyaları siparişe geçer (aynı dosya, aynı tarama sonucu); taslak silinir
    let draftFiles = [];
    let dropped = [];
    if (draftId) {
      const draft = await tx.orderDraft.findFirst({ where: { id: draftId, customerId: firm.id }, include: { files: { orderBy: { createdAt: 'asc' } } } });
      if (!draft) throw new WorkflowError('DRAFT_GONE');
      // Eski çok camlı taslak çözülmeden gönderilemez (müşteri tutulacak camı seçmeli; diğerleri sessizce atılmaz)
      if (isLegacyMultiGlass(draft.items)) throw new WorkflowError('DRAFT_LEGACY_GLASS');
      draftFiles = draft.files.filter((f) => !dropDraftFileIds.includes(f.id));
      dropped = draft.files.filter((f) => dropDraftFileIds.includes(f.id));
      await tx.orderDraft.delete({ where: { id: draft.id } });
    }
    const allFiles = [...draftFiles, ...files];
    if (allFiles.length === 0) throw new WorkflowError('NO_FILES');
    const order = await tx.order.create({
      data: {
        orderNo, customerOrderNo: no, orderTypeCode: 'GLASS_ORDER', title, customerId: firm.id, createdById: actor.id,
        status: 'YENI', slaDeadline: slaDeadline({ status: 'YENI', createdAt: now }), estimatedShipDate: glassLoadingDate(now, getEnv().APP_TIMEZONE),
        camEtiket: firm.camEtiket ?? null, sandikEtiket: firm.sandikEtiket ?? null,
        items: { create: items },
        files: {
          create: allFiles.map((f) => ({
            name: f.name, storageKey: f.storageKey, size: f.size, mime: f.mime ?? null, checksum: f.checksum ?? null,
            scanStatus: f.scanStatus ?? 'SKIPPED', scanSignature: f.scanSignature ?? null, scannedAt: f.scannedAt ?? null,
            kind: 'CUSTOMER', uploadedById: f.uploadedById ?? actor.id,
          })),
        },
        ...(note ? { notes: { create: { userId: actor.id, text: note, internal: false } } } : {}),
      },
    });
    await writeHistory(tx, { orderId: order.id, event: 'CREATED', from: null, to: 'YENI', actorId: actor.id });
    await writeAudit(tx, {
      action: 'ORDER_CREATE', entityType: 'Order', entityId: order.id, userId: actor.id,
      details: { orderNo, files: allFiles.length, ...(key ? { requestKey: key } : {}), ...(draftId ? { fromDraft: true } : {}), ...(no !== parseCustomerOrderNo(requestedNo, firm.prefix) ? { requestedNo: parseCustomerOrderNo(requestedNo, firm.prefix), assignedNo: no } : {}) },
    }, actor);
    await enqueueOutbox(tx, outboxEvent('ORDER_CREATED', { orderId: order.id, payload: { orderNo, actorId: actor.id } }));
    return { id: order.id, orderNo, customerOrderNo: no, bumped: no !== parseCustomerOrderNo(requestedNo, firm.prefix), dropped };
  });
}
