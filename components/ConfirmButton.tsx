'use client';

/** Formu göndermeden önce onay ister. */
export function ConfirmButton({ message, children, danger, primary, name, value }: { message: string; children: React.ReactNode; danger?: boolean; primary?: boolean; name?: string; value?: string }) {
  const cls = primary ? 'btn btn-primary' : `btn btn-link${danger ? ' danger' : ''}`;
  return (
    <button
      type="submit"
      className={cls}
      name={name}
      value={value}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
