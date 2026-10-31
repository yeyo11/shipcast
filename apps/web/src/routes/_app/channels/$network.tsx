import { createFileRoute, Link, notFound, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { NetworkGlyph } from '../../../components/channels/NetworkGlyph';
import type { AccountView, NetworkView } from '../../../components/channels/sheets';
import { stateOf } from '../../../components/channels/view';
import { TopBar } from '../../../components/kit/Bars';
import { Icon } from '../../../components/kit/Icon';
import { ProfileReview, reviewStanding, type ProfileView } from '../../../components/ProfileReview';
import { useToast } from '../../../components/Toasts';
import { Select } from '../../../components/ui/Select';
import { connectWithForm, getChannels } from '../../../server/channels.functions';
import { groupOf } from '../../../server/network-groups';
import { getProfileReview } from '../../../server/profiles.functions';

export const Route = createFileRoute('/_app/channels/$network')({
  validateSearch: (search: Record<string, unknown>): { problem?: string; review?: number } => ({
    ...(typeof search.problem === 'string' && { problem: search.problem }),
    // A review's job links back here, to its account's review
    ...(typeof search.review === 'number' && Number.isInteger(search.review) && { review: search.review }),
  }),
  loader: async ({ params }) => {
    const data = await getChannels();
    const network = data.networks.find((n) => n.id === params.network);
    if (!network) throw notFound();
    // Each account's profile capability and latest review; null for a network with no profile
    const reviews = await Promise.all(network.accounts.map((a) => getProfileReview({ data: a.id })));
    return { network, brands: data.brands, oauthReady: data.oauthReady, secretsKind: data.secretsKind, reviews, now: data.now };
  },
  head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.network.name ?? 'Channel'} · Shipcast` }] }),
  component: NetworkPage,
});

/** Where an OAuth network's authorisation starts: the brand, the name and (Mastodon) the instance go with it */
function oauthHref(network: NetworkView, brand: string, label: string, instance: string | undefined): string {
  return `/auth/${network.id}?${new URLSearchParams({ brand, label, ...(network.id === 'mastodon' ? { instance: instance ?? '' } : {}) })}`;
}

/** What the network needs set up before it can be authorised, when the owner's app is missing */
function needsApp(network: NetworkView, oauthReady: Record<string, boolean>): string | null {
  if (!(network.id in oauthReady) || oauthReady[network.id]) return null;
  const what = network.id === 'linkedin' || network.id === 'reddit' ? `${network.name} app’s client id and secret` : `${network.name} app id and secret`;
  return `Connecting ${network.name} needs your ${what}: set them in Settings.`;
}

function NetworkPage() {
  const { network, reviews, now } = Route.useLoaderData();
  const search = Route.useSearch();
  const index = network.accounts.findIndex((a) => a.id === search.review);
  const reviewed = index >= 0 ? network.accounts[index] : undefined;
  if (reviewed)
    return (
      <>
        <TopBar back={{ label: network.name, to: `/channels/${network.id}` }} />
        <div className="ch-page">
          <div className="k-px ch-net ch-narrow">
            <ProfileReview key={reviewed.id} account={{ id: reviewed.id, label: reviewed.label, failed: stateOf(reviewed.status) === 'failed' }} network={network} initial={reviews[index] ?? null} now={now} />
          </div>
        </div>
      </>
    );
  return <Connect />;
}

/** A broken account of an OAuth network (board ChannelNetwork): what failed, and the way to authorise it again */
function Reconnect({ network, account, brand, ready }: { network: NetworkView; account: AccountView; brand: string; ready: string | null }) {
  return (
    <div className="k-card k-fail ch-card">
      <div className="k-hrow k-g10">
        <span className="k-av" aria-hidden="true">
          {account.avatarUrl ? <img src={account.avatarUrl} alt="" referrerPolicy="no-referrer" /> : account.label.replace(/^@/, '').slice(0, 1).toUpperCase()}
        </span>
        <div className="k-grow k-stack">
          <strong className="k-ellipsis">{account.label}</strong>
          <span className="k-xs ch-bad">◆ {account.problem ?? 'Its last check failed'}</span>
        </div>
      </div>
      <p className="k-sm k-muted ch-flush">{network.channel ? `Nothing goes out to ${network.name} with it until it works again.` : `Its numbers are not read until it works again.`}</p>
      {ready ? (
        <div className="k-notice k-bad">
          <div className="k-grow">
            {ready.replace(/ Settings\.$/, ' ')}
            <Link to="/settings">Settings</Link>.
          </div>
        </div>
      ) : (
        <>
          <a className="k-btn k-pri k-full" href={oauthHref(network, brand, account.label, account.settings.instance)}>
            <Icon name="external" size={18} />
            Continue to {network.name}
          </a>
          <span className="k-xs k-muted ch-center">You authorise Shipcast there and come back here.</span>
        </>
      )}
    </div>
  );
}

function Connect() {
  const { network, brands, oauthReady, secretsKind, reviews } = Route.useLoaderData();
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
    void navigate({ to: '/channels/$network', params: { network: network.id }, search: (prev) => ({ ...prev, problem: undefined }), replace: true });
  }, [search.problem, network.id, navigate, toast]);
  const failed = network.accounts.filter((a) => stateOf(a.status) === 'failed');
  const ready = needsApp(network, oauthReady);
  const oauth = network.auth === 'oauth';
  const pasting = oauth && Boolean(values.accessToken?.trim());
  // An OAuth network with a broken account is authorised again from its card; the form is for a new one
  const showForm = !(oauth && failed.length > 0);
  const firstSecret = network.fields.find((f) => f.secret);
  const profiles = network.accounts.map((a, i) => ({ account: a, view: (reviews[i] ?? null) as ProfileView | null })).filter((p) => p.view?.capability);
  const perms = (
    <ul className="k-sm ch-perms">
      {network.permissions.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  );

  return (
    <>
      <TopBar back={{ label: 'Channels', to: '/channels', search: { tab: groupOf(network) } }} />
      <div className="ch-page">
        <div className="k-px k-stack k-g16 ch-net ch-narrow">
          <div className="k-hrow k-g12">
            <span className={`k-ic ch-net-ic${failed.length > 0 ? ' ch-ic-fail' : ''}`}>
              <NetworkGlyph network={network} size={24} />
            </span>
            <h1 className="k-d k-d48">{network.name}</h1>
          </div>
          {failed.map((a) =>
            oauth ? (
              <Reconnect key={a.id} network={network} account={a} brand={brand} ready={ready} />
            ) : (
              <div key={a.id} className="k-notice k-bad">
                <div className="k-grow">
                  <strong>{a.label}</strong> <span className="ch-bad">◆ {a.problem ?? 'Its last check failed'}</span>. Fill the form below again with a new credential: connecting the same account replaces it.
                </div>
              </div>
            ),
          )}
          {showForm && (
            <>
              <p className="k-muted ch-flush">{network.howTo}</p>
              <form
                className="k-stack k-g16"
                onSubmit={async (e) => {
                  e.preventDefault();
                  // An OAuth network can also take a pasted token, for when the authorisation cannot come back here
                  if (oauth && !pasting) {
                    window.location.href = oauthHref(network, brand, label, values.instance);
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
                  <Select label="Brand" options={brands.map((b) => ({ value: b.id, label: b.name }))} value={brand} onValueChange={setBrand} help="A launch only ever publishes with its own brand’s accounts." />
                )}
                {network.fields.map((field) => {
                  const help = [field.help, !oauth && field === firstSecret ? `Checked before it is saved; kept in ${secretsKind}.` : null, field.optional && !field.help ? 'Optional' : null].filter(Boolean).join('. ');
                  const id = `field-${field.key}`;
                  return (
                    <div className="k-field" key={field.key}>
                      <label className="k-lbl" htmlFor={id}>
                        {field.label}
                      </label>
                      {field.multiline ? (
                        <textarea
                          id={id}
                          className="k-input ch-input k-mono"
                          rows={5}
                          placeholder={field.placeholder}
                          value={values[field.key] ?? ''}
                          onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                          required={!field.optional}
                          autoComplete="off"
                        />
                      ) : (
                        <input
                          id={id}
                          className="k-input ch-input k-mono"
                          type={field.secret ? 'password' : 'text'}
                          placeholder={field.placeholder}
                          value={values[field.key] ?? ''}
                          onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                          required={!field.optional}
                          autoComplete="off"
                          aria-describedby={help ? `${id}-help` : undefined}
                        />
                      )}
                      {help && (
                        <span className="k-help" id={`${id}-help`}>
                          {help}
                        </span>
                      )}
                    </div>
                  );
                })}
                <div className="k-field">
                  <label className="k-lbl" htmlFor="field-label">
                    Name
                  </label>
                  <input id="field-label" className="k-input ch-input" placeholder="The account’s own name, if left empty" value={label} onChange={(e) => setLabel(e.target.value)} aria-describedby="field-label-help" />
                  <span className="k-help" id="field-label-help">
                    Optional
                  </span>
                </div>
                {ready && !pasting ? (
                  <div className="k-notice k-bad">
                    <div className="k-grow">
                      {ready.replace(/ Settings\.$/, ' ')}
                      <Link to="/settings">Settings</Link>.
                    </div>
                  </div>
                ) : (
                  <div className="k-stack k-g10">
                    <button className="k-btn k-pri k-full" type="submit" disabled={busy}>
                      {oauth && !pasting ? (
                        <>
                          <Icon name="external" size={18} />
                          Continue to {network.name}
                        </>
                      ) : busy ? (
                        'Checking the credential…'
                      ) : (
                        `Connect ${network.name}`
                      )}
                    </button>
                    {oauth && !pasting && <span className="k-xs k-muted ch-center">You authorise Shipcast there and come back here.</span>}
                    {network.accounts.length > 0 && <span className="k-xs k-muted ch-center">Connecting an account that is already here replaces its credential.</span>}
                  </div>
                )}
              </form>
            </>
          )}
          {profiles.map(({ account, view }) => {
            const standing = reviewStanding(view);
            return (
              <section key={account.id} className="k-card ch-card" aria-labelledby={`review-${account.id}`}>
                <div className="k-hrow k-between k-g8">
                  <h2 className="k-d k-d30" id={`review-${account.id}`}>
                    Profile review
                  </h2>
                  <span className={`k-pill ${standing.tone}`}>{standing.pill}</span>
                </div>
                <p className="k-sm k-muted ch-flush">
                  {profiles.length > 1 ? `${account.label}. ` : ''}
                  {standing.reviewed ? 'The AI read the profile, how the account grew and your brand. Nothing changes until you apply a proposal.' : 'The AI reads the profile, how the account grew and your brand, and proposes what to change. Nothing changes until you apply it.'}
                </p>
                <Link className="k-btn k-full" to="/channels/$network" params={{ network: network.id }} search={{ review: account.id }}>
                  {standing.reviewed ? 'See the proposals' : 'Review this profile'}
                </Link>
              </section>
            );
          })}
          {network.accounts.length > 0 ? (
            <details className="k-card k-flat ch-details">
              <summary className="k-hrow k-between">
                <strong className="k-sm">What Shipcast does with it</strong>
                <Icon name="chevronDown" size={18} />
              </summary>
              {perms}
            </details>
          ) : (
            <section className="k-card k-flat ch-perms-card">
              <h2 className="k-lbl ch-white">What Shipcast does with it</h2>
              {perms}
            </section>
          )}
        </div>
      </div>
    </>
  );
}
