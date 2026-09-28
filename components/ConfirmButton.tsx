'use client';

/** Formu göndermeden önce onay ister. */
export function ConfirmButton({ message, children, danger, primary }: { message: string; children: React.ReactNode; danger?: boolean; primary?: boolean }) {
  const cls = primary ? 'btn btn-primary' : `btn btn-link${danger ? ' danger' : ''}`;
  return (
    <button
      type="submit"
      className={cls}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
