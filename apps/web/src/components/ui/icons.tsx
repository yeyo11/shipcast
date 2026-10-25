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
