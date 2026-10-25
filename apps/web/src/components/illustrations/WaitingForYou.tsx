import { Floor, Halftone, INK, LINE, Letters, PAPER, Parcel, Scene, SHEET, Stamped, YELLOW, type IllustrationProps } from './kit';

// A wobble every few seconds, not a constant shake: it should read as "ding", not as an alarm
const DING =
  '.sc-ding { transform-box: fill-box; transform-origin: 50% 100%; animation: sc-ding 2.4s ease-in-out infinite; } ' +
  '@keyframes sc-ding { 0%, 70%, 100% { transform: rotate(0); } 76% { transform: rotate(-7deg); } 84% { transform: rotate(6deg); } 92% { transform: rotate(-3deg); } }';

/** Waiting for you: a yellow parcel at the counter, ringing the desk bell */
export function WaitingForYou(props: IllustrationProps) {
  return (
    <Scene {...props} motion={DING}>
      <Halftone cx={246} cy={66} r={52} />
      <Floor y={206} />
      <Parcel x={72} y={116} w={136} h={88} depth={40} fill={YELLOW}>
        <path d="M134 116L174 94H190L150 116Z" fill={PAPER} stroke={INK} strokeWidth={3} />
        <rect x={134} y={116} width={16} height={88} fill={PAPER} stroke={INK} strokeWidth={3} />
        <Stamped offset={3} fill={PAPER} shape={(p) => <rect x={160} y={140} width={40} height={30} rx={3} strokeWidth={3} {...p} />} />
        <Letters x={180} y={159} size={10}>
          For you
        </Letters>
        <rect x={84} y={180} width={36} height={6} rx={2} fill={INK} stroke="none" />
      </Parcel>
      {/* The bell, on the lid */}
      <g className="sc-ding">
        <Stamped offset={4} fill={SHEET} shape={(p) => <path d="M150 98A28 28 0 0 1 206 98Z" {...p} />} />
        <rect x={142} y={96} width={72} height={10} rx={4} fill={INK} stroke={INK} />
        <rect x={174} y={60} width={8} height={10} fill={INK} stroke={INK} strokeWidth={2} />
        <rect x={168} y={54} width={20} height={7} rx={3} fill={INK} stroke={INK} strokeWidth={2} />
        <path d="M164 84C166 78 170 74 176 72" stroke={INK} strokeWidth={3} />
      </g>
      <g stroke={LINE} strokeWidth={3.5}>
        <path d="M136 62L124 52M130 80H114" />
        <path d="M222 62L234 52M228 80H244" />
      </g>
    </Scene>
  );
}
