import { FAILURE, Halftone, INK, LINE, Letters, PAPER, Scene, SHEET, Stamped, type IllustrationProps } from './kit';

/** A post that failed: the clerk's rubber stamp lifting off a fresh "Damaged" */
export function PublishFailed(props: IllustrationProps) {
  return (
    <Scene {...props}>
      <Halftone cx={74} cy={62} r={50} />
      <g transform="rotate(-4 140 156)">
        <Stamped offset={7} fill={PAPER} shape={(p) => <path d="M30 98H250V196L238 206L226 198L214 212H30Z" {...p} />} />
        <path d="M30 98L140 156L250 98" stroke={INK} strokeWidth={3} />
        <g transform="rotate(-9 136 168)">
          <rect x={62} y={146} width={148} height={44} rx={5} stroke={FAILURE} strokeWidth={4} />
          <Letters x={136} y={178} size={28} fill={FAILURE}>
            Damaged
          </Letters>
        </g>
      </g>
      {/* The stamp itself, just lifted */}
      <g transform="rotate(16 252 64)">
        <Stamped offset={5} fill={INK} shape={(p) => <circle cx={252} cy={26} r={14} {...p} />} />
        <rect x={245} y={38} width={14} height={26} fill={INK} stroke={INK} />
        <Stamped offset={5} fill={SHEET} shape={(p) => <rect x={216} y={62} width={72} height={20} rx={4} {...p} />} />
        <rect x={220} y={82} width={64} height={8} rx={2} fill={FAILURE} stroke={INK} strokeWidth={3} />
      </g>
      <path d="M204 104L196 112M222 110L220 122M240 112L244 124" stroke={LINE} strokeWidth={3} />
    </Scene>
  );
}
