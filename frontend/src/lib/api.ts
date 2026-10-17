import { useEffect, useState } from 'react';

export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

const cache = new Map<string, Promise<unknown>>();

export async function getJSON<T>(path: string): Promise<T> {
  const url = `${API_BASE}/api/v1${path}`;
  if (!cache.has(url)) {
    const p = fetch(url, { headers: { Accept: 'application/json' } }).then(async (r) => {
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`${r.status} ${r.statusText} — ${path}${body ? `: ${body.slice(0, 160)}` : ''}`);
      }
      return r.json();
    });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return cache.get(url) as Promise<T>;
}

export async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API_BASE}/api/v1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${(await r.text()).slice(0, 200)}`);
  return r.json() as Promise<T>;
}

export type Loadable<T> = { data?: T; error?: string; loading: boolean };

export function useApi<T>(path: string | null): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ loading: !!path });
  useEffect(() => {
    if (!path) return;
    let alive = true;
    setState((s) => ({ data: s.data, loading: true }));
    getJSON<T>(path)
      .then((data) => alive && setState({ data, loading: false }))
      .catch((e: Error) => alive && setState({ error: e.message, loading: false }));
    return () => { alive = false; };
  }, [path]);
  return state;
}
