import { Floor, Halftone, INK, LINE, Letters, PAPER, Scene, SHEET, Stamped, YELLOW, type IllustrationProps } from './kit';

function Envelope({ x, y, fill = SHEET, rotate = 0 }: { x: number; y: number; fill?: string; rotate?: number }) {
  return (
    <g transform={`rotate(${rotate} ${x + 20} ${y + 13})`}>
      <rect x={x} y={y} width={40} height={26} rx={2} fill={fill} stroke={INK} strokeWidth={3} />
      <path d={`M${x} ${y}L${x + 20} ${y + 15}L${x + 40} ${y}`} stroke={INK} strokeWidth={2.5} />
    </g>
  );
}

/** Comments: letters arriving in a mailbox that is quietly pleased about it, and a reply slip waiting its turn */
export function Mailbox(props: IllustrationProps) {
  return (
    <Scene {...props}>
      <Halftone cx={250} cy={62} r={46} />
      <Floor y={214} />
      <path d="M170 150V214" stroke={LINE} strokeWidth={8} />
      {/* The letters on their way in, along the dotted path */}
      <path d="M60 60C90 44 120 58 140 92" stroke={LINE} strokeWidth={3} strokeDasharray="1 8" />
      <Envelope x={36} y={66} rotate={-12} />
      <Envelope x={92} y={38} fill={YELLOW} rotate={8} />
      {/* The box: arched lid, a smile for a slot, the flag up */}
      <Stamped offset={7} fill={PAPER} shape={(p) => <path d="M104 150V112C104 82 132 66 170 66S236 82 236 112V150Z" {...p} />} />
      <path d="M128 112C140 126 200 126 212 112" stroke={INK} strokeWidth={5} />
      <g fill={INK} stroke="none">
        <circle cx={146} cy={96} r={3.4} />
        <circle cx={194} cy={96} r={3.4} />
      </g>
      <path d="M236 108H262V70" stroke={INK} strokeWidth={4} />
      <rect x={250} y={60} width={34} height={22} rx={2} fill={YELLOW} stroke={INK} strokeWidth={3} />
      <rect x={104} y={140} width={132} height={10} fill={INK} stroke={INK} />
      {/* The reply slip, pinned low and a little askew */}
      <g transform="rotate(5 250 188)">
        <Stamped offset={5} fill={SHEET} shape={(p) => <rect x={206} y={162} width={78} height={46} {...p} />} />
        <path d="M216 176H266M216 186H258" stroke={INK} strokeWidth={3} />
        <path d="M262 198C250 202 238 200 236 192" stroke={INK} strokeWidth={3} />
        <path d="M232 197L236 191L242 195" stroke={INK} strokeWidth={3} />
      </g>
      <Letters x={86} y={128} size={11} face="mono" fill={LINE}>
        +3
      </Letters>
    </Scene>
  );
}
