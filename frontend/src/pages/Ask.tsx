import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import PageHeader from '../components/PageHeader';
import { ProvChip, type Provenance } from '../components/MetricInfo';
import { Icon, type IconName } from '../components/Icon';
import { API_BASE } from '../lib/api';
import { useReveal } from '../lib/motion';
import type { AskResponse } from '../lib/types';
import '../styles/ask.css';

const MAX = 500;
const TOOLS = 8;
const RATE = 30;

/** Each suggestion exercises a different named tool, so a reviewer can see the whole tool surface in six clicks. */
const SUGGESTED: { q: string; icon: IconName; tool: string }[] = [
  { q: 'Which US 84 segments have the highest EB excess of ped/bike crashes, and what is their AADT?', icon: 'rank', tool: 'query_screening' },
  { q: 'How many KA pedestrian crashes happened in dark-not-lighted conditions?', icon: 'moon', tool: 'vru_count' },
  { q: 'At Peachtree, how many rear-end conflicts had TTC below 1.0 s?', icon: 'crosshair', tool: 'intersection_conflicts' },
  { q: 'Which SPF does each site type use, and how well does it fit (MAD, Pearson χ²/df)?', icon: 'trend', tool: 'get_spf' },
  { q: 'Which PBCAT crash type is most frequent among pedestrian crashes?', icon: 'ped', tool: 'vru_summary' },
  { q: 'Did the Kalman RTS smoother beat linear interpolation on occluded tracks at Lankershim?', icon: 'path', tool: 'get_repair' },
];

type Turn = { id: number; q: string; res?: AskResponse; error?: string; limited?: string; ms?: number };
type ModelState = 'unknown' | 'fallback' | 'bedrock';

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
  if (!r.ok) {
    let detail = r.statusText;
    try { const j = await r.json(); detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail); } catch { /* not JSON */ }
    return { error: `${r.status}: ${String(detail).slice(0, 200)}` };
  }
  return { res: (await r.json()) as AskResponse };
}

/** Provenance of a cited table, read from its file name and source label. */
function citeProv(c: string): Provenance {
  const s = c.toLowerCase();
  if (/screening|spf|conflict|repair|ssm/.test(s)) return 'derived';
  if (s.includes('fars') || s.includes('fatal')) return 'public';
  if (s.includes('vru') || s.includes('cris') || s.includes('active transportation')) return 'observed';
  if (s.includes('manifest') || s.includes('aadt') || s.includes('inventory')) return 'public';
  return 'derived';
}

