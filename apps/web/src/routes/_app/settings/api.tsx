import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { Icon } from '../../../components/kit/Icon';
import { ConfirmSheet, OnceSheet } from '../../../components/settings/sheets';
import { shortDay, tokenUse } from '../../../components/settings/view';
import { useToast } from '../../../components/Toasts';
import { createToken, listTokens, revokeToken } from '../../../server/tokens.functions';
import { getWebMcp, setWebMcp } from '../../../server/webmcp.functions';

export const Route = createFileRoute('/_app/settings/api')({
  head: () => ({ meta: [{ title: 'API · Shipcast' }] }),
  loader: async () => {
    const [tokens, webMcp] = await Promise.all([listTokens(), getWebMcp()]);
    return { ...tokens, webMcp: webMcp.enabled };
  },
  component: Api,
});

type Scope = 'read' | 'write';

const SCOPES: Array<{ id: Scope; label: string; text: string }> = [
  { id: 'read', label: 'Read', text: 'Launches, posts, numbers, accounts (without secrets) and jobs' },
  { id: 'write', label: 'Write', text: 'Launch a repo, approve drafts, write an article, retry a channel' },
];

function Api() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Scope[]>(['read']);
  // The token in the page's memory only, for the one time it is shown
  const [created, setCreated] = useState<{ name: string; scopes: Scope[]; token: string } | null>(null);
  const [revoking, setRevoking] = useState<{ id: number; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [unnamed, setUnnamed] = useState(false);

  const create = async () => {
    // The button stays live (one clear primary action): an empty name is asked for here
    if (!name.trim()) {
      setUnnamed(true);
      document.getElementById('st-token-name')?.focus();
      return;
    }
    setBusy(true);
    try {
      const answer = await createToken({ data: { name, scopes } });
      setCreated({ name: name.trim(), scopes, token: answer.token });
      setName('');
      await router.invalidate();
    } catch (error) {
      toast.fail(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="st-content">
      <p className="st-lead">
        For a script or an agent: every call carries <span className="k-mono k-xs">Authorization: Bearer …</span>
      </p>
      <div className="st-cards">
        <form
          className="k-card st-g12"
          aria-labelledby="st-create"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <h2 id="st-create" className="k-d k-d30">
            Create a token
          </h2>
          <label className="k-field">
            <span className="k-lbl">Name</span>
            <input id="st-token-name" className={`k-input st-input st-text${unnamed && !name.trim() ? ' k-bad' : ''}`} value={name} maxLength={100} placeholder="Who will use it, so you know what to revoke" onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="k-stack" role="group" aria-labelledby="st-scopes">
            <span id="st-scopes" className="k-lbl">
              Scopes
            </span>
            {SCOPES.map((s) => {
              const on = scopes.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  className="k-row"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => setScopes(on ? scopes.filter((x) => x !== s.id) : [...scopes, s.id])}
                >
                  <span className={`k-check${on ? ' k-on' : ''}`}>{on && <Icon name="check" size={16} strokeWidth={3} />}</span>
                  <span className="k-grow">
                    {s.label}
                    <br />
                    <span className="k-xs k-muted">{s.text}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <button type="submit" className="k-btn k-pri st-start" disabled={busy || scopes.length === 0}>
            <Icon name="key" size={18} />
            {busy ? 'Creating…' : 'Create the token'}
          </button>
        </form>

        <section className="k-card st-g0" aria-labelledby="st-tokens">
          <h2 id="st-tokens" className="k-d k-d30 st-mb6">
            Tokens
          </h2>
          {data.tokens.length === 0 ? (
            <p className="k-sm k-muted st-m0">No tokens yet.</p>
          ) : (
            data.tokens.map((t) => (
              <div key={t.id} className={`k-row${t.revokedAt ? ' st-revoked' : ''}`}>
                <span className="k-grow">
                  <strong className="k-sm">{t.name}</strong>
                  <br />
                  <span className="k-xs k-muted">{tokenUse(t)}</span>
                </span>
                {t.revokedAt ? (
                  <span className="k-pill k-p-quiet">Revoked {shortDay(t.revokedAt)}</span>
                ) : (
                  <button type="button" className="k-btn k-sm" onClick={() => setRevoking({ id: t.id, name: t.name })}>
                    Revoke
                  </button>
                )}
              </div>
            ))
          )}
        </section>

        <p className="k-xs k-muted st-m0 st-apinote">
          The API is at <span className="k-mono st-anywhere">{data.apiUrl}</span>, described in <a href={`${data.apiUrl}/openapi.json`}>openapi.json</a>.
        </p>

        <section className="k-card st-rowcard" aria-label="WebMCP">
          <span className="k-grow">
            <strong id="st-webmcp">WebMCP</strong>
            <br />
            <span className="k-xs k-muted">An agent in this browser uses the app’s tools while you are signed in.</span>
          </span>
          <button
            type="button"
            className={`k-sw${data.webMcp ? ' k-on' : ''}`}
            role="switch"
            aria-checked={data.webMcp}
            aria-labelledby="st-webmcp"
            onClick={async () => {
              const answer = await setWebMcp({ data: { enabled: !data.webMcp } });
              toast.done(answer.enabled ? 'WebMCP on' : 'WebMCP off', answer.enabled ? 'Reload the app for an agent in this browser to see the tools.' : 'The tools are no longer offered, and the API refuses their calls.');
              await router.invalidate();
            }}
          />
        </section>
      </div>

      <ConfirmSheet
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke “${revoking?.name ?? ''}”?`}
        keep="Keep it"
        confirm="Revoke"
        danger
        onConfirm={async () => {
          if (!revoking) return;
          await revokeToken({ data: revoking.id });
          toast.done('Token revoked', `${revoking.name} no longer opens the API.`);
          await router.invalidate();
        }}
      >
        Anything using it stops working at once. A revoked token cannot be brought back; make a new one instead.
      </ConfirmSheet>

      <OnceSheet
        value={created?.token ?? null}
        title="Copy the token now"
        text="It is shown only this once; Shipcast keeps only a hash of it."
        note={created ? `“${created.name}” · ${created.scopes.map((s) => SCOPES.find((x) => x.id === s)?.label ?? s).join(', ')}` : ''}
        onDone={() => setCreated(null)}
      />
    </div>
  );
}
