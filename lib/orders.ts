import { notFound } from 'next/navigation';
import { Prisma } from '@prisma/client';
import { db } from './db';
import type { CurrentUser } from './auth/session';
import { canSeeCustomerName, maskName } from '../server/orders/rules.js';
import { userCan } from './permissions';
import { DRAWING_SCOPE, orderScope as scopeFor } from '../server/orders/scope.js';
import { customerView } from '../server/orders/customer-view.js';
import { drawingTranslationsFor, notesFor } from '../server/notes/view.js';
import { orderPeopleView } from '../server/orders/order-view.js';
import { pdfUrl } from '../server/documents/fgo-pdf.js';
import { drawingsView } from '../server/orders/drawing-access.js';
import { unreadCounts } from '../server/notes/unread.js';
import { orderAlertCounts } from '../server/notifications/order-alerts.js';

/** Müşteri yalnızca kendi firmasının siparişlerini görür; çizim ekibi yalnızca çizimli siparişleri; diğerleri hepsini. */
export function orderScope(user: CurrentUser): Prisma.OrderWhereInput {
  return scopeFor(user) as Prisma.OrderWhereInput;
}
/** Çizim ekibinin gördüğü siparişler — yöneticinin "Çizim Paneli" de aynı kapsamı kullanır (orderScope'a EK koşul). */
export const drawingScope = DRAWING_SCOPE as Prisma.OrderWhereInput;

export function customerLabel(user: CurrentUser, name: string): string {
  return canSeeCustomerName(user.appRole) ? name : maskName(name);
}

/**
 * Firma kaydını kullanıcının görebileceği hale getirir (kural: server/orders/customer-view.js): tam adı göremeyen
 * rollerde ad maskelenir (GLA**********) ve iletişim / fatura / kur politikası alanları boşaltılır; ticari iç alanlar
 * (kur yüzdesi, fiyat tablosu bağlantıları, grup) firmaları yöneten rol dışında kimseye gitmez. Veri veritabanından
 * gelir gelmez uygulanır; sayfa ve istemci bileşenleri bu alanları hiç görmez.
 */
export function sanitizeCustomer<C extends { name: string }>(user: CurrentUser, c: C): C {
  return customerView(user.appRole, c);
}

type PriceView = 'admin' | 'customer' | 'sales';
/** Fiyat görünümü (karar 4): yönetici iki fiyatı da görür; müşteri ve denetimci yalnızca müşteri fiyatını; satış yalnızca kendi fiyatını. */
function priceView(user: CurrentUser): PriceView {
  if (userCan(user, 'OFFER_SEND')) return 'admin';
  return userCan(user, 'PRICE_FINAL_VIEW') ? 'customer' : 'sales';
}
type OfferLike = { amount: unknown; offerAmount?: unknown; lines?: { unitPrice: unknown; offerPrice?: unknown; listPrice?: unknown; crateFee?: boolean }[] };
/**
 * Teklif fiyatlarını role göre temizler. Müşteri/denetimci için "fiyat" müşteri fiyatıdır (satırda unitPrice ve
 * teklifte amount alanına yazılır; satış fiyatı hiç gitmez). Satış müşteri fiyatını hiç almaz.
 * Sandık bedeli (Paket 4): yöneticinin sandık satırı satışa hiç gitmez (satır, müşteri fiyatıyla birlikte yöneticinin ve
 * müşterinin teklifindedir; satış fiyatı 0 olduğundan satışın tutarını değiştirmez). Satışın kaydı satırı korur
 * (server/orders/transitions.js → salesInput).
 * Eski teklifler (3.10 öncesi, offerAmount yok): gönderilen tutar zaten yöneticinin tutarıydı.
 */
function offerPrices<O extends OfferLike>(view: PriceView, o: O): O {
  if (view === 'admin') return o;
  if (view === 'sales') {
    return { ...o, offerAmount: null, ...(o.lines ? { lines: o.lines.filter((l) => !l.crateFee).map((l) => ({ ...l, offerPrice: null })) } : {}) } as O;
  }
  const legacy = o.offerAmount == null;
  return {
    ...o,
    amount: legacy ? o.amount : o.offerAmount,
    offerAmount: null,
    ...(o.lines ? { lines: o.lines.map((l) => ({ ...l, unitPrice: legacy ? l.unitPrice : l.offerPrice ?? ZERO, offerPrice: null, listPrice: null })) } : {}),
  } as O;
}

/**
 * Liste sorgularının satırlarını temizler (sanitizeOrder ile aynı kurallar; satırda olan alanlara uygulanır).
 */
