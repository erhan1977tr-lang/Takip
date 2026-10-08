import type { T, MsgKey } from './i18n';

/**
 * Yükleme yolunun sorunu (lib/uploads.ts → storeFiles: içerik, virüs, tarayıcı, sınırlar) → teslimat fotoğrafı hata metni
 * (Paket 8, karar 195). Sınır kodları (istek / sipariş / kullanıcı kotası, disk) tek bir "sınır doldu" metnine iner.
 */
export function photoUploadError(t: T, code: string): string {
  const own = ['empty', 'mismatch', 'infected', 'av_unavailable', 'size'];
  if (own.includes(code)) return t(`delivery.photos.errors.${code}` as MsgKey);
  if (['too_many', 'rate', 'order_quota', 'disk'].includes(code)) return t('delivery.photos.errors.limit');
  return t('delivery.photos.errors.other');
}
