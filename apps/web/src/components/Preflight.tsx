import type { Preflight as Result } from '@shipcast/engine';
import { Pill } from './ui';

const NAMES: Record<string, string> = { release: 'Release', launchYml: 'launch.yml', license: 'License', readme: 'README', demo: 'Demo' };

/** The pre-flight checks, each a word and a shape: what passed, what blocks, what is only advised */
export function Preflight({ result }: { result: Result }) {
  return (
    <ul className="checklist" aria-label="Pre-flight checks">
      {result.checks.map((c) => (
        <li key={c.id}>
          <Pill tone={c.ok ? 'published' : c.required ? 'failed' : 'manual'}>{c.ok ? 'Ready' : c.required ? 'Blocks' : 'Advice'}</Pill>
          <span>
            <strong>{NAMES[c.id] ?? c.id}.</strong> {c.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}