export default function Ask() {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [model, setModel] = useState<{ state: ModelState; id?: string }>({ state: 'unknown' });
  const nextId = useRef(1);
  const area = useRef<HTMLTextAreaElement>(null);
  const pageRef = useReveal<HTMLDivElement>();

  // Autosize for browsers without `field-sizing: content`.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el || CSS.supports?.('field-sizing', 'content')) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 12 * 40)}px`;
  }, [q]);

  async function submit(question: string) {
    const text = question.trim().slice(0, MAX);
    if (!text || busy) return;
    const id = nextId.current++;
    setBusy(true);
    setTurns((t) => [{ id, q: text }, ...t].slice(0, 8));
    setQ('');
    const t0 = performance.now();
    let out: Omit<Turn, 'id' | 'q'>;
    try { out = await ask(text); } catch (e) { out = { error: `Network error: ${(e as Error).message}. Check your connection and retry.` }; }
    out.ms = performance.now() - t0;
    if (out.res) setModel({ state: out.res.fallback ? 'fallback' : 'bedrock', id: out.res.model });
    setTurns((t) => t.map((x) => (x.id === id ? { ...x, ...out } : x)));
    setBusy(false);
    area.current?.focus();
  }
  const onSubmit = (e: FormEvent) => { e.preventDefault(); void submit(q); };
  const left = MAX - q.length;
  const answered = turns.filter((t) => t.res).length;

  const chip = model.state === 'bedrock'
    ? <span className="status" data-s="ok"><Icon name="bedrock" size={14} />Bedrock · <span className="measure">{model.id}</span></span>
    : model.state === 'fallback'
      ? <span className="status" data-s="warn"><Icon name="warning" size={14} />Deterministic fallback in use</span>
      : <span className="status" data-s="warn"><Icon name="bedrock" size={14} />Bedrock awaiting AWS account verification</span>;

  return (
    <div className="page ask" ref={pageRef}>
      <PageHeader
        icon="ask"
        title="Ask the data"
        lede="Plain-language questions answered from RoadScope's curated tables through named tools. Every tool call and cited table is shown; nothing is answered from memory."
        source="Bedrock Converse with tool use; rule-based fallback over the same tools"
        actions={chip}
        readouts={[
          { label: 'Named tools', value: TOOLS },
          { label: 'Answered here', value: answered },
          { label: 'Limit', value: RATE, unit: '/ min' },
        ]}
      />

      <form className="ask-form" onSubmit={onSubmit} data-ui data-r="2" data-busy={busy || undefined} aria-busy={busy}>
        <label htmlFor="ask-q" className="ask-label"><Icon name="ask" size={16} />Your question</label>
        <textarea
          id="ask-q" ref={area} rows={2} maxLength={MAX} value={q} disabled={busy}
          placeholder="Which segments have a critical-rate ratio above 1.5?"
          aria-describedby="ask-count ask-keys"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(q); } }}
        />
        <div className="ask-actions">
          <span className="ask-hint">
            <span id="ask-count" className="ask-count num" data-warn={left < 50 || undefined} aria-live={left < 50 ? 'polite' : 'off'}>{q.length}/{MAX}</span>
            <span id="ask-keys"><kbd>⌘</kbd> or <kbd>Ctrl</kbd> + <kbd>Enter</kbd> to send</span>
          </span>
          <span className="ask-btns">
            {q && !busy && <button type="button" className="btn ghost" onClick={() => { setQ(''); area.current?.focus(); }}>Clear</button>}
            <button className="btn ask-go" type="submit" disabled={busy || !q.trim()}>
              {busy ? <><Icon name="spinner" size={18} />Answering…</> : <>Ask<Icon name="send" size={18} /></>}
            </button>
          </span>
        </div>
      </form>

      <section className="section ask-try" aria-labelledby="ask-sugg" data-r="3">
        <h2 id="ask-sugg">Start from a question the tools can answer</h2>
        <ul className="ask-sugg">
          {SUGGESTED.map((s) => (
            <li key={s.q}>
              <button type="button" className="ask-sq" disabled={busy} onClick={() => void submit(s.q)}>
                <Icon name={s.icon} size={18} weight="duotone" />
                <span className="ask-sq-q">{s.q}</span>
                <code className="ask-sq-t">{s.tool}</code>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="section" aria-labelledby="ask-hist" aria-live="polite" aria-busy={busy}>
        <div className="ask-hist-h">
          <h2 id="ask-hist" className={turns.length ? undefined : 'sr-only'}>Answers</h2>
          {turns.length > 0 && !busy && <button type="button" className="btn ghost" onClick={() => setTurns([])}><Icon name="reset" size={16} />Clear answers</button>}
        </div>
        <ol className="ask-turns">
          {turns.map((t) => <TurnView key={t.id} t={t} busy={busy} onRetry={() => void submit(t.q)} />)}
        </ol>
      </section>
    </div>
  );
}

function TurnView({ t, busy, onRetry }: { t: Turn; busy: boolean; onRetry: () => void }) {
  const r = t.res;
  const [copied, setCopied] = useState(false);
  // The service appends a standing caveat paragraph; show it as a note, not as part of the answer.
  const paras = r ? r.answer.split(/\n{2,}/) : [];
  const caveat = paras.length > 1 && /^limitations?:/i.test(paras[paras.length - 1]) ? paras.pop() : undefined;
  const copy = async () => {
    if (!r) return;
    const text = `Q: ${t.q}\n\n${r.answer}\n\nCited: ${r.citations.join('; ') || 'none'}\nModel: ${r.model}`;
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* clipboard blocked */ }
  };
  return (
    <li className="ask-turn">
      <p className="ask-q"><Icon name="ask" size={18} />{t.q}</p>
      {!r && !t.error && !t.limited && (
        <div className="ask-wait" role="status" aria-label="Waiting for answer"><i className="skeleton" /><i className="skeleton" /><i className="skeleton" /></div>
      )}
      {(t.limited || t.error) && (
        <div className="error-box ask-err">
          <Icon name="warning" size={16} />
          <span>{t.limited ? `Rate limited. ${t.limited}` : `The question could not be answered. ${t.error}`}</span>
          <button type="button" className="btn ghost" onClick={onRetry} disabled={busy}><Icon name="reset" size={15} />Retry</button>
        </div>
      )}
      {r && (
        <div className="ask-card">
          {/* Inline "[tool: file]" tags are shown as citation chips below, so they are dropped from the prose. */}
          <div className="ask-answer">{paras.map((p, i) => <Para key={i} text={p.replace(/\s*\[[a-z_]+:[^\]]+\]/g, '')} />)}</div>
          {r.citations.length > 0 && (
            <ul className="ask-cites" aria-label="Cited tables">
              {r.citations.map((c) => (
                <li key={c} className="ask-cite"><Icon name="db" size={14} /><span>{c}</span><ProvChip kind={citeProv(c)} /></li>
              ))}
            </ul>
          )}
          {caveat && <p className="ask-caveat"><Icon name="info" size={15} />{caveat.replace(/^limitations?:\s*/i, '')}</p>}
          <div className="ask-foot">
            <span className="status" data-s={r.fallback ? 'warn' : 'ok'}><Icon name={r.fallback ? 'warning' : 'bedrock'} size={14} />{r.fallback ? 'Rule-based fallback' : 'Bedrock'}</span>
            <span className="measure ask-model">{r.model}</span>
            {t.ms != null && <span className="measure ask-model">{(t.ms / 1000).toFixed(2)} s</span>}
            <button type="button" className="ask-copy" onClick={() => void copy()} aria-label="Copy answer with citations">
              <Icon name={copied ? 'check' : 'copy'} size={15} />{copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          {r.tool_calls.length > 0 && (
            <details className="ask-tools">
              <summary><Icon name="caret" size={14} />{r.tool_calls.length} tool call{r.tool_calls.length === 1 ? '' : 's'}: {r.tool_calls.map((c) => c.name).join(', ')}</summary>
              <ol>
                {r.tool_calls.map((c, i) => (
                  <li key={i}>
                    <code>{c.name}</code> <span className="status" data-s={c.ok ? 'ok' : 'down'}><Icon name={c.ok ? 'ok' : 'fail'} size={13} />{c.ok ? 'ok' : 'failed'}</span>
                    <pre className="measure">{JSON.stringify(c.input, null, 2)}</pre>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>
      )}
    </li>
  );
}

/** A paragraph, or a lead-in line plus a ranked list when the tools return "1. … 2. …" rows. */
function Para({ text }: { text: string }) {
  const lines = text.split('\n');
  const items = lines.filter((l) => /^\d+\.\s/.test(l));
  if (items.length < 2) return <p>{text}</p>;
  const lead = lines.filter((l) => !/^\d+\.\s/.test(l)).join(' ');
  return (
    <>
      {lead && <p>{lead}</p>}
      <ol className="ask-list">{items.map((l, i) => <li key={i}>{l.replace(/^\d+\.\s/, '')}</li>)}</ol>
    </>
  );
}
