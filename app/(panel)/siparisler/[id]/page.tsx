import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission, type CurrentUser } from '@/lib/auth/session';
import { currentOffer, customerLabel, loadOrder, sentOffer, type OrderDetail } from '@/lib/orders';
import { userCan } from '@/lib/permissions';
import { fmtBytes, fmtDate, fmtDateTime, fmtM2, fmtMoney, fmtNum, isoDay } from '@/lib/format';
import { getT, type Dict, type MsgKey, type T } from '@/lib/i18n';
import { translate } from '@/server/i18n/index.js';
import { TRANSLATE_ERRORS, canRetryTranslation, translationState } from '@/server/notes/view.js';
import { countText, isUnreadNote, unreadThreshold } from '@/server/notes/unread.js';
import { OrderSeen } from '@/components/OrderSeen';
import { randomUUID } from 'node:crypto';
import {
  blockerText, customerDrawingText, customerSummaryText, eventNoteText, eventText, lineKindText, lockReasonText, personText, roleText, slaText, stageText,
} from '@/lib/labels';
import { CustomerBadge, DrawingBadge, OfferBadge, OrderBadge } from '@/components/StatusBadge';
import { ConfirmButton } from '@/components/ConfirmButton';
import { SidebarPortal } from '@/components/Sidebar';
import { OrderInfo } from './OrderInfo';
import { ShipDateEdit } from './ShipDateEdit';
import { shipDateLocked } from '@/server/orders/ship-date.js';
import { GlassFinance } from './GlassFinance';
import { OrderPayments } from './OrderPayments';
import { fxOfferNote } from '@/lib/fx-note';
import { OfferEditor, type EditorPricing } from './OfferEditor';
import { ProfileOrderView } from './ProfileOrderView';
import { loadPricing, pricingForCustomer, pricingForUser } from '@/server/pricing/tables.js';
import { loadOf, shipDay } from '@/lib/loading';
import { glassLabel, itemGlassName } from '@/server/catalog/glass.js';
import {
  ALLOWED_EXT, STAGES, atOfferPrice, availableActions, drawingFlags, isSalesCrate, isViewable, offerLineTotals, offerSubmitter, offerTotals, offerNeedsCheck, productionBlockers, slaInfo, stageIndex,
} from '@/server/orders/rules.js';
import { TableJump } from '@/components/TableJump';
import { loadCompensations, loadCompensationForm, type CompEntry } from '@/lib/compensation';
import { compensableLines } from '@/server/orders/compensation.js';
import { CompensationForm } from './CompensationForm';
import { RemoveOrder } from './RemoveOrder';
import { removalPreview } from '@/server/orders/removal.js';
import { priceLock } from '@/server/orders/financial-lock.js';
import { loadPriceChanges, type PriceChangeEntry } from '@/lib/price-history';
import { GuestHostFields } from './GuestHost';
import { setGuestHostAction } from './guest-host-actions';
import { guestHostOptions } from '@/server/loading/crates.js';
import { FgoDocLink } from '@/components/FgoDocLink';
import { RevisionNote } from '@/components/RevisionNote';
import { decideCompensationAction, restoreOrderAction } from './compensation-actions';
import {
  addFilesAction, addNoteAction, markOrderSeenAction, retryNoteTranslationAction, approveDrawingAction, archiveAction, cancelAction, checkOfferAction, holdAction, setCustomerExcelAction,
  markShippedAction, noDrawingAction, sendToDrawingAction, setShipDateAction,
  removeDrawingFileAction, startDrawingAction, undoDrawingAction, undoNoDrawingAction, uploadDrawingAction,
  withdrawDrawingAction, retryDrawingTranslationAction, dwgResubmitAction, dwgRequestDrawingAction, withdrawOfferAction,
} from './actions';
import { DwgDecision } from './DwgDecision';
import { dwgReview, isCustomerDrawingRecord, lastProductionDrawing, sourceFilesOf } from '@/server/orders/dwg-review.js';

/** İşlem sonrası bildirim (?ok=<kod>, metni: order.ok.<kod>); bilinmeyen kodda null. */
function okText(m: Dict, code: string | undefined): string | null {
  const ok = m.order.ok;
  return code && Object.hasOwn(ok, code) ? ok[code as keyof typeof ok] : null;
}

// "Sıradaki adım" satırında gösterilen işlemler (metinleri: order.steps.<işlem>)
const STEP_ACTIONS = [
  'send_to_drawing', 'no_drawing', 'edit_offer', 'approve_price', 'start_drawing', 'upload_drawing', 'send_drawing', 'approve_drawing',
  'request_revision', 'mark_shipped', 'archive', 'unhold',
] as const;
type StepAction = (typeof STEP_ACTIONS)[number];
const isStep = (a: string): a is StepAction => (STEP_ACTIONS as readonly string[]).includes(a);

