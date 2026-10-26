import { Link, useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { explain } from './errors';
import { Collapsible } from './ui/Collapsible';
import { NotFound, ServerError } from './illustrations';

/**
 * The two pages nobody asks for, each with its postal scene: an address with nothing behind it
 * ("Return to sender") and a page that broke on the way ("Damaged"). Both say what to do next.
 * They render inside the shell when a section fails, and on their own when even that is missing.
 */
export function NotFoundPage() {
  return (
    <section className="problem-page" aria-labelledby="problem-title">
      <NotFound width={320} />
      <div>
        <h1 id="problem-title" className="ph">
          Not here
        </h1>
        <p className="muted">Nothing lives at this address: the launch, account or page may have moved, or never existed.</p>
        <div className="row">
          <Link className="btn btn-primary" to="/">
            Back to the launches
          </Link>
        </div>
      </div>
    </section>
  );
}

export function ErrorPage({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const e = explain(error instanceof Error ? error.message : String(error));
  return (
    <section className="problem-page" aria-labelledby="problem-title">
      <ServerError width={320} />
      <div role="alert">
        <h1 id="problem-title" className="ph">
          Damaged on the way
        </h1>
        <p>
          <strong>{e.title}.</strong> <span className="muted">{e.text}</span>
        </p>
        {e.details && (
          <Collapsible className="toast-details" summary="Details">
            <pre>{e.details}</pre>
          </Collapsible>
        )}
        <div className="row">
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => {
              reset();
              void router.invalidate();
            }}
          >
            Try again
          </button>
          <Link className="btn" to="/">
            Back to the launches
          </Link>
        </div>
      </div>
    </section>
  );
}
