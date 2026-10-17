import { useEffect, useState } from 'react';

export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

const cache = new Map<string, Promise<unknown>>();

/** Cold starts and the account's Lambda concurrency cap surface as brief 429/5xx bursts; retry them twice. */
async function fetchRetry(url: string, tries = 3): Promise<Response> {
  for (let k = 0; ; k++) {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (k >= tries - 1 || ![429, 502, 503, 504].includes(r.status)) return r;
    await new Promise((res) => setTimeout(res, 400 * 2 ** k + Math.random() * 200));
  }
}

export async function getJSON<T>(path: string): Promise<T> {
  const url = `${API_BASE}/api/v1${path}`;
  if (!cache.has(url)) {
    const p = fetchRetry(url).then(async (r) => {
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
  // state is tagged with its path so a new path never renders the previous path's data
  const [state, setState] = useState<Loadable<T> & { path?: string | null }>({ loading: !!path, path });
  useEffect(() => {
    if (!path) return;
    let alive = true;
    setState({ loading: true, path });
    getJSON<T>(path)
      .then((data) => alive && setState({ data, loading: false, path }))
      .catch((e: Error) => alive && setState({ error: e.message, loading: false, path }));
    return () => { alive = false; };
  }, [path]);
  return state.path === path ? state : { loading: !!path };
}
