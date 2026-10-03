'use client';

import { useMemo, useRef, useState } from 'react';
import type { Dict } from '@/lib/i18n';
import { formatOfferProblems } from '@/server/i18n/format.js';
import { interpolate } from '@/server/i18n/interpolate.js';
import { atOfferPrice, offerLineTotals, offerProblems, offerTotals } from '@/server/orders/rules.js';
import { TableJump } from '@/components/TableJump';
import { saveOfferAction } from './actions';
import { ExcelImport } from './ExcelImport';

/**
 * listPrice: fiyat tablosundaki liste fiyatı ('' → yok). Sunucu kayıtta yeniden hesaplar; burada yalnızca gösterilir.
 * id: kayıtlı satır ('' → yeni) · unitPrice: satış fiyatı · offerPrice: müşteri fiyatı (yalnızca yönetici görür/girer, karar 4)
 */
type Line = { key: number; id: string; description: string; poz: string; enMm: string; boyMm: string; adet: string; unit: string; unitPrice: string; kind: string; free: boolean; listPrice: string; offerPrice: string; /** TELAFİ satırı (kırık / telafi camı — yalnızca rozet; işaret sunucuda satırla taşınır) */ comp?: boolean };

/** Fiyat tablosu (karar 26): cam adı (ekrandaki dilde ve Türkçe) → m² fiyatı; delik ve CNC adet fiyatı */
export type EditorPricing = { name: string; glass: Record<string, number>; holePrice: number | null; cncPrice: number | null };

let seq = 1000;
const blankGlass = (): Line => ({ key: seq++, id: '', description: '', poz: '', enMm: '', boyMm: '', adet: '1', unit: 'm2', unitPrice: '', kind: 'CAM', free: false, listPrice: '', offerPrice: '' });
const money2 = (n: number | null | undefined) => (n != null ? n.toFixed(2) : '');
const blankSub = (kind: 'CNC' | 'DELIK', price: number | null, customerPrice: number | null): Line => {
  const p = money2(price);
  return { key: seq++, id: '', description: '', poz: '', enMm: '', boyMm: '', adet: '1', unit: 'adet', unitPrice: p, kind, free: false, listPrice: p, offerPrice: money2(customerPrice) };
};
const upper = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleUpperCase('tr-TR');
const samePrice = (a: string, b: string) => Math.abs(Number(a.replace(',', '.') || 0) - Number(b.replace(',', '.') || 0)) < 0.005;

const fmt = (n: number) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

