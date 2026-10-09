import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT, type MsgKey } from '@/lib/i18n';
import { fmtDec } from '@/lib/format';
import { calcErrorText } from '@/lib/profile-calc';
import { Badge } from '@/components/StatusBadge';
import { ConfirmButton } from '@/components/ConfirmButton';
import { localName, unitLabel } from '@/server/profile/catalog.js';
import { loadCalcAdmin } from '@/server/profile/calc-service.js';
import { slotsOf } from '@/server/profile/calculator.js';
import { addItemAction, addThicknessAction, removeItemAction, saveSystemAction, toggleThicknessAction, updateItemAction } from './actions';

export const dynamic = 'force-dynamic';

const MSG: Record<string, [string, MsgKey]> = {
  saved: ['ok', 'profile.calcAdmin.msg.saved'],
  added: ['ok', 'profile.calcAdmin.msg.added'],
  removed: ['ok', 'profile.calcAdmin.msg.removed'],
  exists: ['error', 'profile.calcAdmin.msg.exists'],
  not_found: ['error', 'profile.calcAdmin.msg.notFound'],
  forbidden: ['error', 'profile.calcAdmin.msg.forbidden'],
  code: ['error', 'profile.calcAdmin.msg.code'],
  name: ['error', 'profile.calcAdmin.msg.name'],
  mm: ['error', 'profile.calcAdmin.msg.mm'],
  slot: ['error', 'profile.calcAdmin.msg.slot'],
  color: ['error', 'profile.calcAdmin.msg.color'],
  per_meter: ['error', 'profile.calcAdmin.msg.perMeter'],
  product: ['error', 'profile.calcAdmin.msg.product'],
  thickness: ['error', 'profile.calcAdmin.msg.thickness'],
  kind: ['error', 'profile.calcAdmin.msg.kind'],
  label: ['error', 'profile.calcAdmin.msg.label'],
  overlap: ['error', 'profile.calcAdmin.msg.overlap'],
  no_product: ['error', 'profile.calcAdmin.msg.noProduct'],
};

