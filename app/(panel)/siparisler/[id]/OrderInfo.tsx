// Sipariş bilgileri: teklifin hemen üstünde, yatay ve sıkışık (eski GKH TAKIP düzeni). Cam ve profil siparişi ortak.
// Değerler sayfada hazırlanır; firma adı zaten sunucuda maskelenmiş gelir (lib/orders.ts → customerLabel).
export type InfoRow = { label: string; value: React.ReactNode; mono?: boolean };

export function OrderInfo({ title, rows, children }: { title: string; rows: (InfoRow | false | null | undefined)[]; children?: React.ReactNode }) {
  const shown = rows.filter((r): r is InfoRow => !!r);
  return (
    <div className="card" id="bilgiler">
      <h2>{title}</h2>
      <dl className="order-info">
        {shown.map((r) => (
          <div key={r.label}>
            <dt>{r.label}</dt>
            <dd className={r.mono ? 'mono' : undefined}>{r.value}</dd>
          </div>
        ))}
      </dl>
      {children}
    </div>
  );
}
