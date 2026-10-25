import { Conveyor } from './Conveyor';
import { Floor, Halftone, INK, LINE, PAPER, Parcel, Scene, Stamped, YELLOW, type IllustrationProps } from './kit';

const TICKS = Array.from({ length: 12 }, (_, i) => (i / 12) * Math.PI * 2);

/** Onboarding, automation: the belt runs on the alarm clock's time, not yours */
export function OnboardAutomation(props: IllustrationProps) {
  return (
    <Scene {...props}>
      <Halftone cx={64} cy={58} r={46} />
      <Floor y={212} />
      <Conveyor x={24} y={158} width={272} />
      <Parcel x={46} y={128} w={34} h={28} depth={12} fill={PAPER} offset={4} />
      <Parcel x={138} y={124} w={40} h={32} depth={14} fill={YELLOW} offset={4} />
      <Parcel x={234} y={128} w={34} h={28} depth={12} fill={PAPER} offset={4} />
      {/* The alarm clock: bells, legs, nine o'clock */}
      <g strokeWidth={3}>
        <path d="M128 50A16 16 0 0 1 150 30Z" fill={YELLOW} stroke={INK} transform="rotate(-8 140 40)" />
        <path d="M170 30A16 16 0 0 1 192 50Z" fill={YELLOW} stroke={INK} transform="rotate(8 180 40)" />
        <path d="M134 106L126 118M186 106L194 118" stroke={INK} strokeWidth={5} />
      </g>
      <Stamped offset={6} fill={PAPER} shape={(p) => <circle cx={160} cy={74} r={38} {...p} />} />
      {TICKS.map((a) => (
        <circle key={a} cx={160 + Math.round(Math.sin(a) * 2800) / 100} cy={74 - Math.round(Math.cos(a) * 2800) / 100} r={2.2} fill={INK} stroke="none" />
      ))}
      <path d="M160 74V52M160 74H140" stroke={INK} strokeWidth={4.5} />
      <circle cx={160} cy={74} r={4} fill={YELLOW} stroke={INK} strokeWidth={2} />
      <path d="M118 36L108 30M202 36L212 30" stroke={LINE} strokeWidth={3} />
    </Scene>
  );
}
