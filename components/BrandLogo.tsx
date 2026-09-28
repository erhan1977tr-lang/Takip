import logo from '@/assets/brand/gkh-digital-logo.png';
import mark from '@/assets/brand/gkh-mark.png';
import { APP_VERSION } from '@/lib/version';

/** GKH Digital logosu ve altında uygulama sürümü. compact: yalnızca GKH işareti (dar ekranlar için). */
export function BrandLogo({ compact = false, width }: { compact?: boolean; width?: number }) {
  const img = compact ? mark : logo;
  const w = width ?? (compact ? 64 : 176);
  return (
    <div className={`brand-logo${compact ? ' compact' : ''}`}>
      {/* Statik dosya: .next/static altında, sürüm değişince adı da değişir */}
      <img src={img.src} width={w} height={Math.round((img.height / img.width) * w)} alt="GKH Digital" />
      <span className="version" title={`Takip sürüm ${APP_VERSION}`}>v{APP_VERSION}</span>
    </div>
  );
}
