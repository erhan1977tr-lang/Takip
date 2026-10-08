import { ConfirmButton } from '@/components/ConfirmButton';
import type { T } from '@/lib/i18n';
import { dwgFaultyAction, dwgReadyAction, dwgUpdateAction } from './actions';

/**
 * Müşterinin DWG/DXF çizimi için çizimcinin üç AYRI kararı (karar 167) — sipariş sayfası (DwgPanel) ve "DXF/DWG olarak
 * gelen çizimler" listesi aynı bileşeni kullanır:
 *   Üretime Hazır (dwg_ready) · Çizimi Güncelle (dwg_update) · Çizim Hatalı (dwg_faulty — açıklama zorunlu, açılır kutuda)
 * Her karar ayrı bir sunucu işlemidir; hangi düğmenin görüneceğini çağıran availableActions'tan verir. Düğmeyi göstermek
 * yetki değildir: yetki, sipariş kapsamı ve durum işlemde (server/orders/transitions.js) yeniden denetlenir. Her karar
 * "emin misiniz?" onayından geçer.
 */
export function DwgDecision({ orderId, can, t }: { orderId: string; can: { ready: boolean; faulty: boolean; update: boolean }; t: T }) {
  const hidden = <input type="hidden" name="id" value={orderId} />;
  return (
    <div className="dwg-actions" data-dwg-actions={orderId}>
      {can.ready && (
        <form action={dwgReadyAction}>
          {hidden}
          <ConfirmButton success message={t('order.dwg.readyConfirm')}>{t('order.dwg.ready')}</ConfirmButton>
        </form>
      )}
      {can.update && (
        <form action={dwgUpdateAction}>
          {hidden}
          <ConfirmButton outline message={t('order.dwg.updateConfirm')}>{t('order.dwg.update')}</ConfirmButton>
        </form>
      )}
      {can.faulty && (
        <details className="dwg-faulty">
          <summary className="btn btn-danger">{t('order.dwg.faulty')}</summary>
          <form action={dwgFaultyAction}>
            {hidden}
            <label htmlFor={`dwg-note-${orderId}`} className="small">{t('order.dwg.faultyNote')}</label>
            <textarea id={`dwg-note-${orderId}`} name="note" rows={3} required maxLength={2000} placeholder={t('order.dwg.faultyPlaceholder')} />
            <span><ConfirmButton danger outline message={t('order.dwg.faultyConfirm')}>{t('order.dwg.faultySubmit')}</ConfirmButton></span>
          </form>
        </details>
      )}
    </div>
  );
}
