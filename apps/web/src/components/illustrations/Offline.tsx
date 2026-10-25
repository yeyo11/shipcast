import { Floor, Halftone, INK, LINE, Letters, PAPER, Scene, Stamped, YELLOW, type IllustrationProps } from './kit';

/** Offline: a mailbox with its flag down and its cord cut, dozing */
export function Offline(props: IllustrationProps) {
  return (
    <Scene {...props}>
      <Halftone cx={232} cy={66} r={54} />
      <Floor y={208} />
      <Stamped fill={INK} shape={(p) => <rect x={120} y={140} width={22} height={68} {...p} />} />
      <Stamped offset={7} fill={PAPER} shape={(p) => <path d="M60 144V96C60 70 78 54 102 54H210C234 54 252 70 252 96V144Z" {...p} />} />
      {/* The door's hinge line and its knob */}
      <path d="M100 56C116 64 124 80 124 96V144" stroke={INK} strokeWidth={3} />
      <circle cx={86} cy={104} r={6} fill={INK} stroke="none" />
      {/* The flag, lowered along the side: nothing to collect */}
      <Stamped offset={3} fill={INK} shape={(p) => <rect x={180} y={100} width={56} height={8} rx={2} {...p} />} />
      <Stamped offset={3} fill={YELLOW} shape={(p) => <path d="M174 100H196V128L185 120L174 128Z" {...p} />} />
      <circle cx={230} cy={104} r={5} fill={PAPER} stroke={INK} strokeWidth={3} />
      {/* The cord, cut: two ends with their wires showing */}
      <path d="M252 132C274 132 282 152 276 172" stroke={LINE} strokeWidth={5} />
      <rect x={271} y={170} width={10} height={8} rx={1} fill={YELLOW} stroke={INK} strokeWidth={2} transform="rotate(-20 276 174)" />
      <path d="M288 190C292 200 300 206 314 206" stroke={LINE} strokeWidth={5} />
      <rect x={283} y={184} width={10} height={8} rx={1} fill={YELLOW} stroke={INK} strokeWidth={2} transform="rotate(-30 288 188)" />
      <Letters x={56} y={44} size={24} fill={LINE} anchor="start">
        z
      </Letters>
      <Letters x={36} y={26} size={17} fill={LINE} anchor="start">
        z
      </Letters>
    </Scene>
  );
}
