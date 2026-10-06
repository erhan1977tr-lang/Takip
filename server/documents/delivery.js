// Mali belgelerin (FGO: proforma, avans faturası, fatura) müşteriye ulaştırılması — karar 111.
//
//   FGO belgeyi KESER; müşteriye e-postayı yalnızca TAKİP gönderir (FGO'nun müşteriye e-posta özelliği kullanılmaz).
//   Akış: belge FGO'da kesilir → FgoDocument yazılır → AYNI veritabanı işleminde bu belge için tek bir e-posta işi
//   kuyruğa girer (NotificationOutbox, type FGO_DOC_EMAIL, payload.docId) → işçi (scripts/worker.mjs) e-postayı gönderir.
//   Kesilemeyen / bekleyen / vazgeçilen belgenin FgoDocument kaydı olmadığından e-postası da olmaz.
//
//   Tekrar engeli: otomatik e-posta işi belge kaydıyla birlikte, belge başına bir kez yazılır (queueDocEmail); FGO durum
//   eşitlemesi, sayfa yenileme, işçinin yeniden çalışması yeni iş üretmez. İş, FGO işleriyle aynı atomik sahiplenme +
//   işlem kirasıyla alınır (claimFgoJob): iki işçi aynı e-postayı göndermez. Elle "yeniden gönder" (resendDocEmail)
//   bilinçli olarak yeni bir iş yazar; FGO'da belge KESMEZ, numaraya / faturalamaya dokunmaz.
//
//   PDF: belgenin FGO'daki PDF'i sunucu tarafında indirilir (kayıtlı bağlantıdan; bağlantı yoksa / artık açılmıyorsa
//   factura/print ile yenilenir — yalnızca okuma) ve e-postaya eklenir. Müşteri ekranındaki "PDF" de aynı işlevi kullanır
//   (app/(panel)/belgeler/[id]/pdf); tarayıcıya FGO anahtarı, hash ya da API parametresi gitmez.
import { can } from '../auth/permissions.js';
import { getEnv } from '../env.js';
import { brandedHtml, sendBrandedMail } from '../mail/send.js';
import { writeAudit, writeHistory } from '../orders/journal.js';
import { claimFgoJob } from '../integrations/fgo-claim.js';
import { fgoKey, fgoPrint, fgoReady, fgoStatus, getFgoSettings } from '../integrations/fgo.js';
import { PDF_MAX_BYTES, downloadFgoPdf, pdfUrl } from './fgo-pdf.js';

// Bağlantı kuralı ve indirme server/documents/fgo-pdf.js'tedir (bağımsız dosya); eski içe aktarmalar için buradan da verilir
export { PDF_MAX_BYTES, pdfUrl };

export const DOC_EMAIL = 'FGO_DOC_EMAIL';
export const DOC_EMAIL_MAX_ATTEMPTS = 8;
/** E-posta işinin işlem kirası: PDF indirme (20 sn) + SMTP (≈ 45 sn) süresini güvenle aşar */
export const DOC_EMAIL_LEASE_MS = 5 * 60_000;
/** PDF alınamazsa e-posta bu kadar deneme bekletilir; sonra eksiz (belge bağlantısıyla) gönderilir */
export const PDF_WAIT_ATTEMPTS = 2;
/** "Firmanın e-postası yok" durumu: iş yeniden denenmez (belge geçerlidir, müşteri ekranında görünür) */
export const NO_EMAIL = 'NO_EMAIL';

const backoffMinutes = (attempt) => [1, 5, 15, 30, 60, 120, 240, 480][Math.min(attempt, 7)];
export const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

