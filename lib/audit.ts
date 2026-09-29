import { db } from './db';
import type { Prisma } from '@prisma/client';
import { requestIp } from './auth/throttle';

// Denetim kaydı hiçbir zaman ana işlemi bozmamalı; hata olursa yalnızca günlüğe yazılır.
// İşlemi yapanın o anki rolü ve IP adresi de yazılır (istek dışında çağrılırsa IP boş kalır).
// İş akışı geçişleri denetimi kendi veritabanı işlemleri içinde yazar (server/orders/journal.js).
export async function audit(
  action: string,
  entityType: string,
  entityId: string | null,
  userId: string | null,
  details?: Prisma.InputJsonValue
): Promise<void> {
  try {
    let ip: string | null = null;
    try {
      ip = await requestIp();
    } catch {
      ip = null;
    }
    const role = userId ? (await db.user.findUnique({ where: { id: userId }, select: { appRole: true } }))?.appRole ?? null : null;
    await db.auditLog.create({ data: { action, entityType, entityId, userId, details, actorRole: role, ip } });
  } catch (err) {
    console.error('audit log yazılamadı', action, err);
  }
}
