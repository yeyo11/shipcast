import { Halftone, INK, LINE, Letters, PAPER, Scene, Stamped, YELLOW, type IllustrationProps } from './kit';

/** 404: a shipping label sent back, the blog's own 404 in Cartel's ink */
export function NotFound(props: IllustrationProps) {
  return (
    <Scene {...props}>
      <Halftone cx={234} cy={70} r={58} />
      {/* The way back: a U-turn over the label */}
      <path d="M222 52C198 18 124 14 94 42" stroke={LINE} />
      <path d="M86 26L92 46L112 40" stroke={LINE} />
      <g transform="rotate(-7 160 128)">
        <Stamped offset={7} fill={PAPER} shape={(p) => <path d="M44 64H214L262 128L214 192H44Z" {...p} />} />
        <circle cx={222} cy={128} r={9} fill={YELLOW} stroke={INK} />
        <path d="M231 130C258 142 280 118 298 130C310 138 302 156 290 150" stroke={LINE} strokeWidth={3} />
        <g fill={INK} stroke="none">
          <rect x={60} y={80} width={58} height={10} rx={2} />
          <rect x={60} y={98} width={112} height={6} rx={2} />
          <rect x={60} y={110} width={84} height={6} rx={2} />
        </g>
        <Letters x={196} y={89} size={11} face="mono" anchor="end">
          No. 404
        </Letters>
        <g transform="rotate(-8 128 156)">
          <rect x={62} y={130} width={134} height={52} rx={6} stroke={INK} strokeWidth={3.5} />
          <rect x={68} y={136} width={122} height={40} rx={3} stroke={INK} strokeWidth={1.5} />
          <Letters x={129} y={154} size={15}>
            Return to
          </Letters>
          <Letters x={129} y={172} size={18}>
            sender
          </Letters>
        </g>
      </g>
    </Scene>
  );
}