/**
 * Mali belge e-postasının alıcısı (karar 115) — yalnızca proforma / avans faturası / fatura e-postaları için:
 *   1. firmanın "E-mail facturare" adresi (Customer.billingEmail) — dolu ve geçerliyse
 *   2. yoksa firmanın genel e-postası (Customer.email) — dolu ve geçerliyse
 *   3. yoksa null → "Email yok" (iş NO_EMAIL ile kapanır; belge geçerlidir)
 * Kullanıcıların giriş e-postalarına ASLA düşülmez. Alıcı gönderim anında çözülür: "Email yok" belgesi, adres
 * girildikten sonra "Tekrar gönder" ile güncel adrese gider. Adres yalnızca teslim bilgisidir (erişim hakkı vermez).
 * @param {{ billingEmail?: string | null, email?: string | null } | null | undefined} customer
 * @returns {string | null}
 */
export function financialRecipient(customer) {
  for (const v of [customer?.billingEmail, customer?.email]) {
    const s = String(v ?? '').trim();
    if (isEmail(s)) return s;
  }
  return null;
}
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/**
 * Belge kesildiğinde (FgoDocument'in yazıldığı işlemde) müşteri e-postasını kuyruğa alır — belge başına BİR otomatik iş.
 * @param {any} tx  @param {{ docId: string, orderId?: string | null }} p
 * @returns {Promise<boolean>}  yeni iş yazıldı mı
 */
export async function queueDocEmail(tx, { docId, orderId = null }) {
  const had = await tx.notificationOutbox.findFirst({ where: { type: DOC_EMAIL, payload: { path: ['docId'], equals: docId } }, select: { id: true } });
  if (had) return false;
  await tx.notificationOutbox.create({ data: { type: DOC_EMAIL, orderId, payload: { docId } } });
  return true;
}

// ---------- PDF ----------
/**
 * Belgenin PDF'i (sunucu tarafında). Önce kayıtlı bağlantı; bağlantı yoksa ya da artık yoksa (404 / 410) FGO'dan
 * bağlantı yeniden istenir (factura/print — yalnızca okuma) ve kayda yazılır. FGO her çağrıda sorulmaz.
 *
 * FGO'nun verdiği bağlantı dış veridir (AUD-5 / AUD-7, karar 144): yalnızca FGO'nun kendi adresiyse indirilir, kayda
 * yazılır ve çağırana verilir (pdfUrl). İndirme yönlendirmeleri kendisi izler ve her adımı yeniden doğrular; yanıtı
 * sınırlı okur (downloadFgoPdf).
 * @param {any} db
 * @param {{ id: string, series: string, number: string, link?: string | null }} doc
 * @param {{ fetchImpl?: typeof fetch, secret?: string, appUrl?: string }} [ctx]
 * @returns {Promise<{ ok: true, bytes: Buffer } | { ok: false, link: string | null, error: string }>}
 *   ok değilse link: belgenin FGO'daki bağlantısı — YALNIZCA pdfUrl'den geçmişse (değilse null); müşteri e-postasına ve
 *   sahipliği doğrulanmış okuyanın yönlendirmesine yalnızca bu değer gider
 */
export async function fetchDocPdf(db, doc, { fetchImpl = fetch, secret, appUrl } = {}) {
  // Çağırana yalnızca doğrulanmış bağlantı döner; kayıtlı bağlantı FGO adresi değilse yok sayılır
  let link = pdfUrl(doc.link);
  let error = 'PDF bağlantısı yok';
  if (link) {
    const r = await downloadFgoPdf(link, { fetchImpl });
    if (r.ok) return r;
    error = r.error;
    if (r.status !== 404 && r.status !== 410) return { ok: false, link, error };
  }
  // Bağlantı yok ya da artık geçersiz: FGO'dan yenisi (ayar / anahtar yoksa sorulmaz)
  try {
    const env = getEnv();
    const settings = await getFgoSettings(db);
    const key = fgoReady(settings) ? fgoKey(settings, secret ?? env.AUTH_SECRET) : null;
    if (!key) return { ok: false, link, error };
    const given = await fgoPrint(settings, key, { series: doc.series, number: doc.number, appUrl: appUrl ?? env.APP_URL ?? '' }, fetchImpl);
    if (!given) return { ok: false, link, error };
    // FGO'nun verdiği bağlantı FGO adresi değilse: KAYDA YAZILMAZ, indirilmez, kimseye verilmez
    const fresh = pdfUrl(given);
    if (!fresh) return { ok: false, link, error: 'PDF adresi FGO adresi değil' };
    if (fresh !== doc.link) await db.fgoDocument.updateMany({ where: { id: doc.id }, data: { link: fresh } });
    link = fresh;
    const r = await downloadFgoPdf(fresh, { fetchImpl });
    return r.ok ? r : { ok: false, link, error: r.error };
  } catch (e) {
    // factura/print hatası (FGO'nun kendi iletisi; adres içermez)
    return { ok: false, link, error: String(e?.message ?? e).slice(0, 200) };
  }
}

