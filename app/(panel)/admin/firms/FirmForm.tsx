'use client';

import { useActionState, useEffect, useRef } from 'react';
import { createFirmAction, type FirmFormState } from './actions';

export function CreateFirmForm({ groups }: { groups: string[] }) {
  const [state, action, pending] = useActionState<FirmFormState, FormData>(createFirmAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  const v = state.values ?? {};
  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={action} className="card">
      <h2>Yeni firma</h2>
      {state.ok && <div className="alert alert-ok">{state.ok} <a href="/admin/users">Kullanıcı ata →</a></div>}
      <div className="grid">
        <div>
          <label htmlFor="f-name">Firma adı</label>
          <input id="f-name" name="name" type="text" required defaultValue={v.name} />
        </div>
        <div>
          <label htmlFor="f-type">Firma tipi</label>
          <select id="f-type" name="type" defaultValue={v.type ?? 'CUSTOMER'}>
            <option value="CUSTOMER">Müşteri firması</option>
            <option value="FACTORY">Fabrika</option>
          </select>
        </div>
        <div>
          <label htmlFor="f-prefix">Sipariş no ön eki</label>
          <input id="f-prefix" name="prefix" type="text" maxLength={5} placeholder="Boş bırakılırsa addan üretilir" defaultValue={v.prefix} style={{ textTransform: 'uppercase' }} />
          <div className="hint">Örn. MIR → siparişler MIR1, MIR2… olur.</div>
        </div>
        <div>
          <label htmlFor="f-group">Grup</label>
          <input id="f-group" name="groupName" type="text" list="groups" placeholder="Grup yok" defaultValue={v.groupName} />
          <datalist id="groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
        </div>
        <div>
          <label htmlFor="f-cam">Cam etiketi (varsayılan)</label>
          <input id="f-cam" name="camEtiket" type="text" defaultValue={v.camEtiket} />
        </div>
        <div>
          <label htmlFor="f-sandik">Sandık etiketi (varsayılan)</label>
          <input id="f-sandik" name="sandikEtiket" type="text" defaultValue={v.sandikEtiket} />
          <div className="hint">Fiziksel etikete ve nakliye listesine basılır; sipariş bazında değiştirilebilir.</div>
        </div>
      </div>
      {state.error && <div className="alert alert-error" style={{ marginTop: 14 }}>{state.error}</div>}
      <div className="row end" style={{ marginTop: 14 }}>
        <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? 'Kaydediliyor…' : 'Oluştur'}</button>
      </div>
    </form>
  );
}
