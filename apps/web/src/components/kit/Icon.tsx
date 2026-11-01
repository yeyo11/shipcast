import type { CSSProperties, ReactNode } from 'react';

/*
 * The redesign's line icons, drawn on the board's 24 px grid with a 2.25 stroke. One name per glyph,
 * so a screen says `<Icon name="retry" />` the way its board does. Channel marks are not here: they
 * are the networks' own glyphs (ChannelGlyph).
 */

const PATHS = {
  chevronDown: <path d="M7 10l5 5 5-5" />,
  chevronRight: <path d="M9.5 6l6 6-6 6" />,
  chevronLeft: <path d="M14.5 6l-6 6 6 6" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  retry: <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" />,
  more: <path strokeWidth="3" d="M5 12h.01M12 12h.01M19 12h.01" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5L20 20" />
    </>
  ),
  comments: <path d="M5 5h14v10H10l-5 4z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  launches: (
    <>
      <path d="M4 8l8-4 8 4v8l-8 4-8-4z" />
      <path d="M4 8l8 4 8-4M12 12v8" />
    </>
  ),
  stats: <path d="M5 19V11M10 19V5M15 19v-6M20 19V9" />,
  bell: (
    <>
      <path d="M12 2.5V5M6.5 15.5v-5a5.5 5.5 0 0 1 11 0v5l1.75 1.75H4.75z" />
      <path d="M10.25 19.75a1.75 1.75 0 0 0 3.5 0" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5.5" width="16" height="14" rx="2.5" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  assist: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18" />,
  filter: <path d="M4 6h16M7 12h10M10 18h4" />,
  write: (
    <>
      <path d="M14.5 5.5l4 4L9 19H5v-4z" />
      <path d="M12.5 7.5l4 4" />
    </>
  ),
  download: <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14" />,
  send: <path d="M4.5 12L20 4.5 15.5 20l-3.5-6.5L4.5 12zM12 13.5l8-9" />,
  external: <path d="M13.5 4.5h6v6M19.5 4.5L11 13M17 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1H10" />,
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.75 9.5a2.25 2.25 0 114 1.4c-.9.7-1.75 1.2-1.75 2.6M12 16.75h.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="11" height="11" rx="2.5" />
      <path d="M5 15V6.5A1.5 1.5 0 0 1 6.5 5H15" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  history: <path d="M4 12a8 8 0 108-8 8 8 0 00-6 2.7M4 4.5v3.2h3.2M12 8v4.25l2.75 1.75" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <circle cx="9" cy="10" r="1.75" />
      <path d="M20.5 16l-5-5L6 19" />
    </>
  ),
  trash: <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5" />,
  channels: (
    <>
      <path d="M4 10v4h3l8 4V6L7 10z" />
      <path d="M18.5 9.5a3.5 3.5 0 010 5" />
    </>
  ),
  upload: <path d="M12 3.5v10M8 9.5l4 4 4-4M4.5 14v4.5a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V14" />,
  key: (
    <>
      <circle cx="8" cy="15" r="3.5" />
      <path d="M10.5 12.5L19 4M16 7l2.5 2.5M14 9l2 2" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

interface IconProps {
  name: IconName;
  size?: number;
  /** The board draws a few glyphs heavier (the check on a yellow card: 3) */
  strokeWidth?: number;
  style?: CSSProperties;
  className?: string;
}

export function Icon({ name, size = 20, strokeWidth = 2.25, style, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={{ flex: 'none', ...style }}
    >
      {PATHS[name]}
    </svg>
  );
}

/** The failure diamond: the shape that says "failed" next to its word */
export function Diamond({ size = 10 }: { size?: number }) {
  return <span className="k-diamond" style={{ width: size, height: size }} aria-hidden="true" />;
}
