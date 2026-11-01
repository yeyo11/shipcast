import { Autocomplete } from '@base-ui/react/autocomplete';
import { Dialog } from '@base-ui/react/dialog';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Attention } from '../../server/attention';
import { runRoundNow } from '../../server/automation.functions';
import { getChannels } from '../../server/channels.functions';
import { listLaunches } from '../../server/launches.functions';
import { Icon } from '../kit/Icon';
import { NetworkGlyph } from '../kit/NetworkGlyph';
import { requestTour } from '../tour/request';
import { useToast } from '../Toasts';
import { connectGroups, emptyGroups, needsEntries, sequenceTarget, tryGroup, typedGroups, type PaletteEntry, type PaletteGroup, type PaletteIcon, type PaletteLaunch, type PaletteNetwork, type PalettePill } from './palette';

/** Sign out is a POST, as in the header's form, so the palette posts a form of its own */
function signOut() {
  const form = document.createElement('form');
  form.method = 'post';
  form.action = '/auth/logout';
  document.body.append(form);
  form.submit();
}

/** Whether the shortcut is the platform's: ⌘K on Apple devices, Ctrl+K elsewhere */
const isShortcut = (e: KeyboardEvent) => e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;

/** Whether a key press belongs to something the owner is typing in, where N and L are letters */
const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');

/** How long the second key of a sequence (N, then L) is waited for */
const SEQUENCE_MS = 1200;

/**
 * The label of the shortcut for this device. The server cannot know the platform, so the first
 * render says Ctrl K everywhere and an Apple device corrects it once hydrated, without a mismatch.
 */
export function useShortcutLabel(): string {
  const [label, setLabel] = useState('Ctrl K');
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) setLabel('⌘K');
  }, []);
  return label;
}

const PILL: Record<PalettePill['tone'], string> = { published: 'k-p-pub', waiting: 'k-p-wait', failed: 'k-p-fail', draft: 'k-p-run', quiet: 'k-p-quiet', line: 'k-p-line' };

function EntryIcon({ icon }: { icon: PaletteIcon }) {
  if (icon.kind === 'failed')
    return (
      <span className="home-palette-ic is-bad">
        <span className="home-palette-dia" />
      </span>
    );
  return <span className={`home-palette-ic${icon.bad ? ' is-bad' : ''}`}>{icon.kind === 'network' ? <NetworkGlyph channel={icon.network} size={15} /> : <Icon name={icon.name} size={16} />}</span>;
}

function Title({ entry }: { entry: PaletteEntry }) {
  const { title, hit } = entry;
  return (
    <span className="home-palette-t">
      {hit ? (
        <>
          {title.slice(0, hit[0])}
          <span className="home-palette-hit">{title.slice(hit[0], hit[1])}</span>
          {title.slice(hit[1])}
        </>
      ) : (
        title
      )}
      {entry.version && <span className="home-palette-v">{entry.version}</span>}
    </span>
  );
}

interface Loaded {
  launches: PaletteLaunch[];
  timezone: string;
}

/**
 * The search palette (boards DesktopSearch*, SearchPalette*): ⌘K or Ctrl+K anywhere, or the bars'
 * search, opens it. An empty field lists what needs the owner, the newest launches and the main
 * actions; typing finds launches, articles, accounts, sections and actions; "Connect an account" is a
 * step inside it, listing the networks. A Dialog around an inline Autocomplete, so the focus is
 * trapped while it is open, Escape (or Cancel on a phone) closes it and the focus returns where it was.
 * The lines themselves are built in palette.ts.
 */
