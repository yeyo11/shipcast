import { createFileRoute } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { PageHead } from '../../../components/PageHead';
import { useToast } from '../../../components/Toasts';
import { Pill } from '../../../components/ui';
import { Combobox } from '../../../components/ui/Combobox';
import { ConfirmButton } from '../../../components/ui/ConfirmButton';
import { Dialog, DialogClose } from '../../../components/ui/Dialog';
import { Drawer } from '../../../components/ui/Drawer';
import { DotsIcon } from '../../../components/ui/icons';
import { Menu } from '../../../components/ui/Menu';
import { Popover } from '../../../components/ui/Popover';
import { Select } from '../../../components/ui/Select';
import { Tabs } from '../../../components/ui/Tabs';
import { Tooltip } from '../../../components/ui/Tooltip';

// Not in the navigation: the component layer running, for the owner to review each Base UI wrapper
// in Cartel before and after it is used in a page (docs/decisions/component-layer.md)
export const Route = createFileRoute('/_app/design/components')({
  head: () => ({ meta: [{ title: 'Components · Shipcast' }] }),
  component: Components,
});

const REPOS = ['claudio', 'shipcast', 'launches', 'pando', 'sluice', 'dotfiles', 'blog', 'cartel-specimen', 'tiny-cli', 'notes'].map((name, i) => ({
  value: `owner/${name}`,
  label: name,
  hint: `pushed 2026-10-${String(25 - i).padStart(2, '0')}`,
}));

const RELEASES = [
  { value: 'v0.9.0', label: 'v0.9.0', hint: 'Remote sessions · 2026-10-24' },
  { value: 'v0.8.2', label: 'v0.8.2', hint: 'Fixes · 2026-10-11' },
  { value: 'v0.8.0', label: 'v0.8.0', hint: 'Projects · 2026-09-30 · pre-release' },
];

function Specimen({ name, children, text }: { name: string; text: string; children: ReactNode }) {
  return (
    <section className="spec" aria-labelledby={`spec-${name}`}>
      <div className="spec-name">
        <h2 className="ph" id={`spec-${name}`}>
          {name}
        </h2>
        <p className="muted">{text}</p>
      </div>
      <div className="spec-body">{children}</div>
    </section>
  );
}

