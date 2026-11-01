import { Autocomplete } from '@base-ui/react/autocomplete';
import { Dialog } from '@base-ui/react/dialog';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { runRoundNow } from '../../server/automation.functions';
import { launchTitle } from '../../server/launch-list';
import { listLaunches } from '../../server/launches.functions';
import { Icon } from '../kit/Icon';
import { requestTour } from '../tour/request';
import { useToast } from '../Toasts';

interface Command {
  value: string;
  label: string;
  /** Other words it is found by ("settings", "token") */
  keywords?: string;
  /** A word after it: a launch's state */
  hint?: string;
  run: () => void | Promise<void>;
}

interface Group {
  value: string;
  items: Command[];
}

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

interface LaunchHit {
  id: number;
  label: string;
  state: string;
}

/** At most this many lines per group: the palette is a glance, and typing narrows it */
const PER_GROUP = 4;

const matches = (c: Command, q: string) => !q || `${c.label} ${c.keywords ?? ''}`.toLowerCase().includes(q);

/**
 * The search palette (board SearchPalette): ⌘K or Ctrl+K anywhere, or the bars' search, opens it over
 * the screen; typing narrows the newest launches, the sections and the main actions, a few of each,
 * and Enter runs the highlighted one. A Dialog around an inline Autocomplete, so the focus is trapped
 * while it is open, Escape or Cancel closes it and the focus returns where it was.
 */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const router = useRouter();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [launches, setLaunches] = useState<LaunchHit[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isShortcut(e)) return;
      e.preventDefault();
      onOpenChange(!open);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  // The newest launches, read each time it opens: a launch is found by its project, version or article
  useEffect(() => {
    if (!open) {
      setQ('');
      return;
    }
    let alive = true;
    void listLaunches({ data: {} })
      .then((data) => {
        if (!alive) return;
        setLaunches(
          data.launches.map((l) => {
            const t = launchTitle(l);
            const name = t.title.charAt(0).toUpperCase() + t.title.slice(1);
            return { id: l.id, label: t.version ? `${name} ${t.version}` : name, state: l.state.tone === 'waiting' ? 'waiting' : l.state.label.toLowerCase() };
          }),
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open]);

  const all = useMemo<Group[]>(() => {
    const go = (to: string) => () => void navigate({ to });
    return [
      {
        value: 'Go to',
        items: [
          { value: 'go-comments', label: 'Comments', keywords: 'replies answers mentions', run: go('/comments') },
          { value: 'go-stats', label: 'Stats', keywords: 'numbers metrics charts', run: go('/stats') },
          { value: 'go-channels', label: 'Channels', keywords: 'accounts networks', run: go('/channels') },
          { value: 'go-ai', label: 'AI settings', keywords: 'provider model prompts tone claude', run: go('/settings/ai') },
          { value: 'go-automation', label: 'Automation', keywords: 'rounds webhooks polling', run: go('/settings/automation') },
          { value: 'go-launches', label: 'Launches', keywords: 'home releases', run: go('/') },
          { value: 'go-write', label: 'Write', keywords: 'article blog', run: go('/write') },
          { value: 'go-api', label: 'API', keywords: 'tokens rest mcp', run: go('/settings/api') },
          { value: 'go-settings', label: 'Settings', keywords: 'github app configuration brand', run: go('/settings') },
        ],
      },
      {
        value: 'Actions',
        items: [
          { value: 'launch', label: 'Launch a repo', keywords: 'release draft new', run: go('/launch') },
          { value: 'write', label: 'Write an article', keywords: 'post blog new', run: go('/write') },
          { value: 'connect', label: 'Connect an account', keywords: 'channel network add', run: () => void navigate({ to: '/channels', hash: 'add' }) },
          {
            value: 'round',
            label: 'Run an automation round now',
            keywords: 'check releases publish',
            run: async () => {
              const answer = await runRoundNow().catch((error: unknown) => {
                toast.fail(error instanceof Error ? error.message : String(error));
                return null;
              });
              if (!answer) return;
              if (answer.started) toast.done('A round has started', 'It checks for releases, publishes what is ready and reads the numbers when due.');
              else toast.show({ tone: 'wait', title: 'A round is already running' });
              await router.invalidate();
            },
          },
          { value: 'tour', label: 'Take the tour', keywords: 'help guide walkthrough', run: requestTour },
          { value: 'setup', label: 'Finish setting up', keywords: 'onboarding setup brand provider', run: go('/onboarding') },
          { value: 'token', label: 'Create an API token', keywords: 'rest mcp script', run: go('/settings/api') },
          { value: 'sign-out', label: 'Sign out', keywords: 'log out leave', run: signOut },
        ],
      },
    ];
  }, [navigate, router, toast]);

  const groups = useMemo<Group[]>(() => {
    const words = q.trim().toLowerCase();
    const found: Command[] = launches
      .map((l) => ({ value: `launch-${l.id}`, label: l.label, hint: l.state, run: () => void navigate({ to: '/launches/$id', params: { id: String(l.id) } }) }))
      .filter((c) => matches(c, words));
    return [{ value: 'Launches', items: found }, ...all.map((g) => ({ ...g, items: g.items.filter((c) => matches(c, words)) }))]
      .map((g) => ({ ...g, items: g.items.slice(0, PER_GROUP) }))
      .filter((g) => g.items.length > 0);
  }, [q, launches, all, navigate]);

  const choose = (command: Command) => {
    onOpenChange(false);
    void command.run();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="home-palette-scrim" />
        <Dialog.Popup className="home-palette" aria-label="Search">
          <Autocomplete.Root open inline mode="none" items={groups} value={q} onValueChange={(v) => setQ(v)} itemToStringValue={(c: Command) => c.label} autoHighlight="always" keepHighlight>
            <div className="k-hrow k-g8">
              <label className="k-input k-focus k-grow home-palette-field">
                <Icon name="search" />
                <Autocomplete.Input className="home-palette-input" aria-label="Go to or do" placeholder="Go to or do…" />
              </label>
              <Dialog.Close className="k-btn k-ghost k-sm">Cancel</Dialog.Close>
            </div>
            <div className="k-menu k-stack home-palette-list">
              <Autocomplete.Empty className="k-sm k-muted home-palette-empty">Nothing matches. Try “launch”, “write” or “channels”.</Autocomplete.Empty>
              <Autocomplete.List>
                {(group: Group) => (
                  <Autocomplete.Group key={group.value} items={group.items}>
                    <Autocomplete.GroupLabel className="k-lbl home-palette-group">{group.value}</Autocomplete.GroupLabel>
                    <Autocomplete.Collection>
                      {(command: Command) => (
                        <Autocomplete.Item key={command.value} value={command} className="k-mi home-palette-item" onClick={() => choose(command)}>
                          {command.label}
                          <span className="k-grow" />
                          {command.hint && <span className="k-xs k-muted">{command.hint}</span>}
                        </Autocomplete.Item>
                      )}
                    </Autocomplete.Collection>
                  </Autocomplete.Group>
                )}
              </Autocomplete.List>
            </div>
          </Autocomplete.Root>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
