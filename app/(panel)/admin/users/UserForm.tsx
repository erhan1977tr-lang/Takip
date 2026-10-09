'use client';

import { useActionState, useEffect, useMemo, useRef, useState } from 'react';
import type { Dict, Locale } from '@/lib/i18n';
import Link from 'next/link';
import { rich } from '@/lib/rich';
import { interpolate } from '@/server/i18n/interpolate.js';
import { createUserAction, type UserFormState } from './actions';

type Firm = { id: string; name: string; type: 'CUSTOMER' | 'FACTORY' };
// Rol adları sözlükte: admin.userForm.roles.<ROL>
const ROLES = ['MUSTERI', 'SATIS', 'CIZIM', 'DENETIMCI', 'YONETICI_YARDIMCISI'] as const;
// Davet e-postasının dili: arayüz dilleri (adları sözlükte lang.<dil>)
const LANGS = ['ro', 'tr'] as const;

export function CreateUserForm({ firms, m, langs, locale }: {
  firms: Firm[];
  m: Dict['admin']['userForm'];
  langs: Dict['lang'];
  /** Yöneticinin arayüz dili; e-posta dilinin varsayılanı */
  locale: Locale;
}) {
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
      <h2>{m.title}</h2>
      {state.ok && <div className="alert alert-ok">{state.ok}</div>}
      {state.warn && <div className="alert alert-warn">{state.warn}</div>}
      <div className="grid">
        <div><label htmlFor="u-email">{m.email}</label><input id="u-email" name="email" type="email" required defaultValue={v.email} /></div>
        <div><label htmlFor="u-name">{m.name}</label><input id="u-name" name="name" type="text" defaultValue={v.name} /></div>
        <div><label htmlFor="u-unit">{m.unit}</label><input id="u-unit" name="unit" type="text" placeholder={m.unitPlaceholder} defaultValue={v.unit} /></div>
        <div><label htmlFor="u-phone">{m.phone}</label><input id="u-phone" name="phone" type="tel" defaultValue={v.phone} /></div>
        <div>
          <label htmlFor="u-firm">{m.firm}</label>
          <select id="u-firm" name="customerId" value={firmId} onChange={(e) => setFirmId(e.target.value)} required>
            <option value="">{m.firmPlaceholder}</option>
            {options.map((f) => (
              <option key={f.id} value={f.id}>{f.type === 'FACTORY' ? interpolate(m.factoryOption, { name: f.name }) : f.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="u-lang">{m.language}</label>
          <select id="u-lang" name="language" defaultValue={v.language ?? locale}>
            {LANGS.map((l) => (
              <option key={l} value={l}>{langs[l]}</option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <label>{m.roleQuestion}</label>
        <div className="chips" role="radiogroup">
          {ROLES.map((r) => (
            <label key={r} className="chip" style={{ margin: 0 }}>
              <input type="radio" name="appRole" value={r} checked={role === r} onChange={() => setRole(r)} required />
              <span>{m.roles[r]}</span>
            </label>
          ))}
        </div>
        {noCustomerFirms && (
          <div className="alert alert-warn" style={{ marginTop: 10 }}>
            {rich(m.noCustomerFirms, { firms: <Link href="/admin/firms">{m.firmsTab}</Link> })}
          </div>
        )}
      </div>

      <div className="row" style={{ marginTop: 18, gap: 24 }}>
        <label className="check" style={{ opacity: role === 'MUSTERI' ? 1 : 0.45 }}>
          <input type="checkbox" name="canApprove" disabled={role !== 'MUSTERI'} defaultChecked={v.canApprove === 'on'} />
          {m.canApprove}
        </label>
        <label className="check">
          <input type="checkbox" name="sendInvite" defaultChecked={state.values ? v.sendInvite === 'on' : true} />
          {m.sendInvite}
        </label>
      </div>

      {state.error && <div className="alert alert-error" style={{ marginTop: 14 }}>{state.error}</div>}
      <div className="row end" style={{ marginTop: 14 }}>
        <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? m.saving : m.create}</button>
      </div>
    </form>
  );
}