function Components() {
  const toast = useToast();
  const [repo, setRepo] = useState<string | null>(null);
  const [release, setRelease] = useState<string | null>('v0.9.0');
  const [channel, setChannel] = useState<'bluesky' | 'mastodon' | 'hn'>('bluesky');
  return (
    <>
      <PageHead title="Components" action={<button className="btn btn-primary" type="button" onClick={() => toast.done('The primary action', 'One yellow per view.')}>Primary action</button>}>
        Base UI wearing Cartel only: every part styled in <code>styles/components.css</code> with the role tokens, states from Base UI’s data attributes.
      </PageHead>

      <Specimen name="Toast" text="useToast().done / fail / show. Successes leave after six seconds; failures stay. Hover or focus pauses; swipe right or down to dismiss; F6 reaches them.">
        <div className="row">
          <button className="btn" type="button" onClick={() => toast.done('Mastodon synced', '1,204 followers · 312 posts.')}>
            Done
          </button>
          <button className="btn" type="button" onClick={() => toast.fail('Mastodon rejected the credential (401 Unauthorized)')}>
            Failed
          </button>
          <button className="btn" type="button" onClick={() => toast.show({ tone: 'wait', title: 'Copy the token now', text: 'It is shown only this once.' })}>
            Waiting for you
          </button>
        </div>
      </Specimen>

      <Specimen name="Dialog" text="Modal, focus trapped, Escape and the backdrop close it, focus returns to the trigger.">
        <Dialog
          title="Edit the post"
          description="A dialog holds a task that needs the whole attention for a moment."
          trigger={<button className="btn" type="button">Open a dialog</button>}
          footer={
            <>
              <DialogClose>Cancel</DialogClose>
              <DialogClose className="btn btn-primary">Save the post</DialogClose>
            </>
          }
        >
          <div className="field">
            <label htmlFor="spec-dialog-text">Text</label>
            <textarea id="spec-dialog-text" className="textarea" defaultValue="claudio 0.9 is out. Start a session on your laptop and pick it up from your phone." />
          </div>
        </Dialog>
      </Specimen>

      <Specimen name="Alert dialog" text="Replaces window.confirm: the question, the consequence, Cancel focused first, the verb on the confirming button.">
        <div className="row">
          <ConfirmButton className="btn btn-danger" title="Disconnect Mastodon?" description="Its credential is deleted from the keychain." confirm="Disconnect" onConfirm={() => toast.done('Disconnected (not really)')}>
            Disconnect
          </ConfirmButton>
          <ConfirmButton className="btn" tone="primary" title="Rotate the webhook secret?" description="Every webhook on GitHub must be given the new one." confirm="Rotate the secret" onConfirm={() => undefined}>
            Rotate the secret
          </ConfirmButton>
        </div>
      </Specimen>

      <Specimen name="Combobox" text="A long list with a search: filters by the name and the hint, arrow keys and Enter pick.">
        <div className="form">
          <Combobox label="Repository" placeholder="Type a repo’s name" options={REPOS} value={repo} onValueChange={setRepo} />
        </div>
      </Specimen>

      <Specimen name="Select" text="A short list without a search, in place of a native select.">
        <div className="form">
          <Select label="Release" mono options={RELEASES} value={release} onValueChange={setRelease} />
        </div>
      </Specimen>

      <Specimen name="Menu" text="Secondary actions behind one button, for rows that would carry five.">
        <Menu
          align="start"
          trigger={
            <button type="button" className="btn btn-small" aria-label="More for @owner@mastodon.social">
              <DotsIcon />
            </button>
          }
          entries={[
            { label: 'Check the credential', onSelect: () => toast.done('It works') },
            { label: 'Publish with this one', onSelect: () => undefined },
            { label: 'Rename', onSelect: () => undefined },
            { kind: 'separator' },
            { kind: 'link', label: 'Open the profile', href: '#' },
          ]}
        />
      </Specimen>

      <Specimen name="Tabs" text="Cartel's segmented control: arrow keys move, the list scrolls sideways on a phone instead of overflowing.">
        <Tabs
          label="Drafts by channel"
          value={channel}
          onValueChange={setChannel}
          tabs={[
            { value: 'bluesky', label: 'Bluesky', panel: <p>claudio 0.9 is out: start a session on your laptop, pick it up from your phone.</p> },
            { value: 'mastodon', label: 'Mastodon', panel: <p>claudio 0.9: remote sessions, on any device you own. #claude #cli</p> },
            { value: 'hn', label: 'Hacker News', panel: <p><Pill tone="manual">Post it yourself</Pill></p> },
          ]}
        />
      </Specimen>

      <Specimen name="Tooltip" text="The full text of something clamped, or a shortcut; never the only place it lives.">
        <div className="row">
          <Tooltip content="https://mastodon.social/@josegarridodev/113000000000000000">
            <a href="#spec-Tooltip" className="clamp" style={{ maxWidth: 220 }}>
              mastodon.social/@josegarridodev/113000000000000000
            </a>
          </Tooltip>
          <Tooltip content="Go to or do anything (Ctrl K)">
            <button className="btn btn-small" type="button">
              Hover or focus me
            </button>
          </Tooltip>
        </div>
      </Specimen>

      <Specimen name="Popover" text="A small card anchored to its trigger: an explanation or a few controls.">
        <Popover title="Why manual?" trigger={<button className="btn btn-small" type="button">Why is Reddit manual?</button>}>
          <p>Reddit and Hacker News are always drafts: Shipcast writes them, you post them yourself.</p>
        </Popover>
      </Specimen>

      <Specimen name="Drawer" text="The phone's More: a sheet from the bottom, swiped down, Escape or the backdrop to close.">
        <Drawer title="A drawer" trigger={<button className="btn" type="button">Open a drawer</button>}>
          <p className="muted">It holds the rest of the sections on a phone, and the signed-in account.</p>
        </Drawer>
      </Specimen>

      <Specimen name="Command palette" text="⌘K or Ctrl+K anywhere: the sections and the main actions, filtered as you type.">
        <p className="muted">
          Press <kbd className="ui-kbd">Ctrl K</kbd> (or <kbd className="ui-kbd">⌘K</kbd>), or use Search in the top bar.
        </p>
      </Specimen>
    </>
  );
}
