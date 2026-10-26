import type { SVGProps } from 'react';

/*
 * The few interface glyphs the components need, drawn in currentColor on a 24-unit grid with the
 * same round joins as the illustrations. Always decorative: the control around them carries the name.
 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Glyph({ size = 20, children, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
      {children}
    </svg>
  );
}

export const CheckIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Glyph>
);
export const CaretIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M7 10l5 5 5-5" />
  </Glyph>
);
export const CloseIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Glyph>
);
export const CalendarIcon = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="4" y="5.5" width="16" height="14" rx="2.5" />
    <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
  </Glyph>
);
export const ChevronIcon = ({ dir = 'right', ...p }: IconProps & { dir?: 'left' | 'right' }) => (
  <Glyph {...p}>
    <path d={dir === 'left' ? 'M14.5 6l-6 6 6 6' : 'M9.5 6l6 6-6 6'} />
  </Glyph>
);
export const DownloadIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14" />
  </Glyph>
);
export const SearchIcon = (p: IconProps) => (
  <Glyph {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M15.5 15.5L20 20" />
  </Glyph>
);
export const DotsIcon = (p: IconProps) => (
  <Glyph {...p} strokeWidth={3}>
    <path d="M5 12h.01M12 12h.01M19 12h.01" />
  </Glyph>
);
/** Launches: a parcel, the set's own subject */
export const LaunchesIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M4 8l8-4 8 4v8l-8 4-8-4z" />
    <path d="M4 8l8 4 8-4M12 12v8" />
  </Glyph>
);
export const WriteIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M14.5 5.5l4 4L9 19H5v-4z" />
    <path d="M12.5 7.5l4 4" />
  </Glyph>
);
/** Channels: a megaphone, as in the NoAccounts scene */
export const ChannelsIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M4 10v4h3l8 4V6L7 10z" />
    <path d="M18.5 9.5a3.5 3.5 0 010 5" />
  </Glyph>
);
export const StatsIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M5 19V11M10 19V5M15 19v-6M20 19V9" />
  </Glyph>
);
export const MoreIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Glyph>
);
/** The writing assistant: a spark, as in the OnboardAI scene */
export const SparkIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18" />
  </Glyph>
);
export const ChatIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M5 5h14v10H10l-5 4z" />
  </Glyph>
);
export const HelpIcon = (p: IconProps) => (
  <Glyph {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9.75 9.5a2.25 2.25 0 114 1.4c-.9.7-1.75 1.2-1.75 2.6M12 16.75h.01" />
  </Glyph>
);
