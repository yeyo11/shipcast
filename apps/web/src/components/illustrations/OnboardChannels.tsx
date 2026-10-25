import { Halftone, INK, Letters, PAPER, Scene, SHEET, Stamped, YELLOW, type IllustrationProps } from './kit';

/** One entry of the book: a round avatar and the address under the name */
function Entry({ x, y, fill, ticked = false }: { x: number; y: number; fill: string; ticked?: boolean }) {
  return (
    <g>
      <circle cx={x + 9} cy={y} r={9} fill={fill} stroke={INK} strokeWidth={3} />
      <rect x={x + 24} y={y - 7} width={58} height={6} rx={2} fill={INK} stroke="none" />
      <rect x={x + 24} y={y + 3} width={40} height={4} rx={2} fill={INK} stroke="none" />
      {ticked && <path d={`M${x + 70} ${y + 4}L${x + 76} ${y + 9}L${x + 88} ${y - 5}`} stroke={INK} strokeWidth={3} />}
    </g>
  );
}

/** Onboarding, the channels: the address book open on A, one address already ticked */
export function OnboardChannels(props: IllustrationProps) {
  return (
    <Scene {...props}>
      <Halftone cx={70} cy={56} r={46} />
      <Stamped
        offset={7}
        fill={YELLOW}
        shape={(p) => <path d="M30 70C84 58 128 64 160 80C192 64 236 58 290 70V210C236 198 192 202 160 216C128 202 84 198 30 210Z" {...p} />}
      />
      {/* The index tabs on the right page */}
      <g strokeWidth={3}>
        <rect x={280} y={84} width={18} height={24} rx={3} fill={INK} stroke={INK} />
        <rect x={280} y={112} width={18} height={24} rx={3} fill={SHEET} stroke={INK} />
        <rect x={280} y={140} width={18} height={24} rx={3} fill={SHEET} stroke={INK} />
      </g>
      <path d="M40 72C88 62 128 68 160 84V206C128 192 88 188 40 198Z" fill={PAPER} stroke={INK} />
      <path d="M160 84C192 68 232 62 280 72V198C232 188 192 192 160 206Z" fill={PAPER} stroke={INK} />
      <Letters x={58} y={106} size={26} anchor="start">
        A
      </Letters>
      <Entry x={58} y={128} fill={YELLOW} ticked />
      <Entry x={58} y={156} fill={SHEET} />
      <Entry x={58} y={182} fill={INK} />
      <Entry x={176} y={110} fill={SHEET} />
      <Entry x={176} y={138} fill={YELLOW} />
      <Entry x={176} y={166} fill={SHEET} />
    </Scene>
  );
}
