import type { CurrentUser } from './auth/session';
import { requestIp } from './auth/throttle';

/** İş akışı servisinin beklediği işlemi yapan bilgisi (rol, onay yetkisi, firma, IP). */
export async function actorOf(user: CurrentUser) {
  return {
    id: user.id,
    role: user.appRole as string,
    canApprove: user.canApprove,
    customerId: user.customerId,
    ip: await requestIp(),
  };
}