// ---------- e-posta metni ----------
/** Belge türünün Romence adı (e-posta ve müşteri ekranı aynı adları kullanır) */
export const DOC_KIND_RO = { PROFORMA: 'Proformă', ADVANCE: 'Factură de avans', INVOICE: 'Factură' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n));
const dayRo = (d, timeZone) => new Intl.DateTimeFormat('ro-RO', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(d));

/**
 * Müşteriye giden Romence e-posta: belge türü, seri + numara, kesim tarihi, sipariş(ler), toplam ve para birimi, belgeye
 * erişim (ekteki PDF + TAKİP'teki "Documente financiare"). Maliyet, kâr, iç not, başka müşteri bilgisi içermez.
 * @param {{ kind: string, series: string, number: string, issuedAt?: Date | string | null, orderNos: string[], total?: unknown, currency?: string,
 *   firmName: string, attached?: boolean, portalUrl?: string | null, link?: string | null, timeZone?: string }} p
 *   link: yalnızca PDF eklenemediyse (belgenin FGO'daki bağlantısı); FGO adresi değilse e-postaya yazılmaz
 */
export function renderDocEmail({ kind, series, number, issuedAt = null, orderNos, total = null, currency = 'RON', firmName, attached = false, portalUrl = null, link = null, timeZone = 'Europe/Bucharest' }) {
  const type = DOC_KIND_RO[kind] ?? 'Document';
  const ref = `${series}${number}`;
  // E-postaya yalnızca FGO'nun kendi adresi yazılır (FGO'nun verdiği bağlantı dış veridir — AUD-7); değilse bağlantı satırı yok
  link = pdfUrl(link);
  const nos = orderNos.filter(Boolean);
  const many = nos.length > 1;
  const rows = [
    ['Tip document', type],
    ['Număr document', ref],
    ...(issuedAt ? [['Data emiterii', dayRo(issuedAt, timeZone)]] : []),
    ...(nos.length ? [[many ? 'Comenzi' : 'Comanda', nos.join(', ')]] : []),
    ...(total != null ? [['Total', `${money(total)} ${currency} (cu TVA)`]] : []),
  ];
  const access = [
    attached ? 'Documentul este atașat acestui e-mail (PDF).' : null,
    !attached && link ? `Document (PDF): ${link}` : null,
    portalUrl ? `Îl găsiți oricând și în portalul TAKİP, la „Documente financiare”: ${portalUrl}` : null,
  ].filter(Boolean);
  const text = [
    `Stimate client ${firmName},`,
    '',
    `Vă transmitem documentul ${type} ${ref}.`,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    ...access,
    '',
    'Cu stimă,',
    'GKH',
  ].join('\n');
  const subject = `${type} ${ref}${nos.length ? ` — ${many ? 'comenzile' : 'comanda'} ${nos.join(', ')}` : ''}`;
  // Ortak GKH düzeni (logo başlığı — server/mail/layout.js); burada yalnızca gövde üretilir
  const html = brandedHtml({ lang: 'ro', title: subject, body: `<p style="margin:0 0 12px">Stimate client ${esc(firmName)},</p>
<p>Vă transmitem documentul <b>${esc(type)} ${esc(ref)}</b>.</p>
<table cellpadding="4" style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="color:#6b7280">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('')}</table>
${attached ? '<p>Documentul este atașat acestui e-mail (PDF).</p>' : ''}${!attached && link ? `<p><a href="${esc(link)}">Deschide documentul (PDF)</a></p>` : ''}
${portalUrl ? `<p>Îl găsiți oricând și în portalul TAKİP, la „Documente financiare”:<br><a href="${esc(portalUrl)}">${esc(portalUrl)}</a></p>` : ''}
<p style="margin-bottom:0">Cu stimă,<br>GKH</p>` });
  return { subject, text, html };
}

