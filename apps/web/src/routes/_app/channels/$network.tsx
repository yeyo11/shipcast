import { createFileRoute, Link, notFound, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { PageHead } from '../../../components/PageHead';
import { useToast } from '../../../components/Toasts';
import { Avatar, Notice, when } from '../../../components/ui';
import { Select } from '../../../components/ui/Select';
import { connectWithForm, getChannels } from '../../../server/channels.functions';
import { channelIcon } from '../../../server/view';

export const Route = createFileRoute('/_app/channels/$network')({
  validateSearch: (search: Record<string, unknown>): { problem?: string } => (typeof search.problem === 'string' ? { problem: search.problem } : {}),
  loader: async ({ params }) => {
    const data = await getChannels();
    const network = data.networks.find((n) => n.id === params.network);
    if (!network || network.auth === 'none') throw notFound();
    return { network, brands: data.brands, instagramOAuth: data.instagramOAuth, secretsKind: data.secretsKind };
  },
  head: ({ loaderData }) => ({ meta: [{ title: `Connect ${loaderData?.network.name ?? ''} · Shipcast` }] }),
  component: Connect,
});

function Connect() {
  const { network, brands, instagramOAuth, secretsKind } = Route.useLoaderData();
  const search = Route.useSearch();
  const [brand, setBrand] = useState(brands[0]?.id ?? 'personal');
  const [label, setLabel] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  // A failed OAuth flow comes back here with its problem in the address: shown once, then cleared
  useEffect(() => {
    if (!search.problem) return;
    toast.fail(search.problem);
    void navigate({ to: '/channels/$network', params: { network: network.id }, search: {}, replace: true });
  }, [search.problem, network.id, navigate, toast]);
  const icon = channelIcon(network.channel ?? network.id);
  const oauthUrl = `/auth/${network.id}?${new URLSearchParams({ brand, label, ...(network.id === 'mastodon' ? { instance: values.instance ?? '' } : {}) })}`;

  return (
    <>
      <PageHead
        title={
          <span className="title-with-icon">
            {icon && <img className="icon" src={icon} alt="" />}
            {network.name}
          </span>
        }
        action={
          <Link className="btn" to="/channels">
            Back to channels
          </Link>
        }
      >
        {network.howTo}
      </PageHead>
      <div className="grid-2">
        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            // An OAuth network can also take a pasted token, for when the authorisation cannot come back here
            if (network.auth === 'oauth' && !values.accessToken?.trim()) {
              window.location.href = oauthUrl;
              return;
            }
            setBusy(true);
            const answer = await connectWithForm({ data: { network: network.id, brand, label, values } }).catch((error: unknown) => ({
              ok: false as const,
              problem: error instanceof Error ? error.message : String(error),
            }));
            setBusy(false);
            // The new account is shown where it now lives: the channels list, scrolled to it
            if (answer.ok) await navigate({ to: '/channels', search: { connected: `Connected ${answer.identity}`, focus: String(answer.id) } });
            else toast.fail(answer.problem);
          }}
        >
          {brands.length > 1 && (
            <Select
              label="Brand"
              options={brands.map((b) => ({ value: b.id, label: b.name }))}
              value={brand}
              onValueChange={setBrand}
              help="A launch only ever publishes with its own brand’s accounts."
            />
          )}
          {network.fields.map((field) => (
            <div className="field" key={field.key}>
              <label htmlFor={field.key}>
                {field.label}
                {field.optional ? <span className="muted"> (optional)</span> : null}
              </label>
              {field.multiline ? (
                <textarea
                  id={field.key}
                  className="textarea mono"
                  placeholder={field.placeholder}
                  value={values[field.key] ?? ''}
                  onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                  required={!field.optional}
                  autoComplete="off"
                />
              ) : (
                <input
                  id={field.key}
                  className={`input${field.secret ? ' mono' : ''}`}
                  type={field.secret ? 'password' : 'text'}
                  placeholder={field.placeholder}
                  value={values[field.key] ?? ''}
                  onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                  required={!field.optional}
                  autoComplete="off"
                />
              )}
              {field.help && <small>{field.help}</small>}
            </div>
          ))}
          <div className="field">
            <label htmlFor="label">
              Name <span className="muted">(optional)</span>
            </label>
            <input id="label" className="input" placeholder="The account’s own name, if left empty" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          {network.id === 'instagram' && !instagramOAuth ? (
            <Notice tone="bad">Instagram Login needs the Instagram app id and secret: set them in <a href="/settings">Settings</a>.</Notice>
          ) : (
            <div className="row">
              <button className="btn btn-primary" type="submit" disabled={busy}>
                {network.auth === 'oauth' && !values.accessToken?.trim() ? `Continue to ${network.name}` : busy ? 'Checking the credential…' : `Connect ${network.name}`}
              </button>
              <span className="muted" style={{ fontSize: 14 }}>
                {network.auth === 'oauth' ? 'You authorise Shipcast there and come back here.' : `Checked before it is saved; kept in ${secretsKind}.`}
              </span>
            </div>
          )}
        </form>
        <aside className="card">
          <h3 className="ph">What Shipcast does with it</h3>
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
            {network.permissions.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          {network.accounts.length > 0 && (
            <>
              <ul className="list">
                {network.accounts.map((a) => (
                  <li key={a.id}>
                    <span className="account-who">
                      <Avatar src={a.avatarUrl} alt="" size={32} />
                      <strong>{a.label}</strong>
                    </span>
                    <span className={a.stale ? 'stale' : 'muted'} style={{ fontSize: 14 }}>
                      {a.syncedAt ? `synced ${when(a.syncedAt)}` : 'never synced'}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="muted">Already connected. Connecting the same account again replaces its credential.</p>
            </>
          )}
        </aside>
      </div>
    </>
  );
}
