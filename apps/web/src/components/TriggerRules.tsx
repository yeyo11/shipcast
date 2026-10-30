import { CHANNEL_NAMES } from '../server/view';
import { Select } from './ui/Select';

/** A trigger rule as the Automation page edits it (docs/launch-triggers.md); the engine checks it on save */
export interface RuleDraft {
  id: string;
  enabled: boolean;
  event: 'release' | 'public';
  repos: string;
  prereleases: boolean;
  /** Null: a repo with no launch.yml is left alone; a list: it is launched on these, each waiting for approval */
  channels: string[] | null;
}

const EVENTS = [
  { value: 'release' as const, label: 'A release is published' },
  { value: 'public' as const, label: 'A repo is made public' },
];

/** A new rule's id, unlike every other's */
function freshId(rules: readonly RuleDraft[]): string {
  for (let n = rules.length + 1; ; n++) if (!rules.some((r) => r.id === `rule-${n}`)) return `rule-${n}`;
}

/**
 * The trigger rules, in order: an event takes the first enabled rule it matches. A controlled list,
 * so the page's one save bar saves it with the rest of Automation.
 */
export function TriggerRules({ rules, channels, onChange }: { rules: RuleDraft[]; channels: readonly string[]; onChange: (rules: RuleDraft[]) => void }) {
  const set = (i: number, change: Partial<RuleDraft>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...change } : r)));
  return (
    <div className="form">
      {rules.length === 0 && <p className="muted">No rules: no GitHub event creates a launch. Launch by hand, or add a rule.</p>}
      {rules.map((rule, i) => (
        <fieldset key={rule.id} className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label">
            Rule {i + 1} <span className="muted mono">{rule.id}</span>
          </legend>
          <div className="row">
            <label className="check">
              <input type="checkbox" checked={rule.enabled} onChange={(e) => set(i, { enabled: e.target.checked })} />
              On
            </label>
            <button type="button" className="btn btn-small" onClick={() => onChange(rules.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
          <Select label="When" options={EVENTS} value={rule.event} onValueChange={(event) => set(i, { event, ...(event === 'public' && { prereleases: false }) })} />
          <div className="field">
            <label htmlFor={`rule-repos-${rule.id}`}>Repos</label>
            <input id={`rule-repos-${rule.id}`} className="input mono" value={rule.repos} onChange={(e) => set(i, { repos: e.target.value })} spellCheck={false} autoComplete="off" style={{ maxWidth: 320 }} />
            <small>* for every repo, owner/* for an account’s, or owner/name for one.</small>
          </div>
          {rule.event === 'release' && (
            <label className="check">
              <input type="checkbox" checked={rule.prereleases} onChange={(e) => set(i, { prereleases: e.target.checked })} />
              Pre-releases too
            </label>
          )}
          <div className="field">
            <span className="label">A repo without .github/launch.yml</span>
            <div className="seg">
              <label>
                <input type="radio" name={`rule-without-${rule.id}`} checked={rule.channels === null} onChange={() => set(i, { channels: null })} />
                <span>Leave it alone</span>
              </label>
              <label>
                <input type="radio" name={`rule-without-${rule.id}`} checked={rule.channels !== null} onChange={() => set(i, { channels: rule.channels ?? ['blog'] })} />
                <span>Launch it on these channels</span>
              </label>
            </div>
            {rule.channels !== null && (
              <div className="checks">
                {channels.map((c) => (
                  <label className="check" key={c}>
                    <input
                      type="checkbox"
                      checked={rule.channels!.includes(c)}
                      onChange={(e) => set(i, { channels: e.target.checked ? [...rule.channels!, c] : rule.channels!.filter((x) => x !== c) })}
                    />
                    {CHANNEL_NAMES[c] ?? c}
                  </label>
                ))}
              </div>
            )}
            <small>
              {rule.channels === null
                ? 'Only repos with a launch.yml are launched, on the channels it names.'
                : 'Each channel waits for your approval. A repo with a launch.yml keeps its own channels.'}
            </small>
          </div>
        </fieldset>
      ))}
      <div className="row">
        <button
          type="button"
          className="btn btn-small"
          onClick={() => onChange([...rules, { id: freshId(rules), enabled: true, event: 'release', repos: '*', prereleases: false, channels: null }])}
        >
          Add a rule
        </button>
      </div>
    </div>
  );
}
