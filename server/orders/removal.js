// Siparişi silme / geri yükleme (Aşama 9, karar 110; iki aşamalı onay ve mali kilit — fonksiyonel paket 4) — yalnızca
// yönetici (ORDER_CANCEL; yetki burada, sunucuda denetlenir).
//
//   "Sil" veritabanından SİLMEZ: sipariş kaydı ve ona bağlı her şey (teklif sürümleri, çizim sürümleri, dosyalar, notlar,
//   denetim kaydı, bildirimler) yerinde durur. Sipariş yalnızca olağan kullanımdan kalkar:
//     - removedAt dolar → sipariş kapsamı (server/orders/scope.js) onu hiçbir role göstermez: listeler, arama, sipariş
//       sayfası, teklifler, dosya indirme, iş akışı işlemleri;
//     - durum IPTAL olur → iptal edilmiş siparişi dışlayan her yer (yükleme planı ve onayı, aktarım, sandık, müşteri
//       proforması / faturası, sipariş başına belge, kârlılık planı, kuyruklar) onu da dışlar. Önceki durum
//       removedStatus'ta saklanır.
//   İki aşama (Paket 4): 1) önizleme — sipariş numarası, sonucu ve engeller (removalPreview, yalnızca okur); 2) ayrı son
//   onay — yönetici sipariş numarasını yazar (removeOrder; sunucu numarayı ve önizlemedeki sürümü denetler).
//   Mali / operasyonel geçmişi olan sipariş SİLİNMEZ (LOCKED + nedenler — server/orders/financial-lock.js): silinen sipariş
//   faturalamadan, yükleme planından ve depodan düştüğü için açık süreç (fatura, avans, teslim) tamamlanamaz kalırdı.
//   Kuyrukta bekleyen bir belge / depo e-postası varken de silinmez (BUSY). Silme hiçbir FGO işlemi yapmaz.
//
//   Profil siparişi (3.86.0, karar 281): yönetici / yönetici yardımcısı (ORDER_CANCEL) siler. Silmeden ÖNCE FGO canlı olarak
//   doğrulanır (verifyFgoForRemoval — yalnızca okur; FGO kapalı / anahtar yok / erişilemiyorsa silme REDDEDİLİR:
//   FGO_UNVERIFIED). Proforma / avans / fatura / ödeme kaydı varsa silinmez (LOCKED). Depoya gitmiş, stoktan düşülmüş ama
//   teslim edilmemiş sipariş silinebilir: siparişin stok hareketlerinin NET düşümü (Σ hareket < 0, ürün başına) aynı
//   işlemde IADE hareketiyle geri eklenir — tahmin yok, yalnızca gerçek hareketlerden; düşülmemiş miktar iade edilmez.
//   Mantıksal silme + stok iadesi + geçmiş + denetim TEK işlemdir (hata → hepsi geri alınır). Tekrarlanan / eşzamanlı istek:
//   sipariş satırı kilidi + "zaten silinmiş" denetimi + net hesap → ikinci iade oluşmaz. Stok iadesi yapılmış silinmiş profil
//   siparişi geri yüklenmez (STOCK_RETURNED: stok yeniden düşülmeden sipariş açılmaz).
//
//   "Geri yükle": sipariş önceki durumuna döner, removedAt boşalır. Hiçbir kayıt yeniden üretilmez (silinirken hiçbir şey
//   silinmediği için çoğalacak bir şey yoktur). İki işlem de geçmişe (REMOVED / RESTORED) ve denetim kaydına yazılır;
//   engellenen silme denemesi ORDER_REMOVE_BLOCKED olarak denetime yazılır.
import { can } from '../auth/permissions.js';
import { writeAudit, writeHistory } from './journal.js';
import { refreshSla } from './transitions.js';
import { busyOf, loadLockFacts, lockReasons } from './financial-lock.js';
import { fgoDocumentAbsent, fgoKey, fgoReady, fgoStatus, getFgoSettings } from '../integrations/fgo.js';
import { lockStock, returnRemovedOrderStock, stockToReturn } from '../profile/stock.js';

export { stockToReturn };

/**
 * Profil siparişi silinmeden önce FGO canlı doğrulaması (karar 281) — yalnızca OKUR: FGO açık ve anahtarı kayıtlı olmalı,
 * FGO'ya kimlikli bir okuma isteği (factura/getstatus, var olmayan "0" numaralı belge) KESİN bir yanıt vermeli: belge
 * bilgisi ya da FGO'nun "belge yok" yanıtı (fgoDocumentAbsent — kimlik kabul edildi). Ağ hatası, zaman aşımı, 5xx / 429,
 * kimlik / firma hatası ya da belirsiz yanıt → doğrulanamadı. Hiçbir belge kesilmez, iptal edilmez, değiştirilmez.
 * Sonuç: { ok: true, at } | { ok: false, code: FGO_DISABLED | NO_KEY | FGO_UNREACHABLE }.
 * @param {any} db  @param {{ secret: string, fetchImpl?: typeof fetch, now?: () => Date }} o
 */
