// "Önizle" düğmesi — dosya adının uzantısı önizlenebilir bir aileyse (PDF, JPG / PNG / WEBP, DWG / DXF; karar 283).
// Sunucu bileşenlerinden kullanılır; içerik ve erişim, düğmenin istediği adreste (/dosya/…?onizle=…) yeniden denetlenir.
import { PreviewButton } from './FilePreview';
import { previewFamily } from '@/server/files/preview.js';

export function PreviewFor({ href, name, scanStatus }: { href: string; name: string; scanStatus?: string }) {
  if (scanStatus === 'INFECTED') return null;
  const family = previewFamily(name);
  return family ? <PreviewButton href={href} name={name} family={family} /> : null;
}
