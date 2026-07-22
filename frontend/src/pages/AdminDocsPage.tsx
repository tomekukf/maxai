import runbook from '../../../docs/admin-runbook.md?raw';
import { MarkdownSections } from '../lib/markdown';

export default function AdminDocsPage() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <main className="mx-auto max-w-3xl px-4 py-6">
        <p className="mb-3 text-xs text-slate-400">
          Źródło: <code>docs/admin-runbook.md</code> (edytuj w repo).
        </p>
        <MarkdownSections source={runbook} />
      </main>
    </div>
  );
}