export async function verifyFgoForRemoval(db, { secret, fetchImpl = fetch, now = () => new Date() }) {
  const settings = await getFgoSettings(db);
  if (!fgoReady(settings)) return { ok: false, code: 'FGO_DISABLED' };
  let key = null;
  try { key = fgoKey(settings, secret); } catch { key = null; }
  if (!key) return { ok: false, code: 'NO_KEY' };
  try {
    await fgoStatus(settings, key, { series: settings.invoiceSeries, number: '0' }, fetchImpl);
    return { ok: true, at: now() };
  } catch (e) {
    return fgoDocumentAbsent(e) ? { ok: true, at: now() } : { ok: false, code: 'FGO_UNREACHABLE' };
  }
}

/** Önizleme / sonuç için iade satırları: ürün kodu, adı, birimi (siparişteki kopya, yoksa katalog) */
async function returnRows(db, orderId, returns) {
  if (!returns.length) return [];
  const ids = returns.map((r) => r.productId);
  const [items, products] = await Promise.all([
    db.profileOrderItem.findMany({ where: { orderId, productId: { in: ids } }, select: { productId: true, code: true, nameTr: true, nameRo: true, unitCode: true } }),
    db.profileProduct.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, nameTr: true, nameRo: true, unitCode: true } }),
  ]);
  return returns.map((r) => {
    const src = items.find((i) => i.productId === r.productId) ?? products.find((p) => p.id === r.productId) ?? null;
    return { productId: r.productId, code: src?.code ?? '?', nameTr: src?.nameTr ?? '', nameRo: src?.nameRo ?? '', unit: src?.unitCode ?? '', qty: r.qty };
  });
}

const fail = (code, extra = {}) => ({ ok: false, code, ...extra });
/** Sipariş numarası karşılaştırması (ikinci adımın onayı): boşluk ve büyük-küçük harf farkı sayılmaz */
const sameNo = (a, b) => String(a ?? '').trim().toLocaleUpperCase('tr-TR') === String(b ?? '').trim().toLocaleUpperCase('tr-TR') && String(b ?? '').trim() !== '';

/**
 * Silme önizlemesi (1. adım — yalnızca okur): silinecek sipariş, sonucu ve silmeyi engelleyen nedenler. Son karar
 * removeOrder'da AYNI kuralla (server/orders/financial-lock.js → lockReasons 'remove'), kilit altında yeniden verilir.
 *   busy: kuyrukta bekleyen belge isteği / depo e-postası / sonuçlanmamış müşteri belgesi (önce iş bitmeli)
 *   reasons: mali / operasyonel geçmiş (FGO belgesi, müşteri belgesi kapsamı, onaylı yükleme, yüklenmiş sipariş, profilde
 *            proforma / ödeme / depo / teslim / fatura) — varsa silinmez
 * @param {any} db  @param {string} orderId
 * @returns {Promise<null | { orderNo: string, title: string | null, version: number, busy: boolean, reasons: import('./financial-lock.js').LockReason[],
 *   kept: { offers: number, drawings: number, files: number, notes: number }, profile: boolean, fgoCheck: boolean,
 *   stockReturn: { productId: string, code: string, nameTr: string, nameRo: string, unit: string, qty: number }[] }>}
 */
export async function removalPreview(db, orderId) {
  const id = String(orderId ?? '');
  const order = await db.order.findUnique({
    where: { id },
    select: { orderNo: true, title: true, version: true, removedAt: true, orderTypeCode: true, _count: { select: { offers: true, drawings: true, files: true, notes: true } } },
  });
  if (!order || order.removedAt) return null;
  const facts = await loadLockFacts(db, id);
  if (!facts) return null;
  const profile = order.orderTypeCode === 'PROFILE_ORDER';
  const moves = profile ? await db.stockMovement.findMany({ where: { orderId: id }, select: { productId: true, qty: true } }) : [];
  return {
    orderNo: order.orderNo, title: order.title ?? null, version: order.version, busy: busyOf(facts), reasons: lockReasons(facts, 'remove'),
    kept: { offers: order._count.offers, drawings: order._count.drawings, files: order._count.files, notes: order._count.notes },
    profile, fgoCheck: profile, stockReturn: profile ? await returnRows(db, id, stockToReturn(moves)) : [],
  };
}