function turnText(t: T, order: OrderDetail): string {
  if (order.onHold) return t('order.turn.onHold');
  const offer = currentOffer(order)?.status ?? null;
  const at = (who: string) => t('order.turn.text', { who });
  if (order.status === 'YENI') return at(t('order.turn.sales'));
  if (order.status === 'URETIMDE') return at(t('order.turn.salesLoading'));
  if (order.status === 'YUKLENDI') return at(t('order.turn.salesArchive'));
  if (order.status !== 'HAZIRLANIYOR') return t('order.turn.none');
  const parts: string[] = [];
  const d = order.drawingTrack;
  if (d === 'GEREKLI' || d === 'YAPILIYOR' || d === 'REVIZYON_ISTENDI') parts.push(t('order.turn.drawingTeam'));
  if (d === 'ONAY_BEKLIYOR') parts.push(t('order.turn.customerApproval'));
  if (d === 'DUZELTME_BEKLIYOR') parts.push(t('order.turn.customerCorrection'));
  if (offer === null || offer === 'HAZIRLANIYOR') parts.push(t('order.turn.salesOffer'));
  if (offer === 'YONETIMDE') parts.push(t('order.turn.adminPrice'));
  return parts.length ? at(parts.join(' · ')) : t('order.turn.none');
}

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requirePermission('ORDER_VIEW');
  const { t, m, locale, intl } = await getT();
  const { id } = await params;
  const sp = await searchParams;
  // Silinmiş sipariş (karar 110) kimseye açılmaz; yöneticiye yalnızca "silindi" bilgisi ve geri yükleme gösterilir
  if (userCan(user, 'ORDER_CANCEL')) {
    const gone = await db.order.findFirst({
      where: { id, removedAt: { not: null } },
      select: { id: true, orderNo: true, title: true, removedAt: true, customer: { select: { name: true } }, removedBy: { select: { name: true } } },
    });
    if (gone) {
      return (
        <>
          <div className="page-head">
            <p className="small"><Link href="/siparisler#silinen">← {t('order.back.orders')}</Link></p>
            <h1>{gone.title || gone.orderNo}</h1>
            <div className="row"><span className="mono muted">{gone.orderNo}</span><span className="muted small">· {gone.customer.name}</span></div>
          </div>
          <div className="card" id="silinen">
            <div className="alert alert-warn">
              <b>{t('compensation.remove.removedTitle')}</b> {t('compensation.remove.removedInfo', { when: fmtDateTime(gone.removedAt), who: gone.removedBy?.name ?? '—' })}
            </div>
            <p className="muted small">{t('compensation.remove.listIntro')}</p>
            <form action={restoreOrderAction}>
              <input type="hidden" name="id" value={gone.id} />
              <ConfirmButton primary message={t('compensation.remove.restoreConfirm')}>{t('compensation.remove.restore')}</ConfirmButton>
            </form>
          </div>
        </>
      );
    }
  }
  const order = await loadOrder(id, user);
  const isCustomer = user.appRole === 'MUSTERI';
  // Okunmamış mesaj eşiği (karar 199): sayfa açılmadan önceki okunma anı — yeni mesajlar işaretlenir, sonra okundu olur
  const noteSince = await unreadThreshold(db, user, order.id);
  const notesCard = <Notes order={order} user={user} t={t} since={noteSince} />;
  // "Siparişi sil" (yalnızca yönetici — ORDER_CANCEL): sayfanın en altında, iki aşamalı onay (karar 110; Paket 4). Önizleme
  // (sipariş no, sonuç ve engeller) sunucuda, silmeyle aynı kuraldan (server/orders/removal.js → removalPreview)
  const removeErrors = m.compensation.remove.errors;
  const removeError = sp.silHata && Object.hasOwn(removeErrors, sp.silHata) ? removeErrors[sp.silHata as keyof typeof removeErrors] : sp.silHata ? removeErrors.NOT_FOUND : null;
  const removal = userCan(user, 'ORDER_CANCEL') ? await removalPreview(db, order.id) : null;
  const removalBox = removal ? (
    <RemoveOrder
      orderId={order.id} error={removeError} m={m.compensation.remove}
      preview={{ ...removal, reasons: removal.reasons.map((r) => lockReasonText(t, r)) }}
    />
  ) : null;
  if (order.orderTypeCode === 'PROFILE_ORDER') {
    // Profil siparişi (Aşama 6): kendi akışı ve ekranı; dosya, not ve geçmiş ortak
    const acts = availableActions({ role: user.appRole, status: order.status, onHold: false, canApprove: user.canApprove, drawing: 'YOK', offer: null, orderType: order.orderTypeCode });
    // Profil siparişinde müşterinin dosya yükleme alanı yok (karar 161 — sunucu da reddeder); eski siparişte müşterinin
    // yüklediği dosya varsa yalnızca liste olarak görünür
    const fileCard = isCustomer && !acts.includes('add_file') && !order.files.some((f) => f.kind === 'CUSTOMER')
      ? null
      : <Files order={order} user={user} canAdd={acts.includes('add_file')} t={t} />;
    return (
      <ProfileOrderView
        order={order} user={user} sp={sp} t={t} m={m} locale={locale}
        files={fileCard}
        notes={notesCard}
        history={<>{removalBox}<History order={order} isCustomer={isCustomer} t={t} /></>}
      />
    );
  }
  const fgoDocs = userCan(user, 'PRICE_FINAL_VIEW')
    ? await db.fgoDocument.findMany({ where: { orderId: order.id }, orderBy: { issuedAt: 'asc' }, select: { id: true, kind: true, series: true, number: true, issuedAt: true, link: true } })
    : [];
  const offer = currentOffer(order);
  const sent = sentOffer(order);
  const acts = availableActions({
    role: user.appRole, status: order.status, onHold: order.onHold, canApprove: user.canApprove,
    drawing: order.drawingTrack, offer: offer?.status ?? null, ...drawingFlags(order), orderType: order.orderTypeCode,
  });
  const can = (a: string) => acts.includes(a);
  const sla = isCustomer ? null : slaInfo(order.slaDeadline);
  const stage = stageIndex(order.status);
  // Satış görünümü: teklif hazırlar ama müşteriye gönderemez (rol adına değil yetkiye bakılır)
  const salesView = userCan(user, 'OFFER_PREPARE') && !userCan(user, 'OFFER_SEND');
  // Çizim ekibi görünümü: çizim yapar, teklif görmez (fiyat / sandık / cam ticari bölümleri gösterilmez)
  const drawerView = userCan(user, 'DRAWING_WORK') && !userCan(user, 'OFFER_VIEW');
  const editable = !!offer && (can('edit_offer') || can('approve_price'));
  // Müşterideki teklifin fiyatı (yönetici — Paket 4): mali kilit (FGO belgesi, müşteri belgesi kapsamı, bekleyen belge isteği,
  // onaylı yükleme) varsa "Teklifi güncelle" yerine gerekçe gösterilir. Asıl denetim işlemde (update_offer), kilit altında.
  const lockedPrice = !editable && !!offer && can('update_offer') ? await priceLock(db, order.id) : [];
  const updating = !editable && !!offer && can('update_offer') && lockedPrice.length === 0 && sp.teklif === 'guncelle';
  const glasses = editable || updating
    ? await db.glassProduct.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { nameTr: 'asc' }, { colorTr: 'asc' }] })
    : [];
  const catalog = glasses.map((g) => glassLabel(g, locale));
  // Müşteriye özel fiyatlar (yönetici; karar 32): yöneticinin eklediği satırın müşteri fiyatı buradan dolar
  let customerPricing: EditorPricing | null = null;
  if ((editable || updating) && offer && userCan(user, 'OFFER_SEND')) {
    const cp = await pricingForCustomer(db, order.customerId);
    if (cp && cp.currency === offer.currency) {
      const glass: Record<string, number> = {};
      for (const g of glasses) {
        const price = cp.prices.get(g.id);
        if (price == null) continue;
        glass[glassLabel(g, locale)] = price;
        glass[glassLabel(g, 'tr')] = price;
      }
      customerPricing = { name: cp.name, glass, holePrice: cp.holePrice, cncPrice: cp.cncPrice };
    }
  }
  // Fiyat tablosu (karar 26): teklifin tablosu; eski teklifte tablo yoksa satışçının kendi tablosu
  let pricing: EditorPricing | null = null;
  if ((editable || updating) && offer && userCan(user, 'OFFER_PREPARE')) {
    const p = offer.priceTableId ? await loadPricing(db, offer.priceTableId)
      : !userCan(user, 'OFFER_SEND') ? await pricingForUser(db, user.id) : null;
    if (p && p.currency === offer.currency) {
      const glass: Record<string, number> = {};
      for (const g of glasses) {
        const price = p.prices.get(g.id);
        if (price == null) continue;
        glass[glassLabel(g, locale)] = price;
        glass[glassLabel(g, 'tr')] = price;
      }
      pricing = { name: p.name, glass, holePrice: p.holePrice, cncPrice: p.cncPrice };
    }
  }
  // Veri zaten sunucuda temizlendi (lib/orders.ts → sanitizeOrder); çizim ekibi teklif görmez,
  // müşteri ve denetimci yalnızca müşteriye gönderilmiş teklifi görür.
  const shownOffer = !userCan(user, 'OFFER_VIEW') ? undefined : isCustomer ? sent : editable || updating ? undefined : offer;
  // "Yöneticiye göndermeyi geri al" (karar 212): yalnızca teklifi yöneticiye gönderen satışçıya, yönetici fiyatlandırıp
  // müşteriye göndermeden önce. Asıl denetim işlemde (transitions.js → withdraw_offer: gönderen, durum, sipariş sürümü).
  const withdrawable = can('withdraw_offer') && !!user.id && offerSubmitter(order.events) === user.id;
  const finalPrice = !userCan(user, 'OFFER_DRAFT_VIEW');
  const sentVersions = order.offers.filter((o) => o.status === 'GONDERILDI').length;
  // Müşteriye gönderilmiş son sürüm (taslak sayılmaz)
  const lastDrawing = [...order.drawings].reverse().find((d) => d.status !== 'TASLAK');
  // Müşterinin onayını bekleyen sürüm (yalnızca müşteri ekranında kırmızı bilgilendirme — karar 162). Geri çekilen sürüm
  // ONAY_BEKLIYOR değildir; içerik kuralı (karar 146) değişmez.
  const waitingDrawing = isCustomer && order.status === 'HAZIRLANIYOR' && order.drawingTrack === 'ONAY_BEKLIYOR' && lastDrawing?.status === 'ONAY_BEKLIYOR'
    ? lastDrawing : undefined;
  // Teklif müşteriye gittikten sonra yeni (ikinci ya da sonraki) üretim çizimi geldiyse ölçüler değişmiş olabilir. Üretim
  // çizimi ve sırası tek yerden (server/orders/dwg-review.js → lastProductionDrawing; events en yeniden eskiye sıralı)
  const production = lastProductionDrawing(order.drawings);
  const needsCheck = !isCustomer && userCan(user, 'OFFER_VIEW') && (order.status === 'HAZIRLANIYOR' || order.status === 'URETIMDE') && offerNeedsCheck({
    offer: offer?.status ?? null, sentAt: offer?.sentAt ?? null,
    lastDrawing: production ? { version: production.ordinal, createdAt: production.at, sentAt: production.at } : null,
    checkedAt: order.events.find((e) => e.event === 'OFFER_CHECKED')?.createdAt ?? null,
  });
  // Çizimci müşterinin DWG/DXF çizimini hatalı buldu (karar 167): müşteriye kırmızı bilgilendirme + çizimcinin açıklaması
  // (saklanan Romence çevirisiyle). Yanıt (düzeltilmiş dosya / fabrika çizimi) "Sıradaki adım" kartında (#duzeltme).
  const correction = isCustomer && order.status === 'HAZIRLANIYOR' && order.drawingTrack === 'DUZELTME_BEKLIYOR';
  const faultyRecord = correction ? [...order.drawings].reverse().find((d) => isCustomerDrawingRecord(d) && d.status === 'REVIZYON_ISTENDI') : undefined;
  const faultyNote = faultyRecord ? [...faultyRecord.revisions].reverse().find((r) => r.kind === 'HATALI') : undefined;
  // İç ekip (çizim yetkisi): müşteri revizyon istedi — kırmızı ve belirgin; son talebin numaralı notu (Türkçe çevirisiyle)
  const revisionAsked = !isCustomer && userCan(user, 'DRAWING_WORK') && order.status === 'HAZIRLANIYOR' && !order.onHold
    && order.drawingTrack === 'REVIZYON_ISTENDI' && lastDrawing?.status === 'REVIZYON_ISTENDI' ? lastDrawing : undefined;
  const lastRequest = revisionAsked ? [...revisionAsked.revisions].reverse().find((r) => r.kind === 'TALEP') : undefined;
  const updateHref = `/siparisler/${order.id}?teklif=guncelle#teklif`;
  // Tahmini yükleme tarihi (karar 230): satır içi düzenleme; kilit = Yüklendi / Arşiv / İptal ya da onaylı yükleme kalemi
  // (sunucu işlemi aynı kuralı yeniden uygular: transitions.js → set_ship_date / shipDateLocked)
  const shipLocked = !isCustomer && order.orderTypeCode === 'GLASS_ORDER'
    && (['YUKLENDI', 'ARSIVLENDI'].includes(order.status) || await shipDateLocked(db, order.id));
  const shipEditable = can('set_ship_date') && !shipLocked;
  // Yöneticinin "Hareketler"i: müşteri fiyatı değişiklikleri (denetim kaydından; tutarlar yalnızca yöneticide — Paket 4)
  const priceChanges = await loadPriceChanges(order.id, user);
  const ok = okText(m, sp.ok);
  // Kırık / telafi camı (karar 108): satış ve yönetici (OFFER_PREPARE). Giriş, müşteriye gönderilmiş teklifin cam satırı.
  const canComp = !isCustomer && userCan(user, 'OFFER_PREPARE');
  const comps = canComp ? await loadCompensations(order.id, user) : [];
  const compIds = new Set<string>(canComp && sent && order.status !== 'IPTAL' ? compensableLines(sent.lines).map((g) => String(g.line.id)) : []);
  const compHref = (lineId: string) => `/siparisler/${order.id}?telafi=${lineId}#telafi`;
  const compForm = compIds.size > 0 && sp.telafi ? await loadCompensationForm(order, user) : null;
  // Özel durum (karar 124): yalnızca yönetici (LOADING_CONFIRM) görür; yalnızca FİRMA seçer. Sandık Yüklemeler ekranında seçilir.
  let guestHost: React.ReactNode = null;
  if (userCan(user, 'LOADING_CONFIRM') && order.status !== 'IPTAL') {
    const gm = m.loading.guest.host;
    const [options, hostRow, placed] = await Promise.all([
      guestHostOptions(db, order),
      order.guestHostId ? db.customer.findUnique({ where: { id: order.guestHostId }, select: { name: true } }) : null,
      order.guestHostId ? db.crateOrder.findFirst({ where: { orderId: order.id, crate: { customerId: order.guestHostId } }, select: { crate: { select: { crateNo: true } } } }) : null,
    ]);
    const day = shipDay(order);
    const okText = sp.ozel === 'set' ? gm.ok.set : sp.ozel === 'removed' ? gm.ok.removed : null;
    const errorText = sp.ozelHata ? gm.errors[sp.ozelHata as keyof typeof gm.errors] ?? gm.errors.NOT_FOUND : null;
    guestHost = (
      // Form sunucu bileşenindedir (işlem kimliği sayfada); alanların aç / kapa davranışı istemci bileşeninde
      <form action={setGuestHostAction} className="card guest-host" id="ozel-durum">
        {okText && <div className="alert alert-ok">{okText}</div>}
        {errorText && <div className="alert alert-error">{errorText}</div>}
        <input type="hidden" name="orderId" value={order.id} />
        <GuestHostFields
          hostId={order.guestHostId} hostName={hostRow?.name ?? null} hosts={options.hosts}
          days={options.days.map((d) => d.split('-').reverse().join('.'))} dayHref={day ? `/yuklemeler?ay=${day.slice(0, 7)}&gun=${day}#gun` : null}
          crateNo={placed?.crate.crateNo ?? null} m={gm}
        />
      </form>
    );
  }
  const compErrors = m.compensation.errors;
  const compError = sp.telafiHata ? compErrors[sp.telafiHata as keyof typeof compErrors] ?? compErrors.BAD_REQUEST : null;
  const compOks = m.compensation.ok;
  const compOk = sp.telafiOk && Object.hasOwn(compOks, sp.telafiOk) ? t(`compensation.ok.${sp.telafiOk}` as MsgKey, { order: sp.hedef ?? '' }) : null;
  // Kaynak adedinin sonucu (karar 157): adres çubuğundan yalnızca bilinen kod ve rakam okunur (serbest metin ekrana yazılmaz)
  const srcKept = m.compensation.sourceResult.kept;
  const digits = (v: string | undefined) => (v != null && /^\d{1,6}$/.test(v) ? Number(v) : null);
  const srcBefore = digits(sp.once);
  const srcAfter = digits(sp.kalan);
  const compSource = !compOk ? null
    : sp.kaynak === 'dustu' && srcBefore != null && srcAfter != null ? { warn: false, text: t('compensation.sourceResult.reduced', { before: srcBefore, after: srcAfter }) }
      : sp.kaynak && Object.hasOwn(srcKept, sp.kaynak) ? { warn: sp.kaynak !== 'PENDING', text: srcKept[sp.kaynak as keyof typeof srcKept] } : null;

  return (
    <>
      <div className="page-head row">
        <div>
          <p className="small"><Link href="/siparisler">← {isCustomer ? t('order.back.myOrders') : t('order.back.orders')}</Link></p>
          <h1>{order.title || order.orderNo}</h1>
          <div className="row">
            <span className="mono muted">{order.orderNo}</span>
            {isCustomer
              ? <CustomerBadge status={order.status} drawing={order.drawingTrack} offer={sent ? 'GONDERILDI' : null} />
              : <OrderBadge status={order.status} onHold={order.onHold} />}
            {/* Çizim ekibi: adım çubuğu ve "sıra kimde" kartları yerine küçük durum rozetleri (karar 84) */}
            {drawerView && order.drawingTrack !== 'YOK' && <DrawingBadge track={order.drawingTrack} />}
            {drawerView && order.revisionCount > 0 && <span className="badge badge-danger">{t('order.info.revisionRounds', { n: order.revisionCount })}</span>}
            {!isCustomer && <span className="muted small">· {customerLabel(user, order.customer.name)}</span>}
          </div>
        </div>
        {sla && <span className={sla.over ? 'sla-over' : sla.risk ? 'sla-risk' : 'sla-ok'}>● {slaText(t, sla)}</span>}
      </div>

      {ok && <div className="alert alert-ok">{ok}</div>}
      {compOk && <div className="alert alert-ok">{compOk}</div>}
      {compSource && <div className={`alert ${compSource.warn ? 'alert-warn' : 'alert-info'}`} data-comp-source={sp.kaynak}>{compSource.text}</div>}
      {sp.error && <div className="alert alert-error">{sp.error}</div>}
      {/* Müşteriye yeni çizim gönderildi (karar 162): belirgin kırmızı bilgilendirme; ana işlem "Aç ve incele" */}
      {waitingDrawing && (
        <div className="alert alert-error" id="cizim-onay" data-drawing-alert={waitingDrawing.id}>
          <b>{t('order.customer.newDrawingTitle', { v: waitingDrawing.version })}</b> {t('order.customer.newDrawingText')}
          <div className="row" style={{ marginTop: 10 }}>
            <Link className="btn btn-primary" href={`/siparisler/${order.id}/cizim/${waitingDrawing.id}`}>{t('order.drawings.review')}</Link>
          </div>
        </div>
      )}

      {!drawerView && <div className="card">
        <div className="stepper">
          {STAGES.map((key, i) => {
            const cls = i < stage ? 'done' : i === stage ? 'current' : '';
            return (
              <div key={key} className={`step ${cls}`}>
                <div className="dot">{i < stage ? '✓' : String(i + 1).padStart(2, '0')}</div>
                <div className="lbl">{stageText(t, key)}</div>
                {i === stage && sla && <div className={`sla-chip ${sla.over ? 'over' : ''}`}>{slaText(t, sla)}</div>}
              </div>
            );
          })}
        </div>
        {order.status === 'HAZIRLANIYOR' && (
          <div className="tracks">
            <div className="track">
              <span className="k">{t('order.tracks.drawing')}</span>
              {isCustomer
                ? <span>{customerDrawingText(t, order.drawingTrack)}</span>
                : <DrawingBadge track={order.drawingTrack} />}
            </div>
            <div className="track">
              <span className="k">{t('order.tracks.offer')}</span>
              {isCustomer ? <span>{sent ? t('order.tracks.offerReady') : t('order.tracks.preparing')}</span> : <OfferBadge status={offer?.status} />}
            </div>
          </div>
        )}
      </div>}

      {/* Müşterinin DWG/DXF çizimi hatalı bulundu (karar 167): kırmızı bilgilendirme; yanıt "Sıradaki adım" kartında */}
      {correction && (
        <div className="alert alert-error" id="cizim-hatali">
          <b>{t('order.customer.correctionTitle')}</b> {t('order.customer.correctionText')}
          {faultyNote && <RevisionNote r={faultyNote} role={user.appRole} t={t} />}
          <div className="row" style={{ marginTop: 10 }}>
            <a className="btn btn-primary" href="#duzeltme">{t('order.customer.correctionRespond')}</a>
          </div>
        </div>
      )}
      {/* İç ekip: müşteri revizyon istedi — kırmızı ve belirgin (Paket 3); ayrıntı ve geçmiş "Çizim onayı ve revizyon"da */}
      {revisionAsked && (
        <div className="alert alert-error" id="revizyon" data-revision-alert={revisionAsked.id}>
          <b>{t('order.revisionAlert.title', { v: revisionAsked.version })}</b> {t('order.revisionAlert.text')}
          {lastRequest && <RevisionNote r={lastRequest} role={user.appRole} t={t} />}
          <div className="row" style={{ marginTop: 10 }}>
            <a className="btn" href="#cizim">{t('order.revisionAlert.open')}</a>
          </div>
        </div>
      )}

      {needsCheck && production && (
        <div className="alert alert-warn">
          <b>{t('order.check.title', { v: production.drawing.version, date: fmtDateTime(production.at) })}</b>{' '}
          {can('update_offer') ? t('order.check.admin') : t('order.check.other')}
          {can('update_offer') && !updating && (
            <div className="row" style={{ marginTop: 10 }}>
              {/* Mali kilitte (Paket 4) fiyat güncellenemez: yalnızca "değişiklik yok" kalır; gerekçe teklif kartında */}
              {lockedPrice.length === 0 && <Link href={updateHref} className="btn btn-primary">{t('order.check.update')}</Link>}
              <form action={checkOfferAction}>
                <input type="hidden" name="id" value={order.id} />
                <button className="btn">{t('order.check.noChange')}</button>
              </form>
            </div>
          )}
        </div>
      )}

      {/*
        Bölüm sırası (her bölüm bir kez gösterilir; yönetici, satış, müşteri ve denetimci aynı sıra — karar 214):
          sıra kimde + yapılabilecek işlemler → 1) müşteri sipariş dosyaları → 2) notlar → 3) sipariş bilgileri →
          4) teklif tablosu (düzenleme ya da görünüm; altında özel durum ve telafi formu) → 5) teknik çizimler ve onay →
          6) önemli kararlar / finans / sandık; hareketler sol menüde. Yalnızca yer değişti: görünürlük kuralları aynı.
        Çizim ekibi (karar 77, 84; Paket 3): 1) müşterinin sipariş dosyaları → 2) teknik çizim dosyaları (çizime başla, taslağa
          yükleme, sürümlerin dosyaları) → 3) çizim onayı ve revizyon (DWG/DXF kararı, onay / revizyon geçmişi, geri çekme) →
          4) notlar → 5) sipariş bilgileri. Adım çubuğu ve işlem kartları yok (durum başlıkta rozetle); teklif / ticari bölüm yok.
      */}
      {drawerView && <Files order={order} user={user} canAdd={can('add_file')} t={t} />}

      {isCustomer ? <CustomerActions order={order} user={user} can={can} t={t} /> : !drawerView && <InternalActions order={order} user={user} can={can} acts={acts} t={t} />}
      {drawerView && <DrawingFiles order={order} user={user} can={can} t={t} />}
      {drawerView && <DrawingReview order={order} user={user} can={can} t={t} />}
      {!drawerView && <Files order={order} user={user} canAdd={can('add_file')} t={t} />}
      {notesCard}

      <OrderInfo
        title={t('order.info.title')}
        rows={[
          !!order.title && { label: t('order.info.heading'), value: order.title },
          { label: t('order.info.orderNo'), value: order.orderNo, mono: true },
          { label: t('order.info.customerOrderNo'), value: order.customerOrderNo },
          !isCustomer && { label: t('order.info.customer'), value: customerLabel(user, order.customer.name) },
          { label: t('order.info.drawing'), value: order.status === 'YENI' ? (isCustomer ? '—' : t('order.info.drawingPending')) : order.drawingTrack === 'YOK' ? t('order.info.drawingNotNeeded') : t('order.info.drawingNeeded') },
          order.drawingTrack !== 'YOK' && { label: t('order.info.revisions'), value: t('order.info.revisionRounds', { n: order.revisionCount }) },
          !!order.assignedDrawer && !isCustomer && { label: t('order.info.drawer'), value: order.assignedDrawer.name || order.assignedDrawer.email },
          { label: t('order.info.orderDate'), value: fmtDate(order.createdAt) },
          {
            label: t('order.info.estimatedShip'),
            value: isCustomer || drawerView ? fmtDate(order.estimatedShipDate) : (
              <ShipDateEdit
                orderId={order.id} version={order.version} current={isoDay(order.estimatedShipDate)} currentText={fmtDate(order.estimatedShipDate)}
                editable={shipEditable} locked={shipLocked} action={setShipDateAction}
                labels={{
                  edit: t('order.shipDate.edit'), save: t('order.shipDate.save'), cancel: t('order.shipDate.cancel'), none: t('order.shipDate.none'),
                  confirm: t('order.shipDate.confirm', { from: '%FROM%', to: '%TO%' }), locked: t('order.shipDate.locked'), field: t('order.shipDate.label'),
                }}
              />
            ),
          },
          !!order.actualShipDate && { label: t('order.info.shipped'), value: fmtDate(order.actualShipDate) },
          // Etiketler müşteri kaydından (Yönetim → Müşteriler: Customer.camEtiket / Customer.sandikEtiket)
          !isCustomer && !drawerView && { label: t('order.info.camEtiket'), value: order.customer.camEtiket ?? '—' },
          !isCustomer && !drawerView && { label: t('order.info.sandikEtiket'), value: order.customer.sandikEtiket ?? '—' },
          // FGO belgeleri (proforma / avans / fatura): müşteri, yönetici ve denetimci görür (satış ve çizim fiyat görmez)
          ...fgoDocs.map((d) => ({
            label: t(`accounting.receivables.kind.${['INVOICE', 'ADVANCE'].includes(d.kind) ? d.kind : 'PROFORMA'}` as MsgKey),
            value: <>{d.series}{d.number} · {fmtDate(d.issuedAt)}<FgoDocLink link={d.link} prefix=" · " fallback={null}>{t('profile.page.fgo.open')}</FgoDocLink></>,
          })),
        ]}
      >
        {/* "İstenen camlar" satış ve yönetici görünümünde gösterilmez (Paket 4; veri durur — teklif tablosu zaten bu camlarla açılır) */}
        {!salesView && !drawerView && !userCan(user, 'OFFER_SEND') && order.items.length > 0 && (
          <>
            <h3 className="sub-title">{t('order.info.requestedGlass')}</h3>
            <ul className="plain-list">
              {/* Adet yalnızca girilmişse (eski siparişler): müşteri formunda cam adedi yok, 0 = belirtilmedi (karar 160) */}
              {order.items.map((it) => <li key={it.id}>{itemGlassName(it, locale) || t('order.info.glassFallback')}{it.camAdedi > 0 ? ` × ${it.camAdedi}` : ''}</li>)}
            </ul>
          </>
        )}
      </OrderInfo>

      {(editable || updating) && offer && (
        <OfferEditor
          orderId={order.id}
          version={order.version}
          mode={updating ? 'update' : can('approve_price') ? 'admin' : 'sales'}
          cancelHref={`/siparisler/${order.id}#teklif`}
          currency={offer.currency}
          catalog={catalog}
          pricing={pricing}
          customerPricing={customerPricing}
          statusLabel={updating ? t('offer.editor.statusUpdating', { n: sentVersions + 1 }) : offer.status === 'YONETIMDE' ? t('offer.editor.statusAdmin') : t('offer.editor.statusSales')}
          camEtiket={order.camEtiket ?? order.customer.camEtiket ?? ''}
          sandikEtiket={order.sandikEtiket ?? order.customer.sandikEtiket ?? ''}
          initial={offer.lines.map((l) => ({
            description: locale === 'ro' && l.descriptionRo ? l.descriptionRo : l.description,
            poz: l.poz ?? '', enMm: l.enMm?.toString() ?? '', boyMm: l.boyMm?.toString() ?? '',
            adet: String(l.adet), unit: l.unit, unitPrice: Number(l.unitPrice) ? Number(l.unitPrice).toFixed(2) : '',
            kind: l.kind, free: l.free, listPrice: l.listPrice != null ? Number(l.listPrice).toFixed(2) : '',
            id: l.id, offerPrice: l.offerPrice != null ? Number(l.offerPrice).toFixed(2) : '', comp: !!l.compensationId, splitGroup: l.splitGroup ?? '',
            crate: l.crateFee,
            // Satışın sandık parası (karar 211, 214): yöneticinin sandık satırıyla aynı düzen (numaralı, ölçüsüz, adı sabit);
            // yöneticinin sandık bedeli satışa hiç gelmez
            salesCrate: isSalesCrate(l),
          }))}
          nextVersion={sentVersions + 1}
          m={m.offer}
          common={m.common}
          problemsMsg={m.offerProblems}
          lineKind={m.status.lineKind}
          excelFiles={order.files.filter((f) => f.kind === 'CUSTOMER' && /\.xlsx?$/i.test(f.name) && f.scanStatus !== 'INFECTED').map((f) => ({ id: f.id, name: f.name }))}
          importGlass={order.items[0] ? itemGlassName(order.items[0], locale) ?? '' : ''}
          original={order.items.map((it) => ({ description: itemGlassName(it, locale) ?? '', adet: String(Math.max(1, it.camAdedi || 1)) }))}
        />
      )}

      {shownOffer && (
        <OfferView order={order} offer={shownOffer} isCustomer={isCustomer} finalPrice={finalPrice} versions={sentVersions} updateHref={can('update_offer') && lockedPrice.length === 0 ? updateHref : undefined} t={t} locale={locale} admin={userCan(user, 'OFFER_SEND')} canExport={userCan(user, 'OFFER_EXPORT') || userCan(user, 'OFFER_SEND')}
          compIds={shownOffer.id === sent?.id ? compIds : undefined} compHref={compHref} priceLocked={lockedPrice.map((r) => lockReasonText(t, r))}
          withdraw={withdrawable ? (
            <form action={withdrawOfferAction} className="row" style={{ gap: 8 }}>
              <input type="hidden" name="id" value={order.id} />
              <input type="hidden" name="v" value={order.version} />
              <span className="muted small">{t('offer.view.withdrawHint')}</span>
              <ConfirmButton outline message={t('offer.view.withdrawConfirm')}>{t('offer.view.withdraw')}</ConfirmButton>
            </form>
          ) : undefined} />
      )}
      {/* Özel durum (karar 124): yalnızca yönetici, teklif tablosunun hemen altında — başka firmanın yüklemesiyle gidecek */}
      {guestHost}
      {/* Kırık / telafi camı: teklif tablosunun hemen altında tek kısa form; "Önemli kararlar" aynı formu açar */}
      {compForm && (
        <CompensationForm
          data={compForm} preselect={sp.telafi && compIds.has(sp.telafi) ? sp.telafi : null} history={comps.filter((c) => c.sourceOrder.id === order.id)}
          error={compError} cancelHref={`/siparisler/${order.id}#teklif`} locale={locale} intl={intl} m={m.compensation} kinds={m.status.lineKind}
        />
      )}
      {/* Teknik çizimler ve onay (karar 214): teklif tablosundan SONRA — Sipariş Bilgileri → Teklif Tablosu → Teknik Çizim ve
          Onaylar. Çizimi olmayan siparişte kart yok; çizim ekibinin kendi ekranı (dosyalar → çizim → onay) değişmedi. */}
      {!drawerView && <Drawings order={order} user={user} can={can} t={t} />}
      {canComp && <Decisions order={order} user={user} comps={comps} createHref={compIds.size > 0 ? compHref('sec') : null} error={compForm ? null : compError} t={t} locale={locale} />}
      {/* Finans / FGO (yönetici): cam proforma → avans faturası → fatura; Muhasebe → Cam Tahsilat ile aynı kayıtlar */}
      {userCan(user, 'OFFER_SEND') && <GlassFinance order={order} t={t} sp={sp} />}
      {/* Ödemeler ve avans (Paket 10): FGO tahsilatı ve elle kayıtlar ayrı, belirsiz FGO belgesi kararı — yalnızca yönetici */}
      {userCan(user, 'ACCOUNTING_MANAGE') && (
        <OrderPayments
          orderId={order.id} t={t} m={m.finance} sp={sp} profile={false}
          total={order.price && sent ? { amount: Number(order.price.amount), currency: sent.currency } : null}
        />
      )}
      {/* "Sandıklar" satış ve yönetici görünümünde gösterilmez (Paket 4): sandıklar Yüklemeler sekmesinde girilir ve orada
          görünür; kayıtlar ve işlevler değişmedi */}
      {!isCustomer && !salesView && !drawerView && !userCan(user, 'OFFER_SEND') && order.status !== 'YENI' && <Crates order={order} t={t} />}
      {removalBox}
      <History order={order} isCustomer={isCustomer} t={t} priceChanges={priceChanges} />
    </>
  );
}

