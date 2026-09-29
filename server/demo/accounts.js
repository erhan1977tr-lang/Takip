// Demo ortamının (DEMO_MODE=1) örnek hesapları. Şifre her ortamda rastgele üretilir ve DEMO-GIRIS.txt'ye yazılır.
import { getEnv } from '../env.js';
export const DEMO_FIRM = { name: 'Örnek Cam SRL', prefix: 'ORN', camEtiket: 'ORN-CAM', sandikEtiket: 'ORN-SANDIK' };

export const DEMO_ACCOUNTS = [
  { email: 'yonetici@ornek.test', name: 'Deniz Yönetici', role: 'ADMIN', label: 'Sistem yöneticisi' },
  { email: 'satis@ornek.test', name: 'Selin Satış', role: 'SATIS', label: 'Satış', unit: 'fabrika satış' },
  { email: 'cizim@ornek.test', name: 'Can Çizim', role: 'CIZIM', label: 'Çizimci', unit: 'fabrika çizim' },
  { email: 'musteri@ornek.test', name: 'Mert Müşteri', role: 'MUSTERI', label: 'Müşteri', canApprove: true },
  { email: 'denetim@ornek.test', name: 'Dilek Denetim', role: 'DENETIMCI', label: 'Denetimci', unit: 'kalite' },
];

export function isDemo() {
  return getEnv().DEMO_MODE === true;
}
