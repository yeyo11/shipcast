import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { PageToolbar, ToolbarAction } from '../../../components/PageToolbar';
import { SectionHead } from '../../../components/SectionHead';
import { PlusIcon } from '../../../components/ui/icons';
import { useToast } from '../../../components/Toasts';
import { Pill, when } from '../../../components/ui';
import { ConfirmButton } from '../../../components/ui/ConfirmButton';
import { createToken, listTokens, revokeToken } from '../../../server/tokens.functions';

export const Route = createFileRoute('/_app/settings/api')({
  head: () => ({ meta: [{ title: 'API · Shipcast' }] }),
  loader: () => listTokens(),
  component: Api,
});

type Scope = 'read' | 'write';

const SCOPES: Array<{ id: Scope; text: string }> = [
  { id: 'read', text: 'Read launches, posts, numbers, accounts (without secrets) and jobs' },
  { id: 'write', text: 'Launch a repo, approve drafts, write an article, retry a channel' },
];

function Api() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Scope[]>(['read']);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const answer = await createToken({ data: { name, scopes } });
      setCreated({ name: name.trim(), token: answer.token });
      setName('');
      toast.show({ tone: 'wait', title: 'Copy the token now', text: 'It is shown only this once; Shipcast keeps only a hash of it.' });
      await router.invalidate();
    } catch (error) {
      toast.fail(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SectionHead title="API">
        Tokens for scripts, the MCP server and other clients of the REST API at <code className="break">{data.apiUrl}</code>. Its routes are described in{' '}
        <a href={`${data.apiUrl}/openapi.json`}>openapi.json</a>.
      </SectionHead>
      <PageToolbar
        label="API"
        actions={<ToolbarAction primary type="submit" form="token-form" label="Create a token" busyLabel={busy && 'Creating…'} icon={<PlusIcon />} disabled={busy || !name.trim() || scopes.length === 0} />}
      />

      {created && (
        <div className="form" style={{ marginBottom: 36 }}>
          <div className="field">
            <span className="label">New token, {created.name}</span>
            <div className="row">
              <code className="input mono copyable">
                {created.token}
              </code>
              <button className="btn btn-small" type="button" onClick={() => void navigator.clipboard.writeText(created.token).then(() => toast.done('Token copied'))}>
                Copy
              </button>
            </div>
            <small>
              Send it as <code>Authorization: Bearer …</code>. It is not shown again: if it is lost, revoke it and make another.
            </small>
          </div>
        </div>
      )}

      <form
        id="token-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div className="field">
          <label htmlFor="token-name">Name</label>
          <input id="token-name" className="input" value={name} maxLength={100} placeholder="MCP on my laptop" onChange={(e) => setName(e.target.value)} />
          <small>Who will use it, so you know what to revoke.</small>
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label">Scopes</legend>
          <div className="checks">
            {SCOPES.map((s) => (
              <label className="check" key={s.id}>
                <input
                  type="checkbox"
                  checked={scopes.includes(s.id)}
                  onChange={(e) => setScopes(e.target.checked ? [...scopes, s.id] : scopes.filter((x) => x !== s.id))}
                />
                {s.id}
              </label>
            ))}
          </div>
          <small>{SCOPES.map((s) => `${s.id}: ${s.text}.`).join(' ')} One does not include the other.</small>
        </fieldset>
      </form>

      <h2 className="ph">Tokens</h2>
      {data.tokens.length === 0 ? (
        <p className="muted">No tokens yet.</p>
      ) : (
        <table className="table table-stack">
          <tbody>
            {data.tokens.map((t) => (
              <tr key={t.id}>
                <th scope="row">{t.name}</th>
                <td>{t.scopes.join(', ')}</td>
                <td className="muted">
                  created {when(t.createdAt)} · {t.lastUsedAt ? `last used ${when(t.lastUsedAt)}` : 'never used'}
                </td>
                <td>
                  {t.revokedAt ? (
                    <Pill tone="quiet">Revoked {when(t.revokedAt)}</Pill>
                  ) : (
                    <ConfirmButton
                      className="btn btn-small btn-danger"
                      title={`Revoke “${t.name}”?`}
                      description="Anything using it stops working at once. A revoked token cannot be brought back; make a new one instead."
                      confirm="Revoke"
                      onConfirm={async () => {
                        await revokeToken({ data: t.id });
                        toast.done('Token revoked', `${t.name} no longer opens the API.`);
                        await router.invalidate();
                      }}
                    >
                      Revoke
                    </ConfirmButton>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
