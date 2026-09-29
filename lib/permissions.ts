// Yetki kontrolü (server/auth/permissions.js matrisinin TypeScript yüzü).
import { can, PERMISSIONS } from '../server/auth/permissions.js';

export type Permission = keyof typeof PERMISSIONS;

export function userCan(user: { appRole: string } | null | undefined, permission: Permission): boolean {
  return can(user?.appRole, permission);
}
