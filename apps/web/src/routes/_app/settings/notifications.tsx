import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useToast } from '../../../components/Toasts';
import { shortDay } from '../../../components/settings/view';
import { browserSupport, currentSubscription, deviceLabel, endpointHash, subscribe, subscriptionJson, type PushSupport } from '../../../pwa/push-client';
import type { EventKind, PushDeviceView } from '../../../server/push-api';
import { getNotifications, removePushDevice, savePushEvents, sendTestPush, subscribePush } from '../../../server/push.functions';

export const Route = createFileRoute('/_app/settings/notifications')({
  head: () => ({ meta: [{ title: 'Notifications · Shipcast' }] }),
  loader: () => getNotifications(),
  component: Notifications,
});

const UNSUPPORTED: Record<Exclude<PushSupport, 'ok'>, string> = {
  'install-first': 'On iPhone and iPad, add Shipcast to the Home Screen first (Share, then Add to Home Screen) and turn notifications on from the app it adds.',
  unsupported: 'This browser cannot take push notifications.',
  'no-worker': 'Notifications need the built app: the development server has no service worker.',
};

/**
 * Settings → Notifications (docs/push.md): this device's toggle, what it is told, a test, and the
 * other devices that take notifications. The browser asks for the permission only on the toggle.
 */
function Notifications() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const toast = useToast();
  const [support, setSupport] = useState<PushSupport | null>(null);
  const [blocked, setBlocked] = useState(false);
  // This browser's row, found by its endpoint's fingerprint; undefined while it is being read
  const [mine, setMine] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const found = browserSupport();
    setSupport(found);
    if (found !== 'ok') return setMine(null);
    setBlocked(Notification.permission === 'denied');
    void currentSubscription()
      .then(async (subscription) => setMine(subscription ? await endpointHash(subscription.endpoint) : null))
      .catch(() => setMine(null));
  }, []);

  const device = data.devices.find((d) => d.endpointHash === mine);
  const others = data.devices.filter((d) => d !== device);
  const ready = data.configured && support === 'ok' && !blocked && mine !== undefined;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
      await router.invalidate();
    } catch (error) {
      toast.fail(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const turnOn = () =>
    run(async () => {
      if (!data.publicKey) return;
      const subscription = await subscribe(data.publicKey);
      if (subscription === 'denied') {
        setBlocked(Notification.permission === 'denied');
        toast.show({ tone: 'bad', title: 'Notifications not allowed', text: 'The browser did not allow them; allow them for this site in its settings, then try again.' });
        return;
      }
      await subscribePush({ data: { ...subscriptionJson(subscription), label: deviceLabel(navigator.userAgent) } });
      setMine(await endpointHash(subscription.endpoint));
      toast.done('Notifications on', 'This device is told what you choose below.');
    });

  const turnOff = () =>
    run(async () => {
      const subscription = await currentSubscription();
      if (subscription) {
        await removePushDevice({ data: { endpoint: subscription.endpoint } });
        await subscription.unsubscribe();
      } else if (device) await removePushDevice({ data: { deviceId: device.id } });
      setMine(null);
      toast.done('Notifications off', 'This device is told nothing more.');
    });

  const choose = (target: PushDeviceView, kind: EventKind, on: boolean) => run(async () => void (await savePushEvents({ data: { deviceId: target.id, events: { [kind]: on } } })));

  const test = (target: PushDeviceView) =>
    run(async () => {
      const sent = await sendTestPush({ data: { deviceId: target.id } });
      if (sent.ok) toast.done('Test notification sent', 'It should show on this device within a few seconds.');
      else toast.show({ tone: 'bad', title: 'Not sent', text: sent.problem });
    });

  return (
    <div className="st-content">
      <p className="st-lead">Shipcast tells this device when something needs you, or when a launch is out.</p>
      <div className="st-cards">
        {!data.configured && (
          <section className="k-card st-g12" aria-labelledby="st-push-off">
            <h2 id="st-push-off" className="k-d k-d30">
              Not configured
            </h2>
            <p className="k-sm k-muted st-m0">
              {data.problem ? `Push is not configured on this server: ${data.problem}.` : 'Push is not configured on this server: its VAPID keys are not set.'} Nothing is sent until they are (docs/push.md).
            </p>
          </section>
        )}

        <section className="k-card st-rowcard" aria-label="This device">
          <span className="k-grow">
            <strong id="st-push-device">This device</strong>
            <br />
            <span className="k-xs k-muted">
              {support === null || mine === undefined
                ? 'Checking this browser…'
                : support !== 'ok'
                  ? UNSUPPORTED[support]
                  : blocked
                    ? 'Notifications are blocked for this site: allow them in the browser’s settings, then come back.'
                    : device
                      ? `${device.label}: on.`
                      : `${deviceLabel(navigator.userAgent)}: off. Turning them on asks the browser for permission.`}
            </span>
          </span>
          <button
            type="button"
            className={`k-sw${device ? ' k-on' : ''}`}
            role="switch"
            aria-checked={device !== undefined}
            aria-labelledby="st-push-device"
            disabled={busy || (!device && !ready)}
            onClick={() => void (device ? turnOff() : turnOn())}
          />
        </section>

        {device && (
          <section className="k-card st-g0" aria-labelledby="st-push-events">
            <h2 id="st-push-events" className="k-d k-d30 st-mb6">
              Tell this device about
            </h2>
            {data.events.map((e) => {
              const on = device.events[e.kind];
              return (
                <div key={e.kind} className="k-row">
                  <span className="k-grow">
                    <span id={`st-push-${e.kind}`}>{e.label}</span>
                    <br />
                    <span className="k-xs k-muted">{e.help}</span>
                  </span>
                  <button type="button" className={`k-sw${on ? ' k-on' : ''}`} role="switch" aria-checked={on} aria-labelledby={`st-push-${e.kind}`} disabled={busy} onClick={() => void choose(device, e.kind, !on)} />
                </div>
              );
            })}
            <div className="k-row">
              <button type="button" className="k-btn k-sm" disabled={busy || !data.configured} onClick={() => void test(device)}>
                Send a test notification
              </button>
            </div>
          </section>
        )}

        {others.length > 0 && (
          <section className="k-card st-g0" aria-labelledby="st-push-others">
            <h2 id="st-push-others" className="k-d k-d30 st-mb6">
              Other devices
            </h2>
            {others.map((d) => (
              <div key={d.id} className="k-row">
                <span className="k-grow">
                  <strong className="k-sm">{d.label}</strong>
                  <br />
                  <span className="k-xs k-muted">
                    On since {shortDay(d.createdAt)}
                    {d.lastSuccessAt ? ` · last told ${shortDay(d.lastSuccessAt)}` : ''}
                    {d.lastFailure ? ` · last failure: ${d.lastFailure}` : ''}
                  </span>
                </span>
                <button type="button" className="k-btn k-sm" disabled={busy} onClick={() => void run(async () => void (await removePushDevice({ data: { deviceId: d.id } })))}>
                  Remove
                </button>
              </div>
            ))}
          </section>
        )}

        <p className="k-xs k-muted st-m0">
          On iPhone and iPad, notifications reach only Shipcast added to the Home Screen, on iOS 16.4 or later: open it from there and turn them on in this page. A notification says what happened and opens the page for it; it never shows a comment or a draft.
        </p>
      </div>
    </div>
  );
}
