import type { ReactNode } from 'react';
import { languageName, type Language } from '@shipcast/schema/languages';
import { CHANNEL_NAMES } from '../../server/view';
import { Icon } from '../kit/Icon';

/*
 * The form pieces Launch a repo, Launch from sources and Write share, drawn as their boards draw
 * them: the segmented choice, the channel chips, the radio rows and cards, the bar the primary
 * action sits in above the bottom bar.
 */

export interface SegOption<V extends string> {
  value: V;
  label: string;
}

/**
 * One of a few, as the board's pill row: a radio group whose radios are buttons. `tone` is the
 * chosen one's fill: yellow for a setting (the language), the text colour for a mode switch.
 */
export function Seg<V extends string>({ label, options, value, onChange, tone = 'yellow' }: { label: string; options: ReadonlyArray<SegOption<V>>; value: V; onChange: (value: V) => void; tone?: 'yellow' | 'text' }) {
  return (
    <div className={`k-seg${tone === 'text' ? ' wr-seg-text' : ''}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'k-on' : undefined}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            // A radio group moves with the arrows, as a native one does
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            e.preventDefault();
            const at = options.findIndex((x) => x.value === value);
            const next = options[(at + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length];
            if (next) {
              onChange(next.value);
              const group = e.currentTarget.parentElement;
              requestAnimationFrame(() => group?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus());
            }
          }}
          tabIndex={o.value === value ? 0 : -1}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The languages an article may be written in: the brand's, named, its primary first */
export const langOptions = (languages: readonly Language[]): ReadonlyArray<SegOption<Language>> => languages.map((value) => ({ value, label: languageName(value) }));

/** The channels to publish on besides the blog, as chips that toggle */
export function ChannelChips({ ready, chosen, onChange, disabled }: { ready: readonly string[]; chosen: readonly string[]; onChange: (next: string[]) => void; disabled?: boolean }) {
  return (
    <div className="k-chips">
      {ready.map((c) => {
        const on = chosen.includes(c);
        return (
          <button
            key={c}
            type="button"
            className={`k-chip${on ? ' k-on' : ''}`}
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(on ? chosen.filter((x) => x !== c) : [...chosen, c])}
          >
            {on && <Icon name="check" size={16} strokeWidth={3} />}
            {CHANNEL_NAMES[c] ?? c}
          </button>
        );
      })}
    </div>
  );
}

/** A plain radio row (Write's "How it is published"): the native radio, drawn as the board's ring */
export function RadioRow({ name, checked, onChange, children }: { name: string; checked: boolean; onChange: () => void; children: ReactNode }) {
  return (
    <label className="k-hrow k-g10 k-sm wr-radio-row">
      <input type="radio" className="visually-hidden wr-radio-input" name={name} checked={checked} onChange={onChange} />
      <span className={`k-radio${checked ? ' k-on' : ''}`} aria-hidden="true" />
      {children}
    </label>
  );
}

/** A radio as a card with a line under it (Launch a repo's "How it is published") */
export function RadioCard({ name, checked, onChange, title, detail }: { name: string; checked: boolean; onChange: () => void; title: string; detail: string }) {
  return (
    <label className={`k-card wr-radio-card${checked ? ' wr-on' : ''}`}>
      <input type="radio" className="visually-hidden wr-radio-input" name={name} checked={checked} onChange={onChange} />
      <span className={`k-radio${checked ? ' k-on' : ''}`} aria-hidden="true" />
      <span>
        <strong className="k-sm">{title}</strong>
        <br />
        <span className="k-xs k-muted">{detail}</span>
      </span>
    </label>
  );
}

/**
 * The bar the screen's one yellow action sits in: on a phone fixed above the bottom bar, within
 * reach of the thumb while the form scrolls; from 960 px in the page's flow under the form.
 */
export function ActionBar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`k-bar wr-actionbar${className ? ` ${className}` : ''}`}>{children}</div>;
}
