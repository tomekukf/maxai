import { type ReactNode } from 'react';

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
