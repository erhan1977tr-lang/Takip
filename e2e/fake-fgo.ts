import type { PrismaClient } from '@prisma/client';

// Uçtan uca testlerde SAHTE FGO ile belge kesimi — gerçek FGO / ANAF / BNR'ye hiçbir istek gitmez.
//
// Uçtan uca veritabanında FGO KAPALIDIR ve kapalı kalır: sunucu (Next) hiçbir koşulda FGO'ya gidemez; tarayıcıdan
// "Proforma oluştur" / "Fatura oluştur" FGO_DISABLED ile durur. Kesilmiş belgenin SONRASINI (seçilmeyen sipariş yeniden
// uygun mu, kalan kapsam faturalanabiliyor mu, "fatura bekliyor" uyarısı kalkıyor mu) tarayıcıda sınayabilmek için belge
// burada, TEST SÜRECİNİN İÇİNDE, uygulamanın gerçek servisleriyle (createBatch, createInvoiceBatch, createAdvanceBatch,
// dispatchBatchJobs) ama sahte bir FGO ile kesilir:
//   - FGO ayarı veritabanına YAZILMAZ: servislerin gördüğü veritabanı istemcisi, yalnızca "fgo" ayar satırının okunuşunu
//     sahte (açık) bir ayarla değiştiren bir sarmalayıcıdır. Başka her okuma / yazma gerçek test veritabanına gider.
//   - FGO çağrıları `fetchImpl` olarak verilen sahte işleve düşer (çağrılar `calls`ta toplanır; adres FGO adresi olsa da ağa
//     çıkılmaz). Belge numarası sahte sayaçtan gelir.
//   - `guard`: işlem boyunca test sürecinin global fetch'i kapatılır; servis sahte işlevi atlayıp gerçek ağa gitmeye
//     kalkarsa (FGO, BNR ya da başka bir adres) test başarısız olur.
//   - Belgeyle birlikte kuyruğa yazılan müşteri e-postası işi kapatılır (sonraki testlerde işçi e-posta / PDF denemesin).

export type FgoForm = Record<string, string>;
type AnyObj = Record<string | symbol, unknown>;
type Fn = (...args: unknown[]) => unknown;

const member = (target: AnyObj, prop: string | symbol) => {
  const value = target[prop];
  return typeof value === 'function' ? (value as Fn).bind(target) : value;
};

/** Yalnızca IntegrationSetting 'fgo' okunuşunu `value` ile değiştiren istemci (işlem içindeki `tx` dahil) */
function withFgoSettings<T extends object>(client: T, value: object): T {
  const model = (m: AnyObj) => new Proxy(m, {
    get: (t, p) => (p === 'findUnique'
      ? (args: { where?: { key?: string } }) => (args?.where?.key === 'fgo' ? Promise.resolve({ key: 'fgo', value }) : Reflect.apply(t.findUnique as Fn, t, [args]))
      : member(t, p)),
  });
  const wrap = (c: AnyObj): AnyObj => new Proxy(c, {
    get: (t, p) => {
      if (p === 'integrationSetting') return model(t.integrationSetting as AnyObj);
      if (p === '$transaction') {
        return (arg: unknown, opts?: unknown) => (typeof arg === 'function'
          ? Reflect.apply(t.$transaction as Fn, t, [(tx: AnyObj) => (arg as Fn)(wrap(tx)), opts])
          : Reflect.apply(t.$transaction as Fn, t, [arg, opts]));
      }
      return member(t, p);
    },
  });
  return wrap(client as unknown as AnyObj) as unknown as T;
}

/** İşlem boyunca gerçek ağ isteğini engeller; yapılırsa hata fırlatır (yutulsa bile işlem sonunda test düşer) */
async function guard<R>(fn: () => Promise<R>): Promise<R> {
  const real = globalThis.fetch;
  const leaked: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    leaked.push(String(url));
    throw new Error(`e2e: gerçek ağ isteği yapılmamalı (${String(url).slice(0, 120)})`);
  }) as typeof fetch;
  let result: R;
  try {
    result = await fn();
  } finally {
    globalThis.fetch = real;
  }
  if (leaked.length) throw new Error(`e2e: gerçek ağ isteği yapıldı: ${leaked.join(', ').slice(0, 400)}`);
  return result;
}

/**
 * @param db     gerçek test veritabanı istemcisi
 * @param start  sahte belge numaralarının başlangıcı (başka testlerin numaralarıyla çakışmayan bir aralık)
 */
