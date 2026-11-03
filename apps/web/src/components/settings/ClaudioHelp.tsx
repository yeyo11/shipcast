import { CLAUDIO_HELP } from './ai';

/** claudio's help line: what it is and a link to its repository, which opens in a new tab */
export function ClaudioHelp({ className = 'k-xs k-muted st-m0' }: { className?: string }) {
  return (
    <p className={className}>
      {CLAUDIO_HELP.text}{' '}
      <a href={CLAUDIO_HELP.href} target="_blank" rel="noreferrer">
        Learn more
        <span className="visually-hidden"> (opens in a new tab)</span>
      </a>
    </p>
  );
}
