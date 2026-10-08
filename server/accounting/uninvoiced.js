// "Fatura bekliyor" — yüklenmiş ama KAPANIŞ FATURASI kesilmemiş cam (karar 126).
//
//   Ayar: Yönetici → Entegrasyonlar → "Fatura edilmemiş sipariş uyarısı" = yüklemeden sonra kaç TAKVİM günü (varsayılan 6,
//   0–60). IntegrationSetting 'accounting' kaydında durur (FGO ayarlarına dokunmaz).
//
//   Kural: kaynak yalnızca ONAYLI yüklemedir ("Yükleme yapıldı" kaydı — LoadingConfirmation; planlanan tarih değil).
//   Sayaç "Yükleme yapıldı" işleminden sonra başlar (Paket 7, karar 189): uyarı günü = onayın kaydedildiği gün (confirmedAt,
//   uygulama saat dilimi) + ayardaki gün sayısı. Yükleme günü (shipDay) yalnızca gösterilir. Aynı gün ikinci kez onaylanamaz
//   (benzersiz shipDay) ve bildirim kapsam başına bir kez yazılır: işlem tekrarlansa da yeni hatırlatma / kayıt oluşmaz.
//   Kapsam = onay + sipariş (müşteri faturasının kapsamıyla aynı birim):
//   siparişin o onaydaki GEÇERLİ yüklenen kalemleri (effectiveItems — düzeltmeler uygulanmış; yüklenmeyen / aktarılan cam
//   yüklendiği onayda kendi günüyle sayılır).
//     Kapatan: yalnızca kapanış faturası — o kapsamı içeren KESİLMİŞ müşteri faturası (BillingBatch INVOICE, ISSUED) ya da
//       siparişin kendi belge zincirindeki kesilmiş fatura (FgoDocument INVOICE).
//     Kapatmayan: proforma (sipariş ya da müşteri), avans faturası, kuyruktaki / kesilemeyen fatura isteği.
//     Uyarı üretmeyen: faturalanabilir kalemi olmayan kapsam (bedelsiz / fiyatsız — NO_LINES, para birimi dışı) ve
//       "muhasebe işlemi gerekli" dondurması (camı kaynağındaki faturada zaten faturalanmış aktarım — karar 105).
//   Uygunluk kararı faturalama ekranıyla AYNI işlevden gelir (server/glass/invoice-batch.js → invoiceScope); burada ikinci
//   bir faturalama kuralı yoktur ve hiçbir belge kesilmez / değişmez.
//
//   Gösterim: Muhasebe → Cam Tahsilat'ta kalıcı liste (fatura kesilince kendiliğinden kalkar; elle "tamamlandı" yoktur) +
//   muhasebe yetkisine (ACCOUNTING_MANAGE) uygulama içi bildirim — kapsam başına BİR kez (işçi saatte bir bakar; anahtar
//   kapsamın kimliğidir, yükleme düzeltmesi kapsamı değiştirirse yeni bildirim).
import { getEnv } from '../env.js';
import { writeAudit } from '../orders/journal.js';
import { effectiveItems } from '../loading/confirmation.js';
import { localDay } from '../profile/dates.js';
import { GLASS_FGO } from '../glass/billing.js';
import { heldReplans, invoiceScope } from '../glass/invoice-batch.js';
import { notifyStaff } from '../notifications/inapp.js';

export const ACCOUNTING_KEY = 'accounting';
export const UNINVOICED_DEFAULT_DAYS = 6;
export const UNINVOICED_MAX_DAYS = 60;
export const REMIND_EVERY_MS = 60 * 60_000;

/**
 * Formdan gelen gün sayısı: 0–60 arası tam sayı. Boş → varsayılan (6).
 * @param {unknown} raw
 * @returns {{ ok: true, value: number } | { ok: false }}
 */
export function parseUninvoicedDays(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return { ok: true, value: UNINVOICED_DEFAULT_DAYS };
  if (!/^\d{1,3}$/.test(text)) return { ok: false };
  const value = Number(text);
  return value >= 0 && value <= UNINVOICED_MAX_DAYS ? { ok: true, value } : { ok: false };
}

/** @returns {Promise<{ uninvoicedDays: number }>} */
export async function getAccountingSettings(db) {
  const row = await db.integrationSetting.findUnique({ where: { key: ACCOUNTING_KEY } });
  const v = row?.value && typeof row.value === 'object' ? row.value : {};
  const n = v.uninvoicedDays;
  return { uninvoicedDays: Number.isInteger(n) && n >= 0 && n <= UNINVOICED_MAX_DAYS ? n : UNINVOICED_DEFAULT_DAYS };
}

