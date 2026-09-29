import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { secureCookies } from '@/lib/env';
import { LOCALE_COOKIE, isLocale } from '@/server/i18n/index.js';

/** Yalnızca site içi göreli adreslere dönülür (açık yönlendirme olmasın). */
function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/login';
  return next;
}

/**
 * Dil değiştirme: /dil?l=ro&next=/siparisler
 * Seçimi çereze yazar (giriş sayfası ve panel bununla açılır), oturum varsa kullanıcının diline de kaydeder
 * (e-postalar o dilde gider) ve geldiği sayfaya döner.
 */
export async function GET(req: NextRequest) {
  const l = req.nextUrl.searchParams.get('l');
  const next = safeNext(req.nextUrl.searchParams.get('next'));
  // Göreli Location: vekil sunucu arkasında (Codespaces, Caddy) iç adres (localhost) dışarı sızmasın
  const res = new NextResponse(null, { status: 303, headers: { Location: next, 'Cache-Control': 'no-store' } });
  if (isLocale(l)) {
    res.cookies.set(LOCALE_COOKIE, l, { httpOnly: false, sameSite: 'lax', secure: secureCookies(), path: '/', maxAge: 365 * 86_400 });
    const user = await getCurrentUser();
    if (user && user.language !== l) await db.user.update({ where: { id: user.id }, data: { language: l } });
  }
  return res;
}
