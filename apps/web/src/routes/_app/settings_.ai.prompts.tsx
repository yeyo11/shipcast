import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { TopBar } from '../../components/kit/Bars';
import { Icon } from '../../components/kit/Icon';
import { Overlay } from '../../components/kit/Overlay';
import { lockedRuleCount, promptEdited, promptLabel } from '../../components/settings/ai';
import { shortDay } from '../../components/settings/view';
import { useToast } from '../../components/Toasts';
import { getAiSettings, restoreAiPrompt, saveAiPrompt } from '../../server/ai.functions';

export const Route = createFileRoute('/_app/settings_/ai/prompts')({
  head: () => ({ meta: [{ title: 'Prompts · Shipcast' }] }),
  loader: () => getAiSettings(),
  component: PromptsPage,
});

type Data = Awaited<ReturnType<typeof getAiSettings>>;
type PromptView = Data['prompts'][number];

const LOCKED: Array<{ key: keyof Data['locked']; label: string }> = [
  { key: 'launchRules', label: 'Rules for a launch' },
  { key: 'articleRules', label: 'Rules for an article' },
  { key: 'replyRules', label: 'Rules for a reply to a comment' },
  { key: 'profileRules', label: 'Rules for a profile review' },
  { key: 'assistantLaunchRules', label: 'Rules for the writing assistant, on a launch’s pieces' },
  { key: 'assistantArticleRules', label: 'Rules for the writing assistant, on an article' },
  { key: 'packSchema', label: 'The content pack’s schema' },
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function StatePill({ prompt }: { prompt: PromptView }) {
  return promptEdited(prompt) ? <span className="k-pill k-p-draft">Edited</span> : <span className="k-pill k-p-quiet">Default</span>;
}

/** The open prompt (board PromptEditor's first card): its text, a new version or the default, and its versions */
function PromptCard({ prompt, variables }: { prompt: PromptView; variables: readonly string[] }) {
  const router = useRouter();
  const toast = useToast();
  const current = prompt.versions.at(-1)?.text ?? prompt.default;
  const [draft, setDraft] = useState(current);
  const label = promptLabel(prompt.id);

  const run = async (action: () => Promise<unknown>, done: string) => {
    try {
      await action();
      toast.done(done);
      await router.invalidate();
    } catch (error) {
      toast.fail(errorText(error));
    }
  };

  const versions = [...prompt.versions].reverse();
  return (
    <section className="k-card st-g12 st-open" aria-label={label}>
      <div className="k-hrow k-between">
        <strong>{label}</strong>
        <StatePill prompt={prompt} />
      </div>
      <textarea className="k-input k-mono st-prompt" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={label} spellCheck={false} />
      <div className="k-hrow k-g8 k-wrap">
        <button className="k-btn k-pri k-sm" type="button" disabled={draft === current} onClick={() => void run(() => saveAiPrompt({ data: { id: prompt.id, text: draft } }), 'Prompt saved')}>
          Save a new version
        </button>
        <button className="k-btn k-sm" type="button" disabled={current === prompt.default} onClick={() => void run(() => restoreAiPrompt({ data: { id: prompt.id, savedAt: 'default' } }), 'Default restored')}>
          Restore the default
        </button>
      </div>
      {versions.length > 0 && (
        <div className="k-stack k-g4">
          <span className="k-lbl">Versions</span>
          <div>
            {versions.map((v, i) => (
              <div key={`${v.savedAt}-${i}`} className="k-row k-sm st-version">
                <span className="k-grow">{v.savedAt === 'default' ? 'The default' : `Version ${versions.length - i} · ${shortDay(v.savedAt)}`}</span>
                {i === 0 ? (
                  <span className="k-xs k-muted">current</span>
                ) : (
                  <button type="button" className="st-link k-xs" onClick={() => void run(() => restoreAiPrompt({ data: { id: prompt.id, savedAt: v.savedAt } }), 'Version restored')}>
                    Restore
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      <details className="k-help st-vars">
        <summary>The variables a prompt can use</summary>
        <p className="k-mono">{variables.map((v) => `{{${v}}}`).join(' ')}</p>
      </details>
    </section>
  );
}

function PromptsPage() {
  const data = Route.useLoaderData();
  // The first edited prompt opens, or the first one: one at a time, the rest a tap away
  const [open, setOpen] = useState(() => (data.prompts.find(promptEdited) ?? data.prompts[0])?.id);
  const [locked, setLocked] = useState(false);
  const rules = lockedRuleCount(data.locked);

  return (
    <div className="st-sub">
      <TopBar back={{ label: 'AI', to: '/settings/ai' }} />
      <div className="st-subbody st-g12">
        <Link to="/settings/ai" className="k-desktop st-backlink">
          <Icon name="chevronLeft" size={18} />
          AI
        </Link>
        <h1 className="k-d st-subtitle">Prompts</h1>
        {data.prompts.map((p) =>
          p.id === open ? (
            <PromptCard key={`${p.id}-${p.versions.length}`} prompt={p} variables={data.variables} />
          ) : (
            <button key={p.id} type="button" className="k-card st-rowcard" onClick={() => setOpen(p.id)} aria-expanded={false}>
              <strong className="k-grow">{promptLabel(p.id)}</strong>
              <StatePill prompt={p} />
            </button>
          ),
        )}
        <section className="k-card k-quiet st-g6" aria-label="Locked">
          <span className="k-hrow k-g8">
            <strong>Locked</strong>
            <span className="k-xs k-muted">never editable</span>
          </span>
          <span className="k-sm k-muted">What keeps generated text true to the code, and the pack’s schema. Always added after your prompts.</span>
          <button type="button" className="st-link k-sm st-start" onClick={() => setLocked(true)}>
            See the {rules} rules
          </button>
        </section>
      </div>
      <Overlay kind="drawer" wide label="Locked" open={locked} onOpenChange={setLocked} heading="Locked">
        {LOCKED.map((l) => {
          const value = data.locked[l.key];
          return (
            <div key={l.key} className="k-stack k-g6">
              <span className="k-lbl">{l.label}</span>
              <pre className="st-log">{Array.isArray(value) ? value.join('\n') : value}</pre>
            </div>
          );
        })}
      </Overlay>
    </div>
  );
}