// Profil hesaplayıcısı ayarları (Paket 5, karar 175–176): cam kalınlıkları, sistemler ve her sistemin kalemleri (satırları)
// + "Eksikler" (sistemin her geçerli seçiminde hesap yapılamayan noktalar — müşteri aynı açıklamayı görür). Değerler
// yöneticinindir; tahmin yoktur. Paket içerikleri Profil Kataloğu'nda ürünün kendisinde.
export default async function ProfileCalcPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePermission('CATALOG_MANAGE');
  const { t, locale } = await getT();
  const sp = await searchParams;
  const [{ systems, thicknesses, defaults }, products] = await Promise.all([
    loadCalcAdmin(db),
    db.profileProduct.findMany({ orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { code: 'asc' }], select: { id: true, code: true, nameTr: true, nameRo: true, isActive: true } }),
  ]);
  const current = sp.sistem ? systems.find((s) => s.id === sp.sistem) ?? null : null;
  const code = sp.ok ?? sp.error ?? '';
  const msg = Object.hasOwn(MSG, code) ? MSG[code] : undefined;
  const mm = (v: { toString(): string }) => t('profile.calc.mm', { mm: fmtDec(v.toString(), 2) });
  const colorText = (c: string | null) => (c === 'RAL7016' || c === 'ELOXAT' ? t(`profile.calc.colors.${c}` as MsgKey) : t('profile.calcAdmin.items.all'));
  const measureText = (x: string | null) => (x === 'BUC' ? t('profile.calc.measure.BUC') : t('profile.calc.measure.M'));
  const keep = current ? <input type="hidden" name="sistem" value={current.id} /> : null;

  return (
    <>
      <div className="page-head">
        <p className="small"><Link href="/admin/profil-katalogu">{t('profile.calcAdmin.back')}</Link></p>
        <h1>{t('profile.calcAdmin.title')}</h1>
        <p className="muted">{t('profile.calcAdmin.intro')}</p>
        <p className="muted small">{t('profile.calcAdmin.rule')}</p>
      </div>
      {msg && <div className={`alert ${msg[0] === 'ok' ? 'alert-ok' : 'alert-error'}`} role={msg[0] === 'ok' ? 'status' : 'alert'}>{t(msg[1])}</div>}
      {/* Korkuluk hesaplayıcısının varsayılanları (karar 203): yazıldı mı; yazılamadıysa eksik / uyumsuz ürün kodları */}
      {defaults.applied ? (
        <div className="alert alert-info" data-calc-defaults="applied">{t('profile.calcAdmin.defaults.applied')}</div>
      ) : (defaults.missing.length > 0 || defaults.wrongUnit.length > 0) ? (
        <div className="alert alert-error" role="alert" data-calc-defaults="blocked">
          <b>{t('profile.calcAdmin.defaults.blocked')}</b>
          {defaults.missing.length > 0 && <div className="mono small" data-missing-codes>{t('profile.calcAdmin.defaults.missing', { codes: defaults.missing.join(', ') })}</div>}
          {defaults.wrongUnit.length > 0 && <div className="mono small">{t('profile.calcAdmin.defaults.wrongUnit', { codes: defaults.wrongUnit.map((w) => `${w.code} (${w.unit} ≠ ${w.expected})`).join(', ') })}</div>}
        </div>
      ) : null}

      <div className="grid-2">
        <div className="card" id="kalinlik">
          <h2>{t('profile.calcAdmin.thickness.title')}</h2>
          <p className="muted small">{t('profile.calcAdmin.thickness.intro')}</p>
          {thicknesses.length === 0 ? <div className="empty">{t('profile.calcAdmin.thickness.empty')}</div> : (
            <div className="table-wrap">
              <table>
                <tbody>
                  {thicknesses.map((x) => (
                    <tr key={x.id} data-thickness={x.mm.toString()} style={x.isActive ? undefined : { opacity: 0.55 }}>
                      <td><b>{x.label ?? mm(x.mm)}</b>{x.label && <span className="muted small"> · {mm(x.mm)}</span>}</td>
                      <td>{x.isActive ? <Badge tone="ok">{t('profile.calcAdmin.thickness.active')}</Badge> : <Badge tone="muted">{t('profile.calcAdmin.thickness.inactive')}</Badge>}</td>
                      <td className="actions">
                        <form action={toggleThicknessAction}>
                          {keep}
                          <input type="hidden" name="id" value={x.id} />
                          <input type="hidden" name="active" value={x.isActive ? '0' : '1'} />
                          <button className="btn btn-link">{x.isActive ? t('profile.calcAdmin.thickness.deactivate') : t('profile.calcAdmin.thickness.activate')}</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <form action={addThicknessAction} className="acc-form" style={{ marginTop: 10 }}>
            {keep}
            <label htmlFor="th-mm">{t('profile.calcAdmin.thickness.mm')}</label>
            <input id="th-mm" name="mm" inputMode="decimal" required maxLength={8} className="c-amount" placeholder="12,76" />
            <label htmlFor="th-label">{t('profile.calcAdmin.thickness.label')}</label>
            <input id="th-label" name="label" maxLength={20} className="c-amount" placeholder="6+6" title={t('profile.calcAdmin.thickness.labelHint')} />
            <button className="btn">{t('profile.calcAdmin.thickness.add')}</button>
          </form>
        </div>

        <form action={saveSystemAction} className="card" id="yeni-sistem">
          <h2>{t('profile.calcAdmin.system.add')}</h2>
          <div className="grid-2">
            <div>
              <label htmlFor="sy-code">{t('profile.calcAdmin.system.code')}</label>
              <input id="sy-code" name="code" required maxLength={40} placeholder="MR23" />
              <div className="hint">{t('profile.calcAdmin.system.codeHint')}</div>
            </div>
            <div>
              <label htmlFor="sy-ro">{t('profile.calcAdmin.system.nameRo')}</label>
              <input id="sy-ro" name="nameRo" required maxLength={80} />
            </div>
            <div>
              <label htmlFor="sy-tr">{t('profile.calcAdmin.system.nameTr')}</label>
              <input id="sy-tr" name="nameTr" maxLength={80} />
              <div className="hint">{t('profile.calcAdmin.system.nameTrHint')}</div>
            </div>
            <div>
              <label htmlFor="sy-kind">{t('profile.calcAdmin.system.kind')}</label>
              <select id="sy-kind" name="kind" defaultValue="">
                <option value="">{t('profile.calcAdmin.system.kindNone')}</option>
                <option value="PROFILE">{t('profile.calcAdmin.system.kinds.PROFILE')}</option>
                <option value="HANDRAIL">{t('profile.calcAdmin.system.kinds.HANDRAIL')}</option>
              </select>
            </div>
          </div>
          <label className="row" style={{ marginTop: 10 }}>
            <input type="checkbox" name="isActive" defaultChecked /> {t('profile.calcAdmin.system.active')}
          </label>
          <div className="row" style={{ marginTop: 12 }}><button className="btn btn-primary">{t('profile.calcAdmin.system.add')}</button></div>
        </form>
      </div>

      <div className="card card-flush" id="sistemler">
        <div className="card-head"><h2>{t('profile.calcAdmin.system.title')} <span className="badge">{systems.length}</span></h2></div>
        {systems.length === 0 ? <div className="empty">{t('profile.calcAdmin.system.empty')}</div> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('profile.calcAdmin.system.colCode')}</th><th>{t('profile.calcAdmin.system.colName')}</th><th>{t('profile.calcAdmin.system.colKind')}</th>
                  <th className="num">{t('profile.calcAdmin.system.colRows')}</th><th>{t('profile.calcAdmin.system.colState')}</th><th />
                </tr>
              </thead>
              <tbody>
                {systems.map((s) => (
                  <tr key={s.id} data-system={s.code} className={current?.id === s.id ? 'picked' : undefined} style={s.isActive ? undefined : { opacity: 0.55 }}>
                    <td className="mono"><b>{s.code}</b></td>
                    <td>{localName(s, locale)}</td>
                    <td data-kind={s.kind ?? ''}>{s.kind === 'PROFILE' || s.kind === 'HANDRAIL' ? t(`profile.calcAdmin.system.kindShort.${s.kind}` as MsgKey) : <span className="muted small" title={t('profile.calcAdmin.system.noKind')}>—</span>}</td>
                    <td className="num">{s.items.length}</td>
                    <td>
                      {!s.isActive && <><Badge tone="muted">{t('profile.calcAdmin.system.inactive')}</Badge> </>}
                      {s.problems.length === 0 ? <Badge tone="ok">{t('profile.calcAdmin.system.ready')}</Badge> : <Badge tone="warn">{t('profile.calcAdmin.system.problems', { n: s.problems.length })}</Badge>}
                    </td>
                    <td className="actions"><Link className="btn btn-link" href={`/admin/profil-katalogu/hesaplama?sistem=${s.id}#sistem`}>{t('profile.calcAdmin.system.open')}</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {current && (
        <>
          <form action={saveSystemAction} className="card" id="sistem" key={`s-${current.id}`}>
            <h2>{t('profile.calcAdmin.system.edit')} — <span className="mono">{current.code}</span></h2>
            <input type="hidden" name="id" value={current.id} />
            <div className="grid-2">
              <div>
                <label htmlFor="se-ro">{t('profile.calcAdmin.system.nameRo')}</label>
                <input id="se-ro" name="nameRo" required maxLength={80} defaultValue={current.nameRo} />
              </div>
              <div>
                <label htmlFor="se-tr">{t('profile.calcAdmin.system.nameTr')}</label>
                <input id="se-tr" name="nameTr" maxLength={80} defaultValue={current.nameTr} />
              </div>
              <div>
                <label htmlFor="se-kind">{t('profile.calcAdmin.system.kind')}</label>
                <select id="se-kind" name="kind" defaultValue={current.kind ?? ''}>
                  <option value="">{t('profile.calcAdmin.system.kindNone')}</option>
                  <option value="PROFILE">{t('profile.calcAdmin.system.kinds.PROFILE')}</option>
                  <option value="HANDRAIL">{t('profile.calcAdmin.system.kinds.HANDRAIL')}</option>
                </select>
              </div>
            </div>
            <label className="row" style={{ marginTop: 10 }}>
              <input type="checkbox" name="isActive" defaultChecked={current.isActive} /> {t('profile.calcAdmin.system.active')}
            </label>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn btn-primary">{t('profile.calcAdmin.system.save')}</button>
              <Link className="btn btn-link" href="/admin/profil-katalogu/hesaplama">{t('profile.calcAdmin.system.cancel')}</Link>
            </div>
          </form>

          <div className="card card-flush" id="kalemler">
            <div className="card-head"><h2>{t('profile.calcAdmin.items.title', { code: current.code })}</h2></div>
            <p className="card-sub">{t('profile.calcAdmin.items.intro')}</p>
            {current.items.length === 0 ? <div className="empty">{t('profile.calcAdmin.items.empty')}</div> : (
              <div className="table-wrap">
                <table className="calc-items">
                  <thead>
                    <tr>
                      <th>{t('profile.calcAdmin.items.product')}</th><th>{t('profile.calcAdmin.items.color')}</th><th>{t('profile.calcAdmin.items.thickness')}</th>
                      <th className="num">{t('profile.calcAdmin.items.perMeter')}</th><th>{t('profile.calcAdmin.items.pack')}</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {slotsOf(current.items).flatMap((slot) => [
                      <tr key={`g-${slot.key}`} className="group-row"><td colSpan={6}><b>{slot.label}</b></td></tr>,
                      // Kalemin satırları, sayfanın tam kayıtlarıyla (ürün, kalınlık) ve aynı sırayla
                      ...current.items.filter((x) => slot.items.some((r) => r.id === x.id)).map((it) => {
                        const p = it.product;
                        return (
                          <tr key={it.id} data-calc-item={`${slot.label}|${p?.code ?? '-'}`}>
                            <td>{p ? <><b className="mono">{p.code}</b> <span className="muted small">{localName(p, locale)}</span>{!p.isActive && <> <Badge tone="muted">{t('profile.calcAdmin.thickness.inactive')}</Badge></>}</> : <span className="muted">{t('profile.calcAdmin.items.notNeeded')}</span>}</td>
                            <td>{colorText(it.color)}</td>
                            <td>{it.thickness ? (it.thickness.label ? `${it.thickness.label} (${mm(it.thickness.mm)})` : mm(it.thickness.mm)) : t('profile.calcAdmin.items.all')}</td>
                            <td className="num">
                              {p ? (
                                <form action={updateItemAction} className="threshold-form">
                                  <input type="hidden" name="systemId" value={current.id} />
                                  <input type="hidden" name="id" value={it.id} />
                                  <input name="perMeter" inputMode="decimal" maxLength={12} className="qty-input" defaultValue={it.perMeter == null ? '' : fmtDec(it.perMeter.toString(), 4)}
                                    aria-label={t('profile.calcAdmin.items.perMeterLabel', { slot: slot.label, product: p.code })} />
                                  <span className="muted small">{measureText(p.packMeasure)}</span>
                                  <button className="btn">{t('profile.calcAdmin.items.save')}</button>
                                </form>
                              ) : '—'}
                            </td>
                            <td className="nowrap">
                              {p ? (p.packContent != null && p.packMeasure
                                ? t('profile.catalog.packValue', { n: fmtDec(p.packContent.toString(), 3), measure: measureText(p.packMeasure), unit: unitLabel(p.unitCode, locale) })
                                : <Badge tone="warn">{t('profile.calcAdmin.items.noPack')}</Badge>) : '—'}
                            </td>
                            <td className="actions">
                              <form action={removeItemAction}>
                                <input type="hidden" name="systemId" value={current.id} />
                                <input type="hidden" name="id" value={it.id} />
                                <ConfirmButton danger message={t('profile.calcAdmin.items.removeConfirm')}>{t('profile.calcAdmin.items.remove')}</ConfirmButton>
                              </form>
                            </td>
                          </tr>
                        );
                      }),
                    ])}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <form action={addItemAction} className="card" id="satir-ekle">
            <h2>{t('profile.calcAdmin.items.add')}</h2>
            <input type="hidden" name="systemId" value={current.id} />
            <div className="grid-3">
              <div>
                <label htmlFor="it-slot">{t('profile.calcAdmin.items.slot')}</label>
                <input id="it-slot" name="slot" required maxLength={60} list="it-slots" />
                <datalist id="it-slots">{slotsOf(current.items).map((s) => <option key={s.key} value={s.label} />)}</datalist>
                <div className="hint">{t('profile.calcAdmin.items.slotHint')}</div>
              </div>
              <div>
                <label htmlFor="it-product">{t('profile.calcAdmin.items.product')}</label>
                <select id="it-product" name="productId" defaultValue="">
                  <option value="">{t('profile.calcAdmin.items.none')}</option>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.code} — {localName(p, locale)}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="it-per">{t('profile.calcAdmin.items.perMeter')}</label>
                <input id="it-per" name="perMeter" inputMode="decimal" maxLength={12} />
                <div className="hint">{t('profile.calcAdmin.items.perMeterHint')}</div>
              </div>
              <div>
                <label htmlFor="it-color">{t('profile.calcAdmin.items.color')}</label>
                <select id="it-color" name="color" defaultValue="">
                  <option value="">{t('profile.calcAdmin.items.all')}</option>
                  <option value="RAL7016">{t('profile.calc.colors.RAL7016')}</option>
                  <option value="ELOXAT">{t('profile.calc.colors.ELOXAT')}</option>
                </select>
              </div>
              <div>
                <label htmlFor="it-thickness">{t('profile.calcAdmin.items.thickness')}</label>
                <select id="it-thickness" name="thicknessId" defaultValue="">
                  <option value="">{t('profile.calcAdmin.items.all')}</option>
                  {thicknesses.filter((x) => x.isActive).map((x) => <option key={x.id} value={x.id}>{x.label ? `${x.label} (${mm(x.mm)})` : mm(x.mm)}</option>)}
                </select>
              </div>
            </div>
            <div className="row" style={{ marginTop: 12 }}><button className="btn btn-primary">{t('profile.calcAdmin.items.add')}</button></div>
          </form>

          <div className="card" id="eksikler">
            <h2>{t('profile.calcAdmin.problems.title')} {current.problems.length > 0 && <Badge tone="warn">{current.problems.length}</Badge>}</h2>
            {current.problems.length === 0 ? <div className="alert alert-ok" data-calc-ready>{t('profile.calcAdmin.problems.none')}</div> : (
              <>
                <p className="muted small">{t('profile.calcAdmin.problems.intro')}</p>
                <ul className="plain-list" data-calc-problems>
                  {current.problems.map((e, i) => <li key={i} data-problem={e.code}>{calcErrorText(t, e, { system: current.code })}</li>)}
                </ul>
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}
