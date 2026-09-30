'use client';

import { useRef } from 'react';

/**
 * Formu göndermeden önce onay ister.
 * name/value verilirse değer ayrıca gizli bir alana yazılır: onay penceresinden sonra gönderilen formda
 * basılan düğmenin adı/değeri her tarayıcıda güvenilir biçimde taşınmıyor (aynı formda birden çok düğme olduğunda).
 */
export function ConfirmButton({ message, children, danger, primary, name, value }: { message: string; children: React.ReactNode; danger?: boolean; primary?: boolean; name?: string; value?: string }) {
  const cls = primary ? 'btn btn-primary' : `btn btn-link${danger ? ' danger' : ''}`;
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
