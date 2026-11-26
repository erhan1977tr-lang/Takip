import { SW_SOURCE } from '@/server/push/sw.js';

// Servis çalışanı (4.2.33, karar 331): kök adresten sunulur (kapsam: tüm site). Oturum gerektirmez — içinde veri yoktur.
// Tarayıcı her açılışta güncel sürümü alsın (no-cache).
export function GET() {
  return new Response(SW_SOURCE, {
    headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}
