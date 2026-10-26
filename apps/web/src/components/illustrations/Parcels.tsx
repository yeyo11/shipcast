import { Floor, Halftone, INK, LINE, Letters, PAPER, Parcel, Perforation, Scene, SHEET, Stamped, YELLOW, type IllustrationProps } from './kit';

/** Launches, the list: a stack of stamped parcels on a sack truck, the top one wearing a moustache */
export function Parcels(props: IllustrationProps) {
  return (
    <Scene {...props}>
      <Halftone cx={246} cy={66} r={50} />
      <Floor y={212} />
      {/* The truck: wheel first so the toe plate sits over it, then the upright and its handle */}
      <circle cx={94} cy={192} r={18} fill={INK} stroke={INK} />
      <circle cx={94} cy={192} r={6} fill={SHEET} stroke="none" />
      <path d="M96 190H182" stroke={LINE} strokeWidth={5} />
      <path d="M96 190V40M84 40H110" stroke={LINE} strokeWidth={5} />
      <Parcel x={102} y={148} w={72} h={42} depth={16} fill={PAPER}>
        <rect x={130} y={148} width={10} height={42} fill={SHEET} stroke={INK} strokeWidth={2.5} />
        <circle cx={156} cy={170} r={11} stroke={INK} strokeWidth={3} />
        <path d="M148 170H164" stroke={INK} strokeWidth={2.5} />
      </Parcel>
      <Parcel x={106} y={108} w={60} h={40} depth={14} fill={SHEET}>
        <path d="M114 122H150M114 132H138" stroke={INK} strokeWidth={3} />
        <rect x={140} y={114} width={20} height={24} fill={YELLOW} stroke={INK} strokeWidth={2.5} />
        <Perforation x={140} y={114} w={20} h={24} step={6} under={SHEET} />
      </Parcel>
      <Parcel x={112} y={72} w={46} h={36} depth={12} fill={YELLOW}>
        {/* The moustache, and two eyes that have seen a few releases */}
        <g fill={INK} stroke="none">
          <circle cx={128} cy={85} r={2.8} />
          <circle cx={142} cy={85} r={2.8} />
        </g>
        <path d="M135 96C132 90 124 90 120 95C124 98 130 98 135 96C140 98 146 98 150 95C146 90 138 90 135 96Z" fill={INK} stroke={INK} strokeWidth={2} />
      </Parcel>
      {/* The rubber stamp and its pad, for the next one in line */}
      <Stamped offset={5} fill={INK} shape={(p) => <rect x={214} y={190} width={64} height={14} rx={3} {...p} />} />
      <rect x={240} y={156} width={12} height={36} fill={PAPER} stroke={INK} strokeWidth={3} />
      <Stamped offset={4} fill={YELLOW} shape={(p) => <rect x={226} y={128} width={36} height={28} rx={14} {...p} />} />
      <path d="M200 120C208 108 218 104 226 108" stroke={LINE} strokeWidth={3} strokeDasharray="1 8" />
    </Scene>
  );
}
