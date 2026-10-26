import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { SectionHead } from '../../../components/SectionHead';
import { AI_SETTING_NAMES, SettingsForm } from '../../../components/SettingsForm';
import { useToast } from '../../../components/Toasts';
import { Pill, when } from '../../../components/ui';
import { Select } from '../../../components/ui/Select';
import { getSettings } from '../../../server/settings.functions';
import { getAiSettings, previewAiPrompt, restoreAiPrompt, saveAiPrompt, saveAiSettings } from '../../../server/ai.functions';

export const Route = createFileRoute('/_app/settings/ai')({
  head: () => ({ meta: [{ title: 'AI · Shipcast' }] }),
  loader: async () => {
    const [ai, general] = await Promise.all([getAiSettings(), getSettings()]);
    return { ...ai, runtime: general.settings.filter((s) => AI_SETTING_NAMES.has(s.name)) };
  },
  component: AiSettingsPage,
});

type Data = Awaited<ReturnType<typeof getAiSettings>> & { runtime: Parameters<typeof SettingsForm>[0]['settings'] };
type Task = Data['tasks'][number];
type ProviderId = Data['providers'][number]['id'];
type PromptView = Data['prompts'][number];

const TASKS: Record<Task, { label: string; text: string }> = {
  pack: { label: 'Launch content pack', text: 'Reads the released repo and writes every channel’s piece. claudio’s Claude Code explores the clone itself; the others get read-only tools over it.' },
  article: { label: 'Article distribution', text: 'Translates an article you wrote and writes each channel’s piece from it.' },
  assistant: { label: 'Writing assistant', text: 'The streamed suggestions beside Write and each draft (coming next).' },
  replies: { label: 'Comment replies', text: 'Drafts a reply to each comment on your posts, grounded in the repo and the launch’s analysis; it reads the code when a comment asks about it.' },
};

const CHANNEL_NAMES: Record<string, string> = {
  blog: 'Blog article',
  devto: 'dev.to',
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
  instagram: 'Instagram',
  reddit: 'Reddit',
  hashnode: 'Hashnode',
  telegram: 'Telegram',
  discord: 'Discord',
  githubDiscussions: 'GitHub Discussions',
  threads: 'Threads',
  linkedin: 'LinkedIn',
  hackerNews: 'Hacker News',
  productHunt: 'Product Hunt',
  newsletter: 'Newsletter',
};