export function OfferEditor(props: {
  orderId: string;
  /** Siparişin sayfa açıldığındaki sürümü (iyimser kilit) */
  version: number;
  /** sales: satış taslağı · admin: fiyat onayı · update: yönetici müşterideki teklifi günceller */
  mode: 'sales' | 'admin' | 'update';
  cancelHref?: string;
  currency: string;
  catalog: string[];
  pricing: EditorPricing | null;
  /** Müşteriye özel fiyatlar (yönetici; karar 32): yeni satırın müşteri fiyatı buradan dolar */
  customerPricing?: EditorPricing | null;
  initial: Omit<Line, 'key'>[];
  camEtiket: string;
  sandikEtiket: string;
  statusLabel: string;
  /** Sözlük parçaları (istemciye sözlüğün yalnızca gereken kısmı gider) */
  m: Dict['offer'];
  common: Dict['common'];
  problemsMsg: Dict['offerProblems'];
  lineKind: Dict['status']['lineKind'];
  /** Satış: müşterinin yüklediği Excel dosyaları (.xlsx) ve siparişteki cam (aktarılan tüm satırlara uygulanır) */
  excelFiles?: { id: string; name: string }[];
  importGlass?: string;
  /** Müşterinin siparişindeki camlar (cam adı + adet): "Tabloyu temizle" tabloyu bu ilk hâline döndürür */
  original?: { description: string; adet: string }[];
}) {
  const { m, common, lineKind } = props;
  const [lines, setLines] = useState<Line[]>(() =>
    props.initial.length ? props.initial.map((l, i) => ({ key: i, ...l })) : [blankGlass()]
  );
  // Yönetici (fiyat onayı ve güncelleme) müşteri fiyatıyla çalışır; satış fiyatı yalnızca yanında görünür
  const adminMode = props.mode !== 'sales';
  const totals = useMemo(() => offerTotals(lines), [lines]);
  const offerTot = useMemo(() => offerTotals(atOfferPrice(lines)), [lines]);
  const problems = useMemo(() => {
    const used = lines.filter((l) => l.kind !== 'CAM' || l.description || l.enMm || l.boyMm || l.unitPrice || l.offerPrice);
    return offerProblems(adminMode ? atOfferPrice(used) : used);
  }, [lines, adminMode]);
  const problemTexts = useMemo(
    () => formatOfferProblems(problems, { offerProblems: props.problemsMsg, lineKind }),
    [problems, props.problemsMsg, lineKind]
  );
  /** Satır türünün adı: "CNC" / "Delik" (dile göre) */
  const kindName = (kind: string) => lineKind[kind as keyof typeof lineKind] ?? kind;
  const set = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  /**
   * "Tek fiyatı tüm satırlara uygula" (satış; yalnızca ekrandaki düzenleme kolaylığı): işaretliyken bir m² cam satırına
   * yazılan satış fiyatı bedelsiz olmayan tüm m² cam satırlarına yazılır. CNC, delik ve adetli satırlar (sandık parası)
   * değişmez. Fiyat kuralı, doğrulama ve kayıt aynıdır (sunucu her satırı yine tek tek değerlendirir).
   */
  const [onePrice, setOnePrice] = useState(false);
  const setUnitPrice = (l: Line, raw: string) => {
    const unitPrice = raw.replace(/[^\d.,]/g, '');
    const glass = (x: Line) => x.kind === 'CAM' && x.unit === 'm2';
    if (onePrice && glass(l)) setLines((ls) => ls.map((x) => (x.key === l.key || (glass(x) && !x.free) ? { ...x, unitPrice } : x)));
    else set(l.key, { unitPrice });
  };
  const glassPrices = useMemo(() => new Map(Object.entries(props.pricing?.glass ?? {}).map(([k, v]) => [upper(k), v])), [props.pricing]);
  const customerGlass = useMemo(() => new Map(Object.entries(props.customerPricing?.glass ?? {}).map(([k, v]) => [upper(k), v])), [props.customerPricing]);
  /**
   * Cam adı değişince liste fiyatı da değişir; fiyat boşsa ya da liste fiyatıysa yeni liste fiyatı yazılır.
   * Yöneticide: müşteri fiyatı boşsa müşterinin fiyat tablosundaki fiyat yazılır.
   */
  const describe = (l: Line, description: string): Partial<Line> => {
    const p = glassPrices.get(upper(description));
    const listPrice = p != null ? p.toFixed(2) : '';
    const follow = !l.unitPrice || (l.listPrice !== '' && samePrice(l.unitPrice, l.listPrice));
    const cp = adminMode && !l.offerPrice ? customerGlass.get(upper(description)) : undefined;
    return { description, listPrice, ...(follow && !adminMode ? { unitPrice: listPrice } : {}), ...(cp != null ? { offerPrice: cp.toFixed(2) } : {}) };
  };
  const setDescription = (l: Line, description: string) => {
    if (l.kind !== 'CAM') return set(l.key, { description });
    set(l.key, describe(l, description));
  };
  /**
   * Excel'den aktarılan satırlar: elle eklenen cam satırıyla aynı model ve aynı fiyat kuralı (describe → liste fiyatı).
   * Cam tipi siparişteki cam. Ölçüsü girilmemiş ve altında CNC / delik olmayan boş cam satırları yerini aktarılanlara bırakır.
   */
  const importRows = (rows: { en: number; boy: number; adet: number }[]) => setLines((ls) => {
    const glass = props.importGlass ?? '';
    const added = rows.map((r) => {
      const base = { ...blankGlass(), enMm: String(r.en), boyMm: String(r.boy), adet: String(r.adet) };
      return { ...base, ...describe(base, glass) };
    });
    const keep = ls.filter((l, i) => !(l.kind === 'CAM' && !l.id && !l.enMm && !l.boyMm && ls[i + 1]?.kind !== 'CNC' && ls[i + 1]?.kind !== 'DELIK'));
    return [...keep, ...added];
  });
  /**
   * "+" (cam adının yanında): aynı camdan yeni satır, bu satırın (ve alt satırlarının) hemen altına. Ölçü, adet ve fiyat
   * kopyalanmaz; yeni satır elle eklenen cam satırıyla aynı kuralla oluşur (blankGlass + describe → liste fiyatı).
   */
  const duplicateGlass = (l: Line) => setLines((ls) => {
    let i = ls.findIndex((x) => x.key === l.key) + 1;
    while (i < ls.length && ls[i].kind !== 'CAM') i++;
    const base = blankGlass();
    return [...ls.slice(0, i), { ...base, ...describe(base, l.description) }, ...ls.slice(i)];
  });
  /** "+ Sandık parası": adetle fiyatlanan normal bir teklif satırı (fiyatı satış girer; sistemde sandık fiyat tablosu yok) */
  const addCrate = () => setLines((ls) => [...ls, { ...blankGlass(), description: m.editor.crateLine, unit: 'adet', adet: '1' }]);
  /**
   * "Tabloyu temizle": tablo, müşterinin siparişindeki ilk hâline döner (sipariş camları, adetleri ve liste fiyatları).
   * Yalnızca ekrandaki tablo değişir; kaydedilene kadar hiçbir şey yazılmaz. Sipariş ve dosyalar değişmez.
   */
  const resetTable = () => {
    if (!window.confirm(m.editor.resetConfirm)) return;
    const rows = (props.original ?? []).map((o) => {
      const base = { ...blankGlass(), adet: o.adet };
      return { ...base, ...describe(base, o.description) };
    });
    setLines(rows.length ? rows : [blankGlass()]);
  };
  /** Cam satırının (ve varsa alt satırlarının) hemen altına CNC / delik satırı ekler. */
  const addSub = (key: number, kind: 'CNC' | 'DELIK') => setLines((ls) => {
    let i = ls.findIndex((l) => l.key === key) + 1;
    while (i < ls.length && ls[i].kind !== 'CAM') i++;
    const cust = adminMode ? (kind === 'CNC' ? props.customerPricing?.cncPrice : props.customerPricing?.holePrice) ?? null : null;
    const sub = blankSub(kind, kind === 'CNC' ? props.pricing?.cncPrice ?? null : props.pricing?.holePrice ?? null, cust);
    // Yöneticinin eklediği satırın satış fiyatı yoktur (satış fiyatını satış girer)
    return [...ls.slice(0, i), adminMode ? { ...sub, unitPrice: '', listPrice: '' } : sub, ...ls.slice(i)];
  });
  /** Cam satırı silinince altındaki CNC / delik satırları da silinir. */
  const remove = (key: number) => setLines((ls) => {
    const i = ls.findIndex((l) => l.key === key);
    let j = i + 1;
    if (ls[i].kind === 'CAM') while (j < ls.length && ls[j].kind !== 'CAM') j++;
    const next = [...ls.slice(0, i), ...ls.slice(j)];
    return next.length ? next : [blankGlass()];
  });
  let glassNo = 0;
  const isAdmin = props.mode === 'admin';
  const isUpdate = props.mode === 'update';
  // Hangi düğmeye basıldığı gizli alana yazılır (tarayıcıdan bağımsız, güvenilir yol).
  const intentRef = useRef<HTMLInputElement>(null);
  const intent = (v: string) => () => {
    if (intentRef.current) intentRef.current.value = v;
  };

  return (
    <form action={saveOfferAction} className="card offer-card" id="teklif">
      <input type="hidden" name="id" value={props.orderId} />
      {/* Sayfanın gösterdiği sipariş sürümü: bu arada biri siparişi değiştirdiyse kayıt reddedilir */}
      <input type="hidden" name="v" value={props.version} />
      <input type="hidden" name="intent" defaultValue={isUpdate ? 'update' : 'save'} ref={intentRef} />
      <div className="section-head">
        <h2>{m.editor.title} <span className="badge">{props.statusLabel}</span></h2>
        <span className="muted small">{m.editor.formula}</span>
      </div>

      {props.pricing && !isUpdate && (
        <p className="muted small" style={{ marginTop: 0 }}>{interpolate(m.editor.tableInfo, { name: props.pricing.name })} {!isAdmin && m.editor.overrideNote}</p>
      )}
      {isUpdate && (
        <div className="alert alert-info">
          {m.editor.updateInfo}
        </div>
      )}
      {(isAdmin || isUpdate) && (
        <div className="grid-2" style={{ marginBottom: 14 }}>
          <div><label htmlFor="camEtiket">{m.editor.glassLabel}</label><input id="camEtiket" name="camEtiket" type="text" defaultValue={props.camEtiket} /></div>
          <div><label htmlFor="sandikEtiket">{m.editor.crateLabel}</label><input id="sandikEtiket" name="sandikEtiket" type="text" defaultValue={props.sandikEtiket} /></div>
        </div>
      )}

      <datalist id="catalog">{props.catalog.map((c) => <option key={c} value={c} />)}</datalist>
      <div className="table-wrap offer-wrap" id="offer-table">
        <table className="offer-table">
          <thead>
            <tr><th>#</th><th className="c-desc">{m.cols.description}</th><th>{m.cols.poz}</th><th>{m.cols.widthMm}</th><th>{m.cols.heightMm}</th><th>{m.cols.qty}</th><th>{m.cols.unit}</th><th className="num">{m.cols.metraj}</th><th className={adminMode ? 'num' : undefined}>{adminMode ? m.cols.salesPrice : m.cols.unitPrice}</th>{adminMode && <th>{m.cols.offerPrice}</th>}<th className="num">{adminMode ? m.cols.offerAmount : m.cols.amount}</th><th /></tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const tot = offerLineTotals(adminMode ? { ...l, unitPrice: l.offerPrice } : l);
              const sub = l.kind !== 'CAM';
              if (!sub) glassNo += 1;
              const kind = kindName(l.kind);
              const shownPrice = adminMode ? l.offerPrice : l.unitPrice;
              const missing = !l.free && !(Number(shownPrice.replace(',', '.')) > 0) && (sub || !!(l.description || l.enMm || l.boyMm));
              return (
                <tr key={l.key} className={sub ? 'sub-line' : 'glass-line'}>
                  <td className="c-no muted">{sub ? '' : glassNo}
                    <input type="hidden" name="l_id" value={l.id} />
                    <input type="hidden" name="l_kind" value={l.kind} />
                    <input type="hidden" name="l_free" value={l.free ? '1' : '0'} />
                  </td>
                  <td className="desc">
                    <span className="desc-row">
                      {sub && <span className="badge badge-info">{kind}</span>}
                      <input name="l_desc" list={sub ? undefined : 'catalog'} value={l.description} title={l.description || undefined} placeholder={sub ? interpolate(m.editor.subDescPlaceholder, { kind }) : undefined}
                        onChange={(e) => setDescription(l, e.target.value)} aria-label={sub ? interpolate(m.editor.subDescAria, { kind }) : m.cols.description} />
                      {!sub && l.unit === 'm2' && (
                        <button type="button" className="btn btn-dup" title={m.editor.duplicateGlass} aria-label={m.editor.duplicateGlass} onClick={() => duplicateGlass(l)}>+</button>
                      )}
                    </span>
                    {/* Uzun cam adı dar tabloda kutuya sığmayabilir: tam ad altında okunur (geniş tabloda gizli — CSS) */}
                    {!sub && l.description.length > 28 && <div className="desc-full">{l.description}</div>}
                    {/* Satırın işlemleri: açıklamanın hemen altında (ek işlem satırı ekle, bedelsiz yap) */}
                    <div className="line-actions">
                      {l.free && <span className="badge badge-ok">{m.free}</span>}
                      {l.comp && <span className="badge badge-warn">{m.telafi}</span>}
                      {!sub && <button type="button" className="btn btn-link" onClick={() => addSub(l.key, 'CNC')}>+{lineKind.CNC}</button>}
                      {!sub && <button type="button" className="btn btn-link" onClick={() => addSub(l.key, 'DELIK')}>+{lineKind.DELIK}</button>}
                      <button type="button" className="btn btn-link" onClick={() => set(l.key, { free: !l.free })}>{l.free ? m.editor.makePaid : m.editor.makeFree}</button>
                    </div>
                  </td>
                  <td className="c-poz"><input name="l_poz" value={l.poz} onChange={(e) => set(l.key, { poz: e.target.value })} aria-label={m.cols.poz} /></td>
                  {sub ? (
                    <><td><input type="hidden" name="l_en" value="" /></td><td><input type="hidden" name="l_boy" value="" /></td></>
                  ) : (
                    <>
                      <td className="c-dim"><input name="l_en" inputMode="numeric" value={l.enMm} onChange={(e) => set(l.key, { enMm: e.target.value.replace(/\D/g, '') })} aria-label={m.cols.width} /></td>
                      <td className="c-dim"><input name="l_boy" inputMode="numeric" value={l.boyMm} onChange={(e) => set(l.key, { boyMm: e.target.value.replace(/\D/g, '') })} aria-label={m.cols.height} /></td>
                    </>
                  )}
                  <td className="c-qty"><input name="l_adet" inputMode="numeric" value={l.adet} onChange={(e) => set(l.key, { adet: e.target.value.replace(/\D/g, '') })} aria-label={sub ? interpolate(m.editor.subQtyAria, { kind }) : m.cols.qty} /></td>
                  <td className={sub ? 'c-text' : 'c-unit'}>
                    {sub ? (
                      <><input type="hidden" name="l_unit" value="adet" /><span className="muted">{common.unitPiece}</span></>
                    ) : (
                      <select name="l_unit" value={l.unit} onChange={(e) => set(l.key, { unit: e.target.value })} aria-label={m.cols.unit}>
                        <option value="m2">m²</option>
                        <option value="adet">{common.unitPiece}</option>
                      </select>
                    )}
                  </td>
                  <td className="num">{sub ? '' : fmt(tot.metraj)}</td>
                  <td className={adminMode ? 'num' : 'c-price'}>
                    {adminMode ? (
                      // Yönetici satış fiyatını değiştirmez; sunucu da yönetici kaydında satış fiyatına dokunmaz
                      <><input type="hidden" name="l_price" value={l.free ? '0' : l.unitPrice} /><span className="muted">{l.unitPrice ? fmt(Number(l.unitPrice.replace(',', '.'))) : '—'}</span></>
                    ) : (
                      <>
                        <input name="l_price" inputMode="decimal" value={l.free ? '' : l.unitPrice} disabled={l.free} className={missing ? 'input-missing' : undefined}
                          onChange={(e) => setUnitPrice(l, e.target.value)}
                          aria-label={sub ? interpolate(m.editor.subPriceAria, { kind }) : m.cols.unitPrice} />
                        {l.free && <input type="hidden" name="l_price" value="0" />}
                      </>
                    )}
                    {l.listPrice !== '' && (
                      l.free || !samePrice(l.unitPrice, l.listPrice)
                        ? <div className="small list-changed">{interpolate(isAdmin ? m.editor.listChangedAdmin : m.editor.listChanged, { p: fmt(Number(l.listPrice)) })}</div>
                        : <div className="small muted">{interpolate(m.editor.listPrice, { p: fmt(Number(l.listPrice)) })}</div>
                    )}
                  </td>
                  {adminMode && (
                    <td className="c-price">
                      <input name="l_oprice" inputMode="decimal" value={l.free ? '' : l.offerPrice} disabled={l.free} className={missing ? 'input-missing' : undefined}
                        onChange={(e) => set(l.key, { offerPrice: e.target.value.replace(/[^\d.,]/g, '') })}
                        aria-label={sub ? interpolate(m.editor.subOfferPriceAria, { kind }) : m.cols.offerPrice} />
                      {l.free && <input type="hidden" name="l_oprice" value="0" />}
                    </td>
                  )}
                  <td className="num c-amount">{fmt(tot.amount)}</td>
                  <td className="c-del">
                    <button type="button" className="btn btn-link btn-del" aria-label={m.editor.deleteRow} title={m.editor.deleteRow} onClick={() => remove(l.key)}>✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>{common.total}</td>
              <td colSpan={5} className="num">
                {interpolate(m.editor.countGlass, { n: totals.adet })}
                {totals.cnc ? ` · ${interpolate(m.editor.countCnc, { n: totals.cnc })}` : ''}
                {totals.delik ? ` · ${interpolate(m.editor.countHoles, { n: totals.delik })}` : ''}
              </td>
              <td className="num">{fmt(totals.metraj)} m²</td>
              {adminMode ? <td className="num muted">{fmt(totals.amount)}</td> : <td />}
              {adminMode && <td />}
              <td className="num grand">{fmt(adminMode ? offerTot.amount : totals.amount)} {props.currency}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      {adminMode && (
        <p className="offer-summary">
          {interpolate(m.editor.twoTotals, { sales: fmt(totals.amount), offer: fmt(offerTot.amount), diff: fmt(offerTot.amount - totals.amount), cur: props.currency })}
        </p>
      )}
      {/* Araç çubuğu: satır ekleme · Excel'den aktar · tek fiyat (satış) | tabloyu temizle (satış) */}
      <div className="offer-tools">
        <div className="group">
          <button type="button" className="btn" onClick={() => setLines([...lines, blankGlass()])}>+ {m.editor.addGlass}</button>
          <button type="button" className="btn" onClick={addCrate}>+ {m.editor.addCrate}</button>
          {props.mode === 'sales' && (props.excelFiles?.length ?? 0) > 0 && (
            <>
              <span className="sep" aria-hidden="true" />
              <ExcelImport orderId={props.orderId} files={props.excelFiles!} glass={props.importGlass ?? ''} onImport={importRows} m={m.import} />
            </>
          )}
          {props.mode === 'sales' && (
            <>
              <span className="sep" aria-hidden="true" />
              <label className="check" title={m.editor.onePriceHint}>
                <input type="checkbox" checked={onePrice} onChange={(e) => setOnePrice(e.target.checked)} /> {m.editor.onePrice}
              </label>
            </>
          )}
        </div>
        {props.mode === 'sales' && <button type="button" className="btn btn-danger" onClick={resetTable}>{m.editor.reset}</button>}
      </div>
      <TableJump targetId="offer-table" up={m.import.jumpTop} down={m.import.jumpBottom} />
      <p className="muted small" style={{ margin: '8px 0 0' }}>{common.pricesExclVat}{adminMode && props.customerPricing ? ` · ${interpolate(m.editor.customerTableInfo, { name: props.customerPricing.name })}` : ''}</p>

      {problems.length > 0 && (
        <div className="alert alert-warn" style={{ marginTop: 12 }}>
          <b>{m.editor.cannotSend}</b>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{problemTexts.map((p) => <li key={p}>{p}</li>)}</ul>
          <span className="small">{m.editor.canSaveDraft}</span>
        </div>
      )}

      {isAdmin && (
        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="returnNote">{m.editor.returnNote}</label>
          <input id="returnNote" name="returnNote" type="text" placeholder={m.editor.returnNotePlaceholder} />
        </div>
      )}
      {isUpdate && (
        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="updateNote">{m.editor.updateNote}</label>
          <input id="updateNote" name="updateNote" type="text" placeholder={m.editor.updateNotePlaceholder} />
        </div>
      )}
      <div className="row end" style={{ marginTop: 14 }}>
        {isUpdate ? (
          <>
            <a href={props.cancelHref ?? '#'} className="btn">{common.cancel}</a>
            <button type="submit" onClick={intent('update')} className="btn btn-primary" disabled={problems.length > 0}>{m.editor.updateAndSend}</button>
          </>
        ) : (
          <button type="submit" onClick={intent('save')} className="btn">{m.editor.saveDraft}</button>
        )}
        {isUpdate ? null : isAdmin ? (
          <>
            <button type="submit" onClick={intent('return')} className="btn btn-danger">{m.editor.returnToSales}</button>
            <button type="submit" onClick={intent('approve')} className="btn btn-success" disabled={problems.length > 0}>{m.editor.approveAndSend}</button>
          </>
        ) : (
          <button type="submit" onClick={intent('submit')} className="btn btn-primary" disabled={problems.length > 0}>{m.editor.submit}</button>
        )}
      </div>
      <p className="muted small" style={{ marginTop: 8 }}>
        {isUpdate
          ? m.editor.footUpdate
          : isAdmin
            ? m.editor.footAdmin
            : m.editor.footSales}
      </p>
    </form>
  );
}
