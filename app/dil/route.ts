import { NextResponse, type NextRequest } from 'next/server';
import { secureCookies } from '@/lib/env';
import { LOCALE_COOKIE, isLocale } from '@/server/i18n/index.js';

/** Yalnızca site içi göreli adreslere dönülür (açık yönlendirme olmasın). */
function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/login';
  return next;
}

/**
 * Dil değiştirme (giriş ekranındaki RO | TR bağlantıları; JavaScript gerekmez): /dil?l=ro&next=/login
 * YALNIZCA dil çerezini yazar ve geldiği sayfaya döner; veritabanında hiçbir şeyi değiştirmez (SEC-15: kayıt
 * değiştiren işlem GET ile yapılmaz). Kullanıcının dili (User.language) paneldeki dil seçiminde sunucu işlemiyle
 * (app/(panel)/actions.ts → setLanguageAction) ve girişte kaydedilir.
 */
export async function GET(req: NextRequest) {
  const l = req.nextUrl.searchParams.get('l');
  const next = safeNext(req.nextUrl.searchParams.get('next'));
  // Göreli Location: vekil sunucu arkasında (Codespaces, Caddy) iç adres (localhost) dışarı sızmasın
  const res = new NextResponse(null, { status: 303, headers: { Location: next, 'Cache-Control': 'no-store' } });
  if (isLocale(l)) {
    res.cookies.set(LOCALE_COOKIE, l, { httpOnly: false, sameSite: 'lax', secure: secureCookies(), path: '/', maxAge: 365 * 86_400 });
  }
  return res;
}
