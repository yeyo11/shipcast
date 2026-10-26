import { Floor, Halftone, INK, LINE, Letters, PAPER, Scene, SHEET, Stamped, YELLOW, type IllustrationProps } from './kit';

const KEY_ROWS = [
  { y: 164, from: 98, count: 8 },
  { y: 182, from: 108, count: 7 },
];

/** Write: a typewriter mid-sentence, its bell about to ring over a page that starts "Dear world," */
export function Typewriter(props: IllustrationProps) {
  return (
    <Scene {...props}>
      <Halftone cx={56} cy={66} r={44} />
      <Floor y={214} />
      {/* The page, behind the carriage that holds it */}
      <g transform="rotate(-2 160 76)">
        <Stamped offset={6} fill={SHEET} shape={(p) => <rect x={104} y={22} width={112} height={92} {...p} />} />
        <Letters x={116} y={44} size={13} anchor="start">
          Dear world,
        </Letters>
        <g fill={INK} stroke="none">
          <rect x={116} y={56} width={84} height={5} rx={2} />
          <rect x={116} y={67} width={70} height={5} rx={2} />
          <rect x={116} y={78} width={88} height={5} rx={2} />
          <rect x={116} y={89} width={34} height={5} rx={2} />
        </g>
        {/* The cursor, a letter ahead of the sentence */}
        <rect x={154} y={87} width={7} height={9} fill={YELLOW} stroke={INK} strokeWidth={2} />
      </g>
      {/* Carriage, then the body of the machine */}
      <Stamped offset={6} fill={INK} shape={(p) => <rect x={82} y={106} width={156} height={20} rx={6} {...p} />} />
      <circle cx={82} cy={116} r={9} fill={YELLOW} stroke={INK} strokeWidth={3} />
      <circle cx={238} cy={116} r={9} fill={YELLOW} stroke={INK} strokeWidth={3} />
      <Stamped offset={7} fill={PAPER} shape={(p) => <path d="M70 214V150L98 126H222L250 150V214Z" {...p} />} />
      {KEY_ROWS.map((row) =>
        Array.from({ length: row.count }, (_, i) => (
          <circle key={`${row.y}-${i}`} cx={row.from + i * 16} cy={row.y} r={6} fill={i === 3 && row.y === 164 ? YELLOW : SHEET} stroke={INK} strokeWidth={3} />
        )),
      )}
      <rect x={116} y={198} width={88} height={10} rx={5} fill={SHEET} stroke={INK} strokeWidth={3} />
      {/* The bell: ding */}
      <path d="M262 92C270 88 274 82 274 74M266 104C278 100 286 90 288 80" stroke={LINE} strokeWidth={3} />
      <Letters x={272} y={66} size={11} face="mono" fill={LINE}>
        ding
      </Letters>
    </Scene>
  );
}
