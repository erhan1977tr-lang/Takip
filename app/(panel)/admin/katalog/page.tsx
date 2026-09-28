import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';
import { addGlassAction, updateGlassAction } from './actions';

const MSG: Record<string, [string, string]> = {
  added: ['ok', 'Cam kataloğa eklendi.'],
  saved: ['ok', 'Kaydedildi.'],
  empty: ['error', 'Cam adı boş olamaz.'],
  exists: ['error', 'Bu isimde bir cam zaten var.'],
  notfound: ['error', 'Kayıt bulunamadı.'],
};

export default async function CatalogPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireUser(['ADMIN']);
  const sp = await searchParams;
  const items = await db.glassProduct.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
  const msg = MSG[sp.ok ?? sp.error ?? ''];

  return (
    <>
      <div className="page-head">
        <h1>Cam Kataloğu</h1>
        <p className="muted">Müşteri yeni siparişte camını bu listeden seçer; satış teklif tablosunda da aynı adlar önerilir. Pasif camlar yeni siparişte görünmez, eski siparişler etkilenmez.</p>
      </div>
      {msg && <div className={`alert ${msg[0] === 'ok' ? 'alert-ok' : 'alert-error'}`}>{msg[1]}</div>}
      <form action={addGlassAction} className="card row">
        <input name="name" type="text" required maxLength={200} placeholder="örn. 66.3 Temper Lamine Cam (Şeffaf)" aria-label="Cam adı" style={{ flex: 1 }} />
        <button className="btn btn-primary">Kataloğa ekle</button>
      </form>
      <div className="card card-flush">
        <div className="card-head"><h2 style={{ margin: 0 }}>Camlar ({items.length})</h2></div>
        {items.length === 0 ? <div className="empty">Katalog boş. Müşteriler sipariş verebilmek için en az bir cam eklenmeli.</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Sıra</th><th>Cam</th><th>Durum</th><th /></tr></thead>
              <tbody>
                {items.map((g, i) => (
                  <tr key={g.id} style={g.isActive ? undefined : { opacity: 0.55 }}>
                    <td className="muted">{i + 1}</td>
                    <td>
                      <form action={updateGlassAction} className="row">
                        <input type="hidden" name="id" value={g.id} />
                        <input type="hidden" name="intent" value="rename" />
                        <input name="name" type="text" defaultValue={g.name} aria-label="Cam adı" style={{ flex: 1, minWidth: 220 }} />
                        <button className="btn btn-link">Kaydet</button>
                      </form>
                    </td>
                    <td>{g.isActive ? <span className="badge badge-ok">Aktif</span> : <span className="badge badge-muted">Pasif</span>}</td>
                    <td className="actions">
                      <form action={updateGlassAction}>
                        <input type="hidden" name="id" value={g.id} />
                        <button className="btn btn-link" name="intent" value="up" disabled={i === 0} aria-label="Yukarı">↑</button>
                        <button className="btn btn-link" name="intent" value="down" disabled={i === items.length - 1} aria-label="Aşağı">↓</button>
                        <button className="btn btn-link" name="intent" value="toggle">{g.isActive ? 'Pasifleştir' : 'Etkinleştir'}</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
