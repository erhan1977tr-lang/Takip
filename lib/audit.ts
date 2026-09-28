import { db } from './db';
import type { Prisma } from '@prisma/client';

// Denetim kaydı hiçbir zaman ana işlemi bozmamalı; hata olursa yalnızca günlüğe yazılır.
export async function audit(
  action: string,
  entityType: string,
  entityId: string | null,
  userId: string | null,
  details?: Prisma.InputJsonValue
): Promise<void> {
  try {
    await db.auditLog.create({ data: { action, entityType, entityId, userId, details } });
  } catch (err) {
    console.error('audit log yazılamadı', action, err);
  }
}
