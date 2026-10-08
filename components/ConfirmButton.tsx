'use client';

import { useRef } from 'react';

/**
 * Formu göndermeden önce onay ister.
 * name/value verilirse değer ayrıca gizli bir alana yazılır: onay penceresinden sonra gönderilen formda
 * basılan düğmenin adı/değeri her tarayıcıda güvenilir biçimde taşınmıyor (aynı formda birden çok düğme olduğunda).
 * Görünüm (davranışı değiştirmez): primary = ana işlem (mavi) · success = olumlu / onay (yeşil) · solid + danger = geri
 * alınamaz işlem (dolu kırmızı) · outline + danger = kritik ama geri alınabilir (kırmızı çerçeve) · yalnızca outline =
 * ikincil düğme · yalnızca danger = satır içi kırmızı bağlantı · hiçbiri = satır içi bağlantı.
 */
export function ConfirmButton({ message, children, danger, primary, success, solid, outline, name, value }: { message: string; children: React.ReactNode; danger?: boolean; primary?: boolean; success?: boolean; solid?: boolean; outline?: boolean; name?: string; value?: string }) {
  const cls = success ? 'btn btn-success' : primary ? 'btn btn-primary' : danger && solid ? 'btn btn-danger-solid'
    : outline ? `btn${danger ? ' btn-danger' : ''}` : `btn btn-link${danger ? ' danger' : ''}`;
  const field = useRef<HTMLInputElement | null>(null);
  return (
    <>
      {name && <input ref={field} type="hidden" name={name} defaultValue="" />}
      <button
        type="submit"
        className={cls}
        onClick={(e) => {
          if (!window.confirm(message)) {
            e.preventDefault();
            return;
          }
          if (field.current) field.current.value = value ?? '';
        }}
      >
        {children}
      </button>
    </>
  );
}
