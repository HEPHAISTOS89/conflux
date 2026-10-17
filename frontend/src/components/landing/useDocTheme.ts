import { useEffect, useState } from 'react';

export type DocTheme = 'light' | 'dark';
const read = (): DocTheme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

/** The document theme as React state; canvas and map paint re-derive their colours when it flips. */
export function useDocTheme(): DocTheme {
  const [t, setT] = useState<DocTheme>(read);
  useEffect(() => {
    const mo = new MutationObserver(() => setT(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return t;
}
