import { createFileRoute, Link, notFound, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { AssistedEditor } from '../../../components/assistant/AssistedEditor';
import { ChatPanel } from '../../../components/assistant/ChatPanel';
import { channelOfDraft, langOfDraft } from '../../../components/assistant/protocol';
import { useAssistant } from '../../../components/assistant/session';
import { EmptyDrafts } from '../../../components/illustrations';
import { Empty, PageHead } from '../../../components/PageHead';
import { useToast } from '../../../components/Toasts';
import { Notice, Pill } from '../../../components/ui';
import { Select } from '../../../components/ui/Select';
import { getLaunch, saveDraft } from '../../../server/launches.functions';

/*
 * A launch's drafts in the editor, after Typefully: the drafts on the left, the text in the middle
 * with the selection actions, the assistant's chat on the right. A save is a commit on the pull
 * request's branch, as on the launch's page.
 */
export const Route = createFileRoute('/_app/launches/$id_/edit')({
  loader: async ({ params }) => {
    const data = await getLaunch({ data: Number(params.id) });
    if (!data) throw notFound();
    return data;
  },
  head: ({ loaderData }) => ({ meta: [{ title: `Edit · ${loaderData?.launch.repo ?? 'Launch'} · Shipcast` }] }),
  component: DraftsEditor,
});

type Data = Awaited<ReturnType<typeof getLaunch>> & {};
type Review = Exclude<Data['review'], null | { error: string }>;
type DraftView = Review['drafts'][number];

function Editor({ launchId, draft, editable, article }: { launchId: number; draft: DraftView; editable: boolean; article: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [content, setContent] = useState(draft.content ?? '');
  const [busy, setBusy] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const lang = langOfDraft(draft.path);
  const channel = channelOfDraft(draft.path);
  const assistant = useAssistant({
    value: content,
    onChange: setContent,
    launchId,
    ...(lang && { lang }),
    ...(channel && { channel }),
    ...(article && { checkDisabled: 'This launch is an article you wrote: there is no code to check it against, the article is the truth.' }),
  });
  const changed = content !== (draft.content ?? '');
  return (
    <div className={`writer${chatOpen ? ' with-chat' : ''}`}>
      <div className="form">
        <AssistedEditor id="draft-text" label={draft.label} assistant={assistant} tall={draft.kind === 'article'} help={`${draft.path}.`} />
        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!editable || busy || !changed}
            onClick={async () => {
              setBusy(true);
              const answer = await saveDraft({ data: { id: launchId, path: draft.path, content } }).catch((error: unknown) => ({ ok: false as const, problem: error instanceof Error ? error.message : String(error) }));
              setBusy(false);
              if (answer.ok) {
                toast.done(`${draft.label} saved`, 'The edit is a commit on the pull request: it is what gets published.');
                await router.invalidate();
              } else toast.fail(answer.problem);
            }}
          >
            {busy ? 'Saving…' : 'Save this edit'}
          </button>
          {changed && <span className="muted">Not saved yet</span>}
          {!editable && <span className="muted">The pull request is no longer open: the drafts are read-only.</span>}
        </div>
      </div>
      <ChatPanel assistant={assistant} open={chatOpen} onOpenChange={setChatOpen} />
    </div>
  );
}

function DraftsEditor() {
  const data = Route.useLoaderData();
  const { launch, review } = data;
  const reviewOk = review && !('error' in review) ? review : undefined;
  const texts = reviewOk?.drafts.filter((d) => d.kind === 'article' || d.kind === 'channel') ?? [];
  const [path, setPath] = useState(texts[0]?.path ?? '');
  const current = texts.find((d) => d.path === path);
  const editable = reviewOk?.pullRequest.state === 'open';
  const article = launch.ref.startsWith('article:');

  return (
    <>
      <PageHead
        title="Edit the drafts"
        action={
          <div className="row">
            <Pill tone={launch.state.tone}>{launch.state.label}</Pill>
            <Link className="btn" to="/launches/$id" params={{ id: String(launch.id) }}>
              Back to the launch
            </Link>
          </div>
        }
      >
        {launch.repo} · <span className="mono break">{launch.ref}</span>. Select a passage for the quick actions, or ask the assistant beside the text; every change it proposes is a diff you accept or reject.
      </PageHead>
      {review && 'error' in review && <Notice tone="bad">The drafts could not be read: {review.error}</Notice>}
      {texts.length === 0 ? (
        <Empty art={<EmptyDrafts />} title="No drafts to edit">
          This launch has no text drafts on an open pull request.
        </Empty>
      ) : (
        <div className="drafts-editor">
          <nav className="drafts-list" aria-label="Drafts">
            <ul>
              {texts.map((d) => (
                <li key={d.path}>
                  <button type="button" aria-current={d.path === path ? 'true' : undefined} onClick={() => setPath(d.path)}>
                    {d.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <div className="drafts-pick">
            <Select label="Draft" options={texts.map((d) => ({ value: d.path, label: d.label }))} value={path} onValueChange={setPath} />
          </div>
          {current && <Editor key={current.path} launchId={launch.id} draft={current} editable={editable} article={article} />}
        </div>
      )}
    </>
  );
}
