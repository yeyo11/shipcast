/*
 * The drawing kit every scene shares, so the set keeps one hand: Cartel's role tokens only (the day
 * theme then comes for free), one outline weight, and depth as a hard offset copy of the shape in the
 * stamp colour, the same as --sc-stamp-sm/lg on cards. No filters, no blur, no gradients.
 */
import { createContext, useContext, useId, type ReactElement, type ReactNode } from 'react';

/** Ink for outlines and print: black in both themes, like every Cartel outline */
export const INK = 'var(--sc-black)';
/** Paper: the cream of cards on a yellow band */
export const PAPER = 'var(--sc-cream)';
/** A second, whiter paper, for a sheet lying on another (an envelope under a stamp) */
export const SHEET = 'var(--sc-on-black)';
export const YELLOW = 'var(--sc-yellow)';
/** The offset copy: the text colour at night, black by day, as under every yellow thing */
export const SHADOW = 'var(--sc-stamp)';
/** Red is for the failure scenes only, and always carries its word */
export const FAILURE = 'var(--sc-failure)';
/**
 * Print on a red seal: the page colour, because it is the one that passes on both reds (dark on the
 * night's light red, white on the day's deep red), where black or white alone would fail one theme
 */
export const ON_FAILURE = 'var(--sc-ground)';
/** A wall or a grid behind the subject, in the control-border grey: there, never louder than it */
export const RAIL = 'var(--sc-rail)';
/** Lines drawn straight on the page (floors, cords, motion) follow the text around the drawing */
export const LINE = 'currentColor';

/** The outline at the 320-unit frame: 2 px at 160 px wide, 4 px at 320 */
export const OUTLINE = 4;

export interface IllustrationProps {
  /** What the drawing shows, for a drawing that says something the page does not; else decorative */
  title?: string;
  className?: string;
  /** Width in CSS pixels or any length; the height follows the 4:3 frame */
  width?: number | string;
}

const SceneId = createContext('sc-illo');

/**
 * The frame: 320 × 240 (4:3), scaled by the width it is given. The patterns' ids come from useId so
 * two copies of a scene on one page never share (and break) each other's halftone.
 */
