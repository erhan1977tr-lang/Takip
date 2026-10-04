// Sipariş notlarının otomatik çevirisi (karar 127) — kural, ayar ve kayıt tek yerde.
//   Yön yazanın ROLÜNDEN gelir (dil tanımaya bırakılmaz):  müşteri → Türkçe (tr) · yönetici / satış / çizim → Romence (ro)
//   Çeviri not YAZILIRKEN bir kez yapılır ve notun satırında saklanır; sayfa açılışı / yenileme çeviri YAPMAZ.
//   Özgün metin hiçbir zaman değişmez. Not her durumda önce kaydedilir: çeviri başarısız olsa da (zaman aşımı, kota,
//   anahtar) not kaybolmaz; başarısızlık nota güvenli bir kodla yazılır (FAILED) ve kendiliğinden yeniden denenmez —
//   yalnızca iç ekip "Yeniden dene" ile bir kez daha ister.
//   Görünürlük: çeviri, notun görünürlüğünü AŞAMAZ. İç not hiç çevrilmez (Google'a da gitmez). Müşteriye yalnızca
//   kendi tarafının (Romence) tamamlanmış çevirisi gider; hata kodu / bekleme durumu müşteriye gitmez. Denetimci notları
//   yalnızca özgün dilinde görür: çeviri, durum ve "yeniden dene" ona gitmez (karar 128; kural: server/notes/view.js).
//   Anahtar: yalnızca Entegrasyonlar ekranından girilir, şifreli saklanır (server/crypto/secret.js), hiçbir yanıta,
//   günlüğe ya da denetim kaydına yazılmaz; ekranda yalnızca "kayıtlı" olduğu görünür.
import { can } from '../auth/permissions.js';
import { STALE_PENDING_MS, canRetryTranslation, translationTarget } from './view.js';
import { orderScope } from '../orders/scope.js';
import { writeAudit } from '../orders/journal.js';
import { getEnv } from '../env.js';
import { openSecret, sealSecret } from '../crypto/secret.js';
import { TranslateError, translatorFor } from './provider.js';

// Saf kurallar (yön, görünürlük, durum) server/notes/view.js'tedir: sipariş sayfası yalnızca onu yükler — sağlayıcıya
// (Google) giden kod bu dosyadadır ve yalnızca aşağıdaki üç işlevden çağrılır: addNote (yeni not), retryNoteTranslation
// (iç ekibin açık isteği), testTranslation (yöneticinin "Bağlantıyı dene" düğmesi; not okumaz).
export { STALE_PENDING_MS, canRetryTranslation, noteView, notesFor, translationState, translationTarget } from './view.js';

export const TRANSLATE_KEY = 'translate';
const SECRET_PURPOSE = 'translate-key';
export const NOTE_MAX = 4000;
/** Bağlantı denemesinde çevrilen zararsız metin */
export const TEST_PHRASE = 'Bună ziua';

// ---------- ayar ----------
async function readSettings(db) {
  const row = await db.integrationSetting.findUnique({ where: { key: TRANSLATE_KEY } });
  const v = row?.value && typeof row.value === 'object' ? row.value : {};
  return { enabled: v.enabled === true, keySealed: typeof v.keySealed === 'string' && v.keySealed ? v.keySealed : null };
}

/**
 * Ekran için ayar: anahtarın kendisi (şifreli hâli de) dönmez, yalnızca kayıtlı olup olmadığı.
 * @returns {Promise<{ enabled: boolean, hasKey: boolean }>}
 */
export async function getTranslateSettings(db) {
  const s = await readSettings(db);
  return { enabled: s.enabled, hasKey: !!s.keySealed };
}

/** Çeviri yapılır mı (açık ve anahtar kayıtlı) */
export const translateReady = (s) => !!(s?.enabled && (s.hasKey || s.keySealed));

/** Girilen anahtar: boş = değiştirme. Boşluksuz, yazdırılabilir 20–200 karakter. */
export function parseTranslateKey(raw) {
  const key = String(raw ?? '').trim();
  if (!key) return { ok: true, key: '' };
  return /^[\x21-\x7e]{20,200}$/.test(key) ? { ok: true, key } : { ok: false };
}

/**
 * Ayarı kaydeder (yönetici — SETTINGS_MANAGE; denetim kaydıyla, anahtar kayda yazılmaz).
 * key boşsa kayıtlı anahtar kalır; clearKey anahtarı siler. Anahtarsız açılamaz (KEY).
 * @param {any} db
 * @param {{ enabled: boolean }} value
 * @param {{ key?: string, clearKey?: boolean, secret?: string }} o
 * @param {{ id: string, role: string, ip?: string | null }} actor
 * @returns {Promise<{ ok: true } | { ok: false, code: 'FORBIDDEN' | 'KEY_FORMAT' | 'KEY' }>}
 */