export function sanitizeRows<R extends { customer: { name: string }; price?: unknown; offers?: ({ status: string } & Partial<OfferLike>)[] }>(user: CurrentUser, rows: R[]): R[] {
  const view = priceView(user);
  const priceOk = userCan(user, 'PRICE_FINAL_VIEW');
  const drafts = userCan(user, 'OFFER_DRAFT_VIEW');
  const offersOk = userCan(user, 'OFFER_VIEW');
  return rows.map((r) => {
    const out: R = { ...r, customer: sanitizeCustomer(user, r.customer) };
    if ('price' in r && !priceOk) out.price = null as R['price'];
    if (r.offers) {
      const visible = !offersOk ? [] : drafts ? r.offers : r.offers.filter((o) => o.status === 'GONDERILDI');
      out.offers = visible.map((o) => ('amount' in o ? offerPrices(view, o as OfferLike & typeof o) : o)) as R['offers'];
    }
    return out;
  });
}

/**
 * Siparişteki kişi ilişkilerinin alanları. Rol ve tür, kimliğin görene göre maskelenmesi için gerekir
 * (server/orders/order-view.js → personView: müşteri kişisinin adı / e-postası satış ve çizime hiç gitmez — AUD-2).
 */
const PERSON = { name: true, email: true, appRole: true, type: true } as const;

export const orderDetailInclude = {
  customer: true,
  items: true,
  files: { orderBy: { createdAt: 'asc' }, include: { uploadedBy: { select: PERSON } } },
  drawings: {
    orderBy: { version: 'asc' },
    include: {
      uploadedBy: { select: PERSON },
      revisions: { orderBy: { createdAt: 'asc' } },
      files: { orderBy: { createdAt: 'asc' } },
      sentBy: { select: { name: true, appRole: true, type: true } },
      decidedBy: { select: { name: true, appRole: true, type: true } },
    },
  },
  offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } },
  price: true,
  crateLinks: { include: { crate: { select: { crateNo: true, shipDay: true } } } },
  notes: { orderBy: { createdAt: 'asc' }, include: { user: { select: PERSON } } },
  events: { orderBy: { createdAt: 'desc' }, include: { user: { select: PERSON } } },
  assignedDrawer: { select: PERSON },
  createdBy: { select: PERSON },
  // Profil siparişi (Aşama 6)
  profile: true,
  profileItems: { orderBy: { sortOrder: 'asc' } },
  // Yönetici: depo e-postası ve FGO işleri (son kayıtlar)
  outbox: { where: { type: { in: ['WAREHOUSE_EMAIL', 'FGO_PROFORMA', 'FGO_INVOICE'] } }, orderBy: { createdAt: 'desc' }, take: 10 },
} satisfies Prisma.OrderInclude;

export type OrderDetail = Prisma.OrderGetPayload<{ include: typeof orderDetailInclude }>;
type OfferRow = OrderDetail['offers'][number];

/** Siparişi kullanıcının yetkisi dahilinde yükler (erişimi yoksa 404) ve role göre temizler. */
export async function loadOrder(id: string, user: CurrentUser): Promise<OrderDetail> {
  const order = await db.order.findFirst({ where: { id, ...orderScope(user) }, include: orderDetailInclude });
  if (!order) notFound();
  return sanitizeOrder(user, order);
}

const ZERO = new Prisma.Decimal(0);

/**
 * Rolün göremeyeceği her şeyi sunucuda çıkarır (ekranda gizlemek yetmez):
 *  - firma adı / iletişim (satış, çizim)       - iç notlar ve iç dosyalar (müşteri)
 *  - gönderilmemiş teklifler (müşteri, denetimci) - teklif tutarları ve satırları (çizim; durum kalır)
 *  - yönetici fiyatı (satış, çizim)            - liste fiyatları (teklif hazırlamayan herkes)
 *  - taslak çizim sürümleri ve çizim iç notları (müşteri)
 *  - not ve revizyon notu çevirisinin hata kodu / bekleme durumu ve müşterinin kendi notunun Türkçesi (müşteri)
 *  - not ve revizyon notu çevirisinin tamamı: çeviri, durum, hata kodu (denetimci — notu yalnızca özgün dilinde görür)
 *  - müşteri kişilerinin adı / e-postası (satış, çizim: yalnızca "Müşteri" rolü) ve olay geçmişi role göre: satır ve not
 *    olay koduna göre (FGO / muhasebe olayları, alıcı e-postası, satış tutarı, dış servis hata metni) — tek kural
 *    server/orders/order-view.js (AUD-1, AUD-2); eski kayıtlar da okunurken korunur
 */
