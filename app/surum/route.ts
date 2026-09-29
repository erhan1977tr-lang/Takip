import { APP_VERSION } from '@/lib/version';
import { getEnv } from '@/lib/env';

// Yayındaki sürüm (herkese açık; giriş sayfası zaten sürümü gösterir). Sunucu kurulumu ve izleme bunu kullanır.
export const dynamic = 'force-dynamic';

export function GET() {
  const sha: string = getEnv().GIT_SHA || '';
  return Response.json(
    { version: APP_VERSION, build: sha ? sha.slice(0, 7) : 'dev' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
