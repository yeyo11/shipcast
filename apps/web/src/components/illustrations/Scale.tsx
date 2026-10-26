import { Floor, Halftone, INK, PAPER, Parcel, Scene, SHEET, Stamped, YELLOW, type IllustrationProps } from './kit';

const BARS = [10, 16, 13, 22];
const TICKS = [-60, -36, -12, 12, 36, 60];

/** Stats: a platform scale weighing a parcel whose label carries a bar chart; the parcel is sweating a little */
export function Scale(props: IllustrationProps) {
  return (
    <Scene {...props}>
      <Halftone cx={62} cy={64} r={46} />
      <Floor y={214} />
      <rect x={148} y={140} width={24} height={14} fill={INK} stroke={INK} />
      {/* The dial: ticks, a needle that has read more than it expected */}
      <Stamped offset={5} fill={PAPER} shape={(p) => <circle cx={160} cy={180} r={32} {...p} />} />
      <g transform="translate(160 180)">
        {TICKS.map((a) => (
          <path key={a} d="M0 -26V-20" transform={`rotate(${a})`} stroke={INK} strokeWidth={3} />
        ))}
        <path d="M0 0L16 -18" stroke={INK} strokeWidth={4} />
        <circle r={5} fill={YELLOW} stroke={INK} strokeWidth={3} />
      </g>
      <Stamped offset={6} fill={SHEET} shape={(p) => <rect x={64} y={128} width={192} height={14} rx={4} {...p} />} />
      <Parcel x={106} y={64} w={84} h={64} depth={22} fill={YELLOW}>
        <rect x={118} y={76} width={52} height={40} fill={SHEET} stroke={INK} strokeWidth={2.5} />
        {BARS.map((h, i) => (
          <rect key={h} x={124 + i * 11} y={108 - h} width={7} height={h} fill={i === BARS.length - 1 ? YELLOW : INK} stroke={INK} strokeWidth={2} />
        ))}
        <path d="M122 109H166" stroke={INK} strokeWidth={2.5} />
      </Parcel>
      {/* A drop of sweat, for the weight */}
      <path d="M226 70C220 80 218 86 226 90C234 86 232 80 226 70Z" fill={SHEET} stroke={INK} strokeWidth={3} />
    </Scene>
  );
}
