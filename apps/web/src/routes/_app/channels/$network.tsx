import { createFileRoute, Link, notFound, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { Notice } from '../../../components/ui';
import { connectWithForm, getChannels } from '../../../server/channels.functions';
import { channelIcon } from '../../../server/view';

export const Route = createFileRoute('/_app/channels/$network')({
  validateSearch: (search: Record<string, unknown>): { connected?: string; problem?: string } => ({
    ...(typeof search.connected === 'string' ? { connected: search.connected } : {}),
    ...(typeof search.problem === 'string' ? { problem: search.problem } : {}),
  }),
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
  const router = useRouter();
  const [brand, setBrand] = useState(brands[0]?.id ?? 'personal');
  const [label, setLabel] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    search.connected ? { ok: true, text: search.connected } : search.problem ? { ok: false, text: search.problem } : null,
  );
  const [busy, setBusy] = useState(false);
  const icon = channelIcon(network.channel ?? network.id);
  const oauthUrl = `/auth/${network.id}?${new URLSearchParams({ brand, label, ...(network.id === 'mastodon' ? { instance: values.instance ?? '' } : {}) })}`;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="ph" style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            {icon && <img className="icon" src={icon} alt="" style={{ width: 64, height: 64 }} />}
            {network.name}
          </h1>
          <p>{network.howTo}</p>
        </div>
        <Link className="btn" to="/channels">
          Back to channels
        </Link>
      </div>
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
            setResult(null);
            const answer = await connectWithForm({ data: { network: network.id, brand, label, values } });
            setBusy(false);
            setResult(answer.ok ? { ok: true, text: `Connected ${answer.identity}` } : { ok: false, text: answer.problem });
            if (answer.ok) {
              setValues({});
              await router.invalidate();
            }
          }}
        >
          {result && <Notice tone={result.ok ? 'ok' : 'bad'}>{result.text}</Notice>}
          {brands.length > 1 && (
            <div className="field">
              <label htmlFor="brand">Brand</label>
              <select id="brand" className="select" value={brand} onChange={(e) => setBrand(e.target.value)}>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
              <small>A launch only ever publishes with its own brand’s accounts.</small>
            </div>
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
            <Notice tone="bad">Instagram Login needs INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET in .env, then a restart of the app.</Notice>
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
            <p className="muted">
              Already connected: {network.accounts.map((a) => a.label).join(', ')}. Connecting the same account again replaces its credential.
            </p>
          )}
        </aside>
      </div>
    </>
  );
}
