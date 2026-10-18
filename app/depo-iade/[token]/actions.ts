'use server';

// Profil iadesinin depo teslimi (DÜZELTME 10 M8) — e-postadaki tek kullanımlık bağlantı (giriş gerektirmez). Bağlantının tek
// yetkisi o iadenin fiziksel teslimini (sağlam / hasarlı) onaylamaktır; kural server/profile/returns.js → confirmReturnByToken.
// Geçersiz anahtar denemeleri IP başına sınırlıdır (depo bağlantısıyla aynı sayaç).
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { requestIp } from '@/lib/auth/throttle';
import { WINDOW_MS } from '@/server/auth/throttle.js';
import { confirmReturnByToken } from '@/server/profile/returns.js';

const DEPOT_FAIL_LIMIT = 30;

export async function depotReturnAction(fd: FormData) {
  const token = String(fd.get('token') ?? '');
  const base = `/depo-iade/${encodeURIComponent(token)}`;
  const ip = await requestIp();
  const fails = await db.authFailure.count({ where: { kind: 'DEPOT', ip, createdAt: { gte: new Date(Date.now() - WINDOW_MS) } } });
  if (fails >= DEPOT_FAIL_LIMIT) redirect(`${base}?e=many`);
  const keys = [...fd.keys()];
  const ids = [...new Set(keys.filter((k) => /^[gd]-/.test(k)).map((k) => k.slice(2)))];
  const quantities = Object.fromEntries(ids.map((id) => [id, { good: String(fd.get(`g-${id}`) ?? ''), damaged: String(fd.get(`d-${id}`) ?? '') }]));
  const r = await confirmReturnByToken(db, { token, quantities, note: fd.get('note'), ip });
  if (!r.ok) {
    const code = String((r as unknown as { code?: unknown }).code ?? 'OTHER');
    if (code === 'INVALID') {
      await db.authFailure.create({ data: { kind: 'DEPOT', email: '-', ip: ip.slice(0, 64) } });
      redirect(`${base}?e=invalid`);
    }
    redirect(`${base}?e=${encodeURIComponent(code)}`);
  }
  revalidatePath('/admin/stok');
  redirect(`${base}?ok=done`);
}