function History({ order, isCustomer, t, priceChanges = [] }: { order: OrderDetail; isCustomer: boolean; t: T; priceChanges?: PriceChangeEntry[] }) {
  // Sol menünün altında (eski düzen); veri bu sayfanın yüklediği siparişten gelir. Yöneticide müşteri fiyatı değişiklikleri
  // (denetim kaydından — Paket 4) olaylarla tarih sırasında birlikte gösterilir; başka role hiç gelmez (lib/price-history.ts).
  type Item = { at: Date; key: string; node: React.ReactNode };
  const items: Item[] = [];
  for (const e of order.events) {
    const label = eventText(t, e.event, isCustomer);
    if (label === null) continue;
    const note = eventNoteText(t, e.event, e.note, isCustomer);
    items.push({
      at: new Date(e.createdAt), key: e.id,
      node: (
        <li key={e.id}>
          <div className="when">{fmtDateTime(e.createdAt)}{!isCustomer && e.user ? ` · ${personText(t, e.user)}` : ''}</div>
          {/* Teslimat raporu (Paket 8, karar 196): geçmişten raporların listesine (aynı sayfa, kalıcı bağlantılar) */}
          <div>{e.event === 'DELIVERY_REPORT' ? <a href="#teslimat"><b>{label}</b></a> : <b>{label}</b>}{note ? ` — ${note}` : ''}</div>
        </li>
      ),
    });
  }
  const money = (v: string | null, cur: string) => (v === 'FREE' ? t('order.priceHistory.free') : v == null ? '—' : fmtMoney(v, cur));
  for (const c of priceChanges) {
    items.push({
      at: new Date(c.at), key: `p${c.id}`,
      node: (
        <li key={`p${c.id}`} data-price-change={c.version}>
          <div className="when">{fmtDateTime(c.at)}{c.who ? ` · ${c.who}` : ''}</div>
          <div><b>{t('order.priceHistory.label', { v: c.version })}</b> — {c.sent ? t('order.priceHistory.sent') : t('order.priceHistory.draft')}</div>
          <ul className="price-changes">
            {c.changes.map((x) => {
              const what = [x.kind === 'CNC' || x.kind === 'DELIK' ? lineKindText(t, x.kind) : '', x.description, x.enMm && x.boyMm ? `${x.enMm}×${x.boyMm}` : ''].filter(Boolean).join(' ');
              const change = x.change === 'ADDED' ? `${t('order.priceHistory.added')}: ${money(x.new, c.currency)}`
                : x.change === 'REMOVED' ? `${money(x.old, c.currency)} → ${t('order.priceHistory.removed')}`
                  : `${money(x.old, c.currency)} → ${money(x.new, c.currency)}`;
              return <li key={`${x.no}${x.change}`}>{t('order.priceHistory.line', { no: x.no })} {what}: <b>{change}</b></li>;
            })}
          </ul>
          {c.more > 0 && <div className="small muted">{t('order.priceHistory.more', { n: c.more })}</div>}
          {c.oldTotal != null && c.newTotal != null && <div className="small muted">{t('order.priceHistory.total', { from: fmtMoney(c.oldTotal, c.currency), to: fmtMoney(c.newTotal, c.currency) })}</div>}
        </li>
      ),
    });
  }
  items.sort((a, b) => b.at.getTime() - a.at.getTime());
  return (
    <SidebarPortal>
      <div className="nav-section">{t('order.history')}</div>
      <ul className="timeline side-timeline">{items.map((i) => i.node)}</ul>
    </SidebarPortal>
  );
}

