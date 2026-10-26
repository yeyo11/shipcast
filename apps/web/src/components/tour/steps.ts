/*
 * The tour's steps, as data: pure, so the tests check the routes chain up. A step's target is scoped
 * to its page through the shell's `data-path` on <main>, because NextStep moves on as soon as the
 * next step's selector matches: a selector the page being left also matches would skip ahead before
 * the navigation lands.
 */

export const TOUR_NAME = 'shipcast';

export interface TourStep {
  title: string;
  content: string;
  /** The page the step is on */
  route: string;
  selector?: string;
  side?: 'top' | 'bottom' | 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'left-top' | 'left-bottom' | 'right-top' | 'right-bottom';
  nextRoute?: string;
  prevRoute?: string;
  pointerPadding?: number;
  pointerRadius?: number;
  selectorRetryAttempts?: number;
}

const on = (path: string, inside = 'h1') => `main[data-path="${path}"] ${inside}`;

/** The tour: Launches, the newest launch's page (when there is one), Write and its assistant, Channels, Automation */
export function tourSteps({ launchId }: { launchId: number | null }): TourStep[] {
  const launch = launchId === null ? null : `/launches/${launchId}`;
  const steps: Array<Omit<TourStep, 'nextRoute' | 'prevRoute'>> = [
    {
      route: '/',
      selector: on('/'),
      side: 'bottom-left',
      title: 'Launches',
      content: 'Every release Shipcast noticed, or one you launched by hand: where it went and how it did. A launch waiting for you shows on a yellow card, and the bell in the top bar counts what needs you.',
    },
    ...(launch
      ? [
          {
            route: launch,
            selector: on(launch),
            side: 'bottom-left' as const,
            title: 'A launch',
            content: 'Its drafts sit in a pull request on your launches repo. Review them here, edit them with the assistant, and approve: approving publishes on every channel in its mode.',
          },
        ]
      : []),
    {
      route: '/write',
      // The page's title, not the form: the form is taller than a screen, and a card above it lands off-screen
      selector: on('/write'),
      side: 'bottom-left',
      title: 'Write',
      content: 'An article of your own, in your words. Shipcast translates it and writes a piece for each channel you tick.',
    },
    {
      route: '/write',
      selector: on('/write', '[data-tour="assistant"]'),
      side: 'left',
      title: 'The writing assistant',
      content: 'Select a passage for the quick actions (improve, shorten, translate, titles, adapt to a network), or ask beside the text. Every change comes as a diff you accept or reject.',
    },
    {
      route: '/channels',
      selector: on('/channels'),
      side: 'bottom-left',
      title: 'Channels',
      content: 'The accounts you post from, one per network, and whether each publishes on its own, waits for your approval or stays a draft.',
    },
    {
      route: '/settings/automation',
      // Under Settings the page's h1 is Settings; the section's own title is an h2
      selector: on('/settings/automation', 'h2'),
      side: 'bottom-left',
      title: 'Automation',
      content: 'How Shipcast notices a release on its own: rounds every few minutes, or GitHub’s webhooks. Off means only what you start by hand.',
    },
    {
      route: '/settings/automation',
      title: 'That is all',
      content: 'Settings, in the menu under your name, holds the AI, the API and this. Take the tour again from that menu, or from the search (⌘K or Ctrl K).',
    },
  ];
  return steps.map((step, i) => {
    const next = steps[i + 1];
    const prev = steps[i - 1];
    return {
      pointerPadding: 12,
      pointerRadius: 18,
      selectorRetryAttempts: 10,
      ...step,
      ...(next && next.route !== step.route && { nextRoute: next.route }),
      ...(prev && prev.route !== step.route && { prevRoute: prev.route }),
    };
  });
}

export interface Notch {
  /** The card's edge that faces the target */
  edge: 'top' | 'bottom' | 'left' | 'right';
  /** Where along that edge: over the target's start, its middle or its end, as the card is aligned to it */
  align: 'start' | 'center' | 'end';
}

/**
 * The card's notch for a NextStep side (where the card sits relative to the target, after NextStep
 * moves it away from a cut-off edge): "bottom-left" puts the card under the target, left edges
 * aligned, so the notch is on the card's top edge near its left end, over the target's start.
 * Nothing for an unknown side: no notch beats one pointing the wrong way.
 */
export function notchFor(side: string): Notch | null {
  const [main, along] = side.split('-');
  const edge = ({ bottom: 'top', top: 'bottom', left: 'right', right: 'left' } as const)[main as 'bottom' | 'top' | 'left' | 'right'];
  if (!edge) return null;
  if (along === undefined) return { edge, align: 'center' };
  const start = along === 'left' || along === 'top';
  const end = along === 'right' || along === 'bottom';
  if (!start && !end) return null;
  return { edge, align: start ? 'start' : 'end' };
}
