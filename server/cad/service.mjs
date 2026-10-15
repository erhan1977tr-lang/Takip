// CAD önizleme hizmeti (DWG / DXF → önizleme geometrisi). Ayrı, yalıtılmış bir kapsayıcıda çalışır (deploy/docker-compose.yml
// "cad" servisi: ağı yalnızca uygulamayla paylaşır, internete / veritabanına / yükleme birimine erişemez, salt okunur kök,
// bütün yetenekler bırakılmış, bellek / işlemci / süreç sınırlı, root değil). Uygulama yetki denetimini yaptıktan sonra dosyanın
// baytlarını buraya gönderir; hizmet hiçbir dosyaya, kullanıcıya ya da siparişe erişmez.
//
//   POST /preview?type=dwg|dxf   gövde = dosya (Content-Length zorunlu, sınırlı)
//   GET  /health                 {"ok":true,"dwg":true|false}
//
// DWG: GNU LibreDWG'nin dwg2dxf programı (GPLv3+, ayrı program olarak çalıştırılır; docs/adr/0014-cad-onizleme.md) → DXF.
// DXF: ayrıştırma ayrı bir node sürecinde (dxf-cli.mjs). Her iki süreç de prlimit ile sınırlanır (bellek, işlemci süresi,
// dosya boyutu, çekirdek dökümü yok) ve süre aşımında öldürülür. Dosya adları komut satırına KONMAZ: girdi / çıktı her
// istekte yeni açılan geçici klasördeki sabit adlardır; argümanlar kabuk olmadan (spawn, dizi) verilir; geçici klasör her
// durumda silinir. Yanıtlar yalnızca sabit hata kodları taşır (araç çıktısı, yol, ileti dışarı verilmez).
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { converterReport } from './dxf.js';

export const SERVICE_LIMITS = Object.freeze({
  dwgBytes: 40_000_000,
  dxfBytes: 60_000_000,
  dxfFromDwgBytes: 300_000_000,
  outBytes: 64_000_000,
  dwgTimeoutMs: 60_000,
  parseTimeoutMs: 90_000,
  waitMs: 60_000,
  active: 1,
  queue: 3,
  dwgMemBytes: 1_500_000_000,
  parseHeapMb: 1024,
  cpuSeconds: 90,
  stderrBytes: 2_000_000,
});

/** Hata kodu → HTTP durumu (uygulama da aynı kodları kullanıcı metnine çevirir) */
export const STATUS = Object.freeze({
  TOO_LARGE: 413, LENGTH: 411, BAD_TYPE: 400, INVALID: 422, MISMATCH: 415, BINARY_DXF: 415, NOT_DXF: 415,
  CONVERT_FAILED: 422, TOO_COMPLEX: 422, BUSY: 503, UNAVAILABLE: 503, TIMEOUT: 504,
});

/**
 * İçerik dosya türüyle uyumlu mu (uzantıya güvenilmez — ilk baytlar)
 * @param {'dwg' | 'dxf'} type @param {Buffer} head
 * @returns {null | 'MISMATCH' | 'BINARY_DXF'}
 */
export function sniff(type, head) {
  const s = head.subarray(0, 32).toString('latin1');
  if (type === 'dwg') return /^AC(?:1\.\d|2\.\d|10\d\d)/.test(s) ? null : 'MISMATCH';
  if (s.startsWith('AutoCAD Binary DXF')) return 'BINARY_DXF';
  // ASCII DXF: (BOM) boşluk + grup kodu satırı ("0" ya da "999")
  const t = head.toString('latin1').replace(/^﻿|^\xEF\xBB\xBF/, '');
  if (!/^\s*(?:0|999)\s*\r?\n/.test(t)) return 'MISMATCH';
  for (const b of head) if (b === 0) return 'MISMATCH';
  return null;
}

/** Süreç çalıştırır: süre aşımında öldürür; stderr istenirse en çok `stderrMax` bayt tutulur. { code, timedOut, stderr } */
function runProcess(spawnImpl, cmd, args, { timeoutMs, env, cwd, stderrMax = 0 }) {
  return new Promise((resolve) => {
    let done = false;
    let timedOut = false;
    /** @type {Buffer[]} */
    const err = [];
    let errBytes = 0;
    let child;
    try {
      child = spawnImpl(cmd, args, { env, cwd, stdio: ['ignore', 'ignore', stderrMax > 0 ? 'pipe' : 'ignore'], detached: false });
    } catch {
      resolve({ code: -1, timedOut: false, stderr: '', truncated: false });
      return;
    }
    let truncated = false;
    child.stderr?.on('data', (chunk) => {
      if (errBytes + chunk.length > stderrMax) truncated = true;
      if (errBytes >= stderrMax) return;
      const part = chunk.subarray(0, stderrMax - errBytes);
      err.push(part);
      errBytes += part.length;
    });
    child.stderr?.on('error', () => {});
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* süreç zaten bitti */ }
    }, timeoutMs);
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: typeof code === 'number' ? code : -1, timedOut, stderr: Buffer.concat(err).toString('latin1'), truncated });
    };
    child.on('error', () => finish(-1));
    child.on('close', (code) => finish(code));
  });
}

