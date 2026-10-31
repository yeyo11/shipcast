import { Link } from '@tanstack/react-router';
import { useRef } from 'react';
import { requestTour } from '../tour/request';
import { tourSteps } from '../tour/steps';
import { Icon } from './Icon';
import { useShell } from './shell';
import { Sheet, SheetClose } from './Sheet';

export interface Owner {
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

/** The owner's picture, or their initial on the hairline disc where there is none */
export function OwnerAvatar({ owner, size }: { owner: Owner; size?: number }) {
  const style = size ? { width: size, height: size, fontSize: Math.round(size * 0.4) } : undefined;
  return (
    <span className="k-av" style={style} aria-hidden="true">
      {owner.avatarUrl ? <img src={owner.avatarUrl} alt="" referrerPolicy="no-referrer" /> : (owner.name ?? owner.login).slice(0, 1).toUpperCase()}
    </span>
  );
}

const STOPS = ['', 'One stop', 'Two stops', 'Three stops', 'Four stops', 'Five stops', 'Six stops', 'Seven stops', 'Eight stops'];

/** The phone's More (board MoreSheet): Channels, Launch, Settings and the tour, then who is signed in */
export function MoreSheet({ owner }: { owner: Owner }) {
  const { moreOpen, setMoreOpen, brokenAccounts } = useShell();
  const signOut = useRef<HTMLFormElement>(null);
  const stops = tourSteps({ launchId: null, phone: true }).length;
  return (
    <Sheet label="More" open={moreOpen} onOpenChange={setMoreOpen} bottom={76}>
      <nav aria-label="More" className="k-stack">
        <SheetClose render={<Link to="/channels" className="k-mi k-more-item" />}>
          <Icon name="channels" size={22} />
          <span className="k-grow">
            <strong>Channels</strong>
            <br />
            <span className="k-xs k-muted">Accounts on each network</span>
          </span>
          {brokenAccounts > 0 ? (
            <span className="k-pill k-p-fail" aria-label={`${brokenAccounts} failing`}>
              {brokenAccounts}
            </span>
          ) : (
            <Icon name="chevronRight" size={18} />
          )}
        </SheetClose>
        <SheetClose render={<Link to="/launch" className="k-mi k-more-item" />}>
          <Icon name="launches" size={22} />
          <span className="k-grow">
            <strong>Launch a repo</strong>
            <br />
            <span className="k-xs k-muted">Or launch from sources</span>
          </span>
          <Icon name="chevronRight" size={18} />
        </SheetClose>
        <SheetClose render={<Link to="/settings" className="k-mi k-more-item" />}>
          <Icon name="menu" size={22} />
          <span className="k-grow">
            <strong>Settings</strong>
            <br />
            <span className="k-xs k-muted">General, AI, Automation, API</span>
          </span>
          <Icon name="chevronRight" size={18} />
        </SheetClose>
        <button
          type="button"
          className="k-mi k-more-item"
          onClick={() => {
            setMoreOpen(false);
            requestTour();
          }}
        >
          <Icon name="help" size={22} />
          <span className="k-grow">
            <strong>Take the tour</strong>
            <br />
            <span className="k-xs k-muted">{STOPS[stops] ?? `${stops} stops`}, two minutes</span>
          </span>
          <Icon name="chevronRight" size={18} />
        </button>
        <div className="k-sep" />
        <div className="k-mi k-more-item">
          <OwnerAvatar owner={owner} size={32} />
          <span className="k-grow">
            <strong>@{owner.login}</strong>
            <br />
            <span className="k-xs k-muted">Signed in with GitHub</span>
          </span>
          <button type="button" className="k-btn k-sm" onClick={() => signOut.current?.requestSubmit()}>
            Sign out
          </button>
          <form ref={signOut} method="post" action="/auth/logout" hidden />
        </div>
      </nav>
    </Sheet>
  );
}