/** Ayarı kaydeder (yönetici; denetim kaydıyla). value: parseUninvoicedDays sonucu */
export async function saveAccountingSettings(db, { uninvoicedDays }, actor) {
  return db.$transaction(async (tx) => {
    const before = await tx.integrationSetting.findUnique({ where: { key: ACCOUNTING_KEY } });
    const value = { uninvoicedDays };
    await tx.integrationSetting.upsert({ where: { key: ACCOUNTING_KEY }, create: { key: ACCOUNTING_KEY, value, updatedById: actor.id }, update: { value, updatedById: actor.id } });
    await writeAudit(tx, { action: 'SETTINGS_UPDATE', entityType: 'IntegrationSetting', entityId: ACCOUNTING_KEY, userId: actor.id, details: { before: before?.value ?? null, after: value } }, actor);
  });
}

const DAY_MS = 86_400_000;
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (day, n) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));
/** İki gün ("YYYY-AA-GG") arasındaki takvim günü farkı */
export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
/** Uyarı günü: sayacın başladığı gün ("Yükleme yapıldı" kaydının günü) + ayardaki takvim günü */
export const dueDayOf = (startDay, days) => addDays(startDay, days);

/**
 * Uyarı günü gelmiş ve kapanış faturası kesilmemiş kapsamlar (onay + sipariş), en eski yükleme önce. day: yükleme günü ·
 * confirmedDay: "Yükleme yapıldı" kaydının günü (sayacın başlangıcı) · dueDay = confirmedDay + gün · daysSince: confirmedDay'den beri.
 *   note: neden hâlâ açık (yalnızca bilgi) — null: fatura kesilebilir · ORDER_CHAIN: sipariş kendi belge zincirinde (fatura
 *   sipariş sayfasından) · PROFORMA_NOT_ISSUED: müşteri proforması kesilemedi / kuyrukta · INVOICE_QUEUED / INVOICE_FAILED:
 *   fatura isteği kuyrukta / kesilemedi.
 * @param {any} db
 * @param {{ now?: Date, days?: number }} [o]  days verilmezse ayardan okunur
 * @returns {Promise<{ confirmationId: string, orderId: string, orderNo: string, customerId: string, customerName: string, day: string, confirmedDay: string, dueDay: string,
 *   daysSince: number, revision: number, removed: boolean, note: string | null }[]>}
 */
