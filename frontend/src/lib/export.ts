/** Exports that keep the current state: CSV of the visible rows, PNG of a canvas/SVG figure, and the current URL. */

export function downloadCSV(filename: string, rows: Record<string, unknown>[], columns?: string[]) {
  if (!rows.length) return;
  const cols = columns ?? Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  save(filename, new Blob([body], { type: 'text/csv;charset=utf-8' }));
}

/**
 * PNG of a figure: canvases are composited in DOM order onto one bitmap; SVGs are serialised with
 * computed colours so the image matches the active theme. A caption line with source is added at the foot.
 */
export async function downloadPNG(filename: string, root: HTMLElement, caption?: string) {
  const r = root.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const font = '12px Switzer, system-ui, sans-serif';
  const lines = caption ? wrap(caption, r.width - 24, font) : [];
  const foot = lines.length ? 12 + lines.length * 16 : 0;
  const out = document.createElement('canvas');
  out.width = Math.round(r.width * dpr); out.height = Math.round((r.height + foot) * dpr);
  const ctx = out.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  ctx.fillStyle = css.getPropertyValue('--sheet').trim() || '#1d1e1d';
  ctx.fillRect(0, 0, r.width, r.height + foot);
  for (const el of Array.from(root.querySelectorAll('canvas, svg')) as (HTMLCanvasElement | SVGSVGElement)[]) {
    const b = el.getBoundingClientRect();
    const x = b.left - r.left, y = b.top - r.top;
    if (el instanceof HTMLCanvasElement) {
      try { ctx.drawImage(el, x, y, b.width, b.height); } catch { /* tainted or WebGL without preserveDrawingBuffer */ }
    } else {
      const img = await svgToImage(el, b.width, b.height);
      if (img) ctx.drawImage(img, x, y, b.width, b.height);
    }
  }
  if (lines.length) {
    ctx.fillStyle = css.getPropertyValue('--ink-3').trim() || '#9a9b96';
    ctx.font = font;
    lines.forEach((l, i) => ctx.fillText(l, 12, r.height + 18 + i * 16));
  }
  out.toBlob((b) => b && save(filename, b), 'image/png');
}

/** Greedy word wrap of the caption to the figure width. */
function wrap(text: string, width: number, font: string): string[] {
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.font = font;
  const out: string[] = [];
  let line = '';
  for (const w of text.split(/\s+/)) {
    const next = line ? `${line} ${w}` : w;
    if (line && ctx.measureText(next).width > width) { out.push(line); line = w; } else line = next;
  }
  if (line) out.push(line);
  return out;
}

async function svgToImage(svg: SVGSVGElement, w: number, h: number): Promise<HTMLImageElement | null> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const src = svg.querySelectorAll('*'), dst = clone.querySelectorAll('*');
  src.forEach((n, i) => {
    const cs = getComputedStyle(n as Element);
    const d = dst[i] as SVGElement;
    for (const p of ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'font-size', 'font-family', 'font-weight']) d.style.setProperty(p, cs.getPropertyValue(p));
  });
  clone.setAttribute('width', String(w)); clone.setAttribute('height', String(h));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise<void>((ok, no) => { img.onload = () => ok(); img.onerror = () => no(); img.src = url; });
    return img;
  } catch { return null; } finally { URL.revokeObjectURL(url); }
}

export async function copyLink(): Promise<boolean> {
  try { await navigator.clipboard.writeText(location.href); return true; } catch { return false; }
}

function save(filename: string, blob: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