// ---------------- işlem kartları ----------------
function CustomerActions({ order, user, can, t }: { order: OrderDetail; user: CurrentUser; can: (a: string) => boolean; t: T }) {
  const s = customerSummaryText(t, { status: order.status, drawing: order.drawingTrack, offer: sentOffer(order) ? 'GONDERILDI' : null });
  const latest = order.drawings[order.drawings.length - 1];
  // Müşteri ekranda gördüğü sürüme karar verir; bu arada yeni sürüm yüklendiyse işlem reddedilir
  const hidden = <><input type="hidden" name="id" value={order.id} />{latest && <input type="hidden" name="drawingId" value={latest.id} />}</>;
  const waiting = order.drawingTrack === 'ONAY_BEKLIYOR' && order.status === 'HAZIRLANIYOR';
  // Çizim hatalı bulundu (karar 167): düzeltilmiş dosya gönder (en az bir DWG / DXF) ya da fabrikadan çizim iste. İkisi de
  // onay yetkisi ister (çizim kararı); yetkisiz kullanıcı yalnızca görür. Asıl denetim sunucu işlemlerinde.
  const correction = order.drawingTrack === 'DUZELTME_BEKLIYOR' && order.status === 'HAZIRLANIYOR';
  return (
    <div className={`card ${waiting || correction ? 'turn' : ''}`} id={correction ? 'duzeltme' : undefined}>
      <h2 style={{ marginBottom: 4 }}>{s.next}</h2>
      {correction && !user.canApprove && <div className="alert alert-warn" style={{ marginTop: 8 }}>{t('order.customer.correctionNoRight')}</div>}
      {correction && can('dwg_resubmit') && (
        <form action={dwgResubmitAction} className="drawing-upload" style={{ marginTop: 10 }}>
          <input type="hidden" name="id" value={order.id} />
          <label htmlFor="dwg-resubmit">{t('order.customer.correctionResubmit')}</label>
          <input id="dwg-resubmit" name="files" type="file" multiple required accept={ACCEPT} />
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
            <span className="hint">{t('order.upload.scanInfo')}</span>
            <button className="btn btn-primary">{t('order.customer.correctionResubmitButton')}</button>
          </div>
        </form>
      )}
      {correction && can('dwg_request_drawing') && (
        <form action={dwgRequestDrawingAction} className="row" style={{ gap: 8 }}>
          <input type="hidden" name="id" value={order.id} />
          <span className="muted small" style={{ flex: '1 1 260px' }}>{t('order.customer.correctionFactoryHint')}</span>
          <ConfirmButton outline message={t('order.customer.correctionFactoryConfirm')}>{t('order.customer.correctionFactory')}</ConfirmButton>
        </form>
      )}
      {waiting && !user.canApprove && (
        <div className="alert alert-warn" style={{ marginTop: 8 }}>{t('order.customer.noApproveRight')}</div>
      )}
      {waiting && <p className="muted small">{t('order.customer.reviewHint')}</p>}
      {waiting && latest && (
        // Ana işlem "Aç ve incele" (karar 162): çizim görüntüleyici (onay ve revizyon orada da var). "Bu çizimi onayla" ve
        // "Revizyon iste" (numaralı maddelerle zorunlu not) ikincildir; ikisi de yalnızca onay yetkili kullanıcıda
        // (sunucuda denetlenir).
        <div className="row" style={{ marginTop: 12, gap: 8 }}>
          <Link className="btn btn-primary" href={`/siparisler/${order.id}/cizim/${latest.id}`}>{t('order.drawings.review')}</Link>
          {can('approve_drawing') && (
            <form action={approveDrawingAction}>
              {hidden}
              <ConfirmButton success message={t('order.customer.approveConfirm', { v: latest.version })}>{t('order.steps.approve_drawing')}</ConfirmButton>
            </form>
          )}
          {can('request_revision') && <Link className="btn" href={`/siparisler/${order.id}/cizim/${latest.id}?revizyon=1`}>{t('order.steps.request_revision')}</Link>}
        </div>
      )}
      {!waiting && !correction && <p className="muted small">{t('order.customer.nothingToDo')}</p>}
    </div>
  );
}

function InternalActions({ order, user, can, acts, t }: { order: OrderDetail; user: CurrentUser; can: (a: string) => boolean; acts: string[]; t: T }) {
  const hidden = <input type="hidden" name="id" value={order.id} />;
  const offerStatus = currentOffer(order)?.status ?? null;
  const steps = acts.filter(isStep).map((a) => t(`order.steps.${a}`));
  const blockers = order.status === 'HAZIRLANIYOR' && !order.onHold && userCan(user, 'ORDER_REVIEW')
    ? productionBlockers({ status: order.status, drawing: order.drawingTrack, offer: offerStatus })
    : [];
  const buttons: React.ReactNode[] = [];
  const btn = (key: string, action: (fd: FormData) => Promise<void>, label: string, extra?: React.ReactNode, confirm?: string) =>
    buttons.push(
      <form key={key} action={action}>
        {hidden}{extra}
        {confirm ? <ConfirmButton primary message={confirm}>{label}</ConfirmButton> : <button className="btn btn-primary">{label}</button>}
      </form>
    );

  if (can('send_to_drawing')) btn('d', sendToDrawingAction, t('order.steps.send_to_drawing'));
  if (can('no_drawing')) btn('o', noDrawingAction, t('order.steps.no_drawing'));
  if (can('mark_shipped')) btn('ms', markShippedAction, t('order.steps.mark_shipped'));
  if (can('archive')) btn('ar', archiveAction, t('order.steps.archive'));
  const undo = (key: string, action: (fd: FormData) => Promise<void>, label: string, message: string) =>
    buttons.push(<form key={key} action={action}>{hidden}<ConfirmButton message={message}>{label}</ConfirmButton></form>);
  if (can('undo_drawing')) undo('ud', undoDrawingAction, t('order.actions.undoDrawing'), t('order.actions.undoDrawingConfirm'));
  if (can('undo_no_drawing')) undo('un', undoNoDrawingAction, t('order.actions.undoNoDrawing'), t('order.actions.undoNoDrawingConfirm'));
  if (can('hold')) btn('h', holdAction, t('order.actions.hold'), <input type="hidden" name="hold" value="1" />);
  if (can('unhold')) btn('uh', holdAction, t('order.steps.unhold'), <input type="hidden" name="hold" value="0" />);

  // Çizim başlatma ve çizim yükleme "Teknik çizimler ve onay" bölümündedir (Drawings)
  // Tahmini yükleme tarihi Sipariş Bilgileri'nde satır içi düzenlenir (karar 230)
  const hasForms = can('cancel');

  return (
    <>
      <div className="card">
        <h2 style={{ marginBottom: 4 }}>{turnText(t, order)}</h2>
        <p className="muted small">
          {steps.length ? t('order.turn.nextStep', { steps: steps.join(' · ') }) : t('order.turn.noAction')}
          {' '}· {t('order.turn.yourRole', { role: roleText(t, user.appRole) })}
        </p>
      </div>

      {(buttons.length > 0 || hasForms || blockers.length > 0) && (
        <div className="card turn">
          <h2 style={{ marginBottom: 2 }}>{t('order.actions.title')}</h2>
          <p className="muted small">{t('order.actions.hint')}</p>
          {buttons.length > 0 && <div className="row" style={{ marginTop: 10 }}>{buttons}</div>}

          {blockers.length > 0 && (
            <div className="alert alert-info" style={{ marginTop: 12, marginBottom: 0 }}>
              <b>{t('order.actions.waitingFor')}</b> {blockers.map((b) => blockerText(t, b)).join(' · ')}
            </div>
          )}

          {can('cancel') && (
            <details style={{ marginTop: 14 }}>
              <summary className="small muted">{t('order.cancel.summary')}</summary>
              <form action={cancelAction} className="row" style={{ marginTop: 8 }}>
                {hidden}
                <input name="note" type="text" required placeholder={t('order.cancel.reason')} style={{ flex: 1 }} />
                <ConfirmButton danger solid message={t('order.cancel.confirm')}>{t('order.cancel.submit')}</ConfirmButton>
              </form>
            </details>
          )}
        </div>
      )}
    </>
  );
}