/**
 * @param {{ dwgBin?: string | null, nodeBin?: string, cliPath?: string, prlimit?: string | null, tmpRoot?: string,
 *   limits?: Partial<typeof SERVICE_LIMITS>, spawnImpl?: typeof spawn, log?: (...a: any[]) => void }} [o]
 */
export function createCadService(o = {}) {
  const L = { ...SERVICE_LIMITS, ...(o.limits ?? {}) };
  const spawnImpl = o.spawnImpl ?? spawn;
  const nodeBin = o.nodeBin ?? process.execPath;
  const cliPath = o.cliPath ?? fileURLToPath(new URL('./dxf-cli.mjs', import.meta.url));
  const tmpRoot = o.tmpRoot ?? os.tmpdir();
  const log = o.log ?? (() => {});
  const isExec = (p) => {
    if (!p) return false;
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const dwgBin = isExec(o.dwgBin) ? o.dwgBin : null;
  const prlimit = o.prlimit === undefined ? (isExec('/usr/bin/prlimit') ? '/usr/bin/prlimit' : null) : isExec(o.prlimit) ? o.prlimit : null;
  const state = { active: 0, waiting: /** @type {(() => void)[]} */ ([]), served: 0 };

  const limited = (limits, cmd, args) => (prlimit ? [prlimit, [...limits, '--', cmd, ...args]] : [cmd, args]);

  function acquire() {
    if (state.active < L.active) {
      state.active++;
      return Promise.resolve(true);
    }
    if (state.waiting.length >= L.queue) return Promise.resolve(false);
    return new Promise((resolve) => {
      let entry;
      const timer = setTimeout(() => {
        state.waiting = state.waiting.filter((w) => w !== entry);
        resolve(false);
      }, L.waitMs);
      entry = () => {
        clearTimeout(timer);
        state.active++;
        resolve(true);
      };
      state.waiting.push(entry);
    });
  }
  function release() {
    state.active--;
    const next = state.waiting.shift();
    if (next) next();
  }

  const send = (res, status, body) => {
    const s = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s), 'Cache-Control': 'no-store' });
    res.end(s);
  };
  const fail = (res, code) => send(res, STATUS[code] ?? 422, { ok: false, code });

  /** Gövdeyi dosyaya yazar; bildirilen boyut ve sınır aşılırsa durur */
  function receive(req, file, declared, max) {
    return new Promise((resolve) => {
      let n = 0;
      let failed = false;
      const out = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 });
      const stop = (code) => {
        if (failed) return;
        failed = true;
        req.unpipe?.(out);
        out.destroy();
        req.resume();
        resolve(code);
      };
      req.on('data', (chunk) => {
        n += chunk.length;
        if (n > declared || n > max) stop('TOO_LARGE');
      });
      req.on('error', () => stop('INVALID'));
      out.on('error', () => stop('INVALID'));
      out.on('finish', () => {
        if (!failed) resolve(n === declared ? null : 'INVALID');
      });
      req.pipe(out);
    });
  }

  async function preview(req, res, type) {
    const declared = Number(req.headers['content-length']);
    if (!Number.isInteger(declared) || declared <= 0) return fail(res, 'LENGTH');
    const max = type === 'dwg' ? L.dwgBytes : L.dxfBytes;
    if (declared > max) {
      req.resume();
      return fail(res, 'TOO_LARGE');
    }
    if (type === 'dwg' && !dwgBin) {
      req.resume();
      return fail(res, 'UNAVAILABLE');
    }
    if (!(await acquire())) {
      req.resume();
      return fail(res, 'BUSY');
    }
    let dir = null;
    try {
      dir = await fsp.mkdtemp(path.join(tmpRoot, 'cad-'));
      const input = path.join(dir, type === 'dwg' ? 'in.dwg' : 'in.dxf');
      const bad = await receive(req, input, declared, max);
      if (bad) return fail(res, bad);
      const fh = await fsp.open(input, 'r');
      const head = Buffer.alloc(64);
      const { bytesRead } = await fh.read(head, 0, 64, 0);
      await fh.close();
      const kind = sniff(type, head.subarray(0, bytesRead));
      if (kind) return fail(res, kind);
      const env = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: dir };
      let dxf = input;
      let warning = false;
      /** @type {string | null} */
      let reportFile = null;
      if (type === 'dwg') {
        dxf = path.join(dir, 'out.dxf');
        const [cmd, args] = limited(
          [`--as=${L.dwgMemBytes}`, `--cpu=${L.cpuSeconds}`, `--fsize=${L.dxfFromDwgBytes}`, '--core=0', '--nofile=64'],
          /** @type {string} */ (dwgBin), ['-y', '-o', dxf, input],
        );
        const r = await runProcess(spawnImpl, cmd, args, { timeoutMs: L.dwgTimeoutMs, env, cwd: dir, stderrMax: L.stderrBytes });
        if (r.timedOut) return fail(res, 'TIMEOUT');
        // DXF'e yazılmayan nesne türleri (yalnızca tür adı + sayı; araç çıktısının kendisi saklanmaz / dışarı verilmez)
        // çıktı sınırı aşıldıysa rapor eksik olabilir: önizleme uyarıyla gösterilir
        if (r.truncated) warning = true;
        reportFile = path.join(dir, 'report.json');
        await fsp.writeFile(reportFile, JSON.stringify(converterReport(r.stderr)), { mode: 0o600 });
        let size = 0;
        try { size = (await fsp.stat(dxf)).size; } catch { size = 0; }
        if (size === 0) return fail(res, 'CONVERT_FAILED');
        // dwg2dxf hata koduyla bitti ama çıktı üretti: önizleme UYARIYLA gösterilir (sessizce eksik gösterilmez)
        if (r.code !== 0) warning = true;
      }
      const json = path.join(dir, 'out.json');
      const [cmd, args] = limited([`--cpu=${L.cpuSeconds}`, '--core=0', '--nofile=64'], nodeBin, [`--max-old-space-size=${L.parseHeapMb}`, cliPath, dxf, json, ...(reportFile ? [reportFile] : [])]);
      const r = await runProcess(spawnImpl, cmd, args, { timeoutMs: L.parseTimeoutMs, env, cwd: dir });
      if (r.timedOut) return fail(res, 'TIMEOUT');
      let st = null;
      try { st = await fsp.stat(json); } catch { st = null; }
      if (!st || r.code !== 0) return fail(res, type === 'dwg' ? 'CONVERT_FAILED' : 'INVALID');
      if (st.size > L.outBytes) return fail(res, 'TOO_COMPLEX');
      /** @type {any} */
      let out;
      try { out = JSON.parse(await fsp.readFile(json, 'utf8')); } catch { return fail(res, 'INVALID'); }
      if (!out || out.ok !== true) return fail(res, typeof out?.code === 'string' && STATUS[out.code] ? out.code : 'INVALID');
      state.served++;
      return send(res, 200, { ok: true, converted: type === 'dwg', warning, data: out.data });
    } catch (e) {
      log('cad önizleme işlenemedi', /** @type {any} */ (e)?.code ?? 'ERR');
      return fail(res, 'INVALID');
    } finally {
      release();
      if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://cad.invalid');
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, dwg: !!dwgBin });
    if (req.method === 'POST' && url.pathname === '/preview') {
      const type = url.searchParams.get('type');
      if (type !== 'dwg' && type !== 'dxf') {
        req.resume();
        return fail(res, 'BAD_TYPE');
      }
      return void preview(req, res, type);
    }
    req.resume();
    return send(res, 404, { ok: false, code: 'NOT_FOUND' });
  }

  return { handler, state, dwgAvailable: !!dwgBin, prlimit };
}

// Doğrudan çalıştırılınca: dinler (kapsayıcının ağında yalnızca uygulama erişir)
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number(process.env.CAD_PORT || 3311);
  const svc = createCadService({ dwgBin: process.env.DWG2DXF_BIN || '/usr/local/bin/dwg2dxf', log: (...a) => console.error(...a) });
  const server = http.createServer(svc.handler);
  server.headersTimeout = 20_000;
  server.requestTimeout = 300_000;
  server.listen(port, process.env.CAD_HOST || '0.0.0.0', () => {
    console.log(`cad önizleme hizmeti: ${port} (DWG ${svc.dwgAvailable ? 'açık' : 'yok'}, sınırlama ${svc.prlimit ? 'prlimit' : 'yok'})`);
  });
}
