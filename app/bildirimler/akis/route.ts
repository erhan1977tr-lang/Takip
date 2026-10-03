import { getCurrentUser } from '@/lib/auth/session';
import { getLocale } from '@/lib/i18n';
import { loadFeed } from '@/lib/notifications';

export const dynamic = 'force-dynamic';

// Bildirim akışı (JSON): ortak otomatik yenileme sayfayı yenilemediği anlarda (sekme arka planda, form doluyor) zilin
// yine de güncellenmesi için — aynı 60 sn'lik zamanlayıcı çağırır (components/AutoRefresh.tsx), ayrı bir döngü yoktur.
// Yalnızca oturum sahibinin kendi bildirimleri döner; oturum yoksa 401.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  const feed = await loadFeed(user.id, await getLocale());
  return Response.json({ ...feed, sound: user.notificationSound }, { headers: { 'Cache-Control': 'no-store' } });
}