export async function fakeFgo(db: PrismaClient, start: number) {
  const { getEnv } = await import('../server/env.js');
  const { sealSecret } = await import('../server/crypto/secret.js');
  const { getFgoSettings } = await import('../server/integrations/fgo.js');
  const batchSvc = await import('../server/glass/batch.js');
  const invoiceSvc = await import('../server/glass/invoice-batch.js');
  const receivablesSvc = await import('../server/accounting/receivables.js');
  const secret = getEnv().AUTH_SECRET;
  // Gerçek ayarın seri / TVA değerleri korunur (sayfanın önizlemesiyle aynı hesap); yalnızca "açık + anahtar" sahte
  const real = await getFgoSettings(db);
  const { hasKey: _hasKey, keySealed: _sealed, ...plain } = real;
  const settings = { ...plain, enabled: true, cui: plain.cui || '123456', dailyLimit: 0, invoiceNext: null, keySealed: sealSecret('e2e-sahte-anahtar', secret, 'fgo-key') };
  const client = withFgoSettings(db, settings);

  let n = start;
  const calls: FgoForm[] = [];
  const totals = new Map<string, number>();
  const fetchImpl = (async (url: unknown, init?: { body?: unknown }) => {
    const form: FgoForm = Object.fromEntries(new URLSearchParams(init?.body as string));
    if (String(url).endsWith('/factura/getstatus')) {
      const total = totals.get(`${form.Serie}${form.Numar}`) ?? 0;
      return new Response(JSON.stringify({ Success: true, Factura: { Valoare: total.toFixed(2), ValoareAchitata: '0.00' } }));
    }
    calls.push(form);
    n += 1;
    let total = 0;
    for (let i = 0; form[`Continut[${i}][Denumire]`] != null; i++) {
      const qty = Number(form[`Continut[${i}][NrProduse]`]);
      total += form[`Continut[${i}][PretTotal]`] != null ? Number(form[`Continut[${i}][PretTotal]`]) : Math.round(qty * Number(form[`Continut[${i}][PretUnitar]`]) * (100 + Number(plain.vatRate))) / 100;
    }
    totals.set(`${form.Serie}${n}`, Math.round(total * 100) / 100);
    return new Response(JSON.stringify({ Success: true, Factura: { Numar: String(n), Serie: form.Serie, Link: `https://fgo.example/${form.Serie}${n}.pdf` } }));
  }) as typeof fetch;
  const never = async () => { throw new Error('e2e: BNR çağrılmamalıydı'); };

  /** Kuyruktaki partiyi sahte FGO ile keser; belge kaydını döner (müşteri e-postası işi kapatılır) */
  async function issue(batchId: string) {
    const r = await guard(() => batchSvc.dispatchBatchJobs(client, { fetchImpl, onlyBatchId: batchId, sleep: async () => {} }));
    if (r.done !== 1) throw new Error(`e2e: parti kesilemedi (${JSON.stringify(r)})`);
    const doc = await db.fgoDocument.findUniqueOrThrow({ where: { batchId } });
    await db.notificationOutbox.updateMany({
      where: { type: 'FGO_DOC_EMAIL', status: 'PENDING', payload: { path: ['docId'], equals: doc.id } },
      data: { status: 'SKIPPED', lastError: 'e2e', inAppAt: new Date() },
    });
    return doc;
  }

  // "TAKİP'ten kaldır" (karar 132): FGO'ya giden durum sorguları (yöntem + uç + belge no) — silme isteği olmadığı buradan sınanır
  const statusCalls: string[] = [];
  const statusFetch = (answer: 'gone' | 'exists' | 'down' | 'auth') => (async (url: unknown, init?: { method?: string; body?: unknown }) => {
    const form: FgoForm = Object.fromEntries(new URLSearchParams(init?.body as string));
    statusCalls.push(`${init?.method} ${String(url).split('/v1')[1]} ${form.Serie}${form.Numar}`);
    if (answer === 'down') throw new Error('ETIMEDOUT');
    if (answer === 'auth') return new Response(JSON.stringify({ Success: false, Message: 'Hash invalid' }));
    if (answer === 'gone') return new Response(JSON.stringify({ Success: false, Message: 'Factura nu exista' }));
    return new Response(JSON.stringify({ Success: true, Factura: { Valoare: '300.00', ValoareAchitata: '0.00' } }));
  }) as typeof fetch;

  return {
    calls,
    statusCalls,
    issue,
    /**
     * Yöneticinin "TAKİP'ten kaldır" işlemi, uygulamanın gerçek servisiyle (removeDocumentDeletedInFgo → mevcut temizlik
     * yolu) ama FGO'nun durum yanıtı sahte: gone = "Factura nu exista", exists = belge duruyor, down = zaman aşımı,
     * auth = kimlik hatası. Gerçek FGO'ya istek gitmez.
     */
    removeDeleted: (o: { docId: string; actor: object; answer: 'gone' | 'exists' | 'down' | 'auth' }) =>
      guard(() => receivablesSvc.removeDocumentDeletedInFgo(client, { docId: o.docId, actor: o.actor, secret, fetchImpl: statusFetch(o.answer) })),
    /** Satır adları (Continut[n][Denumire]) */
    names: (form: FgoForm) => Object.keys(form).filter((k) => /^Continut\[\d+\]\[Denumire\]$/.test(k)).map((k) => form[k]),
    /** Müşteri proforması partisi: sayfanın önizleme anahtarı ve seçilen siparişlerle (gerçek servis; FGO'ya gitmez) */
    createProforma: (o: { customerId: string; days: string[]; orderIds: string[] | null; key: string; actor: object }) =>
      guard(() => batchSvc.createBatch(client, { ...o, bnrImpl: never })),
    /** Onaylı yüklemeden fatura partisi: sayfanın grup / önizleme anahtarı ve seçilen siparişlerle */
    createInvoice: (o: { day: string; groupKey: string; previewKey: string; orderIds: string[] | null; actor: object }) =>
      guard(() => invoiceSvc.createInvoiceBatch(client, { ...o, bnrImpl: never })),
    /** Müşteri proformasına gelen tahsilatın avans faturası partisi */
    createAdvance: (o: { proformaBatchId: string; actor: object }) => guard(() => invoiceSvc.createAdvanceBatch(client, o)),
  };
}
