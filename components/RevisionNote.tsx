import type { MsgKey, T } from '@/lib/i18n';
import { translate } from '@/server/i18n/index.js';
import { TRANSLATE_ERRORS, canRetryTranslation, translationState } from '@/server/notes/view.js';
import { revisionItems } from '@/server/orders/revision-note.js';

type Revision = {
  comment: string;
  translation?: string | null; translationLang?: string | null; translationStatus?: string | null;
  translationError?: string | null; translationAt?: Date | null;
};

/** Numaralı not (karar 162): "1. …\n2. …" düzenindeyse sıralı liste, değilse (eski serbest not) olduğu gibi */
function NumberedText({ text }: { text: string }) {
  const items = revisionItems(text);
  if (!items) return <div className="pre">{text}</div>;
  return <ol className="revision-list">{items.map((x, i) => <li key={i}>{x}</li>)}</ol>;
}

/**
 * Müşterinin revizyon notu ve saklanan çevirisi (karar 163) — sipariş sayfası (Teknik çizimler) ve çizim ekranı (Revizyon
 * talepleri) aynı bileşeni kullanır. Veri sunucuda role göre temizlenmiştir (lib/orders.ts → server/notes/view.js →
 * revisionView): iç ekip Türkçe çeviriyi ve çeviri durumunu alır, müşteri ve denetimci yalnızca özgün notu.
 * Bu bileşen çeviri YAPMAZ: yalnızca talep yazılırken saklanan sonucu gösterir.
 */
export function RevisionNote({ r, role, t }: { r: Revision; role: string; t: T }) {
  const st = translationState({ internal: false, ...r });
  const lang = r.translationLang === 'tr' || r.translationLang === 'ro' ? r.translationLang : null;
  const translated = st?.state === 'done' && lang && r.translation ? r.translation : null;
  const staff = canRetryTranslation(role);
  const reason = st?.state === 'failed' ? (TRANSLATE_ERRORS.includes(st.code ?? '') ? st.code : 'ERROR') : null;
  return (
    <div className="revision-note">
      {translated && <div className="note-label">{t('order.notes.original')}</div>}
      <NumberedText text={r.comment} />
      {translated && lang && (
        <div className="note-translation" lang={lang} data-translation={lang}>
          {/* Etiket çevirinin dilindedir (arayüz dilinden bağımsız) — sipariş notlarındakiyle aynı metin */}
          <div className="note-label">{translate(lang, 'order.notes.translatedLabel')}</div>
          <NumberedText text={translated} />
        </div>
      )}
      {staff && st?.state === 'pending' && <div className="note-translation note-state">{t('order.notes.translation.pending')}</div>}
      {staff && reason && (
        <div className="note-translation note-state failed" data-translation-failed={reason}>
          {t('order.notes.translation.failed', { reason: t(`order.notes.translation.reason.${reason}` as MsgKey) })}
        </div>
      )}
    </div>
  );
}
