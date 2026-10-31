import type { Preflight as Result } from '@shipcast/engine';

const NAMES: Record<string, string> = { release: 'Release', launchYml: 'launch.yml', license: 'License', readme: 'README', demo: 'Demo' };

/** The pre-flight checks, each a word and a shape: what passed, what blocks, what is only advised */
export function Preflight({ result }: { result: Result }) {
  return (
    <ul className="k-card wr-checks" aria-label="Pre-flight checks">
      {result.checks.map((c) => (
        <li key={c.id} className="k-row wr-check">
          <span className={`k-pill ${c.ok ? 'k-p-pub' : c.required ? 'k-p-fail' : 'k-p-quiet'}`}>{c.ok ? 'Ready' : c.required ? 'Blocks' : 'Advice'}</span>
          <span className="k-sm">
            <strong>{NAMES[c.id] ?? c.id}.</strong> {c.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}
