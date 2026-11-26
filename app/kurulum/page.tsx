import type { Metadata } from 'next';
import { getT } from '@/lib/i18n';
import { AuthCard } from '../AuthCard';
import { GUIDE_VIDEO_NAMES } from '@/server/push/guide-video-list.js';

// Telefona kurma rehberi (4.2.33, karar 331): herkese açık, kişisel / sipariş verisi içermez; duyuru e-postası buraya bağlanır.
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'GKH TAKİP' };

export default async function GuidePage() {
  const { m, locale } = await getT();
  const g = m.settings.guide;
  const has = (n: string) => (GUIDE_VIDEO_NAMES as readonly string[]).includes(n);
  const android = `android-${locale}.mp4`;
  const iphone = `iphone-${locale}.mp4`;
  return (
    <AuthCard next="/kurulum">
      <div className="guide" data-guide>
        <h1>{g.title}</h1>
        <p className="muted">{g.intro}</p>
        <h2>{g.android}</h2>
        {has(android) && <p className="muted">{g.video}</p>}
        {has(android) && <video className="guide-video" controls playsInline preload="metadata" src={`/kurulum/video/${android}`} data-guide-video="android" />}
        <ol>
          <li>{g.android1}</li>
          <li>{g.android2}</li>
          <li>{g.android3}</li>
          <li>{g.android4}</li>
        </ol>
        <h2>{g.iphone}</h2>
        <p className="muted">{g.iphoneNote}</p>
        {has(iphone) && <p className="muted">{g.video}</p>}
        {has(iphone) && <video className="guide-video" controls playsInline preload="metadata" src={`/kurulum/video/${iphone}`} data-guide-video="iphone" />}
        <ol>
          <li>{g.ios1}</li>
          <li>{g.ios2}</li>
          <li>{g.ios3}</li>
        </ol>
        <h2>{g.both}</h2>
        <ol>
          <li>{g.end1}</li>
          <li>{g.end2}</li>
          <li>{g.end3}</li>
        </ol>
        <p className="muted">{g.privacy}</p>
        <a className="btn btn-primary btn-block" href="/login">{g.open}</a>
      </div>
    </AuthCard>
  );
}