/**
 * Siparişi siler (yumuşak) — iki aşamalı onayın ikinci adımı (Paket 4). confirmNo: yöneticinin elle yazdığı sipariş
 * numarası (siparişinkiyle aynı olmalı); expectedVersion: önizlemedeki sipariş sürümü (bu arada değiştiyse STALE).
 * Engeller (kilit altında): kuyrukta iş → BUSY · mali / operasyonel geçmiş → LOCKED + nedenler (denetim kaydına da yazılır:
 * ORDER_REMOVE_BLOCKED). Hiçbir kayıt fiziksel olarak silinmez.
 * Kilit sırası belge isteği, yükleme onayı ve fiyat güncellemesiyle aynı: yükleme onayı → sipariş belgesi → sipariş satırı.
 * @param {any} db
 * Profil siparişinde (karar 281) fgoCheck ZORUNLUDUR (verifyFgoForRemoval'ı çağıran işlev): işlemden ÖNCE çalışır; başarısızsa
 * silme yapılmaz (FGO_UNVERIFIED + fgo kodu; denetime ORDER_REMOVE_BLOCKED). Stoktan net düşülmüş miktar aynı işlemde iade
 * edilir (IADE hareketi, createdAt = now) ve sonuçta döner.
 * @param {any} db
 * @param {{ orderId: string, confirmNo: string | null | undefined, expectedVersion?: number | null, actor: { id: string, role: string, ip?: string | null }, now?: Date,
 *   fgoCheck?: (() => Promise<{ ok: boolean, code?: string, at?: Date }>) | null }} p
 * @returns {Promise<{ ok: true, orderNo: string, stockReturned?: { code: string, qty: number, unit: string }[] } | { ok: false, code: 'FORBIDDEN' | 'CONFIRM_REQUIRED' | 'NOT_FOUND' | 'ALREADY_REMOVED' | 'STALE' | 'BUSY' | 'LOCKED' | 'FGO_UNVERIFIED', reasons?: object[], fgo?: string }>}
 */