export function CommandPalette({ open, onOpenChange, attention, onOpened, owner }: { open: boolean; onOpenChange: (open: boolean) => void; attention: Attention | null; onOpened?: () => void; owner: string | null }) {
  const navigate = useNavigate();
  const router = useRouter();
  const toast = useToast();
  const shortcut = useShortcutLabel();
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [step, setStep] = useState<'connect' | null>(null);
  const [loaded, setLoaded] = useState<Loaded>({ launches: [], timezone: 'UTC' });
  const [found, setFound] = useState<PaletteLaunch[]>([]);
  const [networks, setNetworks] = useState<PaletteNetwork[]>([]);

  // ⌘K toggles it; N then L or W goes to an action, when the owner is not typing and no dialog is open
  useEffect(() => {
    let previous: { key: string; at: number } | null = null;
    const onKey = (e: KeyboardEvent) => {
      if (isShortcut(e)) {
        e.preventDefault();
        onOpenChange(!open);
        return;
      }
      if (open || e.metaKey || e.ctrlKey || e.altKey || e.repeat || isEditable(e.target) || document.querySelector('[role="dialog"], [role="alertdialog"]')) {
        previous = null;
        return;
      }
      const fresh = previous && e.timeStamp - previous.at < SEQUENCE_MS ? previous.key : null;
      const to = sequenceTarget(fresh, e.key);
      previous = to ? null : { key: e.key, at: e.timeStamp };
      if (to) {
        e.preventDefault();
        void navigate({ href: to });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange, navigate]);

  // Read each time it opens: the newest launches, the accounts and what needs the owner
  useEffect(() => {
    if (!open) {
      setQ('');
      setStep(null);
      setFound([]);
      return;
    }
    onOpened?.();
    let alive = true;
    void listLaunches({ data: {} })
      .then((data) => alive && setLoaded({ launches: data.launches, timezone: data.timezone }))
      .catch(() => {});
    void getChannels()
      .then((data) => alive && setNetworks(data.networks))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, onOpened]);

  // Typed words search every launch, not only the newest page; the newest stay while the answer comes
  const words = q.trim();
  useEffect(() => {
    if (!open || !words || step) return;
    let alive = true;
    const timer = setTimeout(() => {
      void listLaunches({ data: { q: words } })
        .then((data) => alive && setFound(data.launches))
        .catch(() => {});
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, words, step]);

  const now = useMemo(() => new Date(), [open]);
  const needs = useMemo(() => needsEntries(attention?.items ?? [], loaded.launches, networks, now), [attention, loaded.launches, networks, now]);

  const { groups, empty } = useMemo<{ groups: PaletteGroup[]; empty: boolean }>(() => {
    if (step === 'connect') return { groups: connectGroups(networks, q), empty: false };
    if (!words) return { groups: emptyGroups({ needs, launches: loaded.launches, networks, timezone: loaded.timezone, now }), empty: false };
    const launches = [...found, ...loaded.launches.filter((l) => !found.some((f) => f.id === l.id))];
    const typed = typedGroups(words, { needs, launches, networks, timezone: loaded.timezone, now });
    return typed.length > 0 ? { groups: typed, empty: false } : { groups: [tryGroup(words, owner)], empty: true };
  }, [step, networks, q, words, needs, loaded, found, owner, now]);

  const back = () => {
    setStep(null);
    setQ('');
  };

  // The field is mounted again with each step: the focus goes back into it
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open, step]);

  const choose = (entry: PaletteEntry) => {
    const run = entry.run;
    if (run.kind === 'step') {
      setStep(run.step);
      setQ('');
      return;
    }
    onOpenChange(false);
    if (run.kind === 'href') {
      void navigate({ href: run.href });
      return;
    }
    if (run.command === 'tour') requestTour();
    else if (run.command === 'sign-out') signOut();
    else void runRound();
  };

  const runRound = async () => {
    const answer = await runRoundNow().catch((error: unknown) => {
      toast.fail(error instanceof Error ? error.message : String(error));
      return null;
    });
    if (!answer) return;
    if (answer.started) toast.done('A round has started', 'It checks for releases, publishes what is ready and reads the numbers when due.');
    else toast.show({ tone: 'wait', title: 'A round is already running' });
    await router.invalidate();
  };

  const onFieldKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (step && e.key === 'Backspace' && e.currentTarget.value === '') {
      e.preventDefault();
      back();
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="home-palette-scrim" />
        <Dialog.Popup className="home-palette" aria-label="Search" initialFocus={input}>
          <Autocomplete.Root
            // A step is a new list: mounted again, its first line is the highlighted one, not the line under the pointer
            key={step ?? 'search'}
            open
            inline
            mode="none"
            items={groups}
            value={q}
            onValueChange={(v, details) => {
              // Choosing a line is not typing: the field keeps the words (a step empties it itself)
              if (details.reason !== 'item-press') setQ(v);
            }}
            itemToStringValue={(e: PaletteEntry) => e.title}
            autoHighlight="always"
            keepHighlight
          >
            <div className="home-palette-top">
              <label className="home-palette-field">
                {step ? (
                  <>
                    <button type="button" className="k-btn k-icon k-sm k-ghost home-palette-back" aria-label="Back" onClick={back}>
                      <Icon name="chevronLeft" size={18} />
                    </button>
                    <span className="home-palette-tok">
                      <Icon name="channels" size={16} />
                      Connect an account
                    </span>
                  </>
                ) : (
                  <span className="k-muted home-palette-glass">
                    <Icon name="search" />
                  </span>
                )}
                <Autocomplete.Input ref={input} className="home-palette-input" aria-label="Go to or do" placeholder={step ? 'Pick a network…' : 'Go to or do…'} onKeyDown={onFieldKey} />
                <kbd className="k-kbd home-palette-esc">esc</kbd>
              </label>
              <Dialog.Close className="k-btn k-ghost k-sm home-palette-cancel">Cancel</Dialog.Close>
            </div>
            <div className="home-palette-list">
              {empty && (
                <div className="home-palette-empty">
                  <strong>Nothing matches “{words}”.</strong>
                  <span className="k-sm k-muted">It looks in launches, articles, accounts, sections and actions. Comments are not searched yet.</span>
                </div>
              )}
              <Autocomplete.List>
                {(group: PaletteGroup) => (
                  <Autocomplete.Group key={group.id} items={group.items} className="home-palette-groupbox">
                    <Autocomplete.GroupLabel className="home-palette-group">
                      {group.label}
                      {group.count !== undefined && <span className="home-palette-n">· {group.count}</span>}
                    </Autocomplete.GroupLabel>
                    <Autocomplete.Collection>
                      {(entry: PaletteEntry) => (
                        <Autocomplete.Item
                          key={entry.id}
                          value={entry}
                          className="home-palette-item"
                          onClick={() => choose(entry)}
                          // An autocomplete selects nothing, so Base UI leaves aria-selected out: the highlighted line is the selected option
                          render={(props, state) => <div {...props} aria-selected={state.highlighted} />}
                        >
                          <EntryIcon icon={entry.icon} />
                          <Title entry={entry} />
                          {entry.meta && <span className="home-palette-m">{entry.meta}</span>}
                          {entry.pill && <span className={`k-pill ${PILL[entry.pill.tone]}`}>{entry.pill.label}</span>}
                          {entry.keys && (
                            <span className="home-palette-k">
                              {entry.keys.map((k) => (
                                <kbd key={k} className="k-kbd">
                                  {k}
                                </kbd>
                              ))}
                            </span>
                          )}
                          {entry.run.kind === 'step' && (
                            <span className="k-muted home-palette-chev">
                              <Icon name="chevronRight" size={18} />
                            </span>
                          )}
                          <kbd className="k-kbd home-palette-enter" aria-hidden="true">
                            ↵
                          </kbd>
                        </Autocomplete.Item>
                      )}
                    </Autocomplete.Collection>
                  </Autocomplete.Group>
                )}
              </Autocomplete.List>
            </div>
            <div className="home-palette-foot" aria-hidden="true">
              {step && (
                <span>
                  <kbd className="k-kbd">⌫</kbd>Back
                </span>
              )}
              <span>
                <kbd className="k-kbd">↑</kbd>
                <kbd className="k-kbd">↓</kbd>Move
              </span>
              <span>
                <kbd className="k-kbd">↵</kbd>
                {step ? 'Connect' : 'Open'}
              </span>
              <span>
                <kbd className="k-kbd">esc</kbd>Close
              </span>
              <span className="k-grow" />
              <span>
                <kbd className="k-kbd">{shortcut}</kbd>anywhere
              </span>
            </div>
          </Autocomplete.Root>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
