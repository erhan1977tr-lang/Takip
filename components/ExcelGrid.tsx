import type { ReactNode } from 'react';

/** Excel sütun adı: A … Z, sonra A1 … (iki Excel aktarım ekranında aynı) */
export const excelColName = (i: number) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : '');

/** Ön izlemede gösterilen sütun sayısı: ilk 50 satırın en uzunu (iki ekranda aynı kural) */
export const excelCols = (rows: string[][] | null) => Math.max(0, ...(rows ?? []).slice(0, 50).map((r) => r.length));

/**
 * Excel ön izlemesi — dosyanın GERÇEK hücreleri (satır no + A, B, C … sütunları). Satış teklif tablosunun "Excel'den Aktar"
 * penceresi (app/(panel)/siparisler/[id]/ExcelImport.tsx) ve ticari teklifin cam aktarımı
 * (app/(panel)/admin/ticari-teklifler/ExcelImport.tsx) aynı tabloyu kullanır; işaretleme ve son sütun çağırana aittir.
 *   picked: seçilen sütunlar (kalın) · invalid(line): satır kırmızı · trailing(line): satırın son hücresi · rowProps: ek nitelikler
 *   show(line): yalnızca bu satırlar (verilmezse hepsi); limit gösterilen satırlara uygulanır
 */
export function ExcelGrid({ rows, cols, picked, limit = 200, invalid, trailing, rowProps, show, trailingHead = null, tableProps }: {
  rows: string[][];
  cols: number;
  picked: number[];
  limit?: number;
  /** Satır (1 tabanlı) geçersiz mi */
  invalid: (line: number) => boolean;
  trailing: (line: number) => ReactNode;
  rowProps?: (line: number) => Record<string, string | undefined>;
  show?: (line: number) => boolean;
  trailingHead?: ReactNode;
  tableProps?: Record<string, string>;
}) {
  return (
    <div className="import-preview">
      <table {...tableProps}>
        <thead><tr><th>#</th>{Array.from({ length: cols }, (_, i) => <th key={i}>{excelColName(i)}</th>)}<th>{trailingHead}</th></tr></thead>
        <tbody>
          {rows.map((r, i) => [r, i] as const).filter(([, i]) => !show || show(i + 1)).slice(0, limit).map(([r, i]) => {
            const extra = rowProps?.(i + 1) ?? {};
            const cls = [invalid(i + 1) ? 'row-invalid' : '', extra.className ?? ''].filter(Boolean).join(' ') || undefined;
            return (
              <tr key={i} {...extra} className={cls}>
                <td className="muted">{i + 1}</td>
                {Array.from({ length: cols }, (_, c) => (
                  <td key={c} className={picked.includes(c) ? 'col-picked' : undefined}>{r[c] ?? ''}</td>
                ))}
                {trailing(i + 1)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
