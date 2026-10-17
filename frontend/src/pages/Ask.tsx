import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import PageHeader from '../components/PageHeader';
import Info from '../components/Info';
import { Icon, type IconName } from '../components/Icon';
import { API_BASE } from '../lib/api';
import { useReveal } from '../lib/motion';
import { useTyped, useTypedPlaceholder } from '../lib/typing';
import type { AskResponse } from '../lib/types';
import '../styles/ask.css';

const MAX = 500;
const RATE = 30;

/** Each suggestion exercises a different named tool (the tool name stays in `tool`, for the record, not on screen). */
const SUGGESTED: { q: string; icon: IconName; tool: string }[] = [
  { q: 'Top US 84 segments by EB excess?', icon: 'rank', tool: 'query_screening' },
  { q: 'KA pedestrian crashes in dark, unlit conditions?', icon: 'moon', tool: 'vru_count' },
  { q: 'Rear-end conflicts at Peachtree, TTC below 1.0 s?', icon: 'crosshair', tool: 'intersection_conflicts' },
  { q: 'How well does each SPF fit?', icon: 'trend', tool: 'get_spf' },
  { q: 'Most frequent PBCAT type for pedestrian crashes?', icon: 'ped', tool: 'vru_summary' },
  { q: 'Kalman vs linear repair at Lankershim?', icon: 'path', tool: 'get_repair' },
];

const EXAMPLE_LINES = SUGGESTED.map((s) => s.q);
const clean = (p: string) => p.replace(/\s*\[[a-z_]+:[^\]]+\]/g, '');

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

