'use client';

import { useActionState, useMemo, useState } from 'react';
import type { Dict } from '@/lib/i18n';
import { interpolate } from '@/server/i18n/interpolate.js';
import { saveDayCratesAction, type CratesState } from './actions';

export type CrateInit = {
  crateNo: string; lengthMm: string; widthMm: string; heightMm: string; netKg: string; grossKg: string; note: string; orderIds: string[];
  /** Sandıkta giden başka firma siparişleri (misafir yük — yalnızca gösterim; ad role göre maskeli). Böyle bir sandık silinemez / numarası değişmez. */
  guests?: string[];
};
/** origNo: kayıtlı sandığın sunucudaki numarası (yeni satırda yok) — misafir yük bilgisi her çizimde güncel props'tan bu numarayla okunur */
type Row = CrateInit & { key: number; origNo?: string };

let seq = 1;
const kgNum = (s: string) => {
  const n = Number(s.replace(',', '.'));
  return s.trim() && Number.isFinite(n) ? n : null;
};
const fmt0 = (n: number) => new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 }).format(n);

/**
 * Bir müşterinin bir günlük sandıkları (yükleme sekmesi): no, uzunluk / genişlik / yükseklik, net / brüt, not,
 * sandıktaki siparişler. Hepsi birlikte kaydedilir; sunucu yeniden doğrular (server/loading/crates.js).
 * Misafir sipariş (başka firmanın sandığıyla giden) listede yoktur; firmanın misafir olmayan siparişi yoksa (locked)
 * "+ Sandık ekle" kapalıdır — sunucu da reddeder (GUEST_ORDER / GUEST_ONLY).
 */
