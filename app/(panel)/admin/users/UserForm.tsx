'use client';

import { useActionState, useEffect, useMemo, useRef, useState } from 'react';
import { createUserAction, type UserFormState } from './actions';

type Firm = { id: string; name: string; type: 'CUSTOMER' | 'FACTORY' };
const ROLES = [
  { value: 'MUSTERI', label: 'Müşteri' },
  { value: 'SATIS', label: 'Satış' },
  { value: 'CIZIM', label: 'Çizimci' },
];

export function CreateUserForm({ firms }: { firms: Firm[] }) {
  const [state, action, pending] = useActionState<UserFormState, FormData>(createUserAction, {});
  const v = state.values ?? {};
  const [role, setRole] = useState(v.appRole ?? '');
  const [firmId, setFirmId] = useState(v.customerId ?? '');
  const formRef = useRef<HTMLFormElement>(null);

  // Müşteri rolüne yalnızca müşteri firmaları, diğer rollere yalnızca fabrikalar listelenir.
  const options = useMemo(
    () => firms.filter((f) => (!role ? true : role === 'MUSTERI' ? f.type === 'CUSTOMER' : f.type === 'FACTORY')),
    [firms, role]
  );
  useEffect(() => {
    if (firmId && !options.some((f) => f.id === firmId)) setFirmId(options.length === 1 ? options[0].id : '');
    else if (!firmId && options.length === 1) setFirmId(options[0].id);
  }, [options, firmId]);
  useEffect(() => {
    if (state.ok || state.warn) {
      formRef.current?.reset();
      setRole('');
      setFirmId('');
    } else if (state.values) {
      setRole(state.values.appRole ?? '');
      setFirmId(state.values.customerId ?? '');
    }
  }, [state]);

  const noCustomerFirms = role === 'MUSTERI' && options.length === 0;

  return (
    <form ref={formRef} action={action} className="card">
      <h2>Yeni kullanıcı</h2>
      {state.ok && <div className="alert alert-ok">{state.ok}</div>}
      {state.warn && <div className="alert alert-warn">{state.warn}</div>}
      <div className="grid">
        <div><label htmlFor="u-email">E-posta</label><input id="u-email" name="email" type="email" required defaultValue={v.email} /></div>
        <div><label htmlFor="u-name">Ad soyad</label><input id="u-name" name="name" type="text" defaultValue={v.name} /></div>
        <div><label htmlFor="u-unit">Birim etiketi</label><input id="u-unit" name="unit" type="text" placeholder="fabrika satış, fabrika çizim…" defaultValue={v.unit} /></div>
        <div><label htmlFor="u-phone">Telefon</label><input id="u-phone" name="phone" type="tel" defaultValue={v.phone} /></div>
        <div>
          <label htmlFor="u-firm">Firma / fabrika</label>
          <select id="u-firm" name="customerId" value={firmId} onChange={(e) => setFirmId(e.target.value)} required>
            <option value="">— firma seçin —</option>
            {options.map((f) => (
              <option key={f.id} value={f.id}>{f.name}{f.type === 'FACTORY' ? ' (fabrika)' : ''}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="u-lang">E-posta dili</label>
          <select id="u-lang" name="language" defaultValue={v.language ?? 'tr'}>
            <option value="tr">Türkçe</option>
            <option value="ro">Română</option>
            <option value="en">English</option>
          </select>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <label>Bu kişi ne yapacak?</label>
        <div className="chips" role="radiogroup">
          {ROLES.map((r) => (
            <label key={r.value} className="chip" style={{ margin: 0 }}>
              <input type="radio" name="appRole" value={r.value} checked={role === r.value} onChange={() => setRole(r.value)} required />
              <span>{r.label}</span>
            </label>
          ))}
        </div>
        {noCustomerFirms && (
          <div className="alert alert-warn" style={{ marginTop: 10 }}>
            Henüz müşteri firması yok. Önce <a href="/admin/firms">Müşteriler</a> sekmesinde firma oluşturun.
          </div>
        )}
      </div>

      <div className="row" style={{ marginTop: 18, gap: 24 }}>
        <label className="check" style={{ opacity: role === 'MUSTERI' ? 1 : 0.45 }}>
          <input type="checkbox" name="canApprove" disabled={role !== 'MUSTERI'} defaultChecked={v.canApprove === 'on'} />
          Onay yetkisi (müşteri tarafında çizim onaylayabilir)
        </label>
        <label className="check">
          <input type="checkbox" name="sendInvite" defaultChecked={state.values ? v.sendInvite === 'on' : true} />
          Davet e-postası gönder
        </label>
      </div>

      {state.error && <div className="alert alert-error" style={{ marginTop: 14 }}>{state.error}</div>}
      <div className="row end" style={{ marginTop: 14 }}>
        <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? 'Kaydediliyor…' : 'Oluştur'}</button>
      </div>
    </form>
  );
}
