'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Prisma, type CustomerType } from '@prisma/client';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { audit } from '@/lib/audit';
import { isFirmCode, suggestFirmCode } from '@/lib/prefix';
import { getT, type T, type MsgKey } from '@/lib/i18n';
import { parseFxPolicy } from '@/server/fx/resolve.js';
import { isEmail } from '@/server/documents/delivery.js';
import { actorOf } from '@/lib/actor';
import { deleteCustomer, removeOrphanFiles } from '@/server/customers/deletion.js';
import { removeUpload } from '@/server/files/store.js';

export type FirmFormState = { error?: string; ok?: string; values?: Record<string, string> };

type FirmInput = {
  name: string; type: CustomerType; prefix: string | null;
  groupName: string | null; camEtiket: string | null; sandikEtiket: string | null;
  // Kur politikası (karar 95): yalnızca düzenleme formunda; formda yoksa dokunulmaz
  fxPolicy?: 'BT_UNIT_SELL' | 'BNR' | 'BNR_PLUS_PERCENT'; fxMarkupPercent?: string | null;
  // Mali belge e-postası (karar 115): yalnızca düzenleme formunda; formda yoksa dokunulmaz
  billingEmail?: string | null;
} & Partial<Record<(typeof BILLING)[number], string | null>>;

// Fatura bilgileri (Aşama 6b, FGO). Yalnızca düzenleme formunda; formda yoksa dokunulmaz.
const BILLING = ['taxId', 'regCom', 'country', 'county', 'city', 'address'] as const;

function read(formData: FormData) {
  const v = (k: string) => String(formData.get(k) ?? '').trim();
  return {
    name: v('name'), type: v('type'), prefix: v('prefix'),
    groupName: v('groupName'), camEtiket: v('camEtiket'), sandikEtiket: v('sandikEtiket'),
    billing: Object.fromEntries(BILLING.filter((k) => formData.has(k)).map((k) => [k, v(k)])) as Partial<Record<(typeof BILLING)[number], string>>,
    fx: formData.has('fxPolicy') ? { policy: v('fxPolicy'), percent: v('fxMarkupPercent') } : null,
    billingEmail: formData.has('billingEmail') ? v('billingEmail') : null,
  };
}

const formValues = ({ billing, fx: _fx, billingEmail: _mail, ...rest }: ReturnType<typeof read>): Record<string, string> => ({ ...rest, ...billing });

