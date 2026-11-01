import { Tabs as Base } from '@base-ui/react/tabs';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { TopBar } from '../kit/Bars';
import { Icon } from '../kit/Icon';

/*
 * A launch's heading (boards LaunchDetail, LaunchReview, LaunchDrafting, LaunchFailed): the phone's
 * top bar back to the launches, the project in display type beside its version, the actions behind
 * ⋯, then its state as a pill and where it comes from. Every state of the launch page starts here.
 */
export function LaunchHead({
  name,
  version,
  pill,
  meta,
  onMenu,
  primary,
}: {
  name: string;
  version: string | null;
  pill: { label: string; className: string };
  meta: ReactNode;
  /** Opens the launch's menu, hung from the ⋯ given */
  onMenu?: (anchor: HTMLElement) => void;
  /** The page's yellow action beside the ⋯ (a failed release's "Launch it again" on a desktop) */
  primary?: ReactNode;
}) {
  return (
    <>
      <TopBar back={{ label: 'Launches', to: '/' }} />
      {/* A desktop's way back, small above the title (board DesktopLaunchMenu); the phone's is the top bar */}
      <div className="k-desktop">
        <Link to="/" className="k-hrow k-g4 k-sm pub-back">
          <Icon name="chevronLeft" size={16} />
          All launches
        </Link>
      </div>
      <div className="k-px k-stack k-g10 pub-head">
        <div className="k-hrow k-between k-g8 pub-head-top">
          <div className="k-hrow k-g10 k-wrap pub-head-title">
            <h1 className="k-d k-d48">{name}</h1>
            {version && <span className="k-mono k-muted pub-version">{version}</span>}
          </div>
          {(onMenu || primary) && (
            <div className="k-hrow k-g8">
              {primary}
              {onMenu && (
                <button type="button" className="k-btn k-icon" aria-label="More actions" aria-haspopup="menu" onClick={(event) => onMenu(event.currentTarget)}>
                  <Icon name="more" />
                </button>
              )}
            </div>
          )}
        </div>
        <div className="k-hrow k-g10 k-wrap pub-head-state">
          <span className={`k-pill ${pill.className}`}>{pill.label}</span>
          <span className="k-sm k-muted">{meta}</span>
        </div>
      </div>
    </>
  );
}

export interface LaunchTab<V extends string> {
  value: V;
  label: string;
  /** A count beside the label (drafts waiting), in the board's small disc */
  count?: number;
  panel: ReactNode;
}

/** The launch page's four tabs, underlined in yellow; arrow keys move between them (Base UI's tabs) */
export function LaunchTabs<V extends string>({ value, onValueChange, tabs }: { value: V; onValueChange: (next: V) => void; tabs: ReadonlyArray<LaunchTab<V>> }) {
  return (
    <Base.Root value={value} onValueChange={(next) => onValueChange(next as V)} className="pub-tabs-root">
      <div className="pub-tabs-wrap">
        <Base.List className="k-tabs pub-tabs" aria-label="This launch" activateOnFocus>
          {tabs.map((t) => (
            <Base.Tab key={t.value} value={t.value} className="k-tab">
              {t.label}
              {t.count !== undefined && t.count > 0 && <span className="k-n">{t.count}</span>}
            </Base.Tab>
          ))}
        </Base.List>
      </div>
      {tabs.map((t) => (
        <Base.Panel key={t.value} value={t.value} className="pub-panel">
          {t.panel}
        </Base.Panel>
      ))}
    </Base.Root>
  );
}