export async function uninvoicedLoadings(db, { now = new Date(), days = undefined } = {}) {
  days ??= (await getAccountingSettings(db)).uninvoicedDays;
  const tz = getEnv().APP_TIMEZONE;
  const today = localDay(now, tz);
  const cutoff = addDays(today, -days);
  // Aday kapsamlar tek sorguda: uyarı günü gelmiş (onay kaydının yerel günü + gün ≤ bugün) onaylardaki (onay, sipariş)
  // çiftlerinden kapanış faturası OLMAYANLAR.
  // Kesilmiş müşteri faturası (o onay + sipariş anahtarıyla) ya da siparişin kendi faturası olan çiftler burada elenir;
  // böylece geçmişin tamamı her seferinde yüklenmez.
  const pairs = await db.$queryRaw`
    SELECT DISTINCT i."confirmationId" AS "confirmationId", i."orderId" AS "orderId"
    FROM "LoadingConfirmationItem" i
    JOIN "LoadingConfirmation" c ON c."id" = i."confirmationId"
    WHERE ((c."confirmedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}::text)::date <= ${cutoff}::date
      AND NOT EXISTS (
        SELECT 1 FROM "BillingBatchOrder" bo JOIN "BillingBatch" b ON b."id" = bo."batchId"
        WHERE bo."activeKey" = 'INVOICE:' || i."confirmationId" || ':' || i."orderId" AND b."status"::text = 'ISSUED')
      AND NOT EXISTS (SELECT 1 FROM "FgoDocument" d WHERE d."orderId" = i."orderId" AND d."kind" = 'INVOICE')`;
  if (pairs.length === 0) return [];
  const confIds = [...new Set(pairs.map((p) => p.confirmationId))];
  const orderIds = [...new Set(pairs.map((p) => p.orderId))];
  const [confs, items, orders, jobs] = await Promise.all([
    db.loadingConfirmation.findMany({ where: { id: { in: confIds } }, select: { id: true, shipDay: true, confirmedAt: true } }),
    db.loadingConfirmationItem.findMany({ where: { confirmationId: { in: confIds }, orderId: { in: orderIds } }, orderBy: [{ orderId: 'asc' }, { sortOrder: 'asc' }] }),
    db.order.findMany({
      where: { id: { in: orderIds } },
      select: {
        id: true, orderNo: true, customerId: true, removedAt: true, customer: { select: { name: true } },
        fgoDocuments: { select: { kind: true, series: true, number: true }, orderBy: { issuedAt: 'asc' } },
        billingBatchOrders: { where: { activeKey: { not: null } }, select: { activeKey: true, offerId: true, batch: { select: { id: true, kind: true, status: true, document: { select: { series: true, number: true } } } } } },
      },
    }),
    db.notificationOutbox.findMany({ where: { orderId: { in: orderIds }, type: GLASS_FGO, status: 'PENDING' }, select: { orderId: true } }),
  ]);
  // Geçerli durum: düzeltilmiş kapsamda son düzeltmenin kalemleri; yalnızca LOADED olanlar faturalanır
  const loaded = effectiveItems(items).filter((i) => i.status === 'LOADED');
  const held = await heldReplans(db, loaded.map((i) => i.replanId).filter(Boolean));
  const dayOf = new Map(confs.map((c) => [c.id, isoDay(c.shipDay)]));
  const startOf = new Map(confs.map((c) => [c.id, localDay(c.confirmedAt, tz)]));
  const orderOf = new Map(orders.map((o) => [o.id, o]));
  const pending = new Set(jobs.map((j) => j.orderId));
  const out = [];
  for (const p of pairs) {
    const order = orderOf.get(p.orderId);
    const day = dayOf.get(p.confirmationId);
    const start = startOf.get(p.confirmationId);
    const mine = loaded.filter((i) => i.confirmationId === p.confirmationId && i.orderId === p.orderId);
    // Bu onayda fiilen yüklenen kalemi kalmamış (tamamı yüklenmedi / düzeltmeyle sıfırlandı): faturalanacak bir şey yok
    if (!order || !day || !start || mine.length === 0) continue;
    const sc = invoiceScope({ confirmationId: p.confirmationId, order, items: mine, pendingJob: pending.has(order.id), held });
    let note = null;
    if (sc.state === 'IN_INVOICE') {
      if (sc.batch.status === 'ISSUED') continue; // bu arada kesildi
      note = sc.batch.status === 'FAILED' ? 'INVOICE_FAILED' : 'INVOICE_QUEUED';
    } else if (sc.state === 'EXCLUDED') {
      // Faturalanamayan kapsam uyarı üretmez (kalem yok / para birimi dışı / muhasebe işlemi bekleyen dondurma)
      if (sc.reason !== 'ORDER_CHAIN' && sc.reason !== 'PROFORMA_NOT_ISSUED') continue;
      note = sc.reason;
    }
    out.push({
      confirmationId: p.confirmationId, orderId: order.id, orderNo: order.orderNo, customerId: order.customerId, customerName: order.customer?.name ?? '',
      day, confirmedDay: start, dueDay: dueDayOf(start, days), daysSince: daysBetween(start, today), revision: mine.reduce((m, i) => Math.max(m, i.revision ?? 0), 0),
      removed: !!order.removedAt, note,
    });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.orderNo.localeCompare(b.orderNo));
}

/**
 * Uyarı günü gelmiş kapsamları muhasebe yetkisine bildirir (işçi; saatte bir). Bildirim kapsam başına bir kez yazılır
 * (Notification [userId, dedupeKey] benzersiz): saatlik tekrar, iki işçi ya da yeniden başlatma ikinci bildirim üretmez.
 * Yalnızca ACCOUNTING_MANAGE yetkisi olan iç kullanıcılar alır — satış, çizim, denetimci ve müşteri almaz.
 * Listedeki kalıcı uyarı bildirimden bağımsızdır: bildirim okunsa da fatura kesilene kadar görünür.
 * @param {any} db
 * @param {{ now?: Date, log?: Function }} [o]
 * @returns {Promise<{ due: number, created: number }>}
 */
export async function remindUninvoiced(db, { now = new Date(), log = () => {} } = {}) {
  const rows = await uninvoicedLoadings(db, { now });
  let created = 0;
  for (const r of rows) {
    try {
      created += await notifyStaff(db, {
        audience: 'accounting', key: `uninvoiced:${r.confirmationId}:${r.orderId}:r${r.revision}`, type: 'INVOICE_OVERDUE', orderId: r.orderId,
        params: { day: r.day, qty: r.daysSince }, link: '/admin/muhasebe/cam#fatura-bekliyor',
      });
    } catch (e) {
      log('fatura bekliyor bildirimi yazılamadı', r.orderNo, String(e?.message ?? e).slice(0, 200));
    }
  }
  return { due: rows.length, created };
}