function promptLabel(id: string): string {
  if (id === 'article') return 'Article: the translation';
  if (id === 'reply') return 'Comment reply';
  const [group, name = ''] = id.split('.');
  if (group === 'pack') return `Pack brief: ${name === 'launch' ? 'first launch' : `${name} version`}`;
  return `Channel brief: ${CHANNEL_NAMES[name] ?? name}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Tasks({ data }: { data: Data }) {
  const router = useRouter();
  const toast = useToast();
  const [tasks, setTasks] = useState(data.settings.tasks);
  const [tone, setTone] = useState(data.settings.tone ?? '');
  const [busy, setBusy] = useState(false);
  const set = (task: Task, change: { provider?: ProviderId; model?: string }) => setTasks((all) => ({ ...all, [task]: { ...all[task], ...change } }));

  const save = async () => {
    setBusy(true);
    try {
      const clean = Object.fromEntries(
        data.tasks.map((task) => {
          const model = tasks[task].model?.trim();
          return [task, model ? { provider: tasks[task].provider, model } : { provider: tasks[task].provider }];
        }),
      );
      await saveAiSettings({ data: tone.trim() ? { tasks: clean, tone: tone.trim() } : { tasks: clean } });
      toast.done('AI settings saved', 'The next draft uses them.');
      await router.invalidate();
    } catch (error) {
      toast.fail(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {data.tasks.map((task) => {
        const chosen = data.providers.find((p) => p.id === tasks[task].provider);
        return (
          <fieldset key={task} className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label">{TASKS[task].label}</legend>
            <div className="row">
              <Select
                label="Provider"
                options={data.providers.map((p) => ({ value: p.id, label: p.name, hint: p.connected ? undefined : 'not connected' }))}
                value={tasks[task].provider}
                onValueChange={(provider) => set(task, { provider })}
              />
              <input
                className="input mono"
                placeholder="the provider’s default model"
                value={tasks[task].model ?? ''}
                onChange={(e) => set(task, { model: e.target.value })}
                aria-label={`${TASKS[task].label}: model`}
              />
            </div>
            <small>
              {TASKS[task].text}
              {chosen && !chosen.connected ? ' Connect it on the Channels page first, or this task fails.' : ''}
            </small>
          </fieldset>
        );
      })}
      <div className="field">
        <label htmlFor="tone">Tone</label>
        <textarea id="tone" className="input" rows={3} value={tone} placeholder={data.brandTone ?? 'first person, direct and technical, no hype.'} onChange={(e) => setTone(e.target.value)} />
        <small>Replaces brand.yml’s tone in every prompt. Empty keeps brand.yml’s{data.brandTone ? '' : ' (it has none: the default above applies)'}.</small>
      </div>
      <div className="row">
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save AI settings'}
        </button>
      </div>
    </form>
  );
}

function PromptEditor({ prompt }: { prompt: PromptView }) {
  const router = useRouter();
  const toast = useToast();
  const current = prompt.versions.at(-1)?.text ?? prompt.default;
  const [draft, setDraft] = useState(current);
  const edited = prompt.versions.length > 0 && current !== prompt.default;

  const run = async (action: () => Promise<unknown>, done: string) => {
    try {
      await action();
      toast.done(done);
      await router.invalidate();
    } catch (error) {
      toast.fail(errorText(error));
    }
  };

  return (
    <details className="card">
      <summary style={{ display: 'flex', justifyContent: 'space-between', gap: 12, cursor: 'pointer' }}>
        <span>{promptLabel(prompt.id)}</span>
        {edited ? <Pill tone="draft">Edited</Pill> : <Pill tone="manual">Default</Pill>}
      </summary>
      <div className="form" style={{ marginTop: 12 }}>
        <textarea className="input mono" rows={6} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={promptLabel(prompt.id)} />
        <div className="row">
          <button className="btn btn-small btn-primary" type="button" disabled={draft === current} onClick={() => void run(() => saveAiPrompt({ data: { id: prompt.id, text: draft } }), 'Prompt saved')}>
            Save a new version
          </button>
          <button className="btn btn-small" type="button" disabled={current === prompt.default} onClick={() => void run(() => restoreAiPrompt({ data: { id: prompt.id, savedAt: 'default' } }), 'Default restored')}>
            Restore the default
          </button>
        </div>
        {prompt.versions.length > 0 && (
          <ol className="muted" style={{ margin: 0, paddingLeft: 20, lineHeight: 1.6 }} reversed>
            {[...prompt.versions].reverse().map((v, i) => (
              <li key={`${v.savedAt}-${i}`}>
                {v.savedAt === 'default' ? 'The default' : when(v.savedAt)}
                {i === 0 ? ' · in use' : ''}{' '}
                {i > 0 && (
                  <button className="btn btn-small" type="button" onClick={() => void run(() => restoreAiPrompt({ data: { id: prompt.id, savedAt: v.savedAt } }), 'Version restored')}>
                    Restore
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}

function Preview({ data }: { data: Data }) {
  const toast = useToast();
  const [launchId, setLaunchId] = useState(data.launches[0]?.id);
  const [shown, setShown] = useState<{ system: string; prompt: string } | null>(null);
  if (data.launches.length === 0) return <p className="muted">No launches yet: a preview renders the prompt a past launch would get.</p>;
  return (
    <div className="form">
      <div className="row">
        <Select
          label="Launch"
          options={data.launches.map((l) => ({ value: String(l.id), label: l.label }))}
          value={launchId === undefined ? null : String(launchId)}
          onValueChange={(id) => setLaunchId(Number(id))}
        />
        <button
          className="btn"
          type="button"
          onClick={async () => {
            if (launchId === undefined) return;
            try {
              setShown(await previewAiPrompt({ data: { launchId } }));
            } catch (error) {
              toast.fail(errorText(error));
            }
          }}
        >
          Preview
        </button>
      </div>
      <small>With the saved prompts and tone. Nothing is sent to an AI.</small>
      {shown && (
        <>
          <span className="label">System</span>
          <div className="log">{shown.system}</div>
          <span className="label">Prompt</span>
          <div className="log">{shown.prompt}</div>
        </>
      )}
    </div>
  );
}

function AiSettingsPage() {
  const data = Route.useLoaderData();
  return (
    <>
      <SectionHead title="AI">Which AI writes each task, in what tone and with which prompts, and how Shipcast reaches claudio.</SectionHead>

      <h2 className="ph">claudio</h2>
      <p className="muted">
        claudio is a provider of its own: its REST API is what lets Claude Code explore the repo for the content pack, and its OpenAI-compatible surface streams the writing assistant.
        The budget caps what one generation may spend.
      </p>
      <SettingsForm settings={data.runtime} submit="Save claudio settings" />

      <h2 className="ph">Providers</h2>
      <Tasks data={data} />

      <h2 className="ph">Prompts</h2>
      <p className="muted">
        Each edit is a new version; earlier ones stay and can be restored. Variables: {data.variables.map((v) => `{{${v}}}`).join(' ')}
      </p>
      <div className="cards">
        {data.prompts.map((p) => (
          <PromptEditor key={`${p.id}-${p.versions.length}`} prompt={p} />
        ))}
      </div>

      <h2 className="ph">Locked</h2>
      <p className="muted">What keeps generated text true to the code, and the pack’s schema. Always added after your prompts; never editable.</p>
      <div className="cards">
        <details className="card">
          <summary>Rules for a launch</summary>
          <div className="log">{data.locked.launchRules.join('\n')}</div>
        </details>
        <details className="card">
          <summary>Rules for an article</summary>
          <div className="log">{data.locked.articleRules.join('\n')}</div>
        </details>
        <details className="card">
          <summary>Rules for a reply to a comment</summary>
          <div className="log">{data.locked.replyRules.join('\n')}</div>
        </details>
        <details className="card">
          <summary>Rules for the writing assistant, on a launch’s pieces</summary>
          <div className="log">{data.locked.assistantLaunchRules.join('\n')}</div>
        </details>
        <details className="card">
          <summary>Rules for the writing assistant, on an article</summary>
          <div className="log">{data.locked.assistantArticleRules.join('\n')}</div>
        </details>
        <details className="card">
          <summary>The content pack’s schema</summary>
          <div className="log">{data.locked.packSchema}</div>
        </details>
      </div>

      <h2 className="ph">Preview</h2>
      <Preview data={data} />
    </>
  );
}