// ---------- işçi ----------
class Permanent extends Error {}

/**
 * Kuyruktaki belge e-postalarını gönderir. Alıcı: financialRecipient — firmanın fatura e-postası (Customer.billingEmail),
 * yoksa firmanın e-postası (Customer.email).
 *   - E-posta yoksa: iş "e-posta yok" diye kapanır (yeniden denenmez); belge geçerlidir ve müşteri ekranında durur.
 *   - PDF: eklenir; alınamazsa iş birkaç dakika bekletilir, yine olmazsa e-posta eksiz, belge bağlantısıyla gider.
 *   - Tutar FGO'dan henüz okunmamışsa burada bir kez okunur (yalnızca okuma).
 * @param {any} db
 * @param {{ transport: any, from: string, appUrl?: string, now?: Date, fetchImpl?: typeof fetch, secret?: string, timeZone?: string, log?: Function }} ctx
 */
export async function dispatchDocEmails(db, { transport, from, appUrl, now = new Date(), fetchImpl = fetch, secret, timeZone, log = () => {} }) {
  if (!transport) return { sent: 0, failed: 0, skipped: 0 };
  const rows = await db.notificationOutbox.findMany({ where: { type: DOC_EMAIL, status: 'PENDING', availableAt: { lte: now } }, orderBy: { createdAt: 'asc' }, take: 10 });
  if (rows.length === 0) return { sent: 0, failed: 0, skipped: 0 };
  const env = getEnv();
  secret ??= env.AUTH_SECRET;
  appUrl = String(appUrl ?? env.APP_URL ?? '').replace(/\/+$/, '');
  timeZone ??= env.APP_TIMEZONE ?? 'Europe/Bucharest';
  let sent = 0, failed = 0, skipped = 0;
  for (const row of rows) {
    // Atomik sahiplenme + işlem kirası: e-postayı yalnızca sahiplenen işçi gönderir
    if (!(await claimFgoJob(db, row, { now, leaseMs: DOC_EMAIL_LEASE_MS }))) continue;
    const attempt = row.attempts + 1;
    const payload = obj(row.payload);
    const close = (why) => db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SKIPPED', lastError: why } });
    try {
      const doc = await db.fgoDocument.findUnique({
        where: { id: String(payload.docId ?? '') },
        include: { order: { include: { customer: true } }, batch: { include: { customer: true, orders: { select: { orderId: true, orderNo: true }, orderBy: { orderNo: 'asc' } } } } },
      });
      // Belge kaydı yoksa (FGO'da silinmiş) gönderilecek bir şey yok
      if (!doc) { await close('belge yok'); skipped++; continue; }
      // Sipariş belgesi ya da müşteri partisi belgesi (birden çok sipariş)
      const customer = doc.order?.customer ?? doc.batch?.customer;
      const orders = doc.order ? [{ orderId: doc.order.id, orderNo: doc.order.orderNo }] : doc.batch?.orders ?? [];
      if (!customer) throw new Permanent('belgenin müşterisi yok');
      // Alıcı ŞİMDİ çözülür (fatura e-postası → yoksa firmanın e-postası); kullanıcıların bildirim tercihi mali belgeyi etkilemez
      const to = financialRecipient(customer);
      if (!to) { await close(NO_EMAIL); skipped++; continue; }
      if (doc.total == null) {
        // Tutar henüz okunmamış (kesimden hemen sonraki okuma olmadıysa): e-postada toplam yazsın diye bir kez okunur
        try {
          const settings = await getFgoSettings(db);
          const key = fgoReady(settings) ? fgoKey(settings, secret) : null;
          if (key) {
            const st = await fgoStatus(settings, key, { series: doc.series, number: doc.number, appUrl }, fetchImpl);
            if (st.total != null) {
              await db.fgoDocument.update({ where: { id: doc.id }, data: { total: st.total.toFixed(2), paid: st.paid == null ? null : st.paid.toFixed(2), checkedAt: new Date() } });
              doc.total = st.total;
            }
          }
        } catch {
          // okunamadıysa e-posta toplam satırı olmadan gider; muhasebe ekranı sonra okur
        }
      }
      const pdf = await fetchDocPdf(db, doc, { fetchImpl, secret, appUrl });
      if (!pdf.ok && attempt <= PDF_WAIT_ATTEMPTS) {
        // PDF henüz alınamadı: kısa süre sonra yeniden (e-posta gönderilmedi)
        await db.notificationOutbox.update({ where: { id: row.id }, data: { lastError: `PDF alınamadı: ${pdf.error}`.slice(0, 300), availableAt: new Date(now.getTime() + 2 * 60_000) } });
        failed++;
        continue;
      }
      const mail = renderDocEmail({
        kind: doc.kind, series: doc.series, number: doc.number, issuedAt: doc.issuedAt, orderNos: orders.map((o) => o.orderNo), total: doc.total, currency: doc.currency,
        firmName: customer.name, attached: pdf.ok, portalUrl: appUrl ? `${appUrl}/belgeler` : null, link: pdf.ok ? null : pdf.link, timeZone,
      });
      await sendBrandedMail(transport, {
        from, to, subject: mail.subject, text: mail.text, html: mail.html, lang: 'ro',
        ...(pdf.ok ? { attachments: [{ filename: `${doc.series}${doc.number}.pdf`, content: pdf.bytes, contentType: 'application/pdf' }] } : {}),
      });
      await db.$transaction(async (tx) => {
        await tx.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SENT', sentAt: new Date(), lastError: null, payload: { ...payload, to, attached: pdf.ok } } });
        // Geçmiş notunda yalnızca belge no: alıcı adresi (müşterinin fatura e-postası) iş kuyruğundaki kayıtta durur (payload.to);
        // olay geçmişine yazılmaz (AUD-1 — eski satırlar okunurken server/orders/order-view.js ile korunur)
        for (const o of orders) await writeHistory(tx, { orderId: o.orderId, event: 'FGO_DOC_EMAILED', actorId: null, note: `${doc.series}${doc.number}` });
      });
      sent++;
    } catch (e) {
      failed++;
      const msg = String(e?.message ?? e).slice(0, 300);
      const final = e instanceof Permanent || attempt >= DOC_EMAIL_MAX_ATTEMPTS;
      await db.notificationOutbox.update({ where: { id: row.id }, data: { lastError: msg, ...(final ? { status: 'FAILED' } : { availableAt: new Date(now.getTime() + backoffMinutes(attempt) * 60_000) }) } });
      log('belge e-postası gönderilemedi', row.orderId, msg);
    }
  }
  return { sent, failed, skipped };
}