export async function saveTranslateSettings(db, { enabled }, { key = '', clearKey = false, secret = getEnv().AUTH_SECRET } = {}, actor) {
  if (!can(actor?.role, 'SETTINGS_MANAGE')) return { ok: false, code: 'FORBIDDEN' };
  const parsed = parseTranslateKey(key);
  if (!parsed.ok) return { ok: false, code: 'KEY_FORMAT' };
  return db.$transaction(async (tx) => {
    const before = await readSettings(tx);
    const keySealed = clearKey ? null : parsed.key ? sealSecret(parsed.key, secret, SECRET_PURPOSE) : before.keySealed;
    if (enabled && !keySealed) return { ok: false, code: 'KEY' };
    const next = { enabled: !!enabled, keySealed };
    await tx.integrationSetting.upsert({ where: { key: TRANSLATE_KEY }, create: { key: TRANSLATE_KEY, value: next, updatedById: actor.id }, update: { value: next, updatedById: actor.id } });
    await writeAudit(tx, {
      action: 'SETTINGS_UPDATE', entityType: 'IntegrationSetting', entityId: TRANSLATE_KEY, userId: actor.id,
      details: { before: { enabled: before.enabled, hasKey: !!before.keySealed }, after: { enabled: next.enabled, hasKey: !!keySealed }, keyChanged: !!parsed.key && !clearKey, keyCleared: !!clearKey },
    }, actor);
    return { ok: true };
  });
}

// ---------- çeviri ----------
const norm = (s) => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * "Sürüyor" durumundaki notu çevirir ve sonucu yazar. HİÇBİR ZAMAN hata fırlatmaz (not zaten kayıtlıdır).
 * @returns {Promise<'DONE' | 'SAME' | 'FAILED'>}
 */
async function runTranslation(db, note, { settings, secret, translator, now }) {
  let data;
  try {
    const key = settings.keySealed ? openSecret(settings.keySealed, secret, SECRET_PURPOSE) : null;
    if (!key) throw new TranslateError('NO_KEY');
    const r = await translator({ text: note.text, target: note.translationLang, key });
    const out = typeof r?.text === 'string' ? r.text : '';
    if (!out.trim()) throw new TranslateError('BAD_RESPONSE');
    // Çeviri özgün metinle aynıysa (not zaten hedef dilde yazılmış) gösterilecek bir şey yok
    data = norm(out) === norm(note.text)
      ? { translationStatus: 'SAME', translation: null, translationError: null }
      : { translationStatus: 'DONE', translation: out, translationError: null };
  } catch (e) {
    const code = e instanceof TranslateError ? e.code : 'ERROR';
    data = { translationStatus: 'FAILED', translation: null, translationError: code };
    // Günlüğe yalnızca not kimliği ve güvenli kod yazılır (metin, anahtar ve Google'ın yanıtı yazılmaz)
    console.warn('[not çevirisi] çevrilemedi', note.id, code);
  }
  try {
    await db.orderNote.updateMany({ where: { id: note.id, translationStatus: 'PENDING' }, data: { ...data, translationAt: now } });
  } catch (e) {
    console.warn('[not çevirisi] sonuç yazılamadı', note.id, String(e?.code ?? 'ERROR'));
    return 'FAILED';
  }
  return data.translationStatus;
}

/**
 * Sipariş notu ekler ve (çeviri açıksa, not müşteriye açıksa) bir kez çevirir. Not HER DURUMDA önce kaydedilir;
 * çeviri başarısız olursa not durur, durum FAILED olur. Sipariş, yazanın kapsamında değilse NOT_FOUND.
 * @param {any} db
 * @param {{ orderId: string, actor: { id: string, role: string, customerId?: string | null }, text: unknown, internal?: boolean,
 *   now?: Date, translator?: Function, secret?: string }} o
 * @returns {Promise<{ ok: true, noteId: string, translation: 'DONE' | 'SAME' | 'FAILED' | null } | { ok: false, code: 'FORBIDDEN' | 'EMPTY' | 'NOT_FOUND' }>}
 */
export async function addNote(db, { orderId, actor, text, internal = false, now = new Date(), translator = undefined, secret = undefined }) {
  if (!can(actor?.role, 'NOTE_ADD')) return { ok: false, code: 'FORBIDDEN' };
  const body = String(text ?? '').trim().slice(0, NOTE_MAX);
  if (!body) return { ok: false, code: 'EMPTY' };
  const order = await db.order.findFirst({ where: { id: String(orderId ?? ''), ...orderScope({ appRole: actor.role, customerId: actor.customerId }) }, select: { id: true } });
  if (!order) return { ok: false, code: 'NOT_FOUND' };
  // İç not yalnızca iç notları görebilen rol tarafından yazılabilir; iç not çevrilmez
  const isInternal = !!internal && can(actor.role, 'NOTE_INTERNAL_VIEW');
  const target = isInternal ? null : translationTarget(actor.role);
  let settings = null;
  if (target) {
    try {
      settings = await readSettings(db);
    } catch {
      settings = null; // ayar okunamadıysa not yine kaydedilir (çevirisiz)
    }
  }
  const translate = !!(target && translateReady(settings));
  const note = await db.orderNote.create({
    data: {
      orderId: order.id, userId: actor.id, text: body, internal: isInternal, createdAt: now,
      ...(translate ? { translationLang: target, translationStatus: 'PENDING', translationAt: now } : {}),
    },
  });
  const status = translate
    ? await runTranslation(db, note, { settings, secret: secret ?? getEnv().AUTH_SECRET, translator: translator ?? translatorFor(), now })
    : null;
  return { ok: true, noteId: note.id, translation: status };
}