export function sanitizeOrder(user: CurrentUser, order: OrderDetail): OrderDetail {
  let offers = order.offers;
  if (!userCan(user, 'OFFER_VIEW')) offers = offers.map((o) => ({ ...o, lines: [], amount: ZERO }));
  else if (!userCan(user, 'OFFER_DRAFT_VIEW')) offers = offers.filter((o) => o.status === 'GONDERILDI');
  // Liste fiyatı (fiyat tablosu) ve fiyat tablosu bağlantısı yalnızca teklif hazırlayan iç ekibe gider
  if (!userCan(user, 'OFFER_PREPARE')) {
    offers = offers.map((o) => ({ ...o, priceTableId: null, lines: o.lines.map((l) => ({ ...l, listPrice: null })) }));
  }
  // İki kademeli fiyat (karar 4)
  const view = priceView(user);
  offers = offers.map((o) => offerPrices(view, o));
  // Çizim: sürümlerin role göre görünümü TEK kuraldan (server/orders/drawing-access.js, karar 146) — müşteri taslak sürümü
  // hiç görmez; geri çekilen sürümün satırını (durum, tarih, gerekçe) görür ama dosyalarını ve müşteri notunu almaz.
  // Dosya adresi ve çizim görüntüleyicisi de aynı kuralı kullanır. İç not yalnızca iç ekibe gider.
  let drawings = drawingsView(user.appRole, order.drawings);
  if (!userCan(user, 'NOTE_INTERNAL_VIEW')) drawings = drawings.map((d) => ({ ...d, noteInternal: null }));
  // Revizyon notunun (karar 163) ve sürümün müşteri notunun (karar 168) çevirisi sipariş notuyla aynı kuraldan
  // (server/notes/view.js — sağlayıcıyı yüklemez): müşteri yalnızca kendisi için yapılmış (Romence) tamamlanmış çeviriyi
  // alır, iç ekip kendi tarafının notunu özgün dilinde görür, denetimci çeviri alanı almaz. Bu okuma yolu çeviri isteği yapmaz.
  drawings = drawingTranslationsFor(user.appRole, drawings);
  // Depo bağlantısının özeti hiçbir istemciye gitmez; e-posta kuyruğunu yalnızca yönetici görür.
  // FGO belge bağlantıları (yalnızca FGO işçisi yazar: factura/emitere yanıtındaki bağlantı) dış veridir: FGO'nun kendi
  // adresi değilse sayfaya hiç taşınmaz (karar 144 — pdfUrl); belge numarası ve tarihi yine gösterilir.
  const profile = order.profile
    ? { ...order.profile, depotTokenHash: null, proformaLink: pdfUrl(order.profile.proformaLink), invoiceLink: pdfUrl(order.profile.invoiceLink) }
    : null;
  return orderPeopleView(user.appRole, {
    ...order,
    profile,
    outbox: userCan(user, 'OFFER_SEND') ? order.outbox : [],
    drawings,
    customer: sanitizeCustomer(user, order.customer),
    // İç notlar ve çeviri alanları tek kuraldan (server/notes/view.js — sağlayıcıyı yüklemez): çeviri notun görünürlüğünü
    // aşamaz; denetimci çeviri alanı almaz. Bu okuma yolu hiçbir koşulda çeviri isteği yapmaz.
    notes: notesFor(user.appRole, order.notes),
    files: userCan(user, 'FILE_INTERNAL_VIEW') ? order.files : order.files.filter((f) => f.kind === 'CUSTOMER'),
    offers,
    price: userCan(user, 'PRICE_FINAL_VIEW') ? order.price : null,
    // "Özel durum" (karar 124): ev sahibi firma kararı yalnızca iç ekibe gider
    guestHostId: userCan(user, 'FILE_INTERNAL_VIEW') ? order.guestHostId : null,
  });
}

/** Üzerinde çalışılan son teklif (en yeni). */
export function currentOffer(order: { offers: OfferRow[] }): OfferRow | undefined {
  return order.offers[0];
}
/** Müşteriye gönderilmiş son teklif. */
export function sentOffer(order: { offers: OfferRow[] }): OfferRow | undefined {
  return order.offers.find((o) => o.status === 'GONDERILDI');
}

// Sipariş numarası önerisi ve iş akışı işlemleri: server/orders/create.js ve server/orders/transitions.js
export { suggestNextNo } from '../server/orders/create.js';

/**
 * Listede gösterilen siparişlerin okunmamış mesaj sayıları (karar 199). Kimlikler, kullanıcının kapsamından geçmiş
 * satırlardan gelir (liste sorgusu orderScope kullanır); kural server/notes/unread.js.
 */
export async function unreadNotesFor(user: CurrentUser, orderIds: string[]): Promise<Map<string, number>> {
  return unreadCounts(db, user, orderIds);
}

/**
 * Listede gösterilen siparişlerin okunmamış SİPARİŞ UYARILARI (karar 224): kullanıcının o siparişteki okunmamış zil
 * bildirimleri — yeni mesaj hariç (mesajın kendi sayacı var). Kural server/notifications/order-alerts.js; sipariş sayfası
 * açılınca yalnızca o kullanıcının o siparişteki uyarıları okunur.
 */
export async function orderAlertsFor(user: CurrentUser, orderIds: string[], { messages = false }: { messages?: boolean } = {}): Promise<Map<string, number>> {
  return orderAlertCounts(db, user, orderIds, { messages });
}