export function CrateEditor(props: {
  day: string;
  customerId: string;
  /** Bu firmanın sandığa konabilecek (misafir OLMAYAN) siparişleri */
  orders: { id: string; orderNo: string }[];
  initial: CrateInit[];
  /** Firmanın bu günkü siparişlerinin tamamı başka firmanın sandıklarıyla gidiyor: yeni sandık açılmaz */
  locked?: boolean;
  /** O gün başka müşterilerde kullanılan sandık numaraları (etiket rol için maskeli) */
  dayUsed: { no: number; label: string }[];
  /** Tahmini cam ağırlığı (net boş sandıklara eşit bölünür) */
  glassKg: number;
  tare: number;
  updated: string | null;
  m: Dict['loading']['day']['crates'];
}) {
  const { m } = props;
  const [state, action, pending] = useActionState<CratesState, FormData>(saveDayCratesAction, {});
  const [rows, setRows] = useState<Row[]>(() => props.initial.map((c) => ({ ...c, key: seq++, origNo: c.crateNo })));
  // Misafir yük satırları durumda tutulmaz: sandık seçimi (sunucu işlemi) sonrası gelen güncel veriden okunur
  const guestsByNo = new Map(props.initial.map((c) => [c.crateNo, c.guests ?? []]));
  const guestsOf = (r: Row) => (r.origNo != null ? guestsByNo.get(r.origNo) ?? [] : []);
  // Başarılı kayıttan sonra bütün satırlar sunucudaki numaralarıyla kayıtlıdır (yeni satırlar dahil)
  const [syncedAt, setSyncedAt] = useState(state.savedAt);
  if (state.savedAt !== syncedAt) {
    setSyncedAt(state.savedAt);
    setRows((rs) => rs.map((r) => ({ ...r, origNo: r.crateNo })));
  }
  const set = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const nextNo = () => {
    const used = [...props.dayUsed.map((u) => u.no), ...rows.map((r) => Number(r.crateNo) || 0)];
    return String((used.length ? Math.max(...used) : 0) + 1);
  };
  const add = () => {
    if (props.locked) return;
    setRows((rs) => [...rs, {
      key: seq++, crateNo: nextNo(), lengthMm: '', widthMm: '', heightMm: '', netKg: '', grossKg: '', note: '',
      orderIds: props.orders.length === 1 ? [props.orders[0].id] : [],
    }]);
  };
  const totals = useMemo(() => {
    const share = rows.length ? props.glassKg / rows.length : 0;
    let net = 0, gross = 0;
    for (const r of rows) {
      const n = kgNum(r.netKg) ?? share;
      net += n;
      gross += kgNum(r.grossKg) ?? n + props.tare;
    }
    return { net, gross };
  }, [rows, props.glassKg, props.tare]);
  const covered = [...new Set(rows.flatMap((r) => r.orderIds))]
    .map((id) => props.orders.find((o) => o.id === id)?.orderNo).filter(Boolean);
  // Gönderilen veri: yalnızca sandık alanları (misafir yük satırı gösterim içindir; sunucu bağı kendisi korur)
  const payload = JSON.stringify(rows.map(({ key: _k, guests: _g, origNo: _o, ...r }) => r));
  const many = props.orders.length > 1;
  // Sütun genişlikleri sınıftan gelir (app/globals.css → .crate-table .c-no / .c-dim / .c-kg)
  const cell = (r: Row, k: 'crateNo' | 'lengthMm' | 'widthMm' | 'heightMm' | 'netKg' | 'grossKg', label: string) => (
    <td className={k === 'crateNo' ? 'c-no' : k === 'netKg' || k === 'grossKg' ? 'c-kg' : 'c-dim'}>
      <input value={r[k]} inputMode={k === 'netKg' || k === 'grossKg' ? 'decimal' : 'numeric'} aria-label={`${label} (${r.crateNo || '—'})`}
        readOnly={k === 'crateNo' && guestsOf(r).length > 0}
        onChange={(e) => set(r.key, { [k]: e.target.value.replace(k === 'netKg' || k === 'grossKg' ? /[^\d.,]/g : /\D/g, '') } as Partial<Row>)} />
    </td>
  );
  const colCount = 8 + (many ? 1 : 0);

  return (
    <form action={action} className="crate-editor">
      <input type="hidden" name="day" value={props.day} />
      <input type="hidden" name="customerId" value={props.customerId} />
      <input type="hidden" name="rows" value={payload} />
      <div className="section-head">
        <h3>{m.title}</h3>
        {props.updated && <span className="badge badge-info">{props.updated}</span>}
      </div>
      <p className="muted small crate-intro">
        {m.intro}{covered.length > 0 && <> {interpolate(m.covers, { list: covered.join(', ') })}</>}
      </p>
      {state.error && <div className="alert alert-error">{state.error}</div>}
      {state.ok && <div className="alert alert-ok">{state.ok}</div>}
      {props.locked && <p className="small crate-locked" data-locked="1">{m.locked}</p>}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="crate-table">
            <thead>
              <tr>
                <th>{m.cols.no}</th><th>{m.cols.length}</th><th>{m.cols.width}</th><th>{m.cols.height}</th>
                <th>{m.cols.net}</th><th>{m.cols.gross}</th><th className="c-note">{m.cols.note}</th>{many && <th>{m.cols.orders}</th>}<th />
              </tr>
            </thead>
            {rows.map((r) => (
              <tbody key={r.key} className="crate-body">
                <tr>
                  {cell(r, 'crateNo', m.cols.no)}
                  {cell(r, 'lengthMm', m.cols.length)}
                  {cell(r, 'widthMm', m.cols.width)}
                  {cell(r, 'heightMm', m.cols.height)}
                  {cell(r, 'netKg', m.cols.net)}
                  {cell(r, 'grossKg', m.cols.gross)}
                  <td className="c-note"><input value={r.note} maxLength={200} aria-label={`${m.cols.note} (${r.crateNo || '—'})`} onChange={(e) => set(r.key, { note: e.target.value })} /></td>
                  {many && (
                    <td className="crate-orders">
                      {props.orders.map((o) => (
                        <label key={o.id} className="crate-pick small">
                          <input type="checkbox" checked={r.orderIds.includes(o.id)} aria-label={`${o.orderNo} (${r.crateNo || '—'})`}
                            onChange={(e) => set(r.key, { orderIds: e.target.checked ? [...r.orderIds, o.id] : r.orderIds.filter((x) => x !== o.id) })} />
                          {o.orderNo}
                        </label>
                      ))}
                    </td>
                  )}
                  <td className="c-del">
                    <button type="button" className="btn btn-link btn-del" aria-label={m.remove} title={guestsOf(r).length ? m.guestKept : m.remove}
                      disabled={guestsOf(r).length > 0} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>✕</button>
                  </td>
                </tr>
                {/* Misafir yük: bu sandıkta giden başka firmanın siparişi ve camı (fiziksel yerleşim; ticari sahiplik değişmez) */}
                {guestsOf(r).length ? (
                  <tr className="crate-guests" data-crate={r.crateNo}>
                    <td colSpan={colCount} className="small">{guestsOf(r).map((g) => <div key={g}>{g}</div>)}</td>
                  </tr>
                ) : null}
              </tbody>
            ))}
          </table>
        </div>
      )}
      <div className="tool-bar">
        <div className="group">
          <button type="button" className="btn" onClick={add} disabled={props.locked} aria-disabled={props.locked || undefined} title={props.locked ? m.locked : undefined}>{m.add}</button>
          {props.dayUsed.length > 0 && (
            <span className="muted small">{interpolate(m.dayUsed, { list: props.dayUsed.map((u) => `${u.no} (${u.label})`).join(', ') })}</span>
          )}
        </div>
        <div className="group">
          {rows.length > 0 && <b className="small">{interpolate(m.totals, { net: fmt0(totals.net), gross: fmt0(totals.gross) })}</b>}
          {(rows.length > 0 || props.initial.length > 0) && <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? m.saving : m.save}</button>}
        </div>
      </div>
      <p className="hint">{interpolate(m.grossHint, { tare: props.tare })}</p>
    </form>
  );
}
