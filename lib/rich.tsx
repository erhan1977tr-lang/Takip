import { Fragment, type ReactNode } from 'react';

/**
 * Çevrilmiş cümlenin içine öğe yerleştirir (kelime sırası dile göre değişebildiği için):
 *   rich(t('auth.setup.step1Text'), { email: <b>{email}</b> })
 */
export function rich(text: string, parts: Record<string, ReactNode>): ReactNode {
  return text.split(/(\{\w+\})/g).map((piece, i) => {
    const m = /^\{(\w+)\}$/.exec(piece);
    return <Fragment key={i}>{m && m[1] in parts ? parts[m[1]] : piece}</Fragment>;
  });
}