export default function Ask() {
  const [q, setQ] = useState('');
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [model, setModel] = useState<{ state: ModelState; id?: string }>({ state: 'unknown' });
  const nextId = useRef(1);
  const inflight = useRef(false); // synchronous guard: two clicks in one frame must not send two requests
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
    if (!text || busy || inflight.current) return;
    inflight.current = true;
    const id = nextId.current++;
    setBusy(true);
    setTurns((t) => [{ id, q: text }, ...t].slice(0, 8));
    setQ('');
    const t0 = performance.now();
    let out: Omit<Turn, 'id' | 'q'>;
    try { out = await ask(text); } catch (e) { out = { error: `Network error: ${(e as Error).message}.` }; }
    out.ms = performance.now() - t0;
    if (out.res) setModel({ state: out.res.fallback ? 'fallback' : 'bedrock', id: out.res.model });
    setTurns((t) => t.map((x) => (x.id === id ? { ...x, ...out } : x)));
    inflight.current = false;
    setBusy(false);
    area.current?.focus();
  }
  const onSubmit = (e: FormEvent) => { e.preventDefault(); void submit(q); };
  const left = MAX - q.length;
  const isBedrock = model.state === 'bedrock';

  // Model state: a dot and one word; the reason sits behind the info button.
  const chip = (
    <span className="ask-model-state">
      <Info label="About the model" text={model.state === 'unknown' ? 'Model' : isBedrock ? 'Bedrock' : 'Fallback'} title={isBedrock ? 'Amazon Bedrock' : 'Rule-based fallback'} align="right">
        {isBedrock
          ? <p>Answered by <span className="measure">{model.id}</span> through Bedrock Converse with tool use.</p>
          : <p>Bedrock model access awaits AWS account verification (or the daily Bedrock cap was reached). The same named tools answer deterministically, over the same curated tables.</p>}
        <p>Eight named tools, {RATE} questions per minute per client. Every answer lists its tool calls and cited tables.</p>
      </Info>
    </span>
  );

  const placeholder = useTypedPlaceholder(EXAMPLE_LINES, !q && !focused && !busy, 'Ask about crashes, conflicts or SPFs…');

  return (
    <div className="page ask" ref={pageRef}>
      <PageHeader
        icon="ask"
        title="Ask the data"
        lede="Questions answered from RoadScope's curated tables through named tools."
        source="Bedrock Converse with tool use; rule-based fallback over the same tools"
        actions={chip}
      />

      <form className="ask-form" onSubmit={onSubmit} data-ui data-r="2" data-busy={busy || undefined} aria-busy={busy}>
        <label htmlFor="ask-q" className="sr-only">Question</label>
        <textarea
          id="ask-q" ref={area} rows={2} maxLength={MAX} value={q} disabled={busy}
          placeholder={placeholder}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          aria-describedby="ask-count ask-keys"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(q); } }}
        />
        <div className="ask-actions">
          <span className="ask-hint">
            <span id="ask-count" className="ask-count num" data-warn={left < 50 || undefined} data-show={q.length > 0 || undefined} aria-live={left < 50 ? 'polite' : 'off'}>{q.length}/{MAX}</span>
            <span id="ask-keys" aria-label="Command or Control plus Enter to send"><kbd>⌘</kbd><kbd>↵</kbd></span>
          </span>
          <span className="ask-btns">
            {q && !busy && <button type="button" className="btn ghost" onClick={() => { setQ(''); area.current?.focus(); }}>Clear</button>}
            <button className="btn ask-go" type="submit" disabled={busy || !q.trim()} aria-busy={busy}
              title={busy ? 'Answering the previous question' : !q.trim() ? 'Type a question first' : undefined}>
              {busy ? <><Icon name="spinner" size={16} />Answering…</> : <>Ask<Icon name="send" size={16} /></>}
            </button>
          </span>
        </div>
      </form>

      <section className="section ask-try" aria-labelledby="ask-sugg" data-r="3">
        <h2 id="ask-sugg" className="sr-only">Examples</h2>
        <ul className="ask-sugg">
          {SUGGESTED.map((s) => (
            <li key={s.q}>
              <button type="button" className="ask-sq" disabled={busy} title={busy ? 'Answering the previous question' : undefined} onClick={() => void submit(s.q)}>
                <Icon name={s.icon} size={20} weight="duotone" />
                <span className="ask-sq-q">{s.q}</span>
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
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  // The service appends a standing caveat paragraph; show it as a note, not as part of the answer.
  const paras = r ? r.answer.split(/\n{2,}/) : [];
  const caveat = paras.length > 1 && /^limitations?:/i.test(paras[paras.length - 1]) ? paras.pop() : undefined;
  const shown = paras.map(clean);
  const full = shown.join('\n\n');
  const { n, done } = useTyped(full);
  let offset = 0;
  const partial = shown.map((p) => { const v = p.slice(0, Math.max(0, n - offset)); offset += p.length + 2; return v; });
  const copy = async () => {
    if (!r) return;
    const text = `Q: ${t.q}\n\n${r.answer}\n\nCited: ${r.citations.join('; ') || 'none'}\nModel: ${r.model}`;
    try { await navigator.clipboard.writeText(text); setCopied('ok'); } catch { setCopied('fail'); /* clipboard blocked: say so rather than pretend */ }
    setTimeout(() => setCopied('idle'), 1800);
  };
  return (
    <li className="ask-turn">
      <p className="ask-q"><Icon name="ask" size={20} />{t.q}</p>
      {!r && !t.error && !t.limited && (
        <div className="ask-wait" role="status" aria-label="Waiting for answer"><i className="skeleton" /><i className="skeleton" /><i className="skeleton" /></div>
      )}
      {(t.limited || t.error) && (
        <div className="error-box ask-err">
          <Icon name="warning" size={16} />
          <span>{t.limited ? `Rate limited. ${t.limited}` : `Request failed. ${t.error}`}</span>
          <button type="button" className="btn ghost sm" onClick={onRetry} disabled={busy} title={busy ? 'Another question is being answered' : undefined}><Icon name="reset" size={16} />Retry</button>
        </div>
      )}
      {r && (
        <div className="ask-card">
          {/* Inline "[tool: file]" tags are shown as citation chips below, so they are dropped from the prose. */}
          <p className="sr-only">{full}</p>
          <div className="ask-answer" aria-hidden="true" data-typing={!done || undefined}>
            {partial.map((p, i) => p && <Para key={i} text={p} />)}
          </div>
          <div className="ask-after" data-wait={!done || undefined}>
          {r.citations.length > 0 && (
            <ul className="ask-cites" aria-label="Cited tables">
              {r.citations.map((c) => (
                <li key={c} className="ask-cite"><Icon name="db" size={14} /><span>{c}</span></li>
              ))}
            </ul>
          )}
          <div className="ask-foot">
            {caveat && <Info label="Limitations of this answer" title="Limitations"><p>{caveat.replace(/^limitations?:\s*/i, '')}</p><p className="measure">{r.model}</p></Info>}
            {t.ms != null && <span className="measure ask-model">{(t.ms / 1000).toFixed(2)} s</span>}
            <button type="button" className="ask-copy" onClick={() => void copy()} aria-label="Copy answer with citations">
              <Icon name={copied === 'ok' ? 'check' : copied === 'fail' ? 'warning' : 'copy'} size={14} /><span aria-live="polite">{copied === 'ok' ? 'Copied' : copied === 'fail' ? 'Copy blocked' : 'Copy'}</span>
            </button>
          </div>
          {r.tool_calls.length > 0 && (
            <details className="ask-tools">
              <summary><Icon name="caret" size={14} />{r.tool_calls.length} tool call{r.tool_calls.length === 1 ? '' : 's'}</summary>
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