async function validate(t: T, raw: ReturnType<typeof read>, exceptId?: string): Promise<{ data?: FirmInput; error?: string }> {
  if (!raw.name) return { error: t('admin.firmActions.nameRequired') };
  if (raw.name.length > 120) return { error: t('admin.firmActions.nameTooLong') };
  const type: CustomerType = raw.type === 'FACTORY' ? 'FACTORY' : 'CUSTOMER';
  // Firma kodu tam 3 harf (A–Z). Boş bırakılırsa addan, boşta olan bir kod önerilir.
  let prefix = raw.prefix ? raw.prefix.toUpperCase() : '';
  if (!prefix && type === 'CUSTOMER') {
    const taken = (await db.customer.findMany({ where: { prefix: { not: null } }, select: { prefix: true } })).map((c) => c.prefix!);
    prefix = suggestFirmCode(raw.name, taken) ?? '';
  }
  if (prefix && !isFirmCode(prefix)) return { error: t('admin.firmActions.prefixInvalid') };
  if (type === 'CUSTOMER' && !prefix) return { error: t('admin.firmActions.prefixInvalid') };

  const nameClash = await db.customer.findFirst({
    where: { name: { equals: raw.name, mode: 'insensitive' }, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
  });
  if (nameClash) return { error: t('admin.firmActions.nameTaken') };
  if (prefix) {
    const prefixClash = await db.customer.findFirst({ where: { prefix, ...(exceptId ? { NOT: { id: exceptId } } : {}) } });
    if (prefixClash) return { error: t('admin.firmActions.prefixTaken', { prefix, firm: prefixClash.name }) };
  }
  const nz = (s: string) => (s ? s.slice(0, 120) : null);
  // Kur politikası: yüzde sunucuda doğrulanır (sayı, 0–20, en çok 3 ondalık). Fabrika kaydında politika kullanılmaz.
  let fx: Pick<FirmInput, 'fxPolicy' | 'fxMarkupPercent'> = {};
  if (raw.fx && type === 'CUSTOMER') {
    const r = parseFxPolicy(raw.fx);
    if (!r.ok) return { error: t(`fx.errors.${r.code}` as MsgKey) };
    fx = r.data;
  }
  // Fatura e-postası: boş bırakılabilir; doluysa geçerli bir adres olmalı (sunucuda doğrulanır)
  if (raw.billingEmail && (raw.billingEmail.length > 200 || !isEmail(raw.billingEmail))) return { error: t('admin.firmActions.billingEmailInvalid') };
  return {
    data: {
      ...fx,
      ...(raw.billingEmail != null ? { billingEmail: raw.billingEmail || null } : {}),
      name: raw.name, type, prefix: prefix || null,
      groupName: nz(raw.groupName), camEtiket: nz(raw.camEtiket), sandikEtiket: nz(raw.sandikEtiket),
      ...Object.fromEntries(Object.entries(raw.billing).map(([k, y]) => [k, String(y ?? '')]).map(([k, x]) => [k, k === 'taxId' ? nz(x.replace(/^RO/i, '').replace(/\s/g, '')) : k === 'address' ? (x ? x.slice(0, 250) : null) : k === 'country' ? nz(x.toUpperCase().slice(0, 2)) : nz(x)])),
    },
  };
}

function isUniqueError(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export async function createFirmAction(_prev: FirmFormState, formData: FormData): Promise<FirmFormState> {
  const admin = await requirePermission('CUSTOMER_MANAGE');
  const { t } = await getT();
  const raw = read(formData);
  const { data, error } = await validate(t, raw);
  if (!data) return { error, values: formValues(raw) };
  try {
    const firm = await db.customer.create({ data });
    await audit('CUSTOMER_CREATE', 'Customer', firm.id, admin.id, { name: firm.name, prefix: firm.prefix });
  } catch (err) {
    if (isUniqueError(err)) return { error: t('admin.firmActions.duplicate'), values: formValues(raw) };
    throw err;
  }
  revalidatePath('/admin/firms');
  return {
    ok: data.prefix
      ? t('admin.firmActions.createdWithPrefix', { name: data.name, prefix: data.prefix })
      : t('admin.firmActions.created', { name: data.name }),
  };
}

export async function updateFirmAction(formData: FormData) {
  const admin = await requirePermission('CUSTOMER_MANAGE');
  const { t } = await getT();
  const id = String(formData.get('id') ?? '');
  const firm = await db.customer.findUnique({ where: { id } });
  if (!firm) redirect('/admin/firms');
  // Hata metni çevrilmiş olarak adrese yazılır; düzenleme sayfası olduğu gibi gösterir.
  const { data, error } = await validate(t, read(formData), id);
  if (!data) redirect(`/admin/firms/${id}?error=${encodeURIComponent(error ?? t('admin.firmActions.invalid'))}`);
  // Siparişi olan firmanın kodu değişmez: eski sipariş numaraları (GLA68) bu koda bağlı.
  if (data.prefix !== firm.prefix && (await db.order.count({ where: { customerId: id } })) > 0) {
    redirect(`/admin/firms/${id}?error=${encodeURIComponent(t('admin.firmActions.prefixLocked', { prefix: firm.prefix ?? '' }))}`);
  }
  if (data.type !== firm.type && (await db.user.count({ where: { customerId: id } })) > 0) {
    redirect(`/admin/firms/${id}?error=${encodeURIComponent(t('admin.firmActions.typeLocked'))}`);
  }
  try {
    await db.customer.update({ where: { id }, data });
  } catch (err) {
    if (isUniqueError(err)) redirect(`/admin/firms/${id}?error=${encodeURIComponent(t('admin.firmActions.duplicate'))}`);
    throw err;
  }
  // Kur politikası değişikliği denetim kaydında ayrıca görünür (mali ayar)
  const fxBefore = { fxPolicy: firm.fxPolicy, fxMarkupPercent: firm.fxMarkupPercent?.toString() ?? null };
  const fxAfter = data.fxPolicy ? { fxPolicy: data.fxPolicy, fxMarkupPercent: data.fxMarkupPercent ?? null } : fxBefore;
  const mailAfter = data.billingEmail !== undefined ? data.billingEmail : firm.billingEmail;
  await audit('CUSTOMER_UPDATE', 'Customer', id, admin.id, { before: { name: firm.name, prefix: firm.prefix, billingEmail: firm.billingEmail, ...fxBefore }, after: { name: data.name, prefix: data.prefix, billingEmail: mailAfter, ...fxAfter } });
  revalidatePath('/admin/firms');
  redirect(`/admin/firms?saved=${encodeURIComponent(data.name)}`);
}

/**
 * Müşteri firmasını siler (Paket A, karar 221) — CUSTOMER_DELETE (yönetici ve Yönetici Yardımcısı). İki adım: firma sayfası
 * önce etkilenecek kayıtları ve engelleri gösterir (?sil=1), yönetici firma adını elle yazarak onaylar; sunucu adı, önizleme
 * parmak izini ve engelleri kilit altında yeniden denetler. Diskteki dosyalar işlem bittikten sonra ve yalnızca artık hiçbir
 * kaydın göstermediği dosyalarsa silinir.
 */
export async function deleteCustomerAction(formData: FormData) {
  const user = await requirePermission('CUSTOMER_DELETE');
  const id = String(formData.get('id') ?? '');
  const r = await deleteCustomer(db, { customerId: id, confirmName: formData.get('confirm'), fingerprint: formData.get('fp'), actor: await actorOf(user) });
  if (!r.ok) redirect(`/admin/firms/${encodeURIComponent(id)}?sil=1&delError=${encodeURIComponent(r.code)}#firma-sil`);
  const done = r as Extract<typeof r, { ok: true }>;
  const files = await removeOrphanFiles(db, done.storageKeys, removeUpload);
  if (files.failed) console.error('firma silme: diskten kaldırılamayan dosya sayısı', files.failed);
  revalidatePath('/admin/firms');
  redirect(`/admin/firms?deleted=${encodeURIComponent(done.name)}`);
}
