import fs from 'node:fs/promises';
import path from 'node:path';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { fmtDateTime } from '@/lib/format';
import { isDemo } from '@/server/demo/accounts.js';

// Demo ortamında e-postalar gönderilmez, MAIL_OUTBOX_DIR klasörüne yazılır. Bu sayfa onları gösterir
// (yeni kullanıcıya giden doğrulama kodu dahil). Yalnızca DEMO_MODE=1 iken ve yöneticiye açıktır.
export const dynamic = 'force-dynamic';

type Mail = { file: string; to: string; subject: string; text: string; at: Date; code: string | null };

async function readOutbox(dir: string): Promise<Mail[]> {
  let files: string[] = [];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, 50);
  } catch {
    return [];
  }
  const mails: Mail[] = [];
  for (const file of files) {
    try {
      const m = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
      const text = String(m.text ?? '');
      mails.push({
        file, to: String(m.to ?? ''), subject: String(m.subject ?? ''), text,
        at: new Date(Number(file.split('-')[0]) || 0), code: /\b(\d{6})\b/.exec(text)?.[1] ?? null,
      });
    } catch {
      // bozuk dosya: atla
    }
  }
  return mails;
}

export default async function DemoMailPage() {
  const dir = process.env.MAIL_OUTBOX_DIR;
  if (!isDemo() || !dir) notFound();
  await requireUser(['ADMIN']);
  const mails = await readOutbox(dir);

  return (
    <>
      <div className="page-head">
        <h1>Demo posta kutusu</h1>
        <p className="muted">
          Demo ortamında e-posta gönderilmez; kullanıcılara gidecek davet e-postaları burada görünür.
          Yeni bir kullanıcı oluşturduğunuzda doğrulama kodunu buradan alıp o kullanıcıyla ilk girişi deneyebilirsiniz.
        </p>
      </div>
      {mails.length === 0 && <div className="card"><p className="muted">Henüz e-posta yok. Kullanıcılar sayfasından yeni bir kullanıcı oluşturun.</p></div>}
      {mails.map((m) => (
        <div key={m.file} className="card mail">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <b>{m.to}</b>
              <div className="muted small">{m.subject} · {fmtDateTime(m.at)}</div>
            </div>
            {m.code && <span className="badge badge-warn">Kod: <span className="code mono">{m.code}</span></span>}
          </div>
          <details style={{ marginTop: 8 }}>
            <summary className="small muted" style={{ cursor: 'pointer' }}>E-postanın metni</summary>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13, marginTop: 8 }}>{m.text}</pre>
          </details>
        </div>
      ))}
    </>
  );
}
