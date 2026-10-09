/**
 * Aynı müşteride aynı tutar (Paket 10, karar 208): eşleşen kayıtlar + zorunlu onay kutusu. Kutu formun içinde durur; işaretlenince
 * "ack" alanı eşleşmelerin onay anahtarını taşır — sunucu anahtarı yeniden hesaplar, eşleşmeler değiştiyse onay geçmez.
 * Kanca yok: sunucu ve istemci bileşenleri aynı kutuyu kullanır. Satırlar sunucuda biçimlenir (lib/finance.ts → matchLines).
 */
export function DuplicateAck({ lines, ackKey, texts, id }: { lines: string[]; ackKey: string; texts: { title: string; lead: string; ack: string }; id?: string }) {
  if (!lines.length || !ackKey) return null;
  return (
    <div className="alert alert-warn dup-risk" data-duplicate-risk>
      <b>{texts.title}</b>
      <p className="small" style={{ margin: '4px 0' }}>{texts.lead}</p>
      <ul className="plain-list small" data-duplicate-lines>
        {lines.map((l, i) => <li key={i}>{l}</li>)}
      </ul>
      <label className="check small" style={{ marginTop: 6 }}>
        <input id={id} type="checkbox" name="ack" value={ackKey} required data-duplicate-ack /> {texts.ack}
      </label>
    </div>
  );
}
