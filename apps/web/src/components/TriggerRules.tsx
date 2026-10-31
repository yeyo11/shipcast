import { CHANNEL_NAMES } from '../server/view';
import { Icon } from './kit/Icon';
import type { RuleDraft } from './settings/rules';

export { ruleTitle, ruleWithout, type RuleDraft } from './settings/rules';

/**
 * One rule's details, in the sheet a rule's title opens (board SettingsAutomation shows only the
 * summary and the switch): the event, the repos, pre-releases and what a repo without launch.yml gets.
 * Controlled, so the page's save bar saves it with the other rules.
 */
export function RuleEditor({
  n,
  rule,
  channels,
  onChange,
  onRemove,
  onDone,
}: {
  n: number;
  rule: RuleDraft;
  channels: readonly string[];
  onChange: (change: Partial<RuleDraft>) => void;
  onRemove: () => void;
  onDone: () => void;
}) {
  return (
    <>
      <h2 className="k-d k-d30">Rule {n}</h2>
      <div className="k-field">
        <span className="k-lbl">When</span>
        <div className="k-seg" role="radiogroup" aria-label="When">
          <button type="button" role="radio" aria-checked={rule.event === 'release'} className={rule.event === 'release' ? 'k-on' : undefined} onClick={() => onChange({ event: 'release' })}>
            A release
          </button>
          <button type="button" role="radio" aria-checked={rule.event === 'public'} className={rule.event === 'public' ? 'k-on' : undefined} onClick={() => onChange({ event: 'public', prereleases: false })}>
            A repo goes public
          </button>
        </div>
      </div>
      <label className="k-field">
        <span className="k-lbl">Repos</span>
        <input className="k-input st-input" value={rule.repos} onChange={(e) => onChange({ repos: e.target.value })} spellCheck={false} autoComplete="off" />
        <span className="k-help">* for every repo, owner/* for an account’s, or owner/name for one.</span>
      </label>
      {rule.event === 'release' && (
        <button type="button" className="k-row st-checkrow" role="checkbox" aria-checked={rule.prereleases} onClick={() => onChange({ prereleases: !rule.prereleases })}>
          <span className={`k-check${rule.prereleases ? ' k-on' : ''}`}>{rule.prereleases && <Icon name="check" size={16} strokeWidth={3} />}</span>
          <span className="k-grow">Pre-releases too</span>
        </button>
      )}
      <div className="k-field">
        <span className="k-lbl">A repo without .github/launch.yml</span>
        <div className="k-seg" role="radiogroup" aria-label="A repo without .github/launch.yml">
          <button type="button" role="radio" aria-checked={rule.channels === null} className={rule.channels === null ? 'k-on' : undefined} onClick={() => onChange({ channels: null })}>
            Leave it alone
          </button>
          <button type="button" role="radio" aria-checked={rule.channels !== null} className={rule.channels !== null ? 'k-on' : undefined} onClick={() => onChange({ channels: rule.channels ?? ['blog'] })}>
            Launch it
          </button>
        </div>
        {rule.channels !== null && (
          <div className="k-chips" role="group" aria-label="On these channels">
            {channels.map((c) => {
              const on = rule.channels?.includes(c) ?? false;
              return (
                <button
                  key={c}
                  type="button"
                  className={`k-chip${on ? ' k-on' : ''}`}
                  aria-pressed={on}
                  onClick={() => onChange({ channels: on ? (rule.channels ?? []).filter((x) => x !== c) : [...(rule.channels ?? []), c] })}
                >
                  {CHANNEL_NAMES[c] ?? c}
                </button>
              );
            })}
          </div>
        )}
        <span className="k-help">
          {rule.channels === null ? 'Only repos with a launch.yml are launched, on the channels it names.' : 'Each channel waits for your approval. A repo with a launch.yml keeps its own channels.'}
        </span>
      </div>
      <div className="k-hrow k-g10">
        <button type="button" className="k-btn k-danger" onClick={onRemove}>
          <Icon name="trash" size={18} />
          Remove
        </button>
        <button type="button" className="k-btn k-grow" onClick={onDone}>
          Done
        </button>
      </div>
    </>
  );
}
