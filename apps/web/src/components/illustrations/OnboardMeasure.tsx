import { Halftone, INK, LINE, Letters, PAPER, Scene, SHADOW, SHEET, Stamped, YELLOW, zigzag, type IllustrationProps } from './kit';

const BARS = [22, 34, 28, 46, 62];

/** Onboarding, measuring: the tracking slip, its chart going up, under the magnifying glass */
export function OnboardMeasure(props: IllustrationProps) {
  return (
    <Scene {...props}>
      <Halftone cx={248} cy={64} r={52} />
      <g transform="rotate(-4 150 120)">
        <Stamped offset={7} fill={PAPER} shape={(p) => <path d={`M84 26H220V196${zigzag(84, 196, 136, 9, 10)}Z`} {...p} />} />
        <Letters x={152} y={52} size={16}>
          Tracking
        </Letters>
        <Letters x={152} y={66} size={9} face="mono">
          No. 0042
        </Letters>
        <path d="M98 76H206" stroke={INK} strokeWidth={2} strokeDasharray="3 5" />
        {BARS.map((h, i) => (
          <rect key={h} x={102 + i * 20} y={150 - h} width={14} height={h} fill={i === BARS.length - 1 ? YELLOW : INK} stroke={INK} strokeWidth={2.5} />
        ))}
        {/* Last period, dashed, as in every Shipcast chart */}
        <path d="M109 134L129 126L149 130L169 116L189 108" stroke={INK} strokeWidth={2.5} strokeDasharray="4 4" />
        <path d="M98 152H206" stroke={INK} strokeWidth={3} />
        <g fill={INK} stroke="none">
          {[0, 6, 9, 15, 18, 22, 28, 34, 37, 43, 49, 52, 58, 64, 68, 74, 80, 84, 90, 96, 100].map((x, i) => (
            <rect key={x} x={102 + x} y={166} width={i % 3 === 0 ? 4 : 2} height={18} />
          ))}
        </g>
      </g>
      {/* The glass, over the best day */}
      <g transform="rotate(-30 230 112)">
        <rect x={224} y={126} width={14} height={50} rx={6} transform="translate(5 5)" fill={SHADOW} stroke={SHADOW} />
        <rect x={224} y={126} width={14} height={50} rx={6} fill={INK} stroke={INK} />
        <circle cx={231} cy={98} r={30} stroke={INK} strokeWidth={8} />
        <circle cx={231} cy={98} r={30} stroke={SHEET} strokeWidth={2} />
        <path d="M214 86C218 78 226 74 234 74" stroke={LINE} strokeWidth={3} />
      </g>
    </Scene>
  );
}
