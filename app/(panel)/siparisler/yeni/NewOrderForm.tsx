'use client';

import { useActionState, useState } from 'react';
import { createOrderAction, type NewOrderState } from './actions';

type Glass = { id: string; name: string };
const ACCEPT = '.pdf,.dwg,.dxf,.step,.stp,.igs,.iges,.xls,.xlsx,.doc,.docx,.zip,.jpg,.jpeg,.png';

export function NewOrderForm({ catalog, suggestedNo, prefix, shipDate }: { catalog: Glass[]; suggestedNo: number; prefix: string; shipDate: string }) {
  const [state, action, pending] = useActionState<NewOrderState, FormData>(createOrderAction, {});
  const v = state.values;
  const [rows, setRows] = useState<{ key: number; id: string; qty: string }[]>(
    () => (v?.glasses.length ? v.glasses : [{ id: '', qty: '1' }]).map((g, i) => ({ key: i, ...g }))
  );
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [no, setNo] = useState(v?.no ?? String(suggestedNo));
  const ready = fileNames.length > 0 && rows.some((r) => r.id);

  return (
    <form action={action}>
      <div className="card">
        <h2>Sipariş bilgileri</h2>
        <p className="muted small">Siparişler haftalık yüklenir. Bu siparişin tahmini yükleme tarihi <b>{shipDate}</b> olarak yazılacak; satış ekibi gerekirse günceller.</p>
        <div className="grid-2" style={{ marginTop: 12 }}>
          <div>
            <label htmlFor="title">Sipariş adı</label>
            <input id="title" name="title" type="text" required maxLength={160} placeholder="örn. Duş kabini camı" defaultValue={v?.title} />
          </div>
          <div>
            <label htmlFor="no">Sipariş numaranız</label>
            <input id="no" name="customerOrderNo" type="text" inputMode="numeric" required value={no} onChange={(e) => setNo(e.target.value.replace(/\D/g, ''))} />
            <div className="hint">Önerilen numara (son siparişinizden bir sonraki) — değiştirebilirsiniz. Sipariş kodu: <b>{prefix}{no || '…'}</b></div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Sipariş dosyaları (zorunlu)</h2>
        <label htmlFor="files" className="dropzone">
          <input id="files" name="files" type="file" multiple accept={ACCEPT} required onChange={(e) => setFileNames(Array.from(e.target.files ?? []).map((f) => f.name))} />
          <b>{fileNames.length ? `${fileNames.length} dosya seçildi` : 'Dosya seçmek için tıklayın'}</b>
          <span className="muted small">PDF · DWG · DXF · STEP · STP · IGS · IGES · XLS · XLSX · DOC · DOCX · ZIP · JPG · PNG — dosya başına en fazla 100 MB, toplam 250 MB</span>
          {fileNames.length > 0 && <span className="small mono">{fileNames.join(', ')}</span>}
        </label>
      </div>

      <div className="card">
        <h2>İstediğiniz cam kombinasyonu (zorunlu)</h2>
        <p className="muted small">Hangi camı istediğinizi katalogdan seçin. Ölçüleri ve fiyatı satış ekibi girecek.</p>
        {catalog.length === 0 && <div className="alert alert-warn">Cam kataloğu henüz boş. Lütfen yöneticinize başvurun.</div>}
        {rows.map((r) => (
          <div className="glass-row" key={r.key}>
            <select name="glassId" aria-label="Cam" value={r.id} required onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, id: e.target.value } : x)))}>
              <option value="">— katalogdan seçin —</option>
              {catalog.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input name="glassQty" aria-label="Adet" type="number" min={1} step={1} value={r.qty} onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, qty: e.target.value } : x)))} />
            {rows.length > 1 && <button type="button" className="btn btn-link danger" aria-label="Kaldır" onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>✕</button>}
          </div>
        ))}
        <button type="button" className="btn" onClick={() => setRows([...rows, { key: Date.now(), id: '', qty: '1' }])}>+ Cam ekle</button>
      </div>

      {state.error && <div className="alert alert-error">{state.error}</div>}
      <div className="card row" style={{ justifyContent: 'space-between' }}>
        <span className="muted small">
          {!fileNames.length && 'Göndermek için en az bir dosya yüklemelisiniz. '}
          {!rows.some((r) => r.id) && 'Cam kombinasyonu seçmelisiniz.'}
        </span>
        <button type="submit" className="btn btn-primary" disabled={pending || !ready}>{pending ? 'Gönderiliyor…' : 'Siparişi gönder'}</button>
      </div>
    </form>
  );
}
