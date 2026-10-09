'use client';

import { useActionState, useEffect, useRef } from 'react';
import Link from 'next/link';
import type { Dict } from '@/lib/i18n';
import { createFirmAction, type FirmFormState } from './actions';

export function CreateFirmForm({ groups, m, canUsers }: { groups: string[]; m: Dict['admin']['firmForm']; canUsers: boolean }) {
  const [state, action, pending] = useActionState<FirmFormState, FormData>(createFirmAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  const v = state.values ?? {};
  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={action} className="card">
      <h2>{m.title}</h2>
      {state.ok && <div className="alert alert-ok">{state.ok} {canUsers && <Link href="/admin/users">{m.assignUsers}</Link>}</div>}
      <div className="grid">
        <div>
          <label htmlFor="f-name">{m.name}</label>
          <input id="f-name" name="name" type="text" required defaultValue={v.name} />
        </div>
        <div>
          <label htmlFor="f-type">{m.type}</label>
          <select id="f-type" name="type" defaultValue={v.type ?? 'CUSTOMER'}>
            <option value="CUSTOMER">{m.typeCustomer}</option>
            <option value="FACTORY">{m.typeFactory}</option>
          </select>
        </div>
        <div>
          <label htmlFor="f-prefix">{m.prefix}</label>
          <input id="f-prefix" name="prefix" type="text" maxLength={3} pattern="[A-Za-z]{3}" placeholder={m.prefixPlaceholder} defaultValue={v.prefix} style={{ textTransform: 'uppercase' }} />
          <div className="hint">{m.prefixHint}</div>
        </div>
        <div>
          <label htmlFor="f-group">{m.group}</label>
          <input id="f-group" name="groupName" type="text" list="groups" placeholder={m.groupPlaceholder} defaultValue={v.groupName} />
          <datalist id="groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
        </div>
        <div>
          <label htmlFor="f-cam">{m.camEtiket}</label>
          <input id="f-cam" name="camEtiket" type="text" defaultValue={v.camEtiket} />
        </div>
        <div>
          <label htmlFor="f-sandik">{m.sandikEtiket}</label>
          <input id="f-sandik" name="sandikEtiket" type="text" defaultValue={v.sandikEtiket} />
          <div className="hint">{m.sandikHint}</div>
        </div>
      </div>
      {state.error && <div className="alert alert-error" style={{ marginTop: 14 }}>{state.error}</div>}
      <div className="row end" style={{ marginTop: 14 }}>
        <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? m.saving : m.create}</button>
      </div>
    </form>
  );
}