// ---------- yönetici: e-posta durumu ve yeniden gönderme ----------
/**
 * Kuyruk satırı → e-posta durumu (Muhasebe → Tahsilat). SENT: gönderildi · PENDING: bekliyor (yeniden deneme dahil) ·
 * FAILED: gönderilemedi · NO_EMAIL: firmanın e-postası yok. Kapatılmış başka satır (belge silinmiş) → null.
 * @returns {{ state: 'SENT' | 'PENDING' | 'FAILED' | 'NO_EMAIL', at: Date | null, error: string | null, to: string | null, manual: boolean } | null}
 */
export function emailState(row) {
  if (!row) return null;
  const p = obj(row.payload);
  const base = { at: row.sentAt ?? row.createdAt ?? null, error: null, to: typeof p.to === 'string' ? p.to : null, manual: p.manual === true };
  if (row.status === 'SENT') return { ...base, state: 'SENT' };
  if (row.status === 'PENDING') return { ...base, state: 'PENDING', error: row.lastError ?? null };
  if (row.status === 'FAILED') return { ...base, state: 'FAILED', error: row.lastError ?? null };
  if (row.status === 'SKIPPED' && row.lastError === NO_EMAIL) return { ...base, state: 'NO_EMAIL' };
  return null;
}

/**
 * Belgelerin e-posta durumu: belge başına EN SON e-posta işi (otomatik ya da elle yeniden gönderme).
 * @param {any} db  @param {{ id: string, issuedAt?: Date | null, createdAt?: Date | null }[]} docs
 * @returns {Promise<Map<string, NonNullable<ReturnType<typeof emailState>>>>}
 */
