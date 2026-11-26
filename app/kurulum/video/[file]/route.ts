import { GUIDE_VIDEOS } from '@/server/push/guide-videos.js';

// Kurulum rehberi videosu (4.2.33): uygulamanın kendi varlığı, oturum gerektirmez, kişisel veri içermez.
// iPhone Safari videoyu Range istekleriyle oynatır: tek aralık (206) desteklenir.
const VIDEOS: Record<string, string> = GUIDE_VIDEOS;
const cache = new Map<string, Buffer>();
const bytesOf = (f: string) => {
  let b = cache.get(f);
  if (!b) { b = Buffer.from(VIDEOS[f], 'base64'); cache.set(f, b); }
  return b;
};

export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (!Object.hasOwn(VIDEOS, file)) return new Response('Not found', { status: 404 });
  const all = bytesOf(file);
  const base = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : all.length - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : all.length - 1;
    start = Math.max(0, start);
    end = Math.min(end, all.length - 1);
    if (start > end || start >= all.length) {
      return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${all.length}` } });
    }
    const part = all.subarray(start, end + 1);
    return new Response(new Uint8Array(part), {
      status: 206, headers: { ...base, 'Content-Length': String(part.length), 'Content-Range': `bytes ${start}-${end}/${all.length}` },
    });
  }
  return new Response(new Uint8Array(all), { headers: { ...base, 'Content-Length': String(all.length) } });
}
