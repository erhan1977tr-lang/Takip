import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT } from '@/lib/i18n';
import { suggestNextNo } from '@/lib/orders';
import { fmtDate } from '@/lib/format';
import { glassLoadingDate } from '@/server/orders/rules.js';
import { getEnv } from '@/lib/env';
import { glassLabel } from '@/server/catalog/glass.js';
import { readDraftItems } from '@/server/orders/drafts.js';
import { NewOrderForm, type DraftData, type GlassOption } from './NewOrderForm';
import { deleteDraftAction } from './actions';
import { ProfileOrderForm, type ProfileDraft } from './ProfileOrderForm';
import { localName, unitLabel } from '@/server/profile/catalog.js';
import { readProfileDraftItems } from '@/server/profile/drafts.js';

// Yeni sipariş: önce sipariş tipi seçilir (tipler veritabanından; yalnızca etkin olanlar).
// Tek tip etkinken seçim ekranı atlanır. Profil siparişi (Aşama 6) kendi formunu kullanır.
// ?taslak=<id>: kaydedilmiş taslaktan devam.
export default async function NewOrderPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePermission('ORDER_CREATE');
  const { t, m, locale } = await getT();
  const sp = await searchParams;
  const firm = user.customer;
  if (!firm || firm.type !== 'CUSTOMER' || !firm.prefix) {
    return <div className="alert alert-warn">{t('newOrder.errors.noFirm')}</div>;
  }

  const draftRow = sp.taslak
    ? await db.orderDraft.findFirst({ where: { id: sp.taslak, customerId: firm.id }, include: { files: { orderBy: { createdAt: 'asc' } } } })
    : null;
  if (sp.taslak && !draftRow) {
    return (
      <>
        <div className="page-head"><p className="small"><Link href="/siparisler">{t('newOrder.back')}</Link></p></div>
        <div className="alert alert-warn">{t('newOrder.errors.draftGone')}</div>
      </>
    );
  }

  const types = await db.orderType.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } });
  const chosen = draftRow
    ? types.find((x) => x.code === draftRow.orderTypeCode)
    : types.find((x) => x.code === sp.tip) ?? (types.length === 1 ? types[0] : undefined);

  if (!chosen) {
    return (
      <>
        <div className="page-head">
          <p className="small"><Link href="/siparisler">{t('newOrder.back')}</Link></p>
          <h1>{t('newOrder.selector.title')}</h1>
          <p className="muted">{t('newOrder.selector.intro')}</p>
        </div>
        <div className="type-cards">
          {types.map((x) => (
            <Link key={x.code} href={`/siparisler/yeni?tip=${x.code}`} className="card type-card">
              <h2>{locale === 'tr' ? x.nameTr : x.nameRo}</h2>
              <p className="muted">{m.newOrder.selector.desc[x.code as keyof typeof m.newOrder.selector.desc] ?? ''}</p>
              <span className="btn btn-primary">{t('newOrder.selector.choose')}</span>
            </Link>
          ))}
        </div>
      </>
    );
  }

  // Seçilen sipariş tipi (birden çok tip etkinken): rozet + tipi değiştirme bağlantısı. Taslakta tip değişmez.
  const typeRow = types.length > 1 && (
    <div className="row type-row">
      <span className="badge badge-info">{locale === 'tr' ? chosen.nameTr : chosen.nameRo}</span>
      {!draftRow && <Link className="small" href="/siparisler/yeni">{t('newOrder.changeType')}</Link>}
    </div>
  );

  if (chosen.code === 'PROFILE_ORDER') {
    // Profil siparişi (Aşama 6): etkin kategori ve ürünler, kullanıcının dilinde; taslaktaki adetler
    const [cats, items, nextNo] = await Promise.all([
      db.profileCategory.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
      db.profileProduct.findMany({ where: { isActive: true, category: { isActive: true } }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], include: { category: { select: { code: true } } } }),
      suggestNextNo(db, firm.id, 'PROFILE_ORDER'),
    ]);
    const pdraft: ProfileDraft | undefined = draftRow ? {
      id: draftRow.id, title: draftRow.title ?? '', note: draftRow.note ?? '',
      no: draftRow.customerOrderNo != null ? String(draftRow.customerOrderNo) : null,
      qty: Object.fromEntries(readProfileDraftItems(draftRow.items).map((l) => [l.productId, String(l.qty)])),
    } : undefined;
    return (
      <>
        <div className="page-head">
          <p className="small"><Link href="/siparisler">{t('newOrder.back')}</Link></p>
          <h1>{pdraft ? t('newOrder.draftTitle') : t('profile.form.title')}</h1>
          <p className="muted">{t('profile.form.intro')}</p>
          {typeRow}
          {draftRow && <p className="muted small">{t('newOrder.draftSavedAt', { date: fmtDate(draftRow.updatedAt) })}</p>}
        </div>
        {sp.ok === 'draft' && <div className="alert alert-ok">{t('newOrder.draftSaved')}</div>}
        <ProfileOrderForm
          key={draftRow ? `${draftRow.id}-${draftRow.updatedAt.getTime()}` : 'new'}
          categories={cats.map((c) => ({ code: c.code, name: localName(c, locale) }))}
          products={items.map((p) => ({ id: p.id, code: p.code, name: localName(p, locale), unit: unitLabel(p.unitCode, locale), imageId: p.imageId, categoryCode: p.category.code }))}
          suggestedNo={nextNo} prefix={firm.prefix} draft={pdraft} m={m.profile.form}
          notes={[t('profile.notes.pickup'), t('profile.notes.eur')]}
        />
        {draftRow && (
          <form action={deleteDraftAction} className="row end">
            <input type="hidden" name="draftId" value={draftRow.id} />
            <button type="submit" className="btn btn-link danger">{t('newOrder.deleteDraft')}</button>
          </form>
        )}
      </>
    );
  }

  const [products, suggestedNo] = await Promise.all([
    // Pasif cam hiçbir listede görünmez
    db.glassProduct.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { nameTr: 'asc' }, { colorTr: 'asc' }] }),
    suggestNextNo(db, firm.id),
  ]);
  const catalog: GlassOption[] = products.map((p) => ({
    id: p.id, group: locale === 'tr' ? p.nameTr : p.nameRo, label: glassLabel(p, locale),
  }));

  let draft: DraftData | undefined;
  let droppedGlass = 0;
  if (draftRow) {
    const active = new Set(products.map((p) => p.id));
    const lines = readDraftItems(draftRow.items);
    const usable = lines.filter((l) => active.has(l.glassProductId));
    droppedGlass = lines.length - usable.length;
    draft = {
      id: draftRow.id, title: draftRow.title ?? '', note: draftRow.note ?? '',
      no: draftRow.customerOrderNo != null ? String(draftRow.customerOrderNo) : null,
      lines: usable.map((l) => ({ id: l.glassProductId, qty: String(l.qty) })),
      files: draftRow.files.map((f) => ({ id: f.id, name: f.name, size: f.size, pending: f.scanStatus === 'PENDING' })),
    };
  }

  return (
    <>
      <div className="page-head">
        <p className="small"><Link href="/siparisler">{t('newOrder.back')}</Link></p>
        <h1>{draft ? t('newOrder.draftTitle') : t('newOrder.title')}</h1>
        <p className="muted">{t('newOrder.intro')}</p>
        {typeRow}
        {draftRow && <p className="muted small">{t('newOrder.draftSavedAt', { date: fmtDate(draftRow.updatedAt) })}</p>}
      </div>
      {sp.ok === 'draft' && <div className="alert alert-ok">{t('newOrder.draftSaved')}</div>}
      {droppedGlass > 0 && <div className="alert alert-warn">{t('newOrder.draftGlassGone', { n: droppedGlass })}</div>}
      <NewOrderForm
        key={draftRow ? `${draftRow.id}-${draftRow.updatedAt.getTime()}` : 'new'}
        catalog={catalog} suggestedNo={suggestedNo} prefix={firm.prefix} shipDate={fmtDate(glassLoadingDate(new Date(), getEnv().APP_TIMEZONE))} draft={draft} m={m.newOrder.form}
      />
      {draftRow && (
        <form action={deleteDraftAction} className="row end">
          <input type="hidden" name="draftId" value={draftRow.id} />
          <button type="submit" className="btn btn-link danger">{t('newOrder.deleteDraft')}</button>
        </form>
      )}
    </>
  );
}