export async function emailStates(db, docs) {
  const out = new Map();
  if (docs.length === 0) return out;
  const ids = new Set(docs.map((d) => d.id));
  const since = docs.reduce((m, d) => Math.min(m, new Date(d.createdAt ?? d.issuedAt ?? 0).getTime()), Date.now());
  const rows = await db.notificationOutbox.findMany({
    where: { type: DOC_EMAIL, createdAt: { gte: new Date(since - 60_000) } },
    orderBy: { createdAt: 'asc' },
    select: { status: true, lastError: true, sentAt: true, createdAt: true, payload: true },
  });
  for (const r of rows) {
    const id = obj(r.payload).docId;
    if (!ids.has(id)) continue;
    const st = emailState(r);
    if (st) out.set(id, st); // sonraki (daha yeni) satır öncekinin yerini alır
  }
  return out;
}

/**
 * Yönetici: kesilmiş bir belgenin e-postasını YENİDEN gönderir (Muhasebe → Tahsilat). Yalnızca TAKİP e-postasıdır:
 * FGO'da belge kesmez (emitere çağrılmaz), numaraya, IdExtern'e ve faturalamaya dokunmaz. Bilinçli bir istektir: otomatik
 * e-postanın tekrar engeline takılmaz; aynı belge için kuyrukta bekleyen iş varken ikinci iş yazılmaz (çift tıklama).
 * @param {any} db  @param {{ docId: string, actor: { id: string, role: string, ip?: string | null }, now?: Date }} p
 * @returns {Promise<{ ok: true } | { ok: false, code: 'FORBIDDEN' | 'NOT_FOUND' | 'ALREADY_QUEUED' }>}
 */
export async function resendDocEmail(db, { docId, actor, now = new Date() }) {
  if (!can(actor?.role, 'ACCOUNTING_MANAGE')) return { ok: false, code: 'FORBIDDEN' };
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`doc-email:${docId}`}, 0))`;
    const doc = await tx.fgoDocument.findUnique({ where: { id: String(docId ?? '') }, select: { id: true, orderId: true, batchId: true, kind: true, series: true, number: true } });
    if (!doc) return { ok: false, code: 'NOT_FOUND' };
    const waiting = await tx.notificationOutbox.findFirst({ where: { type: DOC_EMAIL, status: 'PENDING', payload: { path: ['docId'], equals: doc.id } }, select: { id: true } });
    if (waiting) return { ok: false, code: 'ALREADY_QUEUED' };
    // inAppAt dolu: elle yeniden gönderme uygulama içi bildirimi yinelemez
    await tx.notificationOutbox.create({ data: { type: DOC_EMAIL, orderId: doc.orderId, inAppAt: now, payload: { docId: doc.id, manual: true, by: actor.id } } });
    await writeAudit(tx, {
      action: 'FGO_DOC_EMAIL_RESEND', entityType: 'FgoDocument', entityId: doc.id, userId: actor.id,
      details: { kind: doc.kind, series: doc.series, number: doc.number, orderId: doc.orderId, batchId: doc.batchId },
    }, actor);
    return { ok: true };
  });
}
