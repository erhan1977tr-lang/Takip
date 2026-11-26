import { PWA_ICONS } from '@/server/push/icons.js';

// "Ana ekrana ekle" simgeleri ve bildirim rozeti (4.2.33): uygulamanın kendi varlıkları, oturum gerektirmez.
const ICONS: Record<string, string> = PWA_ICONS;

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (!Object.hasOwn(ICONS, file)) return new Response('Not found', { status: 404 });
  const bytes = Buffer.from(ICONS[file], 'base64');
  return new Response(new Uint8Array(bytes), {
    headers: { 'Content-Type': 'image/png', 'Content-Length': String(bytes.length), 'Cache-Control': 'public, max-age=604800' },
  });
}
