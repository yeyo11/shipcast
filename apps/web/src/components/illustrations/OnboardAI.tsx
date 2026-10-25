import { Halftone, INK, LINE, Letters, PAPER, Scene, SHEET, Stamped, YELLOW, type IllustrationProps } from './kit';

/** Onboarding, the AI: the sorting clerk, a rubber stamp with a face, sparking an idea on the page */
export function OnboardAI(props: IllustrationProps) {
  return (
    <Scene {...props}>
      <Halftone cx={238} cy={74} r={56} />
      {/* The page, lying flat, with one earlier verdict on it */}
      <Stamped offset={6} fill={PAPER} shape={(p) => <path d="M64 156H272L252 210H44Z" {...p} />} />
      <g transform="rotate(-8 92 186)">
        <rect x={68} y={174} width={52} height={22} rx={3} stroke={INK} strokeWidth={2.5} />
        <Letters x={94} y={190} size={11}>
          Draft
        </Letters>
      </g>
      <path d="M196 196H240M188 186H228" stroke={INK} strokeWidth={3} />
      {/* The clerk */}
      <Stamped offset={6} fill={INK} shape={(p) => <circle cx={150} cy={60} r={18} {...p} />} />
      <rect x={142} y={76} width={16} height={34} fill={INK} stroke={INK} />
      <Stamped offset={5} fill={SHEET} shape={(p) => <rect x={110} y={108} width={80} height={36} rx={6} {...p} />} />
      <rect x={114} y={144} width={72} height={10} rx={3} fill={YELLOW} stroke={INK} strokeWidth={3} />
      <circle cx={136} cy={124} r={3.5} fill={INK} stroke="none" />
      <circle cx={164} cy={124} r={3.5} fill={INK} stroke="none" />
      <path d="M144 132C148 136 152 136 156 132" stroke={INK} strokeWidth={2.5} />
      {/* The spark */}
      <Stamped offset={4} fill={YELLOW} shape={(p) => <path d="M232 38Q236 64 262 68Q236 72 232 98Q228 72 202 68Q228 64 232 38Z" {...p} />} />
      <path d="M268 36L274 30M276 50H284M196 40L190 34" stroke={LINE} strokeWidth={3} />
    </Scene>
  );
}
