import { INK, Letters, PAPER, Parcel, RAIL, Scene, SHEET, Stamped, YELLOW, type IllustrationProps } from './kit';

const BRICKS =
  'M16 46H304M16 86H304M16 126H304M16 166H304M16 206H304' +
  'M60 46V86M140 46V86M220 46V86M100 86V126M180 86V126M260 86V126M60 126V166M140 126V166M220 126V166M100 166V206M180 166V206M260 166V206';

/** Sign in: a "Wanted" poster pasted on the wall, for your next release */
export function SignIn(props: IllustrationProps) {
  return (
    <Scene {...props}>
      <path d={BRICKS} stroke={RAIL} strokeWidth={2} />
      <g transform="rotate(-3 160 124)">
        <Stamped offset={8} fill={YELLOW} shape={(p) => <path d="M94 30H226V196L210 214H94Z" {...p} />} />
        <path d="M226 196L210 214L206 196Z" fill={PAPER} stroke={INK} strokeWidth={3} />
        <Letters x={160} y={66} size={30}>
          Wanted
        </Letters>
        <rect x={114} y={76} width={92} height={70} fill={PAPER} stroke={INK} strokeWidth={3} />
        <Parcel x={136} y={108} w={36} h={28} depth={14} fill={YELLOW} offset={3} />
        <Letters x={160} y={166} size={12}>
          Your next release
        </Letters>
        <Letters x={160} y={184} size={9} face="mono">
          REWARD: STARS
        </Letters>
        {/* Tape at the corners; the fourth has come unstuck */}
        <g fill={SHEET} stroke={INK} strokeWidth={2.5}>
          <rect x={82} y={22} width={28} height={12} transform="rotate(-30 96 28)" />
          <rect x={210} y={22} width={28} height={12} transform="rotate(30 224 28)" />
          <rect x={80} y={200} width={28} height={12} transform="rotate(30 94 206)" />
        </g>
      </g>
    </Scene>
  );
}
