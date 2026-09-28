'use server';

import { redirect } from 'next/navigation';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';
import { audit } from '@/lib/audit';
import { filesFrom, removeUpload, saveUpload, type StoredFile } from '@/lib/storage';
import { fileProblem, nextShipDate, slaDeadlineFor } from '@/server/orders/rules.js';

export type NewOrderState = { error?: string; values?: { title: string; no: string; glasses: { id: string; qty: string }[] } };

export async function createOrderAction(_prev: NewOrderState, formData: FormData): Promise<NewOrderState> {
  const user = await requireUser(['MUSTERI']);
  const firm = user.customer;
  const title = String(formData.get('title') ?? '').trim().slice(0, 160);
  const noRaw = String(formData.get('customerOrderNo') ?? '').trim();
  const glassIds = formData.getAll('glassId').map(String);
  const glassQty = formData.getAll('glassQty').map(String);
  const glasses = glassIds.map((id, i) => ({ id, qty: glassQty[i] ?? '1' })).filter((g) => g.id);
  const values = { title, no: noRaw, glasses };
  const fail = (error: string) => ({ error, values });

  if (!firm || firm.type !== 'CUSTOMER' || !firm.prefix) return fail('Hesabınız bir müşteri firmasına bağlı değil. Yöneticinize başvurun.');
  if (!title) return fail('Sipariş adı gerekli.');
  const no = Number(noRaw);
  if (!Number.isInteger(no) || no <= 0 || no > 9_999_999) return fail('Sipariş numarası pozitif bir tam sayı olmalı.');

  const files = filesFrom(formData, 'files');
  if (files.length === 0) return fail('En az bir sipariş dosyası yükleyin.');
  if (files.length > 20) return fail('Tek seferde en fazla 20 dosya yükleyebilirsiniz.');
  for (const f of files) {
    const p = fileProblem(f.name, f.size);
    if (p) return fail(p);
  }

  if (glasses.length === 0) return fail('En az bir cam kombinasyonu seçin.');
  const catalog = await db.glassProduct.findMany({ where: { id: { in: glasses.map((g) => g.id) }, isActive: true } });
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const items: { glassName: string; camAdedi: number }[] = [];
  for (const g of glasses) {
    const product = byId.get(g.id);
    const qty = Number(g.qty);
    if (!product) return fail('Seçilen camlardan biri artık katalogda yok; sayfayı yenileyip tekrar seçin.');
    if (!Number.isInteger(qty) || qty <= 0 || qty > 100_000) return fail('Cam adedi pozitif bir tam sayı olmalı.');
    items.push({ glassName: product.name, camAdedi: qty });
  }

  const orderNo = `${firm.prefix}${no}`;
  if (await db.order.findFirst({ where: { OR: [{ orderNo }, { customerId: firm.id, customerOrderNo: no }] } })) {
    return fail(`${orderNo} numaralı bir sipariş zaten var; farklı bir numara girin.`);
  }

  // Önce dosyalar diske yazılır; veritabanı kaydı başarısız olursa geri silinir.
  const stored: StoredFile[] = [];
  let orderId: string;
  try {
    for (const f of files) stored.push(await saveUpload(f));
    const order = await db.$transaction(async (tx) => {
      const o = await tx.order.create({
        data: {
          orderNo, customerOrderNo: no, title, customerId: firm.id, createdById: user.id,
          status: 'YENI', slaDeadline: slaDeadlineFor('YENI'), estimatedShipDate: nextShipDate(),
          camEtiket: firm.camEtiket, sandikEtiket: firm.sandikEtiket,
          items: { create: items },
          files: { create: stored.map((s) => ({ ...s, kind: 'CUSTOMER' as const, uploadedById: user.id })) },
        },
      });
      await tx.orderStatusHistory.create({ data: { orderId: o.id, fromStatus: null, toStatus: 'YENI', note: 'Sipariş gönderildi', changedById: user.id } });
      return o;
    });
    orderId = order.id;
  } catch (err) {
    await Promise.all(stored.map((s) => removeUpload(s.storageKey)));
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return fail(`${orderNo} numaralı bir sipariş zaten var; farklı bir numara girin.`);
    }
    console.error('Sipariş oluşturulamadı', err);
    return fail('Sipariş kaydedilemedi, lütfen tekrar deneyin.');
  }
  await audit('ORDER_CREATE', 'Order', orderId, user.id, { orderNo, files: stored.length });
  redirect(`/siparisler/${orderId}?ok=created`);
}
