'use client';
// Nakliye formunun canlı toplamı (4.2.19, karar 319): ürün tutarlarının toplamı = fatura tutarı. Yalnızca gösterim — kayıtta
// toplam sunucuda aynı kuralla (server/suppliers/stock-cost.js → parseTransportLines) yeniden hesaplanır.
import { useEffect, useRef, useState } from 'react';
import { money, toScaled } from '@/server/suppliers/money.js';

export function TransportTotal({ label }: { label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState({ total: '0.00', currency: 'EUR', bad: false });
  useEffect(() => {
    const form = ref.current?.closest('form');
    if (!form) return undefined;
    const calc = () => {
      let sum = 0n;
      let bad = false;
      form.querySelectorAll<HTMLInputElement>('input[data-tr-amount]').forEach((i) => {
        const v = i.value.trim().replace(',', '.');
        if (!v || i.disabled) return;
        const c = toScaled(v, 2);
        if (c == null) bad = true;
        else sum += c;
      });
      const cur = form.querySelector<HTMLSelectElement>('select[name="currency"]')?.value ?? 'EUR';
      setState({ total: money(sum), currency: cur, bad });
    };
    calc();
    form.addEventListener('input', calc);
    form.addEventListener('change', calc);
    return () => {
      form.removeEventListener('input', calc);
      form.removeEventListener('change', calc);
    };
  }, []);
  return (
    <div ref={ref} className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }} data-transport-total={state.total}>
      <span className="muted">{label}:</span> <b className={state.bad ? 'text-danger' : undefined}>{state.bad ? '—' : `${state.total} ${state.currency}`}</b>
    </div>
  );
}
