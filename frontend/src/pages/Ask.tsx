import { useRef, useState, type FormEvent } from 'react';
import { API_BASE } from '../lib/api';
import type { AskResponse } from '../lib/types';
import '../styles/ask.css';

const SUGGESTED = [
  'Which US 84 segments have the highest EB excess and what is their AADT?',
  'How many KA pedestrian crashes happened in dark-not-lighted conditions?',
  'At Peachtree, how many rear-end conflicts had TTC below 1.0 s?',
  'What are the pooled SPF coefficients and overdispersion for Lubbock County segments?',
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
    <div className="page ask">
      <header className="page-head">
        <h1>Ask the data</h1>
        <p>
          Questions are answered by a model that can only read RoadScope's curated tables through named tools
          (screening, SPF, VRU, conflicts, repair). Every answer lists the tools it called and the tables it cites, so
          numbers can be checked against the source pages. If the model is unavailable, a deterministic rule-based
          answerer responds instead and says so.
        </p>
      </header>

      <form className="ask-form panel" onSubmit={onSubmit}>
        <label htmlFor="ask-q" className="ask-label">Question</label>
        <textarea
          id="ask-q" ref={area} rows={3} maxLength={500} value={q} placeholder="e.g. Which segments have a critical-rate ratio above 1.5?"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(q); } }}
        />
        <div className="ask-actions">
          <span className="muted ask-hint"><span className="num">{q.length}</span>/500 · Ctrl/⌘ + Enter to send</span>
          <button className="btn" type="submit" disabled={busy || !q.trim()}>{busy ? 'Answering…' : 'Ask'}</button>
        </div>
      </form>

      <section className="section" aria-labelledby="ask-sugg">
        <div className="section-head"><h2 id="ask-sugg">Suggested questions</h2></div>
        <ul className="ask-sugg">
          {SUGGESTED.map((s) => (
            <li key={s}><button type="button" className="ask-sq" disabled={busy} onClick={() => void submit(s)}>{s}</button></li>
          ))}
        </ul>
      </section>

      <section className="section" aria-labelledby="ask-hist" aria-live="polite" aria-busy={busy}>
        <div className="section-head"><h2 id="ask-hist">Answers</h2>{turns.length > 0 && <p>This session only; not stored</p>}</div>
        {turns.length === 0 && <p className="muted">No questions yet.</p>}
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
    <li className="ask-turn panel">
      <p className="ask-q">{t.q}</p>
      {!r && !t.error && !t.limited && <div className="skeleton ask-skel" aria-label="Waiting for answer" />}
      {t.limited && <div className="error-box">Rate limited. {t.limited}</div>}
      {t.error && <div className="error-box">The question could not be answered: {t.error}</div>}
      {r && (
        <>
          {r.fallback && (
            <p className="ask-fallback" role="note">
              <strong>Deterministic fallback.</strong> The language model was not used; this answer comes from a fixed
              rule-based matcher over the same tools and may address the question only partly.
            </p>
          )}
          <div className="ask-answer">{r.answer.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div>
          {r.citations.length > 0 && (
            <div className="ask-cites" aria-label="Citations">
              {r.citations.map((c) => <span key={c} className="chip">{c}</span>)}
            </div>
          )}
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
          <p className="muted ask-model">Model: <span className="num">{r.model}</span></p>
        </>
      )}
    </li>
  );
}
