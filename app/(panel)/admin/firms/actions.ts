'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Prisma, type CustomerType } from '@prisma/client';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';
import { audit } from '@/lib/audit';
import { cleanPrefix, suggestPrefix } from '@/lib/prefix';

export type FirmFormState = { error?: string; ok?: string; values?: Record<string, string> };

type FirmInput = {
  name: string; type: CustomerType; prefix: string | null;
  groupName: string | null; camEtiket: string | null; sandikEtiket: string | null;
};

function read(formData: FormData) {
  const v = (k: string) => String(formData.get(k) ?? '').trim();
  return {
    name: v('name'), type: v('type'), prefix: v('prefix'),
    groupName: v('groupName'), camEtiket: v('camEtiket'), sandikEtiket: v('sandikEtiket'),
  };
}

async function validate(raw: ReturnType<typeof read>, exceptId?: string): Promise<{ data?: FirmInput; error?: string }> {
  if (!raw.name) return { error: 'Firma adı gerekli.' };
  if (raw.name.length > 120) return { error: 'Firma adı çok uzun.' };
  const type: CustomerType = raw.type === 'FACTORY' ? 'FACTORY' : 'CUSTOMER';
  let prefix = cleanPrefix(raw.prefix);
  if (!prefix && type === 'CUSTOMER') prefix = suggestPrefix(raw.name);
  if (type === 'CUSTOMER' && prefix.length < 2) {
    return { error: 'Müşteri firmaları için en az 2 karakterlik bir sipariş no ön eki gerekli (A–Z, 0–9).' };
  }
  if (prefix && prefix.length < 2) return { error: 'Sipariş no ön eki en az 2 karakter olmalı.' };

  const nameClash = await db.customer.findFirst({
    where: { name: { equals: raw.name, mode: 'insensitive' }, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
  });
  if (nameClash) return { error: 'Bu isimde bir firma zaten var.' };
  if (prefix) {
    const prefixClash = await db.customer.findFirst({ where: { prefix, ...(exceptId ? { NOT: { id: exceptId } } : {}) } });
    if (prefixClash) return { error: `“${prefix}” ön eki ${prefixClash.name} firmasında kullanılıyor; farklı bir ön ek girin.` };
  }
  const nz = (s: string) => (s ? s.slice(0, 120) : null);
  return {
    data: {
      name: raw.name, type, prefix: prefix || null,
      groupName: nz(raw.groupName), camEtiket: nz(raw.camEtiket), sandikEtiket: nz(raw.sandikEtiket),
    },
  };
}

function isUniqueError(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export async function createFirmAction(_prev: FirmFormState, formData: FormData): Promise<FirmFormState> {
  const admin = await requireUser(['ADMIN']);
  const raw = read(formData);
  const { data, error } = await validate(raw);
  if (!data) return { error, values: raw };
  try {
    const firm = await db.customer.create({ data });
    await audit('CUSTOMER_CREATE', 'Customer', firm.id, admin.id, { name: firm.name, prefix: firm.prefix });
  } catch (err) {
    if (isUniqueError(err)) return { error: 'Firma adı ya da ön ek başka bir kayıtta kullanılıyor.', values: raw };
    throw err;
  }
  revalidatePath('/admin/firms');
  return { ok: `“${data.name}” firması oluşturuldu${data.prefix ? ` (ön ek: ${data.prefix})` : ''}. Şimdi bu firmaya kullanıcı atayabilirsiniz.` };
}

export async function updateFirmAction(formData: FormData) {
  const admin = await requireUser(['ADMIN']);
  const id = String(formData.get('id') ?? '');
  const firm = await db.customer.findUnique({ where: { id } });
  if (!firm) redirect('/admin/firms');
  const { data, error } = await validate(read(formData), id);
  if (!data) redirect(`/admin/firms/${id}?error=${encodeURIComponent(error ?? 'Geçersiz bilgi.')}`);
  if (data.type !== firm.type && (await db.user.count({ where: { customerId: id } })) > 0) {
    redirect(`/admin/firms/${id}?error=${encodeURIComponent('Bu firmaya bağlı kullanıcılar var; firma tipi değiştirilemez.')}`);
  }
  try {
    await db.customer.update({ where: { id }, data });
  } catch (err) {
    if (isUniqueError(err)) redirect(`/admin/firms/${id}?error=${encodeURIComponent('Firma adı ya da ön ek başka bir kayıtta kullanılıyor.')}`);
    throw err;
  }
  await audit('CUSTOMER_UPDATE', 'Customer', id, admin.id, { before: { name: firm.name, prefix: firm.prefix }, after: { name: data.name, prefix: data.prefix } });
  revalidatePath('/admin/firms');
  redirect(`/admin/firms?saved=${encodeURIComponent(data.name)}`);
}
