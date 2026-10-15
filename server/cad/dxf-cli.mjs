// DXF → önizleme geometrisi, ayrı süreçte (server/cad/service.mjs çağırır; bellek / süre sınırı orada). Kullanım:
//   node dxf-cli.mjs <girdi.dxf> <çıktı.json> [dönüştürücü-raporu.json]
// Çıktı: {"ok":true,"data":{…}} ya da {"ok":false,"code":"…"} (sabit kodlar; girdi metni ya da hata iletisi yazılmaz).
// Rapor (isteğe bağlı): DWG dönüşümünde dwg2dxf'in DXF'e yazmadığı nesne türleri ({ TÜR: sayı }) — önizlemede "çizilmeyen"
// olarak işaretlenir (mergeConverterReport).
import fs from 'node:fs';
import { CadError, CAD_LIMITS, dxfToPreview, mergeConverterReport } from './dxf.js';

/** UTF-8 (R2007+) ya da Windows-1252 (eski sürümler); geçersiz UTF-8 sessizce bozulmaz, 1252'ye düşülür */
export function decodeDxf(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

function readReport(file) {
  if (!file) return null;
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function run(input, output, reportFile) {
  let result;
  try {
    const st = fs.statSync(input);
    if (!st.isFile()) throw new CadError('INVALID');
    if (st.size > CAD_LIMITS.bytes) throw new CadError('TOO_LARGE');
    const buf = fs.readFileSync(input);
    if (buf.subarray(0, 18).toString('latin1') === 'AutoCAD Binary DXF') throw new CadError('BINARY_DXF');
    const data = dxfToPreview(decodeDxf(buf));
    const report = readReport(reportFile);
    if (report) mergeConverterReport(data, report);
    result = { ok: true, data };
  } catch (e) {
    result = { ok: false, code: e instanceof CadError ? e.code : 'INVALID' };
  }
  fs.writeFileSync(output, JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [input, output, report] = process.argv.slice(2);
  if (!input || !output) process.exit(2);
  run(input, output, report);
}
