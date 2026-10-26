import { useState } from 'react';
import { Parcels, Typewriter } from './illustrations';

/*
 * A project's picture beside its title on the launch cards and rows (docs/web-app.md): the GitHub
 * avatar of the repo's owner, or, when there is none or it fails to load, one of our own scenes by
 * the launch's kind (the parcels for a release, the typewriter for an article). Decorative: the
 * title beside it already names the project. A `logo:` in launch.yml is the hook for later.
 */
export function ProjectAvatar({ src, article }: { src: string | null; article: boolean }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="project-avatar" aria-hidden="true">
      {src && !failed ? (
        <img src={src} alt="" width={40} height={40} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : article ? (
        <Typewriter width={64} />
      ) : (
        <Parcels width={64} />
      )}
    </span>
  );
}
