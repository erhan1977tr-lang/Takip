'use client';

import { startTransition, useActionState, useEffect, useState } from 'react';
import type { Dict } from '@/lib/i18n';
import { interpolate } from '@/server/i18n/interpolate.js';
import { DuplicateAck } from '@/components/DuplicateAck';
import { recordPaymentAction, type PaymentFormState } from './finance-actions';

const METHODS = ['BANK_TRANSFER', 'CASH', 'CARD', 'OTHER'] as const;

/** Formun tek kullanımlık anahtarı (çift gönderim tek kayıt yazar); başarıdan sonra yenisi üretilir */
function newKey(): string {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Elle ödeme kaydı (Paket 10, karar 206; yalnızca yönetici). Belge kesmez — avans faturası ayrıca istenir. Alanlar
 * denetimlidir ve form onSubmit ile gönderilir (React'in işlem sonrası otomatik sıfırlaması yok: hata sonrası girilen
 * değerler kalır, başarıda alanlar burada temizlenir). Aynı müşteride aynı tutar varsa sunucu eşleşmeleri döndürür; yönetici
 * kutuyu işaretleyip yeniden gönderir (onay anahtarı sunucuda yeniden hesaplanır).
 */
export function ManualPaymentForm({ orderId, requestKey, today, currencies, rate, m, submit, batchId, idPrefix = 'mp' }: {
  orderId?: string; requestKey: string; today: string; currencies: string[]; rate: string | null; m: Dict['finance'];
  /** Toplu proforma satırı (karar 326): kendi işlemi + parti kimliği; aynı sayfada birden çok form → alan kimliği öneki */
  submit?: (prev: PaymentFormState, fd: FormData) => Promise<PaymentFormState>; batchId?: string; idPrefix?: string;
}) {
  const [state, action, pending] = useActionState<PaymentFormState, FormData>(submit ?? recordPaymentAction, { ok: false });
  const [key, setKey] = useState(requestKey);
  const [paidOn, setPaidOn] = useState(today);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(currencies[0] ?? 'RON');
  const [method, setMethod] = useState<string>('BANK_TRANSFER');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    if (!state.ok || !state.at) return;
    // Kaydedildi: alanlar temizlenir, yeni ödeme için yeni anahtar
    setAmount('');
    setReference('');
    setNote('');
    setKey(newKey());
  }, [state.ok, state.at]);
  const showMatches = !state.ok && !!state.ackKey && (state.matches?.length ?? 0) > 0;
  return (
    <form
      className="fx-block" id={idPrefix === 'mp' ? 'odeme-kaydet' : `odeme-kaydet-${idPrefix}`} data-payment-form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => action(fd));
      }}
    >
      <h3>{m.form.title}</h3>
      {orderId && <input type="hidden" name="orderId" value={orderId} />}
      {batchId && <input type="hidden" name="batchId" value={batchId} />}
      <input type="hidden" name="requestKey" value={key} />
      {state.ok && <div className="alert alert-ok" data-payment-ok>{m.form.ok}</div>}
      {!state.ok && state.error && <div className="alert alert-error" data-payment-error>{state.error}</div>}
      <div className="grid">
        <div>
          <label htmlFor={`${idPrefix}-date`}>{m.form.paidOn}</label>
          <input id={`${idPrefix}-date`} name="paidOn" type="date" required max={today} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-amount`}>{m.form.amount}</label>
          <input id={`${idPrefix}-amount`} name="amount" inputMode="decimal" required maxLength={16} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-currency`}>{m.form.currency}</label>
          <select id={`${idPrefix}-currency`} name="currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${idPrefix}-method`}>{m.form.method}</label>
          <select id={`${idPrefix}-method`} name="method" value={method} onChange={(e) => setMethod(e.target.value)}>
            {METHODS.map((x) => <option key={x} value={x}>{m.methods[x]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${idPrefix}-ref`}>{m.form.reference}</label>
          <input id={`${idPrefix}-ref`} name="reference" maxLength={120} value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-note`}>{m.form.note}</label>
          <input id={`${idPrefix}-note`} name="note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <p className="hint">{rate ? interpolate(m.form.hint, { rate }) : m.form.hintRon}</p>
      {showMatches && <DuplicateAck lines={state.matches ?? []} ackKey={state.ackKey ?? ''} texts={{ title: m.dup.title, lead: m.dup.lead, ack: m.dup.ack }} id={`${idPrefix}-ack`} />}
      <div className="row end" style={{ marginTop: 10 }}>
        <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? m.form.saving : m.form.submit}</button>
      </div>
    </form>
  );
}