export async function removeOrder(db, { orderId, confirmNo, expectedVersion = null, actor, now = new Date(), fgoCheck = null }) {
  if (!can(actor?.role, 'ORDER_CANCEL')) return fail('FORBIDDEN');
  if (!String(confirmNo ?? '').trim()) return fail('CONFIRM_REQUIRED');
  const id = String(orderId ?? '');
  // Profil siparişi: FGO canlı doğrulaması işlemden ÖNCE (ağ isteği kilit / işlem tutarken yapılmaz). Sipariş türü sonradan
  // değişmez; işlem içinde yeniden okunur ve doğrulanmamış profil siparişi asla silinmez.
  const head = await db.order.findUnique({ where: { id }, select: { orderTypeCode: true, orderNo: true, removedAt: true } });
  let fgo = null;
  if (head && !head.removedAt && head.orderTypeCode === 'PROFILE_ORDER') {
    if (!sameNo(confirmNo, head.orderNo)) return fail('CONFIRM_REQUIRED');
    let r;
    try { r = fgoCheck ? await fgoCheck() : { ok: false, code: 'FGO_DISABLED' }; } catch { r = { ok: false, code: 'FGO_UNREACHABLE' }; }
    if (!r?.ok) {
      const code = String(r?.code ?? 'FGO_UNREACHABLE');
      await writeAudit(db, {
        action: 'ORDER_REMOVE_BLOCKED', entityType: 'Order', entityId: id, userId: actor.id,
        details: { orderNo: head.orderNo, reasons: [{ code: 'FGO_UNVERIFIED', ref: code }] },
      }, actor);
      return fail('FGO_UNVERIFIED', { fgo: code });
    }
    fgo = r.at instanceof Date ? r.at : now;
  }
  return db.$transaction(async (tx) => {
    // Profil: stok kilitleri SİPARİŞ SATIRI KİLİDİNDEN ÖNCE (depoya gönderme / iptal işlemleriyle aynı sıra: önce ürün,
    // sonra sipariş — kilitlenme olmaz). Ürünler: sipariş kalemleri + siparişin mevcut stok hareketleri.
    if (fgo) {
      const [its, mv] = await Promise.all([
        tx.profileOrderItem.findMany({ where: { orderId: id }, select: { productId: true } }),
        tx.stockMovement.findMany({ where: { orderId: id }, select: { productId: true } }),
      ]);
      await lockStock(tx, [...its.map((i) => i.productId), ...mv.map((m) => m.productId)]);
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('loading-confirmation', 0))`;
    // Sipariş başına belge isteğiyle aynı kilit: silme ile belge isteği birbirinin arasına giremez
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`glass-billing:${id}`}, 0))`;
    // Sipariş satırı kilitlenir: aynı anda çalışan iş akışı işlemi (depo, teslim, ödeme …) bitene kadar beklenir, sonra
    // güncel kayıtlarla karar verilir
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${id} FOR UPDATE`;
    const order = await tx.order.findUnique({
      where: { id },
      select: {
        id: true, orderNo: true, status: true, version: true, removedAt: true, customerId: true, orderTypeCode: true,
        _count: { select: { offers: true, drawings: true, files: true, notes: true, compensationsFrom: true, compensationsTo: true, crateLinks: true } },
      },
    });
    if (!order) return fail('NOT_FOUND');
    if (order.removedAt) return fail('ALREADY_REMOVED');
    if (!sameNo(confirmNo, order.orderNo)) return fail('CONFIRM_REQUIRED');
    if (expectedVersion != null && Number(expectedVersion) !== order.version) return fail('STALE');
    // Doğrulanmamış profil siparişi asla silinmez (ön okuma ile işlem arasında bir şey değiştiyse bile)
    const profile = order.orderTypeCode === 'PROFILE_ORDER';
    if (profile && !fgo) return fail('FGO_UNVERIFIED', { fgo: 'FGO_DISABLED' });
    const facts = await loadLockFacts(tx, order.id);
    if (!facts || busyOf(facts)) return fail('BUSY');
    const reasons = lockReasons(facts, 'remove');
    if (reasons.length) {
      // Engellenen deneme de denetime yazılır (yalnızca neden kodları ve belge no / gün — tutar yok)
      await writeAudit(tx, {
        action: 'ORDER_REMOVE_BLOCKED', entityType: 'Order', entityId: order.id, userId: actor.id,
        details: { orderNo: order.orderNo, status: order.status, reasons },
      }, actor);
      return fail('LOCKED', { reasons });
    }
    // Profil: stoktan NET düşülmüş miktar geri eklenir (gerçek hareketlerden; kilitler altında yeniden okunur)
    let returned = [];
    if (profile) {
      const back = await returnRemovedOrderStock(tx, { orderId: order.id, orderNo: order.orderNo, actorId: actor.id, at: now });
      returned = await returnRows(tx, order.id, back);
      // Depo bağlantısı geçersiz; stok artık düşülmüş değil (iptaldekiyle aynı)
      await tx.profileOrder.updateMany({ where: { orderId: order.id }, data: { depotTokenHash: null, depotTokenExpiresAt: null, stockDeducted: false } });
      // Siparişin açık stok yetersizliği uyarısı kapanır (sipariş artık yok)
      await tx.adminAlert.updateMany({ where: { orderId: order.id, type: 'STOCK_SHORTAGE', resolvedAt: null }, data: { resolvedAt: now, resolvedById: actor.id } });
    }
    await tx.order.update({
      where: { id: order.id },
      // Numara serbest kalır (karar 260): silinmiş siparişin numarası yeni siparişe verilebilir — sipariş no ve geçmiş değişmez
      data: { removedAt: now, removedById: actor.id, removedStatus: order.status, status: 'IPTAL', slaDeadline: null, numberActive: null, version: { increment: 1 } },
    });
    await writeHistory(tx, { orderId: order.id, event: 'REMOVED', from: order.status, to: 'IPTAL', actorId: actor.id });
    await writeAudit(tx, {
      action: 'ORDER_REMOVED', entityType: 'Order', entityId: order.id, userId: actor.id,
      details: {
        orderNo: order.orderNo, customerId: order.customerId, orderType: order.orderTypeCode, statusBefore: order.status,
        // Korunan kayıtların sayısı (hiçbiri silinmedi / değişmedi)
        kept: {
          offers: order._count.offers, drawings: order._count.drawings, files: order._count.files, notes: order._count.notes,
          crateLinks: order._count.crateLinks, compensations: order._count.compensationsFrom + order._count.compensationsTo,
        },
        ...(profile ? { fgoVerifiedAt: fgo.toISOString(), stockReturned: returned.map((r) => ({ productId: r.productId, code: r.code, qty: r.qty, unit: r.unit })) } : {}),
      },
    }, actor);
    // Cam siparişinin sonucu eskisiyle aynı; profil siparişinde stoğa geri eklenenler de döner
    return { ok: true, orderNo: order.orderNo, ...(profile ? { stockReturned: returned.map((r) => ({ code: r.code, qty: r.qty, unit: r.unit })) } : {}) };
  });
}

/**
 * Silinmiş siparişi geri yükler: önceki durumuna döner. Hiçbir kayıt yeniden üretilmez. Silindikten sonra numarası yeni
 * bir siparişe verildiyse geri yüklenmez (NUMBER_TAKEN — karar 260).
 * @param {any} db
 * @param {{ orderId: string, actor: { id: string, role: string, ip?: string | null }, now?: Date }} p
 * @returns {Promise<{ ok: true, orderNo: string, status: string } | { ok: false, code: 'FORBIDDEN' | 'NOT_FOUND' | 'NOT_REMOVED' | 'NUMBER_TAKEN' | 'STOCK_RETURNED', orderNo?: string }>}
 */
export async function restoreOrder(db, { orderId, actor }) {
  if (!can(actor?.role, 'ORDER_CANCEL')) return fail('FORBIDDEN');
  const id = String(orderId ?? '');
  const head = await db.order.findUnique({ where: { id }, select: { customerId: true } });
  if (!head) return fail('NOT_FOUND');
  try {
    return await db.$transaction(async (tx) => {
      // Numara kilidi (sipariş oluşturmayla aynı, karar 260) → sipariş belgesi kilidi: sıra telafi / oluşturma ile aynı
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`order-no:${head.customerId}`}, 0))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`glass-billing:${id}`}, 0))`;
      const order = await tx.order.findUnique({
        where: { id },
        select: { id: true, orderNo: true, status: true, removedAt: true, removedStatus: true, orderTypeCode: true, customerId: true, customerOrderNo: true, compSeq: true },
      });
      if (!order) return fail('NOT_FOUND');
      if (!order.removedAt) return fail('NOT_REMOVED');
      // Silinirken stoğu iade edilmiş profil siparişi geri yüklenmez: stok yeniden düşülmeden sipariş açılırsa stok iki kez
      // sayılırdı (karar 281)
      if (order.orderTypeCode === 'PROFILE_ORDER') {
        const back = await tx.stockMovement.count({ where: { orderId: order.id, kind: 'IADE', createdAt: { gte: order.removedAt } } });
        if (back > 0) return fail('STOCK_RETURNED', { orderNo: order.orderNo });
      }
      // Silindikten sonra numarası yeni bir siparişe verildiyse geri yüklenmez (iki etkin sipariş aynı numarayı taşıyamaz)
      const taken = await tx.order.findFirst({
        where: {
          id: { not: order.id }, numberActive: true,
          OR: [{ orderNo: order.orderNo }, { customerId: order.customerId, orderTypeCode: order.orderTypeCode, customerOrderNo: order.customerOrderNo, compSeq: order.compSeq }],
        },
        select: { orderNo: true },
      });
      if (taken) return fail('NUMBER_TAKEN', { orderNo: taken.orderNo });
      const status = order.removedStatus ?? order.status;
      await tx.order.update({
        where: { id: order.id },
        data: { removedAt: null, removedById: null, removedStatus: null, status, numberActive: true, version: { increment: 1 } },
      });
      // Cam siparişinde SLA son tarihi güncel duruma göre yeniden hesaplanır (profil siparişinin SLA'sı kendi akışındadır)
      if (order.orderTypeCode === 'GLASS_ORDER') await refreshSla(tx, order.id);
      await writeHistory(tx, { orderId: order.id, event: 'RESTORED', from: 'IPTAL', to: status, actorId: actor.id });
      await writeAudit(tx, { action: 'ORDER_RESTORED', entityType: 'Order', entityId: order.id, userId: actor.id, details: { orderNo: order.orderNo, status } }, actor);
      return { ok: true, orderNo: order.orderNo, status };
    });
  } catch (e) {
    // Yarış: numara aynı anda yeni siparişe verildi (benzersiz indeks) — geri yükleme yapılmaz
    if (/** @type {any} */ (e)?.code === 'P2002') return fail('NUMBER_TAKEN');
    throw e;
  }
}

/** Silinmiş siparişler (yönetici ekranı: geri yükleme). En yeniler önce. */
export function removedOrders(db, { take = 50 } = {}) {
  return db.order.findMany({
    where: { removedAt: { not: null } },
    orderBy: { removedAt: 'desc' },
    take,
    select: {
      id: true, orderNo: true, title: true, orderTypeCode: true, removedAt: true, removedStatus: true,
      customer: { select: { name: true } }, removedBy: { select: { name: true } },
      _count: { select: { fgoDocuments: true } },
    },
  });
}
