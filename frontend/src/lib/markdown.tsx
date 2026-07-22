import { useMemo, useState, type ReactNode } from 'react';

// Lekki renderer markdown (bez zależności): nagłówki, bloki kodu, listy, akapity,
// inline `kod` i **pogrubienie**. Wystarcza do runbooka admina.
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(<strong key={`${keyBase}-${i}`}>{t.slice(2, -2)}</strong>);
    else out.push(<code key={`${keyBase}-${i}`} className="rounded bg-slate-100 px-1 text-[0.85em]">{t.slice(1, -1)}</code>);
    last = m.index + t.length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MarkdownLite({ source }: { source: string }) {
  const lines = source.split('\n');
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  let key = 0;

  const flush = () => {
    if (bullets.length) {
      const items = bullets;
      const k = key++;
      blocks.push(
        <ul key={k} className="my-2 list-disc space-y-0.5 pl-5 text-sm text-slate-700">
          {items.map((b, j) => <li key={j}>{inline(b, `li${k}-${j}`)}</li>)}
        </ul>,
      );
      bullets = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      blocks.push(
        <pre key={key++} className="my-2 overflow-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
          {code.join('\n')}
        </pre>,
      );
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      flush();
      const level = (line.match(/^#+/) as RegExpMatchArray)[0].length;
      const text = line.replace(/^#+\s/, '');
      const cls =
        level === 1 ? 'mt-4 text-lg font-semibold' : level === 2 ? 'mt-4 text-base font-semibold' : 'mt-3 text-sm font-semibold';
      blocks.push(<div key={key++} className={cls}>{inline(text, `h${key}`)}</div>);
      continue;
    }
    if (/^\s*-\s/.test(line)) {
      bullets.push(line.replace(/^\s*-\s/, ''));
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    flush();
    blocks.push(<p key={key++} className="my-1 text-sm text-slate-700">{inline(line, `p${key}`)}</p>);
  }
  flush();
  return <div className="max-w-none">{blocks}</div>;
}

// Podział markdowna na sekcje po nagłówkach `## ` (ignoruje `#` w blokach kodu).
type Section = { title: string; body: string };
function splitSections(source: string): { intro: string; sections: Section[] } {
  const lines = source.split('\n');
  const intro: string[] = [];
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inCode = false;
  for (const line of lines) {
    if (line.startsWith('```')) inCode = !inCode;
    if (!inCode && /^##\s/.test(line)) {
      cur = { title: line.replace(/^##\s/, '').trim(), body: '' };
      sections.push(cur);
      continue;
    }
    if (cur) cur.body += line + '\n';
    else intro.push(line);
  }
  return { intro: intro.join('\n'), sections };
}

// Dokumentacja w zwijanych panelach: nagłówek `##` = panel, treść pod spodem.
// Domyślnie wszystko zwinięte — długi runbook przestaje być ścianą tekstu.
export function MarkdownSections({ source }: { source: string }) {
  const { intro, sections } = useMemo(() => splitSections(source), [source]);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (i: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });

  return (
    <div className="space-y-3">
      {intro.trim() && <MarkdownLite source={intro} />}

      {sections.length > 1 && (
        <div className="flex items-center gap-3 text-xs">
          <button onClick={() => setOpen(new Set(sections.map((_, i) => i)))} className="text-blue-700 hover:underline">
            Rozwiń wszystko
          </button>
          <button onClick={() => setOpen(new Set())} className="text-blue-700 hover:underline">
            Zwiń wszystko
          </button>
          <span className="text-slate-400">{sections.length} sekcji</span>
        </div>
      )}

      <div className="space-y-2">
        {sections.map((s, i) => (
          <div key={i} className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            <button
              onClick={() => toggle(i)}
              aria-expanded={open.has(i)}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-semibold hover:bg-slate-50"
            >
              <span>{s.title}</span>
              <span className="shrink-0 text-slate-400">{open.has(i) ? '−' : '+'}</span>
            </button>
            {open.has(i) && (
              <div className="border-t border-slate-100 px-3 pb-3 pt-1">
                <MarkdownLite source={s.body} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
