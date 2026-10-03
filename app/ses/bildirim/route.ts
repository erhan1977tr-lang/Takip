import { NOTIFICATION_WAV_BASE64 } from '@/server/notifications/sound.js';

// Bildirim sesi: uygulamanın kendi varlığı (dış kaynak yok). İçerik sabittir → tarayıcı önbelleğe alır.
const bytes = Buffer.from(NOTIFICATION_WAV_BASE64, 'base64');

export function GET() {
  return new Response(new Uint8Array(bytes), {
    headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(bytes.length), 'Cache-Control': 'public, max-age=604800, immutable' },
  });
}