// ---------------- teklif ----------------
type Offer = OrderDetail['offers'][number];

// Eski kayıtlarda açıklaması boş CNC / delik satırına tür adı yazılırdı; rozetle aynı bilgi tekrar gösterilmez.
const LEGACY_SUB_DESC: Record<string, string> = { CNC: 'CNC', DELIK: 'Delik' };

function OfferView({ order, offer, isCustomer, finalPrice, versions, updateHref, t, locale, admin, canExport, compIds, compHref, priceLocked = [], withdraw }: { order: OrderDetail; offer: Offer; isCustomer: boolean; finalPrice: boolean; versions: number; updateHref?: string; t: T; locale: 'tr' | 'ro'; admin: boolean; canExport: boolean; compIds?: Set<string>; compHref?: (lineId: string) => string; priceLocked?: string[]; withdraw?: React.ReactNode }) {
  // Kırık / telafi (karar 108): yalnızca müşteriye gönderilmiş teklifin fiziksel cam satırlarında, satış ve yöneticide
  const compCol = !!compIds && compIds.size > 0 && !!compHref;
  // Dışa aktarma (server/orders/offer-export.js): yönetici PDF + Excel; müşteri PDF, Excel yalnızca yöneticinin izniyle.
  // Asıl kontrol indirme adresinde (teklif/route.ts) yapılır.
  const exportHref = (f: 'pdf' | 'xlsx') => `/siparisler/${order.id}/teklif?format=${f}`;
  const showExport = canExport && (admin || offer.status === 'GONDERILDI') && order.orderTypeCode === 'GLASS_ORDER';
  // Veriler role göre temizlendi (lib/orders.ts → offerPrices): müşteri/denetimcide unitPrice ve amount müşteri fiyatıdır,
  // satışta satış fiyatı. Yönetici iki fiyatı yan yana görür (karar 4).
  const total = offer.status === 'GONDERILDI' && order.price && finalPrice && !admin ? order.price.amount : offer.amount;
  const offerTotal = admin ? offerTotals(atOfferPrice(offer.lines.map((l) => ({ ...l, unitPrice: l.unitPrice.toString(), offerPrice: l.offerPrice?.toString() ?? null })))).amount : 0;
  const updated = offer.status === 'GONDERILDI' && versions > 1;
  return (
    <div className="card" id="teklif">
      <div className="section-head">
        <h2>{isCustomer ? t('offer.view.titleCustomer') : t('offer.view.title')}</h2>
        <span className="row">
          {!isCustomer && <OfferBadge status={offer.status} />}
          {!isCustomer && updated && <span className="badge badge-info">{t('offer.view.version', { n: versions })}</span>}
          {offer.sentAt && (
            <span className="muted small">
              {updated
                ? t('offer.view.updatedAt', { date: fmtDate(offer.sentAt) })
                : isCustomer ? fmtDate(offer.sentAt) : t('offer.view.sentAt', { date: fmtDate(offer.sentAt) })}
            </span>
          )}
        </span>
      </div>
      {/* Uzun tabloda ↑ / ↓ (TableJump): düzenlenebilir tabloyla aynı — teklif yöneticide ya da müşterideyken de görünür */}
      <div className="table-wrap offer-wrap" id="offer-table">
        <table className={compCol ? 'offer-view has-actions' : 'offer-view'}>
          <thead><tr><th>#</th><th>{t('offer.cols.description')}</th><th>{t('offer.cols.poz')}</th><th className="num">{t('offer.cols.width')}</th><th className="num">{t('offer.cols.height')}</th><th className="num">{t('offer.cols.qty')}</th><th className="num">{t('offer.cols.metraj')}</th><th className="num">{admin ? t('offer.cols.salesPrice') : t('offer.cols.unitPrice')}</th>{admin && <th className="num">{t('offer.cols.offerPrice')}</th>}<th className="num">{admin ? t('offer.cols.offerAmount') : t('offer.cols.amount')}</th>{compCol && <th />}</tr></thead>
          <tbody>
            {(() => {
              let n = 0;
              return offer.lines.map((l) => {
                const tot = offerLineTotals({ ...l, unitPrice: (admin ? l.offerPrice ?? 0 : l.unitPrice ?? 0).toString() });
                const unitTxt = (v: { toString(): string } | null) => (v == null ? '—' : `${fmtNum(v.toString())} / ${!sub && l.unit === 'm2' ? 'm²' : t('common.unitPiece')}`);
                const sub = l.kind === 'CNC' || l.kind === 'DELIK';
                // Satışın sandık parası (karar 211, 214): bağımsız, numaralı kalem (yöneticinin sandık satırıyla aynı); rozet yalnızca yöneticide
                const salesCrate = admin && isSalesCrate(l);
                if (!sub) n += 1;
                const kindLabel = sub ? lineKindText(t, l.kind) : '';
                const desc = sub && (l.description === kindLabel || l.description === LEGACY_SUB_DESC[l.kind]) ? ''
                  : locale === 'ro' && l.descriptionRo ? l.descriptionRo : l.description;
                return (
                  <tr key={l.id} className={sub ? 'sub-line' : undefined}>
                    <td className="muted">{sub ? '' : n}</td>
                    <td>
                      {sub && <span className="badge badge-info">{kindLabel}</span>}{' '}
                      {desc}
                      {l.free && <> <span className="badge badge-ok">{t('offer.free')}</span></>}
                      {!isCustomer && l.compensationId && <> <span className="badge badge-warn">{t('compensation.badge')}</span></>}
                      {/* Yöneticinin sandık bedeli (Paket 4): satış bu satırı hiç almaz; yönetici "satış görmez" rozetiyle görür */}
                      {admin && l.crateFee && <> <span className="badge badge-info" data-crate-fee>{t('offer.editor.crateBadge')}</span></>}
                      {salesCrate && <> <span className="badge badge-info" data-sales-crate>{t('offer.editor.salesCrateAdminBadge')}</span></>}
                    </td>
                    <td>{l.poz ?? ''}</td>
                    <td className="num">{l.enMm ?? ''}</td><td className="num">{l.boyMm ?? ''}</td><td className="num">{l.adet}</td>
                    <td className="num">{!sub && l.unit === 'm2' ? `${fmtM2(tot.metraj)} m²` : '—'}</td>
                    <td className={`num${admin ? ' muted' : ''}`}>{l.free ? t('offer.free') : unitTxt(l.unitPrice)}</td>
                    {admin && <td className="num">{l.free ? t('offer.free') : unitTxt(l.offerPrice)}</td>}
                    <td className="num">{fmtNum(tot.amount)}</td>
                    {compCol && (
                      <td className="actions">
                        {compIds?.has(l.id) && compHref && <Link className="btn btn-link" href={compHref(l.id)} title={t('compensation.rowActionTitle')}>{t('compensation.rowAction')}</Link>}
                      </td>
                    )}
                  </tr>
                );
              });
            })()}
          </tbody>
          <tfoot>
            {admin ? (
              <tr><td colSpan={7}>{t('common.total')}</td><td className="num muted">{fmtMoney(offer.amount.toString(), offer.currency)}</td><td /><td className="num"><b>{fmtMoney(offerTotal.toFixed(2), offer.currency)}</b></td>{compCol && <td />}</tr>
            ) : (
              <tr><td colSpan={8}>{t('common.total')}</td><td className="num">{total == null ? <span className="muted">—</span> : <b>{fmtMoney(total.toString(), offer.currency)}</b>}</td>{compCol && <td />}</tr>
            )}
          </tfoot>
        </table>
      </div>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
        <p className="muted small" style={{ margin: 0 }}>
          {t('common.pricesExclVat')}
          {/* Kur notu müşterinin kur politikasından gelir; politika satış / çizim ekibine gitmez (SEC-07) → onlarda not yok */}
          {offer.currency === 'EUR' && order.customer.fxPolicy && <><br />{fxOfferNote(t, order.customer.fxPolicy)}</>}
        </p>
        <span className="row" style={{ gap: 8 }}>
          {showExport && <a className="btn" href={exportHref('pdf')}>{t('offer.export.pdf')}</a>}
          {showExport && (admin || order.customerExcel) && <a className="btn" href={exportHref('xlsx')}>{t('offer.export.xlsx')}</a>}
          {updateHref && <Link href={updateHref} className="btn">{t('offer.view.update')}</Link>}
        </span>
      </div>
      {withdraw && <div style={{ marginTop: 10 }} data-offer-withdraw>{withdraw}</div>}
      <TableJump targetId="offer-table" up={t('offer.import.jumpTop')} down={t('offer.import.jumpBottom')} />
      {/* Mali kilit (yönetici — Paket 4): "Teklifi güncelle" yerine neden fiyatın değişmeyeceği */}
      {admin && priceLocked.length > 0 && (
        <div className="alert alert-warn" id="fiyat-kilidi" style={{ marginTop: 10 }}>
          <b>{t('order.priceLock.title')}</b> {t('order.priceLock.text')}
          <ul className="plain-list" style={{ marginTop: 6 }}>{priceLocked.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}
      {admin && order.orderTypeCode === 'GLASS_ORDER' && (
        <form action={setCustomerExcelAction} className="row" style={{ gap: 8, marginTop: 8 }}>
          <input type="hidden" name="id" value={order.id} />
          <input type="hidden" name="allow" value={order.customerExcel ? '0' : '1'} />
          <span className="small">
            {t('offer.export.customerExcel')}: <b>{order.customerExcel ? t('offer.export.on') : t('offer.export.off')}</b>
          </span>
          <button className="btn">{order.customerExcel ? t('offer.export.turnOff') : t('offer.export.turnOn')}</button>
        </form>
      )}
    </div>
  );
}

// ---------------- önemli kararlar (kırık / telafi camı) ----------------
/**
 * Sipariş sayfasındaki "Önemli kararlar" kartı (karar 108): bu siparişin kaynağı ya da hedefi olduğu telafi kararlarının
 * kısa geçmişi ve "Kırık / Telafi Camı Oluştur" düğmesi (teklif satırındaki düğmeyle AYNI formu açar — ikinci bir telafi
 * mantığı yoktur). Veriler role göre temizlenmiştir (lib/compensation.ts): satış müşteri fiyatını görmez — yalnızca kararın
 * türünü (bedelsiz / aynı fiyat / farklı fiyat). Satışın "farklı fiyat" kararı, hedef siparişin teklifi müşterideyse
 * yöneticinin onayını bekler; onay / ret burada verilir (yalnızca yönetici) — karar 157.
 */
function Decisions({ order, user, comps, createHref, error, t, locale }: { order: OrderDetail; user: CurrentUser; comps: CompEntry[]; createHref: string | null; error: string | null; t: T; locale: 'tr' | 'ro' }) {
  const admin = userCan(user, 'OFFER_SEND');
  const price = (v: number | null, cur: string) => (v == null ? '—' : v === 0 ? t('compensation.free') : t('compensation.perM2', { price: fmtNum(v), cur }));
  return (
    <div className="card" id="kararlar">
      <div className="section-head">
        <h2>{t('compensation.decisions.title')}</h2>
        {createHref && <Link className="btn" href={createHref}>{t('compensation.decisions.create')}</Link>}
      </div>
      <p className="muted small">{t('compensation.decisions.intro')}</p>
      {error && <div className="alert alert-error">{error}</div>}
      {comps.length === 0 && <p className="muted">{createHref ? t('compensation.decisions.none') : t('compensation.decisions.noSentOffer')}</p>}
      {comps.map((c) => {
        const glass = `${locale === 'ro' && c.glassRo ? c.glassRo : c.glass}${c.enMm && c.boyMm ? ` · ${c.enMm}×${c.boyMm}` : ''}`;
        const customerTier = c.tier === 'CUSTOMER';
        const destText = c.destOrder
          ? c.destOrder.removed ? t('compensation.decisions.destRemoved', { order: c.destOrder.orderNo }) : t('compensation.decisions.dest', { order: c.destOrder.orderNo, date: c.day ? fmtDate(`${c.day}T12:00:00Z`) : '—' })
          : null;
        return (
          <div key={c.id} className="note comp-entry" data-comp={c.id} data-status={c.status}>
            <div className="row">
              <b className="mono">{c.sourceOrder.orderNo}</b>
              <span className="badge badge-warn">{t('compensation.badge')}</span>
              <b>{t('compensation.decisions.qty', { qty: c.quantity })}</b>
              {c.status !== 'APPLIED' && <span className={`badge ${c.status === 'PENDING' ? 'badge-danger' : 'badge-muted'}`}>{t(`compensation.decisions.status.${c.status}` as MsgKey)}</span>}
              {/* Fiyat kararı her telafide görünür: bedelsiz / aynı fiyat / farklı fiyat (tutar taşımaz — satış da görür) */}
              <span className="badge badge-info" data-comp-mode={c.mode}>{t(`compensation.decisions.flag.${c.free ? 'FREE' : c.mode}` as MsgKey)}</span>
            </div>
            <div className="small">
              {c.sourceOrder.id !== order.id && <><Link href={`/siparisler/${c.sourceOrder.id}#kararlar`}>{t('compensation.decisions.sourceOrder', { order: c.sourceOrder.orderNo })}</Link> · </>}
              {t('compensation.decisions.source', { glass })}
            </div>
            <div className="small">
              {c.normal != null || c.price != null ? (
                <>
                  {t(customerTier ? 'compensation.decisions.normalCustomer' : 'compensation.decisions.normalSales', { price: price(c.normal, c.currency) })}{' · '}
                  <b>{t(customerTier ? 'compensation.decisions.priceCustomer' : 'compensation.decisions.priceSales', { price: price(c.price, c.currency) })}</b>
                  {c.awaitingPrice && <> · {t('compensation.decisions.priceAdminPending')}</>}
                </>
              ) : <>{t('compensation.decisions.modeOnly', { mode: t(`compensation.decisions.mode.${c.mode}` as MsgKey) })}{c.awaitingPrice && <> · {t('compensation.decisions.priceAdminPending')}</>}</>}
            </div>
            {destText && (
              <div className="small">
                {c.destOrder && !c.destOrder.removed && c.destOrder.id !== order.id ? <Link href={`/siparisler/${c.destOrder.id}`}>{destText}</Link> : destText}
                {' '}({t(`compensation.decisions.destType.${c.destType}` as MsgKey)}){c.linked && <> · {t('compensation.decisions.linked')}</>}
              </div>
            )}
            <div className="meta">
              {t('compensation.decisions.by', { who: c.createdBy })} · {t('compensation.decisions.at', { when: fmtDateTime(c.createdAt) })}
              {c.decidedBy && <> · {t(`compensation.decisions.status.${c.status}` as MsgKey)}: {t('compensation.decisions.decided', { who: c.decidedBy, when: fmtDateTime(c.decidedAt) })}{c.decisionNote ? ` — ${c.decisionNote}` : ''}</>}
            </div>
            {c.status === 'PENDING' && <p className="hint">{t('compensation.decisions.pendingHint')}</p>}
            {c.status === 'PENDING' && admin && (
              <>
                <form action={decideCompensationAction} className="row">
                  <input type="hidden" name="id" value={order.id} />
                  <input type="hidden" name="compId" value={c.id} />
                  <input type="hidden" name="do" value="approve" />
                  <label className="small" htmlFor={`cp-${c.id}`} style={{ margin: 0 }}>{t('compensation.decisions.customerPrice', { cur: c.currency })}</label>
                  <input id={`cp-${c.id}`} name="price" inputMode="decimal" style={{ width: 120 }}
                    defaultValue={c.customerPrice != null && !c.free ? c.customerPrice.toFixed(2) : ''} placeholder={c.normalCustomer != null ? c.normalCustomer.toFixed(2) : ''} />
                  <label className="check small"><input type="checkbox" name="free" defaultChecked={c.free} /> {t('compensation.decisions.makeFree')}</label>
                  <ConfirmButton success message={t('compensation.decisions.approveConfirm')}>{t('compensation.decisions.approve')}</ConfirmButton>
                </form>
                <form action={decideCompensationAction} className="row">
                  <input type="hidden" name="id" value={order.id} />
                  <input type="hidden" name="compId" value={c.id} />
                  <input type="hidden" name="do" value="reject" />
                  <input name="note" maxLength={300} placeholder={t('compensation.decisions.rejectNote')} aria-label={t('compensation.decisions.rejectNote')} style={{ flex: 1, minWidth: 160 }} />
                  <ConfirmButton danger message={t('compensation.decisions.rejectConfirm')}>{t('compensation.decisions.reject')}</ConfirmButton>
                </form>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------- sandıklar ----------------
function Crates({ order, t }: { order: OrderDetail; t: T }) {
  const load = loadOf(order, false);
  const day = shipDay(order);
  const nos = [...new Set(order.crateLinks.map((l) => l.crate.crateNo))].sort((a, b) => a - b);
  return (
    <div className="card" id="sandik">
      <h2>{t('order.crates.title')}</h2>
      <p className="muted small">{t('order.crates.plan', { m2: fmtM2(load.metraj), glass: load.camAdet, net: fmtNum(load.netKg, 0) })}</p>
      <p>{nos.length ? t('order.crates.linked', { list: nos.join(', ') }) : <span className="muted">{t('order.crates.none')}</span>}</p>
      <p className="muted small">
        {t('order.crates.where')}{' '}
        {day && <Link href={`/yuklemeler?ay=${day.slice(0, 7)}&gun=${day}#gun`}>{t('order.crates.open')}</Link>}
      </p>
    </div>
  );
}

// ---------------- çizim, dosya, not ----------------
type DrawingRow = OrderDetail['drawings'][number];
type Can = (a: string) => boolean;

/** Fabrika sürümünün durum rozeti */
function versionBadge(t: T, st: string): React.ReactNode {
  return ({
    TASLAK: <span className="badge badge-muted">{t('order.drawings.draft')}</span>,
    ONAY_BEKLIYOR: <span className="badge badge-warn">{t('order.drawings.pending')}</span>,
    ONAYLANDI: <span className="badge badge-ok">{t('order.drawings.approved')}</span>,
    REVIZYON_ISTENDI: <span className="badge badge-danger">{t('order.drawings.revisionRequested')}</span>,
    GERI_CEKILDI: <span className="badge badge-muted">{t('order.drawings.withdrawn')}</span>,
  } as Record<string, React.ReactNode>)[st] ?? null;
}

/** Müşterinin DWG/DXF karar kaydının durumu → rozet rengi (karar 167; metni order.dwg.status.<durum>) */
const DWG_TONE: Record<string, string> = { BEKLIYOR: 'badge-warn', ONAYLANDI: 'badge-ok', REVIZYON_ISTENDI: 'badge-danger', YAPILIYOR: 'badge-purple' };

/**
 * Çizim alanındaki çevrilemeyen notun "Çeviriyi yeniden dene" düğmesi (karar 168). Yalnızca iç ekibe ve yalnızca
 * başarısız / yarıda kalmış çeviride görünür (RevisionNote karar verir); asıl kural sunucuda (retryDrawingTranslation).
 */
function RetryTranslation({ orderId, target, id, t }: { orderId: string; target: 'revision' | 'drawing'; id: string; t: T }) {
  return (
    <form action={retryDrawingTranslationAction}>
      <input type="hidden" name="id" value={orderId} />
      <input type="hidden" name="target" value={target} />
      <input type="hidden" name="targetId" value={id} />
      <button className="btn btn-link">{t('order.notes.translation.retry')}</button>
    </form>
  );
}

/**
 * Sürümün müşteri notu (saklanan Romence çevirisiyle — karar 168: sürüm müşteriye gönderilirken bir kez çevrilir) ve iç
 * notu. Çeviri alanları sunucuda role göre temizlenmiştir (sanitizeOrder → drawingTranslationsFor): müşteri tamamlanmış
 * Romence çeviriyi, iç ekip yalnızca özgün notu (+ başarısız çevirinin durumu), denetimci yalnızca özgün notu alır.
 */
function VersionNotes({ order, d, user, t }: { order: OrderDetail; d: DrawingRow; user: CurrentUser; t: T }) {
  const isCustomer = user.appRole === 'MUSTERI';
  return (
    <>
      {d.noteCustomer && (
        <div className="note" data-version-note={d.id}>
          <b className="small">{t('order.drawings.noteCustomer')}</b>
          <RevisionNote
            r={{ comment: d.noteCustomer, translation: d.translation, translationLang: d.translationLang, translationStatus: d.translationStatus, translationError: d.translationError, translationAt: d.translationAt }}
            role={user.appRole} t={t} retry={<RetryTranslation orderId={order.id} target="drawing" id={d.id} t={t} />}
          />
        </div>
      )}
      {!isCustomer && d.noteInternal && <div className="note internal"><b className="small">{t('order.drawings.noteInternal')}</b> {d.noteInternal}</div>}
    </>
  );
}

/**
 * Sürümün revizyon kayıtları: müşterinin revizyon talebi (numaralı not — karar 162–163) ve çizimcinin "çizim hatalı"
 * açıklaması (karar 167–168). Saklanan çeviri gösterilir; sayfa çeviri YAPMAZ. Kayıtlar silinmez — geçmiş korunur.
 */
function RevisionNotes({ order, d, user, t }: { order: OrderDetail; d: DrawingRow; user: CurrentUser; t: T }) {
  const isCustomer = user.appRole === 'MUSTERI';
  return (
    <>
      {d.revisions.map((r) => {
        // Eski taleplerin çizim üstü işaretleri yalnızca iç ekibe (müşteri ekranında işaret yok — karar 162)
        const marks = !isCustomer && Array.isArray(r.annotations) ? r.annotations.length : 0;
        const faulty = r.kind === 'HATALI';
        return (
          <div key={r.id} className="note" data-revision={r.id} data-revision-kind={r.kind}>
            <b className="small">{t(faulty ? 'order.dwg.faultyLabel' : 'order.drawings.revisionRequest')}</b>
            <RevisionNote r={r} role={user.appRole} t={t} retry={<RetryTranslation orderId={order.id} target="revision" id={r.id} t={t} />} />
            <div className="meta">
              {fmtDateTime(r.createdAt)}
              {marks > 0 && <> · <Link href={`/siparisler/${order.id}/cizim/${d.id}?rev=${r.id}`}>{t('order.drawings.marks', { n: marks })}</Link></>}
            </div>
          </div>
        );
      })}
    </>
  );
}

/**
 * Müşterinin DWG/DXF çiziminin karar kaydı (karar 167): kararın verildiği dosyalar (müşterinin kendi sipariş dosyaları —
 * dosya adresi /dosya/siparis kendi kuralıyla denetler), karar, tarih ve "hatalı" açıklaması. Kayıt değişmez; hatalı bulunan
 * dosya ve karar geçmişte kalır. Müşteri iç ekipten kişi adı görmez (yalnızca tarih).
 */
function CustomerRecord({ order, d, user, t }: { order: OrderDetail; d: DrawingRow; user: CurrentUser; t: T }) {
  const isCustomer = user.appRole === 'MUSTERI';
  const files = sourceFilesOf(d.sourceFiles);
  const status = Object.hasOwn(DWG_TONE, d.status) ? d.status : null;
  return (
    <div className="drawing-version customer-record" data-dwg-record={d.id} data-dwg-status={d.status}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span className="badge badge-muted">v{d.version}</span>
        <b className="small">{t('order.dwg.record')}</b>
        {status && <span className={`badge ${DWG_TONE[status]}`}>{t(`order.dwg.status.${status}` as MsgKey)}</span>}
        <span className="muted small">{t('order.dwg.submitted', { when: fmtDateTime(d.createdAt) })}</span>
        {d.decidedAt && (
          <span className="muted small">
            {isCustomer ? fmtDateTime(d.decidedAt) : t('order.drawings.decidedBy', { who: d.decidedBy ? personText(t, d.decidedBy) : '—', when: fmtDateTime(d.decidedAt) })}
          </span>
        )}
      </div>
      {files.length > 0 && (
        <div className="dwg-files">
          {files.map((f) => <a key={f.id} className="mono small" href={`/dosya/siparis/${f.id}`}>{f.name}</a>)}
        </div>
      )}
      <RevisionNotes order={order} d={d} user={user} t={t} />
    </div>
  );
}

/**
 * Fabrika çizim sürümü. part: 'all' (iç ekip ve müşteri — tek kart) · 'files' (çizimci: "Teknik çizim dosyaları" —
 * dosyalar, notlar, taslakta "Kontrol Et") · 'review' (çizimci: "Çizim onayı ve revizyon" — karar, revizyon notları,
 * geri çekme). Gönderim sipariş sayfasında yoktur: önce "Kontrol Et" (görüntüleyici; sunucu kontrol kanıtı ister).
 */
function FactoryVersion({ order, d, current, user, can, t, part }: { order: OrderDetail; d: DrawingRow; current: boolean; user: CurrentUser; can: Can; t: T; part: 'all' | 'files' | 'review' }) {
  const isCustomer = user.appRole === 'MUSTERI';
  const draft = d.status === 'TASLAK';
  const blocked = d.files.length === 0 || d.files.some((f) => f.scanStatus !== 'CLEAN');
  const viewable = d.files.some((f) => isViewable(f.name));
  const showFiles = part !== 'review';
  const showReview = part !== 'files';
  return (
    <div className={`drawing-version${draft ? ' draft' : ''}`} data-version={d.version}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {/* "güncel" etiketi bir kez: çizimcinin ekranında dosyalar bölümünde (onay / revizyon bölümü aynı sürümü tekrar etiketlemez) */}
        <span className={`badge ${current && part !== 'review' ? 'badge-info' : 'badge-muted'}`}>v{d.version}{current && !draft && part !== 'review' ? ` · ${t('order.drawings.current')}` : ''}</span>
        {versionBadge(t, d.status)}
        {draft && <b className="small">{t('order.upload.draftTitle', { v: d.version })}</b>}
        {!isCustomer && d.sentAt && <span className="muted small">{t('order.drawings.sentBy', { who: d.sentBy?.name ?? '—', when: fmtDateTime(d.sentAt) })}</span>}
        {isCustomer && d.sentAt && <span className="muted small">{fmtDateTime(d.sentAt)}</span>}
        {d.decidedAt && <span className="muted small">{t('order.drawings.decidedBy', { who: d.decidedBy ? personText(t, d.decidedBy) : '—', when: fmtDateTime(d.decidedAt) })}</span>}
        {/* Müşterinin onayını bekleyen sürümde "Deschide și verifică" ana işlemdir (karar 162): belirgin düğme */}
        {!draft && d.files.some((f) => isViewable(f.name) && f.scanStatus !== 'INFECTED') && (
          isCustomer && current && d.status === 'ONAY_BEKLIYOR'
            ? <Link className="btn btn-primary" href={`/siparisler/${order.id}/cizim/${d.id}`}>{t('order.drawings.review')}</Link>
            : <Link className="small" href={`/siparisler/${order.id}/cizim/${d.id}`}>{t('order.drawings.review')}</Link>
        )}
      </div>
      {showFiles && <VersionNotes order={order} d={d} user={user} t={t} />}
      {showFiles && d.files.length === 0 && draft && <p className="muted small">{t('order.upload.draftEmpty')}</p>}
      {showFiles && d.files.map((f) => (
        <div key={f.id} className="file-row">
          <div className="file-ext">{f.name.split('.').pop()?.slice(0, 4) || t('order.drawings.fileFallback')}</div>
          <div className="grow">
            <div className="fname">{f.name}</div>
            <div className="small muted"><ScanBadge status={f.scanStatus} t={t} /> {fmtBytes(f.size)} · {fmtDateTime(f.createdAt)}</div>
          </div>
          <FileButtons href={`/dosya/cizim/${f.id}`} name={f.name} scanStatus={f.scanStatus} t={t} />
          {draft && can('remove_drawing_file') && (
            <form action={removeDrawingFileAction}>
              <input type="hidden" name="id" value={order.id} />
              <input type="hidden" name="fileId" value={f.id} />
              <ConfirmButton danger message={t('order.upload.removeConfirm', { name: f.name })}>{t('order.upload.remove')}</ConfirmButton>
            </form>
          )}
        </div>
      ))}
      {showReview && <RevisionNotes order={order} d={d} user={user} t={t} />}
      {showReview && d.withdrawReason && <div className="note"><b className="small">{t('order.drawings.withdrawReason')}</b> {d.withdrawReason}{d.withdrawnAt && <div className="meta">{fmtDateTime(d.withdrawnAt)}</div>}</div>}
      {showFiles && draft && can('send_drawing') && d.files.length > 0 && (
        // Gönderim bu sayfada yok: önce "Kontrol Et" (görüntüleyici), "Müşteriye gönder" o ekrandadır (sunucu da kanıt ister)
        <div className="row drawing-next">
          <Link className="btn btn-primary" href={`/siparisler/${order.id}/cizim/${d.id}`}>{t('order.upload.check')}</Link>
          <span className="muted small">{blocked ? t('order.upload.sendBlocked') : !viewable ? t('order.upload.sendNeedsViewable') : t('order.upload.checkFirst')}</span>
        </div>
      )}
      {showReview && d.status === 'ONAY_BEKLIYOR' && can('withdraw_drawing') && (
        <form action={withdrawDrawingAction} style={{ marginTop: 8 }}>
          <input type="hidden" name="id" value={order.id} />
          <label htmlFor={`wd-${d.id}`} className="small">{t('order.upload.withdrawLabel', { v: d.version })}</label>
          <div className="row">
            <input id={`wd-${d.id}`} name="reason" required maxLength={1000} placeholder={t('order.upload.withdrawPlaceholder')} style={{ flex: 1 }} />
            <ConfirmButton danger message={t('order.upload.withdrawConfirm', { v: d.version })}>{t('order.upload.withdraw')}</ConfirmButton>
          </div>
        </form>
      )}
    </div>
  );
}

/** Çizime başla + taslağa yükleme formu (çizimci; yetki ve durum işlemde, sunucuda denetlenir) */
function DrawingUpload({ order, can, t, anchor }: { order: OrderDetail; can: Can; t: T; anchor?: string }) {
  return (
    <>
      {can('start_drawing') && (
        <form action={startDrawingAction} className="row drawing-start">
          <input type="hidden" name="id" value={order.id} />
          <button className="btn btn-primary">{t('order.steps.start_drawing')}</button>
          <span className="muted small">{t('order.upload.start')}</span>
        </form>
      )}
      {can('upload_drawing') && (() => {
        // Akış (karar 84): Yükle → Kontrol Et → (görüntüleyici) → Müşteriye gönder → onay penceresi
        const last = order.drawings[order.drawings.length - 1];
        const v = last?.status === 'TASLAK' ? last.version : (last?.version ?? 0) + 1;
        return (
          <form action={uploadDrawingAction} className="drawing-upload" id={anchor}>
            <input type="hidden" name="id" value={order.id} />
            <label htmlFor="drawing-file">{t(order.drawingTrack === 'REVIZYON_ISTENDI' ? 'order.upload.labelRevised' : 'order.upload.label', { v })}</label>
            <input id="drawing-file" name="files" type="file" multiple required accept={ACCEPT} />
            <div className="grid-2" style={{ marginTop: 8 }}>
              <div>
                <label htmlFor="d-note-c" className="small">{t('order.upload.noteCustomer')}</label>
                <input id="d-note-c" name="noteCustomer" maxLength={2000} placeholder={t('order.upload.noteCustomerPlaceholder')} />
              </div>
              <div>
                <label htmlFor="d-note-i" className="small">{t('order.upload.noteInternal')}</label>
                <input id="d-note-i" name="noteInternal" maxLength={2000} />
              </div>
            </div>
            <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
              <span className="hint">{t('order.upload.scanInfo')} {t('order.upload.sendNeedsViewable')}</span>
              <button className="btn btn-primary">{t('order.upload.submit')}</button>
            </div>
          </form>
        );
      })()}
    </>
  );
}

/**
 * Müşterinin DWG/DXF çizimi için çizimci kararı (karar 167): karar bekleniyorsa incelenecek dosyalar ve üç ayrı karar;
 * müşterinin düzeltmesi bekleniyorsa bilgi + "Çizimi Güncelle". Düğmeleri availableActions belirler; asıl yetki ve durum
 * denetimi sunucu işlemlerinde (dwg_ready / dwg_faulty / dwg_update).
 */
function DwgPanel({ order, can, t }: { order: OrderDetail; can: Can; t: T }) {
  const decide = { ready: can('dwg_ready'), faulty: can('dwg_faulty'), update: can('dwg_update') };
  const waiting = order.status === 'HAZIRLANIYOR' && order.drawingTrack === 'DUZELTME_BEKLIYOR';
  if (decide.ready || decide.faulty) {
    const review = dwgReview(order);
    const files = review.files as { id: string; name: string }[];
    return (
      <div className="dwg-panel" id="dwg-karar">
        <h3 className="sub-title">{t('order.dwg.title')}</h3>
        <p className="small">{review.record ? t('order.dwg.resubmitted', { v: (review.record as { version: number }).version }) : t('order.dwg.intro')}</p>
        {files.length > 0 && (
          <>
            <div className="small"><b>{t('order.dwg.files')}</b></div>
            <div className="dwg-files" style={{ margin: '4px 0 10px' }}>
              {files.map((f) => <a key={f.id} className="mono small" href={`/dosya/siparis/${f.id}`}>{f.name}</a>)}
            </div>
          </>
        )}
        <ul className="dwg-hints">
          <li><b>{t('order.dwg.ready')}:</b> {t('order.dwg.readyHint')}</li>
          <li><b>{t('order.dwg.faulty')}:</b> {t('order.dwg.faultyHint')}</li>
          <li><b>{t('order.dwg.update')}:</b> {t('order.dwg.updateHint')}</li>
        </ul>
        <DwgDecision orderId={order.id} can={decide} t={t} />
      </div>
    );
  }
  if (waiting && decide.update) {
    return (
      <div className="dwg-panel" id="dwg-karar">
        <h3 className="sub-title">{t('order.dwg.waitingTitle')}</h3>
        <p className="small">{t('order.dwg.waitingText')}</p>
        <DwgDecision orderId={order.id} can={decide} t={t} />
      </div>
    );
  }
  return null;
}

/** Sipariş çizim hattının bugünkü durumu (çizimcinin "Çizim onayı ve revizyon" bölümünün başı) */
function DrawingState({ order, t }: { order: OrderDetail; t: T }) {
  if (order.drawingTrack === 'YOK') return null;
  const last = [...order.drawings].reverse().find((d) => d.status !== 'TASLAK');
  let text: string | null = null;
  if (last && order.drawingTrack === 'ONAY_BEKLIYOR' && last.status === 'ONAY_BEKLIYOR') text = t('order.drawings.awaiting', { v: last.version, when: fmtDateTime(last.sentAt ?? last.createdAt) });
  else if (last && order.drawingTrack === 'ONAYLANDI' && last.status === 'ONAYLANDI') {
    text = isCustomerDrawingRecord(last)
      ? t('order.drawings.readyState', { v: last.version, when: fmtDateTime(last.decidedAt ?? last.createdAt) })
      : t('order.drawings.approvedState', { v: last.version, when: fmtDateTime(last.decidedAt ?? last.createdAt) });
  } else if (last && order.drawingTrack === 'REVIZYON_ISTENDI' && last.status === 'REVIZYON_ISTENDI') text = t('order.drawings.revisionState', { v: last.version, when: fmtDateTime(last.decidedAt ?? last.createdAt) });
  return (
    <p className="row drawing-state" style={{ gap: 8 }}>
      <DrawingBadge track={order.drawingTrack} />
      {text && <span className="small">{text}</span>}
    </p>
  );
}

/** Sürüm listesi (yeniden eskiye): fabrika sürümü ya da müşterinin DWG/DXF karar kaydı */
function VersionList({ order, user, can, t, part }: { order: OrderDetail; user: CurrentUser; can: Can; t: T; part: 'all' | 'files' | 'review' }) {
  // Müşteriye taslak sürüm hiç gelmez; geri çekilen sürümün yalnızca satırı gelir (dosyasız, müşteri notsuz) — sanitizeOrder, karar 146
  const versions = [...order.drawings].reverse();
  const latest = versions[0];
  // "Teknik çizim dosyaları": yalnızca fabrika sürümleri (müşterinin dosyası sipariş dosyalarındadır) ·
  // "Çizim onayı ve revizyon": müşteriye gitmiş sürümler ve müşterinin karar kayıtları (taslak burada değil)
  const shown = versions.filter((d) => (part === 'files' ? !isCustomerDrawingRecord(d) : part === 'review' ? d.status !== 'TASLAK' : true));
  if (shown.length === 0) return <p className="muted">{part === 'review' ? t('order.drawings.noDecisions') : part === 'files' ? t('order.drawings.noVersions') : t('order.drawings.none')}</p>;
  return (
    <>
      {shown.map((d) => (isCustomerDrawingRecord(d)
        ? <CustomerRecord key={d.id} order={order} d={d} user={user} t={t} />
        : <FactoryVersion key={d.id} order={order} d={d} current={d.id === latest?.id} user={user} can={can} t={t} part={part} />))}
    </>
  );
}

/**
 * Teknik çizimler ve onay — tek kart (yönetici, satış, denetimci, müşteri). Çizim ekibinin ekranı aynı parçalarla iki
 * bölümdür: DrawingFiles ("Teknik çizim dosyaları") + DrawingReview ("Çizim onayı ve revizyon") — Paket 3.
 */
function Drawings({ order, user, can, t }: { order: OrderDetail; user: CurrentUser; can: Can; t: T }) {
  if (order.drawingTrack === 'YOK' && order.drawings.length === 0) return null;
  return (
    <div className="card" id="cizim">
      <h2>{t('order.drawings.title')}</h2>
      <DwgPanel order={order} can={can} t={t} />
      <DrawingUpload order={order} can={can} t={t} anchor="cizim-dosyalari" />
      <VersionList order={order} user={user} can={can} t={t} part="all" />
    </div>
  );
}

/** Çizimci: 2) Teknik çizim dosyaları — çizime başla, taslağa yükle, sürümlerin dosyaları ve notları, "Kontrol Et" */
function DrawingFiles({ order, user, can, t }: { order: OrderDetail; user: CurrentUser; can: Can; t: T }) {
  return (
    <div className="card" id="cizim-dosyalari">
      <h2>{t('order.drawings.filesTitle')}</h2>
      <DrawingUpload order={order} can={can} t={t} />
      <VersionList order={order} user={user} can={can} t={t} part="files" />
    </div>
  );
}

/** Çizimci: 3) Çizim onayı ve revizyon — durum, DWG/DXF kararı, onay / revizyon geçmişi (numaralı notlar), geri çekme */
function DrawingReview({ order, user, can, t }: { order: OrderDetail; user: CurrentUser; can: Can; t: T }) {
  return (
    <div className="card" id="cizim">
      <h2>{t('order.drawings.reviewTitle')}</h2>
      <DrawingState order={order} t={t} />
      <DwgPanel order={order} can={can} t={t} />
      <VersionList order={order} user={user} can={can} t={t} part="review" />
    </div>
  );
}

// Müşterinin ve çizimcinin yükleyebileceği türler (server/orders/rules.js → ALLOWED_EXT)
const ACCEPT = ALLOWED_EXT.map((e: string) => `.${e}`).join(',');

/** Antivirüs durumu: taranmadı (uyarı) ya da virüslü (karantina, indirilemez). Temiz/tarama kapalı → rozet yok. */
function ScanBadge({ status, t }: { status: string; t: T }) {
  if (status === 'PENDING') return <span className="badge badge-warn" title={t('order.files.scanPendingTitle')}>{t('order.files.scanPending')}</span>;
  if (status === 'INFECTED') return <span className="badge badge-danger">{t('order.files.infected')}</span>;
  return null;
}

function FileButtons({ href, name, scanStatus, t }: { href: string; name: string; scanStatus: string; t: T }) {
  if (scanStatus === 'INFECTED') return null;
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
      {isViewable(name) && <a className="btn" href={`${href}?ac=1`} target="_blank" rel="noopener">{t('common.open')}</a>}
      <a className="btn" href={href}>{t('common.download')}</a>
    </span>
  );
}

function Files({ order, user, canAdd, t }: { order: OrderDetail; user: CurrentUser; canAdd: boolean; t: T }) {
  const isCustomer = user.appRole === 'MUSTERI';
  const files = order.files.filter((f) => !isCustomer || f.kind === 'CUSTOMER');
  return (
    <div className="card">
      <h2>{isCustomer ? t('order.files.titleCustomer') : t('order.files.title')}</h2>
      {files.length === 0 && <p className="muted">{t('order.files.none')}</p>}
      {files.map((f) => (
        <div key={f.id} className="file-row">
          <div className="file-ext">{f.name.split('.').pop()?.slice(0, 4)}</div>
          <div className="grow">
            <div className="fname">{f.name}</div>
            <div className="small muted">
              <ScanBadge status={f.scanStatus} t={t} />{f.scanStatus === 'PENDING' || f.scanStatus === 'INFECTED' ? ' ' : ''}
              {fmtBytes(f.size)} · {fmtDateTime(f.createdAt)}
              {!isCustomer && <> · {f.kind === 'CUSTOMER' ? t('order.files.fromCustomer') : <span className="badge badge-muted">{t('order.files.internal')}</span>}</>}
            </div>
          </div>
          <FileButtons href={`/dosya/siparis/${f.id}`} name={f.name} scanStatus={f.scanStatus} t={t} />
        </div>
      ))}
      {canAdd && (
        <form action={addFilesAction} className="row" style={{ marginTop: 10 }}>
          <input type="hidden" name="id" value={order.id} />
          <input name="files" type="file" multiple required accept={ACCEPT} style={{ flex: 1 }} aria-label={t('order.files.add')} />
          <button className="btn">{t('order.files.add')}</button>
        </form>
      )}
      {canAdd && !isCustomer && <p className="hint">{t('order.files.internalHint')}</p>}
    </div>
  );
}

function Notes({ order, user, t, since }: { order: OrderDetail; user: CurrentUser; t: T; since: Date }) {
  const isCustomer = user.appRole === 'MUSTERI';
  // İç notlar müşteriye hiç yüklenmez; çeviri alanları da role göre sunucuda temizlenmiştir (sanitizeOrder → notesFor):
  // denetimciye çeviri alanı hiç gelmez (notu yalnızca özgün dilinde görür), müşteriye yalnızca tamamlanmış Romence çeviri.
  const notes = order.notes;
  // Çeviri durumu (bekliyor / yapılamadı) ve "yeniden dene" yalnızca çeviriyle çalışan iç ekibe (yönetici, satış, çizim)
  const staff = canRetryTranslation(user.appRole);
  const canRetry = staff;
  const now = new Date();
  // Okunmamış: başkasının yazdığı, okunma anından sonraki (gösterilen notlar zaten role göre süzülmüş — liste sayacıyla aynı kural)
  const unread = notes.filter((n) => isUnreadNote(n, user, since)).length;
  // Mesajlar doğrudan açık gösterilir (karar 225 — "Mesajları göster" düğmesi yok); her mesaj ekranda GÖRÜLDÜĞÜNDE okunur,
  // diğer uyarılar gösterildikleri bölüm görüldüğünde (Paket B — karar 228; components/OrderSeen.tsx). "Yeni" vurgusu,
  // sayfanın çizildiği andaki okunma eşiğine göredir.
  return (
    <div className="card" id="notlar">
      {/* Bölüm / mesaj görüldü → yalnızca bu kullanıcının o bölümdeki uyarıları okundu (karar 228; tarayıcıda, çizimden sonra) */}
      <OrderSeen orderId={order.id} upTo={now.toISOString()} mark={markOrderSeenAction} />
      <h2>
        {t('order.notes.title')}
        {unread > 0 && <span className="msg-count" data-unread-notes={unread} title={t('order.notes.unread', { n: unread })} aria-hidden="true">{countText(unread)}</span>}
      </h2>
      <p className="muted small">{t('order.notes.intro')}{!isCustomer && ` ${t('order.notes.introInternal')}`}</p>
      {notes.length === 0 && <p className="muted">{t('order.notes.none')}</p>}
      {notes.length > 0 && <div id="notlar-liste" data-notes-open="1">
      {notes.map((n) => {
        const fresh = isUnreadNote(n, user, since);
        const st = translationState(n, now);
        const lang = n.translationLang === 'tr' || n.translationLang === 'ro' ? n.translationLang : null;
        // Çeviri sayfa açılırken YAPILMAZ: yalnızca not yazılırken saklanan sonuç gösterilir (karar 127)
        const translated = st?.state === 'done' && lang && n.translation ? n.translation : null;
        const reason = st?.state === 'failed' ? (TRANSLATE_ERRORS.includes(st.code ?? '') ? st.code : 'ERROR') : null;
        return (
          <div key={n.id} className={`note ${n.internal ? 'internal' : ''} ${fresh ? 'note-new' : ''}`} data-note={n.id} data-at={new Date(n.createdAt).toISOString()} data-new={fresh ? '1' : undefined}>
            {translated && <div className="note-label">{t('order.notes.original')}</div>}
            <div className="pre note-text">{n.text}</div>
            {translated && lang && (
              <div className="note-translation" lang={lang} data-translation={lang}>
                {/* Etiket çevirinin dilindedir (arayüz dilinden bağımsız): "Türkçe · otomatik çevrilmiştir" / "Română · tradus automat" */}
                <div className="note-label">{translate(lang, 'order.notes.translatedLabel')}</div>
                <div className="pre">{translated}</div>
              </div>
            )}
            {staff && st?.state === 'pending' && <div className="note-translation note-state">{t('order.notes.translation.pending')}</div>}
            {staff && reason && (
              <div className="note-translation note-state failed" data-translation-failed={reason}>
                <span>{t('order.notes.translation.failed', { reason: t(`order.notes.translation.reason.${reason}` as MsgKey) })}</span>
                {canRetry && (
                  <form action={retryNoteTranslationAction}>
                    <input type="hidden" name="id" value={order.id} />
                    <input type="hidden" name="noteId" value={n.id} />
                    <button className="btn btn-link">{t('order.notes.translation.retry')}</button>
                  </form>
                )}
              </div>
            )}
            <div className="meta">
              {personText(t, n.user)}{(!isCustomer || n.user.appRole === 'MUSTERI') && personText(t, n.user) !== roleText(t, n.user.appRole) ? ` (${roleText(t, n.user.appRole)})` : ''} · {fmtDateTime(n.createdAt)}
              {n.internal && <> · <b>{t('order.notes.internal')}</b></>}
              {fresh && <> · <span className="badge badge-danger">{t('order.notes.new')}</span></>}
            </div>
          </div>
        );
      })}
      </div>}
      {userCan(user, 'NOTE_ADD') && <form action={addNoteAction} style={{ marginTop: 10 }}>
        <input type="hidden" name="id" value={order.id} />
        {/* Tek kullanımlık anahtar (karar 199): çift tıklama / yeniden gönderim ikinci mesajı yazmaz */}
        <input type="hidden" name="requestKey" value={randomUUID()} />
        <textarea name="text" rows={2} required placeholder={t('order.notes.placeholder')} aria-label={t('order.notes.aria')} />
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
          {userCan(user, 'NOTE_INTERNAL_VIEW') ? <label className="check small"><input type="checkbox" name="internal" /> {t('order.notes.internalCheck')}</label> : <span />}
          <span className="row"><span className="muted small">{t('order.notes.noEdit')}</span><button className="btn btn-primary">{t('order.notes.send')}</button></span>
        </div>
      </form>}
    </div>
  );
}
