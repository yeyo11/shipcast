import { ageWords, type TotalAge } from '../server/launch-summary';

/**
 * When a total was last read, quietly under it ("read 12 min ago"), and its source's lag where it
 * has one by design (Search Console's 2–3 days). Worded on the client's clock, so the server's render
 * may be a minute off.
 */
export function NumberAge({ age }: { age: TotalAge }) {
  return (
    <dd className="k-xs k-muted" title={age.lag} suppressHydrationWarning>
      {ageWords(age)}
    </dd>
  );
}
