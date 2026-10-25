import { Autocomplete } from '@base-ui/react/autocomplete';
import { Dialog } from '@base-ui/react/dialog';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { useEffect, useId, useMemo, useState } from 'react';
import { runRoundNow } from '../../server/automation.functions';
import { useToast } from '../Toasts';
import { SearchIcon } from './icons';

interface Command {
  value: string;
  label: string;
  /** Other words it is found by ("settings", "token") */
  keywords?: string;
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

/**
 * The command palette, after Linear's: ⌘K or Ctrl+K anywhere opens it, typing filters the sections
 * and the main actions, Enter runs the highlighted one. A Dialog around an inline Autocomplete, so
 * the focus is trapped while it is open, Escape closes it and the focus returns where it was.
 */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const router = useRouter();
  const toast = useToast();
  const hintId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isShortcut(e)) return;
      e.preventDefault();
      onOpenChange(!open);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const groups = useMemo<Group[]>(() => {
    const go = (to: string) => () => void navigate({ to });
    return [
      {
        value: 'Go to',
        items: [
          { value: 'go-launches', label: 'Launches', keywords: 'home releases', run: go('/') },
          { value: 'go-write', label: 'Write', keywords: 'article blog', run: go('/write') },
          { value: 'go-channels', label: 'Channels', keywords: 'accounts networks', run: go('/channels') },
          { value: 'go-stats', label: 'Stats', keywords: 'numbers metrics charts', run: go('/stats') },
          { value: 'go-automation', label: 'Automation', keywords: 'rounds webhooks polling', run: go('/automation') },
          { value: 'go-ai', label: 'AI settings', keywords: 'provider model prompts tone claude', run: go('/ai') },
          { value: 'go-api', label: 'API', keywords: 'tokens rest mcp', run: go('/tokens') },
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
          { value: 'token', label: 'Create an API token', keywords: 'rest mcp script', run: go('/tokens') },
          { value: 'sign-out', label: 'Sign out', keywords: 'log out leave', run: signOut },
        ],
      },
    ];
  }, [navigate, router, toast]);

  const choose = (command: Command) => {
    onOpenChange(false);
    void command.run();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-backdrop" />
        <Dialog.Viewport className="ui-dialog-viewport ui-palette-viewport">
          <Dialog.Popup className="ui-dialog ui-palette" aria-label="Command palette">
            <Autocomplete.Root
              open
              inline
              items={groups}
              itemToStringValue={(c: Command) => `${c.label} ${c.keywords ?? ''}`}
              autoHighlight="always"
              keepHighlight
            >
              <div className="ui-palette-search">
                <SearchIcon />
                <Autocomplete.Input className="ui-palette-input" aria-label="Search sections and actions" aria-describedby={hintId} placeholder="Go to or do…" />
                <kbd className="ui-kbd">Esc</kbd>
              </div>
              <div className="ui-palette-list">
                <Autocomplete.Empty className="ui-empty">Nothing matches. Try “launch”, “write” or “channels”.</Autocomplete.Empty>
                <Autocomplete.List>
                  {(group: Group) => (
                    <Autocomplete.Group key={group.value} items={group.items} className="ui-group">
                      <Autocomplete.GroupLabel className="ui-group-label">{group.value}</Autocomplete.GroupLabel>
                      <Autocomplete.Collection>
                        {(command: Command) => (
                          <Autocomplete.Item key={command.value} value={command} className="ui-option" onClick={() => choose(command)}>
                            {command.label}
                          </Autocomplete.Item>
                        )}
                      </Autocomplete.Collection>
                    </Autocomplete.Group>
                  )}
                </Autocomplete.List>
              </div>
              <p id={hintId} className="ui-palette-hint">
                <kbd className="ui-kbd">↑</kbd> <kbd className="ui-kbd">↓</kbd> to move, <kbd className="ui-kbd">Enter</kbd> to go
              </p>
            </Autocomplete.Root>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
