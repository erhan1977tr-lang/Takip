// Belge kesme sonucu belirsiz kalan FGO işleri (Paket 10, karar 209 — ürün sahibinin kararı: "dur, yöneticiye sor").
//   FGO'ya belge kesme isteği (factura/emitere) gönderildikten sonra zaman aşımı / kopan bağlantı / 5xx / okunamayan ya da
//   numarasız yanıt: belge FGO'da kesilmiş OLABİLİR. Bu iş körlemesine yeniden denenmez:
//     - iş "beklemede" kalır (PENDING, availableAt çok ileri, lastError "[BELIRSIZ] …"): hiçbir işçi onu almaz, ama siparişi
//       / partiyi tutmaya devam eder (yeni belge istenemez, kaldırma / fiyat değişikliği kilitli — bekleyen iş kuralı aynı)
//     - "Önemli kararlar"a FGO_UNCERTAIN (iş + deneme başına tek kayıt), muhasebeye uygulama içi bildirim, geçmiş + denetim
//   Yönetici FGO'ya bakıp karar verir (resolveUncertainJob, ACCOUNTING_MANAGE):
//     RECORD  — "FGO'da belge var": seri + numara girer; FGO'ya o belge sorulur (getstatus, salt okunur). Belge FGO'da yoksa,
//               serisi beklenen seri değilse ya da FGO toplamı bu işin tutarından farklıysa kaydedilmez. Doğrulanırsa belge,
//               işçinin başarı yoluyla aynı kayıtlarla yazılır (e-posta, geçmiş, kur kaydı …).
//     RETRY   — "FGO'da belge yok": aynı iş aynı IdExtern ile yeniden kuyruğa girer (FGO'nun mükerrer denetimi de sürer).
//     ABANDON — "FGO'da belge yok, vazgeç": iş FAILED olur (sipariş / parti mevcut kuralla serbest kalır ya da yeniden denenir).
//   Hiçbir yol FGO'da belge silmez / iptal etmez.
import { can } from '../auth/permissions.js';
import { writeAudit, writeHistory } from '../orders/journal.js';
import { FgoError, fgoDocumentAbsent, fgoKey, fgoReady, fgoStatus, getFgoSettings, grossOf, ronPrice } from '../integrations/fgo.js';
import { RECORD_TOLERANCE } from './payments.js';

export const UNCERTAIN_MARK = '[BELIRSIZ]';
/** Beklemedeki işin "uygun olma" anı: hiçbir işçi bu tarihe kadar almaz (çözülene dek) */
export const PARKED_UNTIL = new Date('9999-12-31T00:00:00Z');
export const UNCERTAIN_ALERT = 'FGO_UNCERTAIN';
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** İş beklemede mi (belirsiz sonuç, yöneticinin kararını bekliyor) */
export const isParked = (job) => !!job && job.status === 'PENDING' && typeof job.lastError === 'string' && job.lastError.startsWith(UNCERTAIN_MARK);
/** Beklemedeki işler (Prisma koşulu): öne alma / yeniden deneme bunlara dokunmaz */
export const PARKED_WHERE = { status: 'PENDING', lastError: { startsWith: UNCERTAIN_MARK } };

/**
 * FGO'ya giden satırlardan belgenin beklenen TVA dahil toplamı ve izin verilen fark (satır başına yuvarlama payı).
 * Satır: { gross } (TVA dahil toplam verilen satır) · { ron } (RON birim, adet ile) · { eur } (EUR × kur).
 * @returns {{ gross: number, tolerance: number }}
 */
export function expectedGross(lines, { rate, vatRate }) {
  let gross = 0;
  for (const l of lines) {
    if (l.gross != null) {
      gross = round2(gross + Number(l.gross));
      continue;
    }
    const unit = l.ron != null ? Number(l.ron) : ronPrice(l.eur, rate);
    gross = round2(gross + grossOf(round2(Number(l.qty) * unit), vatRate));
  }
  return { gross, tolerance: round2(RECORD_TOLERANCE + 0.01 * lines.length) };
}

/**
 * Belirsiz sonuçlu işi bekletir ve yöneticiye bildirir. İşçinin catch bloğundan çağrılır (FGO'ya yeniden gidilmez).
 * @param {any} db
 * @param {{ id: string, attempts: number, payload: any }} row  kuyruk satırı (sahiplenilmiş)
 * @param {{ target: 'GLASS' | 'PROFILE' | 'PROFILE_ADVANCE' | 'BATCH', kind: string, orderIds?: string[], batchId?: string | null,
 *   customerId?: string | null, orderNo?: string | null, prepared: object, expected: { gross: number, tolerance: number },
 *   series: string, idExtern: string, error: string, now?: Date }} p
 */