export function Scene({ title, className, width, children, motion }: IllustrationProps & { children: ReactNode; motion?: string }) {
  const id = `sc-illo-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg
      viewBox="0 0 320 240"
      width={width}
      className={className ? `sc-illo ${className}` : 'sc-illo'}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-labelledby={title ? `${id}-title` : undefined}
      focusable="false"
      fill="none"
      strokeWidth={OUTLINE}
      strokeLinejoin="round"
      strokeLinecap="round"
      style={{ display: 'block', height: 'auto', maxWidth: '100%', overflow: 'visible' }}
    >
      {title && <title id={`${id}-title`}>{title}</title>}
      <defs>
        <pattern id={`${id}-ink`} width="6" height="6" patternUnits="userSpaceOnUse">
          <circle cx="3" cy="3" r="1.3" fill={INK} />
        </pattern>
        <pattern id={`${id}-ground`} width="8" height="8" patternUnits="userSpaceOnUse">
          <circle cx="4" cy="4" r="1.5" fill={LINE} />
        </pattern>
      </defs>
      {/* The one motion a scene may have, off for anyone who asked for less */}
      {motion && <style>{`@media (prefers-reduced-motion: no-preference) { ${motion} }`}</style>}
      <SceneId.Provider value={id}>{children}</SceneId.Provider>
    </svg>
  );
}

/** Ink halftone, for the shaded face of a box: a fill value */
export function useShade(): string {
  return `url(#${useContext(SceneId)}-ink)`;
}

export function useSceneId(): string {
  return useContext(SceneId);
}

/** A disc of printed dots on the page behind the subject, the house's halftone "sun" */
export function Halftone({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  const id = useContext(SceneId);
  return <circle cx={cx} cy={cy} r={r} fill={`url(#${id}-ground)`} stroke="none" />;
}

export interface Paint {
  fill: string;
  stroke: string;
}

/**
 * A shape with its stamp: drawn once offset in the stamp colour, then on top in its own fill with
 * the ink outline. The shape is a function so both copies are the same geometry.
 */
export function Stamped({ shape, fill, offset = 6 }: { shape: (paint: Paint) => ReactElement; fill: string; offset?: number }) {
  return (
    <>
      <g transform={`translate(${offset} ${offset})`}>{shape({ fill: SHADOW, stroke: SHADOW })}</g>
      {shape({ fill, stroke: INK })}
    </>
  );
}

type Face = 'display' | 'mono' | 'text';
const FONTS: Record<Face, { family: string; weight: number; spacing: string }> = {
  display: { family: 'var(--sc-font-display)', weight: 900, spacing: '-0.02em' },
  mono: { family: 'var(--sc-font-mono)', weight: 700, spacing: '0' },
  text: { family: 'var(--sc-font-text)', weight: 700, spacing: '0' },
};

/** Lettering in the house faces; display is always uppercase, as everywhere in Cartel */
export function Letters({
  x,
  y,
  size,
  children,
  face = 'display',
  fill = INK,
  anchor = 'middle',
  rotate,
}: {
  x: number;
  y: number;
  size: number;
  children: string;
  face?: Face;
  fill?: string;
  anchor?: 'start' | 'middle' | 'end';
  rotate?: number;
}) {
  const f = FONTS[face];
  return (
    <text
      x={x}
      y={y}
      fill={fill}
      stroke="none"
      textAnchor={anchor}
      transform={rotate ? `rotate(${rotate} ${x} ${y})` : undefined}
      style={{ fontFamily: f.family, fontWeight: f.weight, fontSize: size, letterSpacing: f.spacing, textTransform: face === 'display' ? 'uppercase' : 'none' }}
    >
      {children}
    </text>
  );
}

/** The floor a scene stands on */
export function Floor({ y, from = 28, to = 292 }: { y: number; from?: number; to?: number }) {
  return <path d={`M${from} ${y}H${to}`} stroke={LINE} strokeWidth={3} />;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** A seal's scalloped edge: n bumps around a circle */
export function scallops(cx: number, cy: number, r: number, n: number): string {
  const at = (i: number) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    return [round(cx + r * Math.cos(a)), round(cy + r * Math.sin(a))] as const;
  };
  const bump = round(Math.PI * r / n * 0.62);
  let d = `M${at(0).join(' ')}`;
  for (let i = 1; i <= n; i++) d += `A${bump} ${bump} 0 0 1 ${at(i).join(' ')}`;
  return `${d}Z`;
}

/** A row of teeth along the bottom of a slip, as torn from a printer */
export function zigzag(x: number, y: number, width: number, teeth: number, depth: number): string {
  const step = width / teeth;
  let d = '';
  for (let i = 0; i < teeth; i++) d += `L${round(x + width - step * (i + 0.5))} ${y + depth}L${round(x + width - step * (i + 1))} ${y}`;
  return d;
}

/** The holes of a postage stamp's perforation, punched in the colour of the paper under it */
export function Perforation({ x, y, w, h, step, under }: { x: number; y: number; w: number; h: number; step: number; under: string }) {
  const holes: Array<[number, number]> = [];
  for (let i = 0; i <= Math.round(w / step); i++) holes.push([x + (w / Math.round(w / step)) * i, y], [x + (w / Math.round(w / step)) * i, y + h]);
  for (let i = 1; i < Math.round(h / step); i++) holes.push([x, y + (h / Math.round(h / step)) * i], [x + w, y + (h / Math.round(h / step)) * i]);
  return (
    <g fill={under} stroke="none">
      {holes.map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={round(cx)} cy={round(cy)} r={3.6} />
      ))}
    </g>
  );
}

/**
 * A parcel in three-quarter view: the front face at (x, y) of w × h, its depth going up and to the
 * right. The side carries the ink halftone as its shade; children draw on top (tape, labels).
 */
export function Parcel({ x, y, w, h, depth, fill, offset = 6, children }: { x: number; y: number; w: number; h: number; depth: number; fill: string; offset?: number; children?: ReactNode }) {
  const shade = useShade();
  const dx = depth;
  const dy = round(depth * 0.55);
  const outline = `M${x} ${y}L${x + dx} ${y - dy}H${x + w + dx}V${y + h - dy}L${x + w} ${y + h}H${x}Z`;
  const side = `M${x + w} ${y}L${x + w + dx} ${y - dy}V${y + h - dy}L${x + w} ${y + h}Z`;
  return (
    <g>
      <path d={outline} transform={`translate(${offset} ${offset})`} fill={SHADOW} stroke={SHADOW} />
      <path d={`M${x} ${y}H${x + w}V${y + h}H${x}Z`} fill={fill} stroke={INK} />
      <path d={side} fill={fill} stroke={INK} />
      <path d={side} fill={shade} stroke="none" />
      <path d={side} stroke={INK} />
      <path d={`M${x} ${y}L${x + dx} ${y - dy}H${x + w + dx}L${x + w} ${y}Z`} fill={fill} stroke={INK} />
      {children}
    </g>
  );
}
