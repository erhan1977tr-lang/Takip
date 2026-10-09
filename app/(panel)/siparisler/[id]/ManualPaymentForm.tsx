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
export function ManualPaymentForm({ orderId, requestKey, today, currencies, rate, m }: {
  orderId: string; requestKey: string; today: string; currencies: string[]; rate: string | null; m: Dict['finance'];
}) {
  const [state, action, pending] = useActionState<PaymentFormState, FormData>(recordPaymentAction, { ok: false });
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
      className="fx-block" id="odeme-kaydet" data-payment-form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => action(fd));
      }}
    >
      <h3>{m.form.title}</h3>
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="requestKey" value={key} />
      {state.ok && <div className="alert alert-ok" data-payment-ok>{m.form.ok}</div>}
      {!state.ok && state.error && <div className="alert alert-error" data-payment-error>{state.error}</div>}
      <div className="grid">
        <div>
          <label htmlFor="mp-date">{m.form.paidOn}</label>
          <input id="mp-date" name="paidOn" type="date" required max={today} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </div>
        <div>
          <label htmlFor="mp-amount">{m.form.amount}</label>
          <input id="mp-amount" name="amount" inputMode="decimal" required maxLength={16} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div>
          <label htmlFor="mp-currency">{m.form.currency}</label>
          <select id="mp-currency" name="currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="mp-method">{m.form.method}</label>
          <select id="mp-method" name="method" value={method} onChange={(e) => setMethod(e.target.value)}>
            {METHODS.map((x) => <option key={x} value={x}>{m.methods[x]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="mp-ref">{m.form.reference}</label>
          <input id="mp-ref" name="reference" maxLength={120} value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
        <div>
          <label htmlFor="mp-note">{m.form.note}</label>
          <input id="mp-note" name="note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <p className="hint">{rate ? interpolate(m.form.hint, { rate }) : m.form.hintRon}</p>
      {showMatches && <DuplicateAck lines={state.matches ?? []} ackKey={state.ackKey ?? ''} texts={{ title: m.dup.title, lead: m.dup.lead, ack: m.dup.ack }} id="mp-ack" />}
      <div className="row end" style={{ marginTop: 10 }}>
        <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? m.form.saving : m.form.submit}</button>
      </div>
    </form>
  );
}