/**
 * Çevrilemeyen (ya da yarıda kalan) notun çevirisini BİR KEZ daha ister — yalnızca iç ekip, açıkça istediğinde.
 * Aynı anda iki istek gelirse yalnızca biri çeviri yapar (atomik sahiplenme). Tamamlanmış çeviri yeniden yapılmaz.
 * @param {any} db
 * @param {{ noteId: string, orderId: string, actor: { id: string, role: string, customerId?: string | null, ip?: string | null }, now?: Date, translator?: Function, secret?: string }} o
 * @returns {Promise<{ ok: true, translation: 'DONE' | 'SAME' | 'FAILED' } | { ok: false, code: 'FORBIDDEN' | 'NOT_FOUND' | 'DISABLED' | 'NOT_ALLOWED' }>}
 */
export async function retryNoteTranslation(db, { noteId, orderId, actor, now = new Date(), translator = undefined, secret = undefined }) {
  if (!canRetryTranslation(actor?.role)) return { ok: false, code: 'FORBIDDEN' };
  const note = await db.orderNote.findFirst({
    where: { id: String(noteId ?? ''), orderId: String(orderId ?? ''), order: orderScope({ appRole: actor.role, customerId: actor.customerId }) },
  });
  if (!note) return { ok: false, code: 'NOT_FOUND' };
  const settings = await readSettings(db);
  if (!translateReady(settings)) return { ok: false, code: 'DISABLED' };
  const stale = new Date(now.getTime() - STALE_PENDING_MS);
  const claimed = await db.orderNote.updateMany({
    where: { id: note.id, internal: false, translationLang: { not: null }, OR: [{ translationStatus: 'FAILED' }, { translationStatus: 'PENDING', translationAt: { lt: stale } }] },
    data: { translationStatus: 'PENDING', translationError: null, translationAt: now },
  });
  if (claimed.count !== 1) return { ok: false, code: 'NOT_ALLOWED' };
  const status = await runTranslation(db, note, { settings, secret: secret ?? getEnv().AUTH_SECRET, translator: translator ?? translatorFor(), now });
  await writeAudit(db, {
    action: 'NOTE_TRANSLATION_RETRY', entityType: 'OrderNote', entityId: note.id, userId: actor.id,
    details: { orderId: note.orderId, lang: note.translationLang, before: note.translationStatus, beforeError: note.translationError, result: status },
  }, actor).catch(() => {});
  return { ok: true, translation: status };
}

/**
 * Bağlantı denemesi (yönetici): kayıtlı anahtarla zararsız bir ifadeyi çevirir. Hiçbir not okunmaz / yazılmaz.
 * Hata ayrıntısı (detail) Google'ın açıklamasıdır; anahtar ayıklanmış ve kısaltılmıştır.
 * @param {any} db
 * @param {{ actor: { id: string, role: string, ip?: string | null }, translator?: Function, secret?: string }} o
 * @returns {Promise<{ ok: true, sample: string } | { ok: false, code: string, detail?: string }>}
 */
export async function testTranslation(db, { actor, translator = undefined, secret = undefined }) {
  if (!can(actor?.role, 'SETTINGS_MANAGE')) return { ok: false, code: 'FORBIDDEN' };
  const settings = await readSettings(db);
  const key = settings.keySealed ? openSecret(settings.keySealed, secret ?? getEnv().AUTH_SECRET, SECRET_PURPOSE) : null;
  /** @type {{ ok: true, sample: string } | { ok: false, code: string, detail?: string }} */
  let result;
  if (!key) result = { ok: false, code: 'NO_KEY' };
  else {
    try {
      const r = await (translator ?? translatorFor())({ text: TEST_PHRASE, target: 'tr', key });
      result = typeof r?.text === 'string' && r.text.trim() ? { ok: true, sample: r.text.trim().slice(0, 120) } : { ok: false, code: 'BAD_RESPONSE' };
    } catch (e) {
      result = e instanceof TranslateError ? { ok: false, code: e.code, detail: e.detail || undefined } : { ok: false, code: 'ERROR' };
    }
  }
  await writeAudit(db, {
    action: 'TRANSLATE_TEST', entityType: 'IntegrationSetting', entityId: TRANSLATE_KEY, userId: actor.id,
    details: { ok: result.ok, code: result.ok ? null : result.code },
  }, actor).catch(() => {});
  return result;
}

/**
 * Son günlerde çevrilemeyen not sayısı (Entegrasyonlar ekranındaki uyarı).
 * @returns {Promise<number>}
 */
export function failedTranslations(db, { now = new Date(), days = 7 } = {}) {
  return db.orderNote.count({ where: { translationStatus: 'FAILED', translationAt: { gte: new Date(now.getTime() - days * 86_400_000) } } });
}