export async function parkUncertain(db, row, { target, kind, orderIds = [], batchId = null, customerId = null, orderNo = null, prepared, expected, series, idExtern, error, now = new Date() }) {
  const attempt = row.attempts + 1;
  const msg = String(error ?? '').slice(0, 300);
  const uncertain = { at: now.toISOString(), target, kind, attempt, error: msg, idExtern, series, expectedGross: expected.gross, tolerance: expected.tolerance, prepared };
  await db.$transaction(async (tx) => {
    await tx.notificationOutbox.update({
      where: { id: row.id },
      data: { availableAt: PARKED_UNTIL, lastError: `${UNCERTAIN_MARK} ${msg}`.slice(0, 500), payload: { ...(row.payload ?? {}), uncertain } },
    });
    await tx.adminAlert.createMany({
      data: [{ type: UNCERTAIN_ALERT, orderId: orderIds[0] ?? null, dedupeKey: `fgo-uncertain:${row.id}:${attempt}`, details: { target, kind, jobId: row.id, idExtern, series, expectedGross: expected.gross, error: msg, orderNo, batchId, customerId } }],
      skipDuplicates: true,
    });
    for (const orderId of orderIds) await writeHistory(tx, { orderId, event: 'FGO_UNCERTAIN', actorId: null, note: kind });
    await writeAudit(tx, {
      action: 'FGO_DOC_UNCERTAIN', entityType: 'NotificationOutbox', entityId: row.id, userId: null,
      details: { target, kind, orderIds, batchId, idExtern, series, expectedGross: expected.gross, attempt, error: msg, before: 'PENDING', after: 'UNCERTAIN' },
    }, { role: 'SYSTEM' });
  });
  const { notifyStaff } = await import('../notifications/inapp.js');
  await notifyStaff(db, {
    audience: 'accounting', key: `fgo-uncertain:${row.id}:${attempt}`, type: 'FGO_UNCERTAIN', orderId: orderIds[0] ?? null,
    params: { kind, ref: idExtern }, link: orderIds[0] ? `/siparisler/${orderIds[0]}#belirsiz` : `/admin/muhasebe/cam/proforma${customerId ? `?musteri=${customerId}` : ''}#belirsiz`,
  }).catch(() => 0);
}

const SERIES_RE = /^[A-Za-z0-9-]{1,12}$/;
const NUMBER_RE = /^[A-Za-z0-9-]{1,20}$/;

/**
 * Yöneticinin kararı (karar 209).
 * @param {any} db
 * @param {{ jobId: string, action: 'RECORD' | 'RETRY' | 'ABANDON', series?: string, number?: string, confirm?: boolean, actor: any,
 *   secret?: string, appUrl?: string, fetchImpl?: typeof fetch, now?: Date, recorders: Record<string, (db: any, job: any, doc: { series: string, number: string, link: null }, now: Date) => Promise<unknown>> }} p
 *   recorders: hedef türüne göre işçinin başarı yolu (GLASS / PROFILE / PROFILE_ADVANCE / BATCH) — iş satırı koşullu olarak SENT olur
 * @returns {Promise<{ ok: true, doc?: string } | { ok: false, code: string, fgoTotal?: number, expected?: number }>}
 */
