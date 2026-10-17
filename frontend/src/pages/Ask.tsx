import { useRef, useState, type FormEvent } from 'react';
import { API_BASE } from '../lib/api';
import { useReveal } from '../lib/motion';
import { Icon } from '../components/Icon';
import type { AskResponse } from '../lib/types';
import '../styles/ask.css';

const SUGGESTED = [
  'Which US 84 segments have the highest EB excess of ped/bike crashes, and what is their AADT?',
  'How many KA pedestrian crashes happened in dark-not-lighted conditions?',
  'At Peachtree, how many rear-end conflicts had TTC below 1.0 s?',
  'Which SPF does each site type use, and how well does it fit (MAD, Pearson χ²/df)?',
  'Which PBCAT crash type is most frequent among pedestrian crashes?',
  'Did the Kalman RTS smoother beat linear interpolation on occluded tracks at Lankershim?',
];

type Turn = { id: number; q: string; res?: AskResponse; error?: string; limited?: string };

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function ask(question: string): Promise<{ res?: AskResponse; error?: string; limited?: string }> {
  const body = JSON.stringify({ question });
  // CloudFront OAC to a Lambda URL requires the payload hash for POST bodies.
  const hash = await sha256Hex(body);
  const r = await fetch(`${API_BASE}/api/v1/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-amz-content-sha256': hash },
    body,
  });
  if (r.status === 429) {
    const ra = r.headers.get('Retry-After');
    let msg = 'Too many questions.';
    try { msg = (await r.json()).detail ?? msg; } catch { /* ignore */ }
    return { limited: `${msg}${ra ? ` Retry in ${ra} s.` : ''}` };
  }
  if (!r.ok) return { error: `${r.status} ${r.statusText}: ${(await r.text()).slice(0, 200)}` };
  return { res: (await r.json()) as AskResponse };
}

export default function Ask() {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const nextId = useRef(1);
  const area = useRef<HTMLTextAreaElement>(null);
  const pageRef = useReveal<HTMLDivElement>();

  async function submit(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    const id = nextId.current++;
    setBusy(true);
    setTurns((t) => [{ id, q: text }, ...t].slice(0, 8));
    setQ('');
    let out: Omit<Turn, 'id' | 'q'>;
    try { out = await ask(text); } catch (e) { out = { error: (e as Error).message }; }
    setTurns((t) => t.map((x) => (x.id === id ? { ...x, ...out } : x)));
    setBusy(false);
    area.current?.focus();
  }
  const onSubmit = (e: FormEvent) => { e.preventDefault(); void submit(q); };

  return (
    <div className="page ask" ref={pageRef}>
      <header className="page-head ask-head">
        <h1 data-r="1">Ask the data</h1>
        <p data-r="2">Answers come from RoadScope's curated tables through named tools; every tool call and cited table is listed.</p>
      </header>

      <form className="ask-form" onSubmit={onSubmit} data-ui data-r="3" data-busy={busy || undefined}>
        <label htmlFor="ask-q" className="sr-only">Question</label>
        <textarea
          id="ask-q" ref={area} rows={3} maxLength={500} value={q} placeholder="Which segments have a critical-rate ratio above 1.5?"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(q); } }}
        />
        <div className="ask-actions">
          <span className="ask-hint">
            {q.length > 400 ? <><span className="num">{q.length}</span>/500 · </> : null}<kbd>Ctrl</kbd> or <kbd>⌘</kbd> + <kbd>Enter</kbd>
          </span>
          <button className="btn ask-go" type="submit" disabled={busy || !q.trim()}>{busy ? 'Answering…' : 'Ask'}<Icon name="arrow" size={18} /></button>
        </div>
      </form>

      <section className="section ask-try" aria-labelledby="ask-sugg" data-r="4">
        <h2 id="ask-sugg">Or start from one of these</h2>
        <ul className="ask-sugg">
          {SUGGESTED.map((s) => (
            <li key={s}>
              <button type="button" className="ask-sq" disabled={busy} onClick={() => void submit(s)}>
                <span>{s}</span><Icon name="arrow" size={18} />
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="section" aria-labelledby="ask-hist" aria-live="polite" aria-busy={busy}>
        <h2 id="ask-hist" className={turns.length ? undefined : 'sr-only'}>Answers</h2>
        <ol className="ask-turns">
          {turns.map((t) => <TurnView key={t.id} t={t} />)}
        </ol>
      </section>
    </div>
  );
}

function TurnView({ t }: { t: Turn }) {
  const r = t.res;
  return (
    <li className="ask-turn">
      <p className="ask-q">{t.q}</p>
      {!r && !t.error && !t.limited && (
        <div className="ask-wait" aria-label="Waiting for answer"><i className="skeleton" /><i className="skeleton" /><i className="skeleton" /></div>
      )}
      {t.limited && <div className="error-box">Rate limited. {t.limited}</div>}
      {t.error && <div className="error-box">The question could not be answered: {t.error}</div>}
      {r && (
        <>
          {r.fallback && (
            <p className="ask-fallback" role="note">
              Deterministic fallback: a rule-based answer over the same tools; the model was not used.
            </p>
          )}
          <div className="ask-answer">{r.answer.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div>
          <p className="ask-meta">
            {r.citations.length > 0 && <>Cited: {r.citations.join(', ')}. </>}
            Model <span className="num">{r.model}</span>.
          </p>
          {r.tool_calls.length > 0 && (
            <details className="ask-tools">
              <summary>{r.tool_calls.length} tool call{r.tool_calls.length === 1 ? '' : 's'}</summary>
              <ol>
                {r.tool_calls.map((c, i) => (
                  <li key={i}>
                    <code>{c.name}</code> {c.ok ? '' : <span className="ask-bad">failed</span>}
                    <pre>{JSON.stringify(c.input, null, 1)}</pre>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </>
      )}
    </li>
  );
}
