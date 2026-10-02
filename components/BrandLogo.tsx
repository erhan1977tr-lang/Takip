import logo from '@/assets/brand/gkh-digital-logo.png';
import mark from '@/assets/brand/gkh-mark.png';
import { APP_VERSION } from '@/lib/version';
import { getT } from '@/lib/i18n';
import { getEnv } from '@/lib/env';

/** Uygulama sürümü rozeti (package.json'daki sürüm; üzerine gelince derleme kimliği). Sürüm başka yere yazılmaz. */
export async function VersionTag() {
  const { t } = await getT();
  const sha: string = getEnv().GIT_SHA || '';
  const title = t('common.version', { v: APP_VERSION }) + (sha ? ` · ${sha.slice(0, 7)}` : '');
  return <span className="version" title={title}>v{APP_VERSION}</span>;
}

/**
 * GKH Digital logosu ve altında uygulama sürümü. compact: yalnızca GKH işareti (dar ekranlar için).
 * version: false → sürüm rozeti yazılmaz (sol menüde rozet başlık satırındadır).
 */
export async function BrandLogo({ compact = false, width, version = true }: { compact?: boolean; width?: number; version?: boolean }) {
  const img = compact ? mark : logo;
  const w = width ?? (compact ? 64 : 176);
  return (
    <div className={`brand-logo${compact ? ' compact' : ''}`}>
      {/* Statik dosya: .next/static altında, sürüm değişince adı da değişir */}
      <img src={img.src} width={w} height={Math.round((img.height / img.width) * w)} alt="GKH Digital" />
      {version && <VersionTag />}
    </div>
  );
}
