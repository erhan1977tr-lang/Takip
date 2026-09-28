'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';
import { audit } from '@/lib/audit';

const back = (q: string) => `/admin/katalog?${q}`;

export async function addGlassAction(formData: FormData) {
  const admin = await requireUser(['ADMIN']);
  const name = String(formData.get('name') ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
  if (!name) redirect(back('error=empty'));
  const exists = await db.glassProduct.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
  if (exists) redirect(back('error=exists'));
  const max = await db.glassProduct.aggregate({ _max: { sortOrder: true } });
  const g = await db.glassProduct.create({ data: { name, sortOrder: (max._max.sortOrder ?? 0) + 10 } });
  await audit('GLASS_CREATE', 'GlassProduct', g.id, admin.id, { name });
  revalidatePath('/admin/katalog');
  redirect(back('ok=added'));
}

export async function updateGlassAction(formData: FormData) {
  const admin = await requireUser(['ADMIN']);
  const id = String(formData.get('id') ?? '');
  const g = await db.glassProduct.findUnique({ where: { id } });
  if (!g) redirect(back('error=notfound'));
  const intent = String(formData.get('intent') ?? '');
  if (intent === 'toggle') {
    await db.glassProduct.update({ where: { id }, data: { isActive: !g.isActive } });
  } else if (intent === 'up' || intent === 'down') {
    const all = await db.glassProduct.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    const i = all.findIndex((x) => x.id === id);
    const j = intent === 'up' ? i - 1 : i + 1;
    if (j >= 0 && j < all.length) {
      [all[i], all[j]] = [all[j], all[i]];
      await db.$transaction(all.map((x, k) => db.glassProduct.update({ where: { id: x.id }, data: { sortOrder: (k + 1) * 10 } })));
    }
  } else if (intent === 'rename') {
    const name = String(formData.get('name') ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
    if (!name) redirect(back('error=empty'));
    const clash = await db.glassProduct.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, NOT: { id } } });
    if (clash) redirect(back('error=exists'));
    await db.glassProduct.update({ where: { id }, data: { name } });
  }
  await audit('GLASS_UPDATE', 'GlassProduct', id, admin.id, { intent });
  revalidatePath('/admin/katalog');
  redirect(back('ok=saved'));
}