export async function resolveUncertainJob(db, { jobId, action, series = '', number = '', confirm = false, actor, secret, appUrl = '', fetchImpl = fetch, now = new Date(), recorders }) {
  if (!actor || !can(actor.role, 'ACCOUNTING_MANAGE')) return { ok: false, code: 'FORBIDDEN' };
  if (!['RECORD', 'RETRY', 'ABANDON'].includes(action)) return { ok: false, code: 'NOT_ALLOWED' };
  const job = await db.notificationOutbox.findUnique({ where: { id: String(jobId ?? '') } });
  if (!isParked(job) || !job.payload?.uncertain) return { ok: false, code: 'NOT_UNCERTAIN' };
  const u = job.payload.uncertain;
  const orderIds = job.orderId ? [job.orderId] : [];
  const closeAlerts = (tx) => tx.adminAlert.updateMany({ where: { type: UNCERTAIN_ALERT, resolvedAt: null, dedupeKey: { startsWith: `fgo-uncertain:${job.id}:` } }, data: { resolvedAt: now, resolvedById: actor.id } });
  const journal = async (tx, details) => {
    for (const orderId of orderIds) await writeHistory(tx, { orderId, event: 'FGO_UNCERTAIN_RESOLVED', actorId: actor.id, note: action });
    await writeAudit(tx, { action: 'FGO_UNCERTAIN_RESOLVED', entityType: 'NotificationOutbox', entityId: job.id, userId: actor.id, details: { target: u.target, kind: u.kind, idExtern: u.idExtern, before: 'UNCERTAIN', ...details } }, actor);
  };

  if (action !== 'RECORD') {
    // Yönetici FGO'da belgenin OLMADIĞINI doğruladı (açık onay şart)
    if (!confirm) return { ok: false, code: 'CONFIRM' };
    return db.$transaction(async (tx) => {
      const history = [...(Array.isArray(job.payload.uncertainHistory) ? job.payload.uncertainHistory : []), { ...u, resolvedAt: now.toISOString(), action, by: actor.id }];
      const payload = { ...job.payload, uncertain: null, uncertainHistory: history };
      const data = action === 'RETRY'
        ? { availableAt: now, lastError: null, payload }
        : { status: /** @type {const} */ ('FAILED'), lastError: 'Belirsiz sonuç: yönetici FGO\'da belge olmadığını doğruladı ve vazgeçti', payload };
      const r = await tx.notificationOutbox.updateMany({ where: { id: job.id, ...PARKED_WHERE }, data });
      if (r.count !== 1) return { ok: false, code: 'NOT_UNCERTAIN' };
      // Müşteri partisi: vazgeçilince parti FAILED olur (mevcut "yeniden dene / vazgeç" kararı yöneticide)
      if (u.target === 'BATCH' && action === 'ABANDON' && job.payload.batchId) {
        await tx.billingBatch.updateMany({ where: { id: String(job.payload.batchId), status: 'PENDING' }, data: { status: 'FAILED', lastError: 'Belirsiz sonuç — FGO\'da belge yok (yönetici)' } });
      }
      await closeAlerts(tx);
      await journal(tx, { after: action === 'RETRY' ? 'PENDING' : 'FAILED', checkedInFgo: true });
      return { ok: true };
    });
  }

  // RECORD: FGO'da kesilmiş belge — seri + numara FGO'dan doğrulanır
  const s = String(series ?? '').trim().toUpperCase();
  const n = String(number ?? '').trim();
  if (!SERIES_RE.test(s) || !NUMBER_RE.test(n)) return { ok: false, code: 'BAD_NUMBER' };
  if (u.series && s !== String(u.series).toUpperCase()) return { ok: false, code: 'SERIES' };
  if (await db.fgoDocument.findUnique({ where: { series_number: { series: s, number: n } } })) return { ok: false, code: 'EXISTS_IN_TAKIP' };
  const settings = await getFgoSettings(db);
  if (!fgoReady(settings)) return { ok: false, code: 'FGO_DISABLED' };
  const key = fgoKey(settings, secret);
  if (!key) return { ok: false, code: 'NO_KEY' };
  let st;
  try {
    st = await fgoStatus(settings, key, { series: s, number: n, appUrl }, fetchImpl);
  } catch (e) {
    return { ok: false, code: fgoDocumentAbsent(e) ? 'NOT_IN_FGO' : 'UNVERIFIED' };
  }
  if (st.total == null) return { ok: false, code: 'UNVERIFIED' };
  if (Math.abs(st.total - Number(u.expectedGross)) > Number(u.tolerance ?? RECORD_TOLERANCE) + 1e-9) {
    return { ok: false, code: 'TOTAL_MISMATCH', fgoTotal: st.total, expected: Number(u.expectedGross) };
  }
  const record = recorders?.[u.target];
  if (!record) return { ok: false, code: 'NOT_ALLOWED' };
  try {
    await record(db, job, { series: s, number: n, link: null }, now);
  } catch (e) {
    if (e?.code === 'P2002') return { ok: false, code: 'EXISTS_IN_TAKIP' };
    if (e?.message === 'JOB_STATE' || e?.code === 'NOT_ALLOWED') return { ok: false, code: 'NOT_UNCERTAIN' };
    if (e instanceof FgoError) return { ok: false, code: 'UNVERIFIED' };
    throw e;
  }
  await db.fgoDocument.updateMany({ where: { series: s, number: n }, data: { total: st.total.toFixed(2), paid: st.paid == null ? null : st.paid.toFixed(2), checkedAt: now } });
  await db.$transaction(async (tx) => {
    await closeAlerts(tx);
    await journal(tx, { after: 'SENT', series: s, number: n, fgoTotal: st.total, expectedGross: Number(u.expectedGross) });
  });
  return { ok: true, doc: `${s}${n}` };
}

/**
 * Siparişin / partinin beklemedeki belirsiz işleri (ekran)
 * @param {any} db  @param {{ orderId?: string | null, batchIds?: string[] }} [o]
 */
export function parkedJobs(db, { orderId = null, batchIds = [] } = {}) {
  const or = [];
  if (orderId) or.push({ orderId });
  if (batchIds.length) or.push({ type: 'FGO_BATCH', OR: batchIds.map((id) => ({ payload: { path: ['batchId'], equals: id } })) });
  if (!or.length) return Promise.resolve([]);
  return db.notificationOutbox.findMany({ where: { ...PARKED_WHERE, OR: or }, orderBy: { createdAt: 'asc' } });
}
