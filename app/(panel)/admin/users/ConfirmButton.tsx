'use client';

export function ConfirmButton({ message, children, danger }: { message: string; children: React.ReactNode; danger?: boolean }) {
  return (
    <button
      type="submit"
      className={`btn btn-link${danger ? ' danger' : ''}`}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
