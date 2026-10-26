import { Floor, Halftone, INK, LINE, PAPER, Scene, SHEET, Stamped, YELLOW, type IllustrationProps } from './kit';

const COLS = [56, 128, 200];
const ROWS = [96, 140, 184 - 4];

/** A letter standing in its pigeonhole: the V of the flap is all that is needed to read it */
function Letter({ x, y, fill = SHEET }: { x: number; y: number; fill?: string }) {
  return (
    <g>
      <rect x={x} y={y} width={44} height={26} rx={2} fill={fill} stroke={INK} strokeWidth={3} />
      <path d={`M${x} ${y}L${x + 22} ${y + 15}L${x + 44} ${y}`} stroke={INK} strokeWidth={2.5} />
    </g>
  );
}

/** A tag on a string, hanging from a hole's rim */
function Tag({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <path d={`M${x} ${y}V${y + 6}`} stroke={INK} strokeWidth={2.5} />
      <path d={`M${x - 8} ${y + 6}H${x + 8}L${x + 11} ${y + 12}V${y + 22}H${x - 11}V${y + 12}Z`} fill={YELLOW} stroke={INK} strokeWidth={2.5} />
      <circle cx={x} cy={y + 12} r={2} fill={INK} stroke="none" />
    </g>
  );
}

/** Channels: the sorting office's pigeonholes, a few of them tagged, and a pigeon who took the job literally */
export function Pigeonholes(props: IllustrationProps) {
  return (
    <Scene {...props}>
      <Halftone cx={268} cy={70} r={42} />
      <Floor y={214} />
      <Stamped offset={7} fill={PAPER} shape={(p) => <rect x={40} y={68} width={240} height={140} rx={6} {...p} />} />
      {/* The partitions, then what sits in the holes */}
      <path d="M120 68V208M200 68V208M40 112H280M40 160H280" stroke={INK} strokeWidth={4} />
      <Letter x={52} y={80} />
      <Letter x={132} y={80} fill={YELLOW} />
      <Letter x={212} y={80} />
      <Letter x={212} y={172} />
      <Tag x={160} y={116} />
      <Tag x={80} y={164} />
      <Tag x={240} y={116} />
      {/* The pigeon on top, a letter in its beak */}
      <g>
        <path d="M70 68C64 56 70 42 84 40H100C112 40 118 52 114 68Z" transform="translate(4 4)" fill="var(--sc-stamp)" stroke="var(--sc-stamp)" />
        <path d="M70 68C64 56 70 42 84 40H100C112 40 118 52 114 68Z" fill={SHEET} stroke={INK} />
        <path d="M90 56C98 54 106 58 108 66" stroke={INK} strokeWidth={3} />
        <circle cx={78} cy={36} r={11} fill={SHEET} stroke={INK} />
        <circle cx={75} cy={34} r={2.4} fill={INK} stroke="none" />
        <path d="M68 38L56 41L68 44" fill={YELLOW} stroke={INK} strokeWidth={3} />
        <g transform="rotate(-14 52 52)">
          <rect x={40} y={46} width={22} height={14} rx={1.5} fill={SHEET} stroke={INK} strokeWidth={2.5} />
          <path d="M40 46L51 54L62 46" stroke={INK} strokeWidth={2} />
        </g>
        <path d="M86 68V74M98 68V74" stroke={INK} strokeWidth={3} />
      </g>
      <path d="M236 52C246 44 256 44 264 50" stroke={LINE} strokeWidth={3} strokeDasharray="1 8" />
    </Scene>
  );
}
