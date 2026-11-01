import { createFileRoute, notFound } from '@tanstack/react-router';
import { DraftsScreen, type EditSearch } from '../../../components/approve/DraftsScreen';
import { launchName } from '../../../server/launch-list';
import { getLaunch } from '../../../server/launches.functions';

/*
 * A launch's drafts in the editor (boards DraftEditor, DesktopDraftEditor and CodeCheck): one piece
 * at a time, its text with the writing assistant beside it, and the check of its claims against the
 * repo's code. A save is a new version of the draft (or a commit on the drafts pull request).
 */

export const Route = createFileRoute('/_app/launches/$id_/edit')({
  validateSearch: (search: Record<string, unknown>): EditSearch => ({
    ...(typeof search.draft === 'string' && search.draft !== '' && { draft: search.draft }),
    ...((search.lang === 'en' || search.lang === 'es') && { lang: search.lang }),
    ...((search.check === true || search.check === 'true' || search.check === 1) && { check: true as const }),
  }),
  loader: async ({ params }) => {
    const data = await getLaunch({ data: Number(params.id) });
    if (!data) throw notFound();
    return data;
  },
  head: ({ loaderData }) => ({ meta: [{ title: `Edit · ${loaderData ? launchName(loaderData.launch) : 'Launch'} · Shipcast` }] }),
  component: EditPage,
});

function EditPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <DraftsScreen data={data} search={search} onSearch={(next) => navigate({ search: next, replace: !next.check && !search.check, resetScroll: Boolean(next.check) !== Boolean(search.check) })} />;
}
